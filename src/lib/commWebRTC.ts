/**
 * SafeComm — Dedicated WebRTC Voice Service
 * 
 * Manages live bidirectional microphone audio communication between ATC and Pilot.
 * Decoupled from transcript synchronization and speech recognition.
 */

import { supabase } from './supabase';
import type { CommRole } from './commRooms';
import { playRadioTone } from './speechAudio';

export type WebRTCConnectionStatus =
  | 'standby'
  | 'requesting_mic'
  | 'no_mic'
  | 'mic_blocked'
  | 'connecting'
  | 'connected'
  | 'audio_blocked'
  | 'reconnecting'
  | 'disconnected';

export interface WebRTCVoiceCallbacks {
  onStatusChange: (status: WebRTCConnectionStatus, message?: string) => void;
  onRemoteTrackReceived: (hasTrack: boolean) => void;
  onAudioBlocked: (blocked: boolean) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onSignalingStatus?: (state: string) => void;
  onPeerAudioState?: (state: { isMuted: boolean; isTransmitting: boolean; isOnline: boolean }) => void;
  onSessionEnded?: () => void;
}

export interface WebRTCSignalPayload {
  roomId: string;
  fromClientId: string;
  fromRole: CommRole;
  type: 'ready' | 'offer' | 'answer' | 'ice-candidate' | 'peer-state' | 'session-ended';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  peerState?: { isMuted?: boolean; isTransmitting?: boolean; isOnline?: boolean };
}

const STUN_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
};

export class WebRTCVoiceService {
  private roomId: string;
  private role: CommRole;
  private callbacks: WebRTCVoiceCallbacks;
  private clientId: string;

  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteAudioElement: HTMLAudioElement | null = null;

  private supabaseChannel: ReturnType<typeof supabase.channel> | null = null;
  private broadcastChannel: BroadcastChannel | null = null;

  private status: WebRTCConnectionStatus = 'standby';
  private isMuted = false;
  private isTransmitting = false;
  private pttLocked = false;
  private isAudioBlocked = false;
  private hasRemoteTrack = false;
  private isSubscribed = false;
  private isCleanedUp = false;

  private makingOffer = false;
  private ignoreOffer = false;
  private iceCandidatesQueue: RTCIceCandidateInit[] = [];
  private fallbackOfferTimeout: ReturnType<typeof setTimeout> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(roomId: string, role: CommRole, callbacks: WebRTCVoiceCallbacks) {
    this.roomId = roomId;
    this.role = role;
    this.callbacks = callbacks;
    this.clientId = Math.random().toString(36).substring(2, 10);
  }

  /**
   * Initializes microphone capture, peer connection, and signaling
   */
  public async initialize(): Promise<void> {
    if (this.isCleanedUp) return;
    this.updateStatus('requesting_mic', 'Requesting microphone access...');

    // 1. Setup DOM remote audio playback element
    this.setupAudioElement();

    // 2. Request user microphone
    await this.acquireMicrophone();

    // 3. Setup RTCPeerConnection
    this.setupPeerConnection();

    // 4. Setup signaling channels
    this.setupSignaling();
  }

  private setupAudioElement(): void {
    if (typeof document === 'undefined') return;
    let audio = document.getElementById(`safecomm_remote_audio_${this.roomId}`) as HTMLAudioElement | null;
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `safecomm_remote_audio_${this.roomId}`;
      audio.autoplay = true;
      (audio as any).playsInline = true;
      audio.setAttribute('playsinline', 'true');
      audio.setAttribute('autoplay', 'true');
      audio.style.position = 'fixed';
      audio.style.top = '-9999px';
      audio.style.opacity = '0';
      audio.style.pointerEvents = 'none';
      document.body.appendChild(audio);
    }
    this.remoteAudioElement = audio;
    this.remoteAudioElement.muted = false;
    this.remoteAudioElement.volume = 1.0;
  }

  private async acquireMicrophone(): Promise<void> {
    try {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });

        // Local track starts disabled until Push-To-Talk is pressed
        this.setLocalTrackEnabled(false);
      } else {
        this.updateStatus('no_mic', 'Microphone not supported in this environment');
      }
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        this.updateStatus('mic_blocked', 'Microphone blocked. Please grant microphone access in browser settings.');
      } else if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
        this.updateStatus('no_mic', 'No microphone detected on your system.');
      } else {
        this.updateStatus('standby', 'Audio input inactive');
      }
    }
  }

  private setupPeerConnection(): void {
    if (typeof RTCPeerConnection === 'undefined' || this.isCleanedUp) return;

    try {
      this.pc = new RTCPeerConnection(STUN_SERVERS);

      // Add local audio track
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach((track) => {
          this.pc?.addTrack(track, this.localStream!);
        });
      } else {
        try {
          this.pc.addTransceiver('audio', { direction: 'sendrecv' });
        } catch {
          // ignore
        }
      }

      // Handle remote audio track arrival
      this.pc.ontrack = (event) => {
        const stream = (event.streams && event.streams[0]) || new MediaStream([event.track]);
        this.remoteStream = stream;
        this.hasRemoteTrack = true;
        this.callbacks.onRemoteTrackReceived(true);
        this.callbacks.onRemoteStream?.(stream);

        if (this.remoteAudioElement) {
          this.remoteAudioElement.srcObject = stream;
          this.remoteAudioElement.muted = false;
          this.remoteAudioElement.volume = 1.0;
          this.remoteAudioElement
            .play()
            .then(() => {
              this.isAudioBlocked = false;
              this.callbacks.onAudioBlocked(false);
              this.updateStatus('connected', 'Peer-to-peer radio active');
            })
            .catch(() => {
              this.isAudioBlocked = true;
              this.callbacks.onAudioBlocked(true);
              this.updateStatus('audio_blocked', 'Incoming radio audio ready. Tap to listen.');
            });
        }

        event.track.onunmute = () => {
          if (this.remoteAudioElement && this.remoteAudioElement.paused) {
            this.remoteAudioElement.play().catch(() => {
              this.isAudioBlocked = true;
              this.callbacks.onAudioBlocked(true);
            });
          }
        };
      };

      // Handle local ICE candidates
      this.pc.onicecandidate = ({ candidate }) => {
        if (candidate && candidate.candidate) {
          this.broadcastSignal({
            roomId: this.roomId,
            fromClientId: this.clientId,
            fromRole: this.role,
            type: 'ice-candidate',
            candidate: candidate.toJSON ? candidate.toJSON() : {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
            },
          });
        }
      };

      // Handle ICE Connection State Changes
      this.pc.oniceconnectionstatechange = () => {
        if (!this.pc) return;
        const iceState = this.pc.iceConnectionState;
        if (iceState === 'connected' || iceState === 'completed') {
          this.callbacks.onSignalingStatus?.('connected');
          if (this.isAudioBlocked) {
            this.updateStatus('audio_blocked', 'Incoming radio audio ready. Tap to listen.');
          } else if (this.hasRemoteTrack) {
            this.updateStatus('connected', 'Peer-to-peer radio active');
          } else {
            this.updateStatus('connected', 'Signaling linked · Standby for audio track');
          }
          this.startRtpStats();
        } else if (iceState === 'checking') {
          this.callbacks.onSignalingStatus?.('connecting');
          this.updateStatus('connecting', 'Negotiating peer audio link...');
        } else if (iceState === 'disconnected') {
          this.callbacks.onSignalingStatus?.('reconnecting');
          this.updateStatus('reconnecting', 'Peer audio link interrupted. Reconnecting...');
        } else if (iceState === 'failed') {
          this.callbacks.onSignalingStatus?.('reconnecting');
          this.updateStatus('reconnecting', 'ICE connection failed. Restarting ICE...');
          try {
            this.pc.restartIce();
            if (this.role === 'atc') this.initiateOffer(true);
          } catch {
            // ignore
          }
        } else if (iceState === 'closed') {
          this.callbacks.onSignalingStatus?.('disconnected');
          this.updateStatus('disconnected', 'Radio connection closed');
        }
      };

      // Handle Connection State
      this.pc.onconnectionstatechange = () => {
        if (!this.pc) return;
        const connState = this.pc.connectionState;
        if (connState === 'connected') {
          this.callbacks.onSignalingStatus?.('connected');
          if (this.hasRemoteTrack && !this.isAudioBlocked) {
            this.updateStatus('connected', 'Peer-to-peer radio active');
          }
          this.startRtpStats();
        } else if (connState === 'failed') {
          this.callbacks.onSignalingStatus?.('reconnecting');
        } else if (connState === 'closed' || connState === 'disconnected') {
          this.callbacks.onSignalingStatus?.('disconnected');
        }
      };

      // Only ATC initiates offer on negotiationneeded
      this.pc.onnegotiationneeded = async () => {
        if (this.role === 'atc' && this.isSubscribed) {
          await this.initiateOffer();
        }
      };

      if (this.status !== 'mic_blocked' && this.status !== 'no_mic') {
        this.updateStatus('connecting', 'Awaiting peer radio handshake...');
      }
    } catch {
      this.updateStatus('standby', 'WebRTC peer connection standby');
    }
  }

  private setupSignaling(): void {
    const channelName = `comm_webrtc_${this.roomId}`;

    // Clean old channels
    if (this.supabaseChannel) {
      try { supabase.removeChannel(this.supabaseChannel); } catch { /* ignore */ }
      this.supabaseChannel = null;
    }
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch { /* ignore */ }
      this.broadcastChannel = null;
    }

    this.isSubscribed = false;

    // 1. Supabase Realtime Channel
    try {
      this.supabaseChannel = supabase
        .channel(channelName, { config: { broadcast: { ack: false } } })
        .on('broadcast', { event: 'webrtc_signal' }, ({ payload }) => {
          this.handleIncomingSignal(payload as WebRTCSignalPayload);
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            this.isSubscribed = true;

            // Announce ready
            this.broadcastSignal({
              roomId: this.roomId,
              fromClientId: this.clientId,
              fromRole: this.role,
              type: 'ready',
            });

            this.broadcastSignal({
              roomId: this.roomId,
              fromClientId: this.clientId,
              fromRole: this.role,
              type: 'peer-state',
              peerState: {
                isMuted: this.isMuted,
                isTransmitting: false,
                isOnline: true,
              },
            });
          }
        });
    } catch {
      // ignore
    }

    // 2. BroadcastChannel
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.broadcastChannel = new BroadcastChannel(`safecomm_audio_${this.roomId}`);
        this.broadcastChannel.onmessage = (event) => {
          this.handleIncomingSignal(event.data as WebRTCSignalPayload);
        };

        this.broadcastChannel.postMessage({
          roomId: this.roomId,
          fromClientId: this.clientId,
          fromRole: this.role,
          type: 'ready',
        });
      }
    } catch {
      // ignore
    }
  }

  public async initiateOffer(iceRestart = false): Promise<void> {
    if (!this.pc || this.isCleanedUp) return;
    if (this.pc.signalingState !== 'stable') return;

    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer({ iceRestart });
      if (this.pc.signalingState !== 'stable') return;

      await this.pc.setLocalDescription(offer);
      this.broadcastSignal({
        roomId: this.roomId,
        fromClientId: this.clientId,
        fromRole: this.role,
        type: 'offer',
        sdp: this.pc.localDescription ? {
          type: this.pc.localDescription.type,
          sdp: this.pc.localDescription.sdp,
        } : undefined,
      });
    } finally {
      this.makingOffer = false;
    }
  }

  private broadcastSignal(payload: WebRTCSignalPayload): void {
    if (this.isCleanedUp) return;

    // 1. Supabase Realtime
    try {
      if (this.supabaseChannel && this.isSubscribed) {
        this.supabaseChannel.send({
          type: 'broadcast',
          event: 'webrtc_signal',
          payload,
        }).catch(() => {});
      }
    } catch {
      // ignore
    }

    // 2. BroadcastChannel
    try {
      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage(payload);
      }
    } catch {
      // ignore
    }
  }

  private async handleIncomingSignal(signal: WebRTCSignalPayload): Promise<void> {
    if (!signal || signal.roomId !== this.roomId || this.isCleanedUp) return;
    if (signal.fromClientId === this.clientId) return;

    const isPolite = this.role === 'pilot';

    try {
      switch (signal.type) {
        case 'ready': {
          this.callbacks.onPeerAudioState?.({
            isMuted: false,
            isTransmitting: false,
            isOnline: true,
          });

          // ATC initiates offer upon receiving ready signal
          if (this.role === 'atc' && this.pc && this.pc.iceConnectionState !== 'connected' && !this.makingOffer) {
            await this.initiateOffer();
          } else if (this.role === 'pilot') {
            if (!this.pc || this.pc.iceConnectionState !== 'connected') {
              if (this.fallbackOfferTimeout) clearTimeout(this.fallbackOfferTimeout);
              this.fallbackOfferTimeout = setTimeout(() => {
                if (this.pc && this.pc.iceConnectionState !== 'connected' && !this.makingOffer && this.pc.signalingState === 'stable') {
                  this.initiateOffer();
                }
              }, 3000);
            }
          }
          break;
        }

        case 'offer': {
          if (!signal.sdp || !this.pc) return;
          const offerCollision = this.makingOffer || this.pc.signalingState !== 'stable';
          this.ignoreOffer = !isPolite && offerCollision;
          if (this.ignoreOffer) return;

          if (offerCollision) {
            await this.pc.setLocalDescription({ type: 'rollback' });
          }

          const remoteDesc = typeof RTCSessionDescription !== 'undefined'
            ? new RTCSessionDescription(signal.sdp)
            : (signal.sdp as RTCSessionDescriptionInit);
          await this.pc.setRemoteDescription(remoteDesc);
          await this.drainIceCandidates();

          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.broadcastSignal({
            roomId: this.roomId,
            fromClientId: this.clientId,
            fromRole: this.role,
            type: 'answer',
            sdp: this.pc.localDescription ? {
              type: this.pc.localDescription.type,
              sdp: this.pc.localDescription.sdp,
            } : undefined,
          });
          break;
        }

        case 'answer': {
          if (!this.pc) return;
          if (signal.sdp && this.pc.signalingState === 'have-local-offer') {
            const remoteDesc = typeof RTCSessionDescription !== 'undefined'
              ? new RTCSessionDescription(signal.sdp)
              : (signal.sdp as RTCSessionDescriptionInit);
            await this.pc.setRemoteDescription(remoteDesc);
            await this.drainIceCandidates();
          }
          break;
        }

        case 'ice-candidate': {
          if (!this.pc || !signal.candidate) return;
          if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
            try {
              const cand = typeof RTCIceCandidate !== 'undefined'
                ? new RTCIceCandidate(signal.candidate)
                : (signal.candidate as RTCIceCandidateInit);
              await this.pc.addIceCandidate(cand);
            } catch {
              // ignore
            }
          } else {
            this.iceCandidatesQueue.push(signal.candidate);
          }
          break;
        }

        case 'peer-state': {
          if (signal.peerState) {
            this.callbacks.onPeerAudioState?.({
              isMuted: signal.peerState.isMuted ?? false,
              isTransmitting: signal.peerState.isTransmitting ?? false,
              isOnline: signal.peerState.isOnline ?? true,
            });
          }
          break;
        }

        case 'session-ended': {
          if (this.callbacks.onSessionEnded) {
            this.callbacks.onSessionEnded();
          }
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  private async drainIceCandidates(): Promise<void> {
    if (!this.pc) return;
    const candidates = [...this.iceCandidatesQueue];
    this.iceCandidatesQueue = [];
    for (const c of candidates) {
      try {
        const cand = typeof RTCIceCandidate !== 'undefined'
          ? new RTCIceCandidate(c)
          : (c as RTCIceCandidateInit);
        await this.pc.addIceCandidate(cand);
      } catch {
        // ignore
      }
    }
  }

  private startRtpStats(): void {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = setInterval(async () => {
      if (!this.pc || (this.pc.iceConnectionState !== 'connected' && this.pc.connectionState !== 'connected')) return;
      try {
        const stats = await this.pc.getStats();
        let bytesRecv = 0;
        let bytesSent = 0;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            bytesRecv = report.bytesReceived || 0;
          }
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            bytesSent = report.bytesSent || 0;
          }
        });
        if (bytesRecv > 0 || bytesSent > 0) {
          // RTP audio is actively flowing in bidirectional stream
        }
      } catch {
        // ignore
      }
    }, 4000);
  }

  /**
   * Resumes remote audio playback following user interaction / unlock
   */
  public async resumeAudio(): Promise<boolean> {
    if (this.remoteAudioElement && this.remoteStream) {
      try {
        await this.remoteAudioElement.play();
        this.isAudioBlocked = false;
        this.callbacks.onAudioBlocked(false);
        if (this.status === 'audio_blocked') {
          this.updateStatus('connected', 'Peer-to-peer radio active');
        }
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Push-to-Talk (PTT) controls OUTGOING audio only.
   * NEVER mutes or interrupts incoming remote audio!
   */
  public startPTT(): void {
    if (this.isMuted) return;
    this.isTransmitting = true;
    this.setLocalTrackEnabled(true);

    if (this.isAudioBlocked) {
      this.resumeAudio().catch(() => {});
    }

    try { playRadioTone('mic_click'); } catch { /* ignore */ }

    this.broadcastSignal({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'peer-state',
      peerState: { isTransmitting: true },
    });
  }

  public stopPTT(): void {
    if (this.pttLocked) return;
    this.isTransmitting = false;
    this.setLocalTrackEnabled(false);

    try { playRadioTone('mic_click'); } catch { /* ignore */ }

    this.broadcastSignal({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'peer-state',
      peerState: { isTransmitting: false },
    });
  }

  public togglePTTLock(): boolean {
    this.pttLocked = !this.pttLocked;
    if (this.pttLocked) {
      this.isTransmitting = true;
      this.setLocalTrackEnabled(!this.isMuted);
      try { playRadioTone('mic_click'); } catch { /* ignore */ }
    } else {
      this.isTransmitting = false;
      this.setLocalTrackEnabled(false);
    }

    if (this.isAudioBlocked) {
      this.resumeAudio().catch(() => {});
    }

    this.broadcastSignal({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'peer-state',
      peerState: { isTransmitting: this.isTransmitting },
    });

    return this.pttLocked;
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this.setLocalTrackEnabled(false);
    } else if (this.pttLocked || this.isTransmitting) {
      this.setLocalTrackEnabled(true);
    }

    if (this.isAudioBlocked) {
      this.resumeAudio().catch(() => {});
    }

    this.broadcastSignal({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'peer-state',
      peerState: { isMuted: this.isMuted },
    });

    return this.isMuted;
  }

  private setLocalTrackEnabled(enabled: boolean): void {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
    }
  }

  private updateStatus(newStatus: WebRTCConnectionStatus, message?: string): void {
    this.status = newStatus;
    this.callbacks.onStatusChange(newStatus, message);
  }

  public broadcastSessionEnded(): void {
    this.broadcastSignal({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'session-ended',
    });
  }

  public getStatus(): WebRTCConnectionStatus {
    return this.status;
  }

  public getIsMuted(): boolean {
    return this.isMuted;
  }

  public getIsTransmitting(): boolean {
    return this.isTransmitting;
  }

  public getIsPTTLocked(): boolean {
    return this.pttLocked;
  }

  public setRole(role: CommRole): void {
    this.role = role;
  }

  public setRoomId(newRoomId: string): void {
    if (!newRoomId || this.roomId === newRoomId) return;
    this.roomId = newRoomId;
    this.setupSignaling();
  }

  public cleanup(): void {
    this.isCleanedUp = true;
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.fallbackOfferTimeout) clearTimeout(this.fallbackOfferTimeout);

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    if (this.remoteAudioElement) {
      if (typeof this.remoteAudioElement.pause === 'function') {
        this.remoteAudioElement.pause();
      }
      this.remoteAudioElement.srcObject = null;
      if (this.remoteAudioElement.parentNode) {
        this.remoteAudioElement.parentNode.removeChild(this.remoteAudioElement);
      }
      this.remoteAudioElement = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    if (this.supabaseChannel) {
      try { supabase.removeChannel(this.supabaseChannel); } catch { /* ignore */ }
      this.supabaseChannel = null;
    }

    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch { /* ignore */ }
      this.broadcastChannel = null;
    }

    this.updateStatus('disconnected', 'WebRTC connection cleaned up');
  }
}
