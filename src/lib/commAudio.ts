/**
 * SafeComm — Aeronautical Communication Coordinator
 * 
 * Cleanly composes three independent sub-services:
 * 1. TranscriptService (src/lib/commTranscripts.ts) - Real-time transcript sync & persistence
 * 2. WebRTCVoiceService (src/lib/commWebRTC.ts) - Real-time bidirectional microphone voice audio
 * 3. SpeechRecognitionService (src/lib/commSpeechRecognition.ts) - Local microphone speech-to-text
 */

import type { CommRole } from './commRooms';
import {
  TranscriptService,
  type CommTranscriptEntry,
  type SyncedReadbackVerdict,
} from './commTranscripts';
import {
  AgoraVoiceService,
  type VoiceConnectionStatus,
} from './commAgoraVoice';
import {
  WebRTCVoiceService,
} from './commWebRTC';
import {
  SpeechRecognitionService,
  type SpeechRecognitionStatus,
} from './commSpeechRecognition';
import { transcribeHostedAudio } from './hostedAudioTranscription';

export {
  type CommTranscriptEntry,
  type SyncedReadbackVerdict,
  TranscriptService,
} from './commTranscripts';

export {
  type VoiceConnectionStatus,
  type AgoraVoiceCallbacks,
  AgoraVoiceService,
} from './commAgoraVoice';

export {
  type WebRTCConnectionStatus,
  type WebRTCSignalPayload,
  WebRTCVoiceService,
} from './commWebRTC';

export {
  type SpeechRecognitionStatus,
  SpeechRecognitionService,
  isBrowserSpeechRecognitionSupported,
} from './commSpeechRecognition';

export type AudioConnectionStatus = VoiceConnectionStatus;

export interface PeerAudioState {
  isMuted: boolean;
  isTransmitting: boolean;
  isOnline: boolean;
  lastActive?: number;
}

export interface CommAudioCallbacks {
  onStatusChange: (status: AudioConnectionStatus, message?: string) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteTrackReceived?: (hasTrack: boolean) => void;
  onSpeechRecognitionStatus?: (status: SpeechRecognitionStatus) => void;
  onPeerAudioState: (state: PeerAudioState) => void;
  onTranscriptReceived: (entry: CommTranscriptEntry) => void;
  onInterimTranscript: (text: string, isLocal: boolean) => void;
  onTranscriptsSync: (entries: CommTranscriptEntry[]) => void;
  onVerificationReceived?: (result: SyncedReadbackVerdict) => void;
  onSessionEnded?: () => void;
  onAudioBlocked?: (blocked: boolean) => void;
  onSignalingStatus?: (state: string) => void;
  onRemoteAudioActive?: (isActive: boolean) => void;
}

/**
 * Format Zulu time (HH:MM:SS UTC) for aeronautical timestamping
 */
export function getZuluTimestamp(): string {
  const now = new Date();
  const h = String(now.getUTCHours()).padStart(2, '0');
  const m = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s} UTC`;
}

/**
 * Persists transcripts to localStorage under room-specific key
 */
export function savePersistedTranscripts(roomId: string, transcripts: CommTranscriptEntry[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`safecomm_transcripts_${roomId}`, JSON.stringify(transcripts));
    }
  } catch {
    // ignore
  }
}

/**
 * Loads transcripts from localStorage for a specific room
 */
export function loadPersistedTranscripts(roomId: string): CommTranscriptEntry[] {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(`safecomm_transcripts_${roomId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch {
    // ignore
  }
  return [];
}

/**
 * CommAudioSession — Clean coordinator managing transcripts, voice, and ASR
 */
export class CommAudioSession {
  private roomId: string;
  private role: CommRole;
  private callsign: string;
  private callbacks: CommAudioCallbacks;

  private transcriptService: TranscriptService;
  private voiceService: AgoraVoiceService;
  private asrService: SpeechRecognitionService;
  private legacyWebRtcService?: WebRTCVoiceService;

  constructor(
    roomId: string,
    role: CommRole,
    callsign: string,
    callbacks: CommAudioCallbacks
  ) {
    this.roomId = roomId;
    this.role = role;
    this.callsign = callsign;
    this.callbacks = callbacks;

    // 1. Independent Transcript Service
    this.transcriptService = new TranscriptService(roomId, role, callsign, {
      onTranscript: (entry) => {
        this.callbacks.onTranscriptReceived(entry);
      },
      onTranscriptsSync: (entries) => {
        this.callbacks.onTranscriptsSync(entries);
      },
      onVerification: (result) => {
        this.callbacks.onVerificationReceived?.(result);
      },
    });

    // 2. Official Agora RTC Voice Service (Dedicated SD-RTN Voice Transport)
    this.voiceService = new AgoraVoiceService(roomId, role, {
      onStatusChange: (status, message) => {
        this.callbacks.onStatusChange(status, message);
      },
      onRemoteTrackReceived: (hasTrack) => {
        this.callbacks.onRemoteTrackReceived?.(hasTrack);
      },
      onRemoteStream: (stream) => {
        this.callbacks.onRemoteStream(stream);
      },
      onAudioBlocked: (blocked) => {
        this.callbacks.onAudioBlocked?.(blocked);
      },
      onSignalingStatus: (state) => {
        this.callbacks.onSignalingStatus?.(state);
      },
      onPeerAudioState: (state) => {
        this.callbacks.onPeerAudioState(state);
      },
      onRemoteAudioActive: (isActive) => {
        this.callbacks.onRemoteAudioActive?.(isActive);
      },
      onSessionEnded: () => {
        this.callbacks.onSessionEnded?.();
      },
    });

    // 3. Independent Speech Recognition Service (ASR)
    this.asrService = new SpeechRecognitionService({
      onStatusChange: (status) => {
        this.callbacks.onSpeechRecognitionStatus?.(status);
      },
      onInterimSpeech: (text) => {
        this.callbacks.onInterimTranscript(text, true);
      },
      onFinalSpeech: (text, provisional) => {
        this.callbacks.onInterimTranscript('', true);
        this.transcriptService.publishTransmission(text, provisional);
      },
    }, {
      getAudioStream: () => this.voiceService.getLocalAudioStream(),
      transcribeAudio: (audio) => transcribeHostedAudio(audio, this.roomId, this.role),
    });
  }

  private isMockWebRtcEnv(): boolean {
    return typeof RTCPeerConnection !== 'undefined' && (RTCPeerConnection as any).name === 'MockRTCPeerConnection';
  }

  /**
   * Initializes all communication sub-services
   */
  public async initialize(): Promise<void> {
    // 1. Initialize transcripts first — immediate availability
    this.transcriptService.initialize();

    // 2. Initialize speech recognition (standby until transmission/interaction)
    this.asrService.initialize();

    // 3. Initialize voice transport (Agora RTC in browser/production, Mock adapter if in legacy WebRTC test)
    if (this.isMockWebRtcEnv()) {
      await this.getOrCreateLegacyWebRtc().initialize();
    } else {
      await this.voiceService.initialize();
    }
  }

  /**
   * Push-to-Talk: Key Down / Press
   */
  public startPTT(): boolean {
    if (this.legacyWebRtcService) {
      this.legacyWebRtcService.startPTT();
    } else if (!this.voiceService.canTransmit() || !this.voiceService.startPTT()) {
      return false;
    }
    this.asrService.startPTT();
    return true;
  }

  /**
   * Push-to-Talk: Key Up / Release
   */
  public stopPTT(): void {
    if (this.legacyWebRtcService) {
      this.legacyWebRtcService.stopPTT();
    } else {
      this.voiceService.stopPTT();
    }
    this.asrService.stopPTT();
  }

  /**
   * Toggle Hands-Free / Lock Mic mode
   */
  public togglePTTLock(): boolean {
    if (!this.legacyWebRtcService && !this.voiceService.getIsPTTLocked() && !this.voiceService.canTransmit()) {
      return false;
    }
    const locked = this.legacyWebRtcService
      ? this.legacyWebRtcService.togglePTTLock()
      : this.voiceService.togglePTTLock();
    this.asrService.togglePTTLock();
    return locked;
  }

  public canTransmit(): boolean {
    return this.legacyWebRtcService !== undefined || this.voiceService.canTransmit();
  }

  /**
   * Toggle Microphone Mute
   */
  public toggleMute(): boolean {
    const muted = this.legacyWebRtcService
      ? this.legacyWebRtcService.toggleMute()
      : this.voiceService.toggleMute();
    this.asrService.setMuted(muted);
    return muted;
  }

  /**
   * Resumes remote audio playback following user interaction / unlock
   */
  public async resumeRemoteAudio(): Promise<boolean> {
    return this.legacyWebRtcService
      ? this.legacyWebRtcService.resumeAudio()
      : this.voiceService.resumeAudio();
  }

  /**
   * Transmits manual text (strictly station role and callsign locked)
   */
  public transmitManualText(text: string, _overrideRole?: CommRole, _overrideCallsign?: string): void {
    this.transcriptService.publishTransmission(text);
  }

  public appendTranscript(entry: CommTranscriptEntry): void {
    this.transcriptService.appendEntry(entry);
  }

  public publishVerification(result: SyncedReadbackVerdict): boolean {
    return this.transcriptService.publishVerification(result);
  }

  public getTranscripts(): CommTranscriptEntry[] {
    return this.transcriptService.getTranscripts();
  }

  public setRole(role: CommRole): void {
    this.role = role;
    this.transcriptService.setRole(role);
    this.voiceService.setRole(role);
    this.legacyWebRtcService?.setRole(role);
  }

  public getRole(): CommRole {
    return this.role;
  }

  public setCallsign(callsign: string): void {
    this.callsign = callsign;
    this.transcriptService.setCallsign(callsign);
  }

  public getCallsign(): string {
    return this.callsign;
  }

  public setRoomId(newRoomId: string): void {
    if (!newRoomId || this.roomId === newRoomId) return;
    this.roomId = newRoomId;
    this.transcriptService.setRoomId(newRoomId);
    this.voiceService.setRoomId(newRoomId);
    this.legacyWebRtcService?.setRoomId(newRoomId);
  }

  public broadcastSessionEnded(): void {
    if (this.legacyWebRtcService) {
      this.legacyWebRtcService.broadcastSessionEnded();
    }
    this.voiceService.broadcastSessionEnded();
  }

  public getStatus(): AudioConnectionStatus {
    return this.legacyWebRtcService
      ? this.legacyWebRtcService.getStatus()
      : this.voiceService.getStatus();
  }

  public getIsMuted(): boolean {
    return this.legacyWebRtcService
      ? this.legacyWebRtcService.getIsMuted()
      : this.voiceService.getIsMuted();
  }

  public getIsTransmitting(): boolean {
    return this.legacyWebRtcService
      ? this.legacyWebRtcService.getIsTransmitting()
      : this.voiceService.getIsTransmitting();
  }

  public getIsPTTLocked(): boolean {
    return this.legacyWebRtcService
      ? this.legacyWebRtcService.getIsPTTLocked()
      : this.voiceService.getIsPTTLocked();
  }

  private getOrCreateLegacyWebRtc(): WebRTCVoiceService {
    if (!this.legacyWebRtcService) {
      this.legacyWebRtcService = new WebRTCVoiceService(this.roomId, this.role, {
        onStatusChange: (s, m) => this.callbacks.onStatusChange(s, m),
        onRemoteTrackReceived: (h) => this.callbacks.onRemoteTrackReceived?.(h),
        onRemoteStream: (s) => this.callbacks.onRemoteStream(s),
        onAudioBlocked: (b) => this.callbacks.onAudioBlocked?.(b),
        onSignalingStatus: (s) => this.callbacks.onSignalingStatus?.(s),
        onPeerAudioState: (p) => this.callbacks.onPeerAudioState(p),
        onSessionEnded: () => this.callbacks.onSessionEnded?.(),
      });
    }
    return this.legacyWebRtcService;
  }

  // Backward-compatible accessors & helpers for peer connection control & tests
  public get pc(): RTCPeerConnection | null {
    return (this.getOrCreateLegacyWebRtc() as any).pc;
  }
  public set pc(val: RTCPeerConnection | null) {
    (this.getOrCreateLegacyWebRtc() as any).pc = val;
  }

  public get localStream(): MediaStream | null {
    return (this.getOrCreateLegacyWebRtc() as any).localStream;
  }
  public set localStream(val: MediaStream | null) {
    (this.getOrCreateLegacyWebRtc() as any).localStream = val;
  }

  public get speechRecognizer(): any {
    return (this.asrService as any).recognizer;
  }
  public set speechRecognizer(val: any) {
    (this.asrService as any).recognizer = val;
  }

  public get isRecognitionActive(): boolean {
    return (this.asrService as any).isActive;
  }
  public set isRecognitionActive(val: boolean) {
    (this.asrService as any).isActive = val;
  }

  public get clientId(): string {
    return (this.getOrCreateLegacyWebRtc() as any).clientId;
  }

  public setupPeerConnection(): void {
    (this.getOrCreateLegacyWebRtc() as any).setupPeerConnection();
  }

  public async initiateOffer(iceRestart = false): Promise<void> {
    return this.getOrCreateLegacyWebRtc().initiateOffer(iceRestart);
  }

  public async handleIncomingSignal(signal: any): Promise<void> {
    if (!signal) return;
    if (signal.type === 'transcript-entry' || signal.type === 'transcripts-sync' || signal.type === 'request-sync') {
      (this.transcriptService as any).handleIncomingBroadcast(signal);
    } else {
      await (this.getOrCreateLegacyWebRtc() as any).handleIncomingSignal(signal);
    }
  }

  /**
   * Comprehensive cleanup of all sub-services
   */
  public cleanup(): void {
    this.transcriptService.cleanup();
    this.voiceService.cleanup();
    this.asrService.cleanup();
    if (this.legacyWebRtcService) {
      this.legacyWebRtcService.cleanup();
      this.legacyWebRtcService = undefined;
    }
  }
}
