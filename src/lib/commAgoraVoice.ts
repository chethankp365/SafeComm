/**
 * SafeComm — Dedicated Agora RTC Voice Transport Service
 * 
 * Replaces custom WebRTC with Agora SD-RTN for reliable two-way voice streaming.
 * Preserves exact SafeComm UI controls, Push-To-Talk, mute, autoplay resolution,
 * and station role authorization.
 */

import type {
  IAgoraRTCClient,
  IMicrophoneAudioTrack,
  IRemoteAudioTrack,
  IAgoraRTCRemoteUser,
} from 'agora-rtc-sdk-ng';
import { supabase } from './supabase';
import type { CommRole } from './commRooms';
import { playRadioTone } from './speechAudio';

export type VoiceConnectionStatus =
  | 'standby'
  | 'requesting_mic'
  | 'no_mic'
  | 'mic_blocked'
  | 'connecting'
  | 'connected'
  | 'audio_blocked'
  | 'reconnecting'
  | 'disconnected';

export interface AgoraVoiceCallbacks {
  onStatusChange: (status: VoiceConnectionStatus, message?: string) => void;
  onRemoteTrackReceived: (hasTrack: boolean) => void;
  onAudioBlocked: (blocked: boolean) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onSignalingStatus?: (state: string) => void;
  onPeerAudioState?: (state: { isMuted: boolean; isTransmitting: boolean; isOnline: boolean }) => void;
  onRemoteAudioActive?: (isActive: boolean) => void;
  onSessionEnded?: () => void;
}

export interface AgoraTokenPayload {
  appId: string;
  channel: string;
  uid: number;
  token: string;
  role: CommRole;
  expiresAt: number;
}

export async function formatAgoraTokenRequestError(error: unknown): Promise<string> {
  if (!(error instanceof Error)) return 'Token request failed with an unknown error.';

  const context = (error as Error & { context?: unknown }).context;
  if (context instanceof Response) {
    let detail = '';
    try {
      const payload: unknown = await context.clone().json();
      if (payload && typeof payload === 'object') {
        const body = payload as { error?: unknown; message?: unknown; code?: unknown };
        const message = typeof body.error === 'string'
          ? body.error
          : typeof body.message === 'string'
            ? body.message
            : '';
        const code = typeof body.code === 'string' ? ` (${body.code})` : '';
        detail = message ? `${message}${code}` : '';
      }
    } catch {
      // A non-JSON gateway response is still reported by status below.
    }

    return detail
      ? `Agora token request failed (HTTP ${context.status}): ${detail}`
      : `Agora token request failed (HTTP ${context.status}): ${error.message}`;
  }

  return error.message;
}

interface PresenceBroadcastPayload {
  roomId: string;
  fromClientId: string;
  fromRole: CommRole;
  type: 'ready' | 'peer-state' | 'session-ended';
  peerState?: { isMuted?: boolean; isTransmitting?: boolean; isOnline?: boolean };
}

export class AgoraVoiceService {
  private roomId: string;
  private role: CommRole;
  private callbacks: AgoraVoiceCallbacks;
  private clientId: string;

  private client: IAgoraRTCClient | null = null;
  private localAudioTrack: IMicrophoneAudioTrack | null = null;
  private localAudioPublished = false;
  private remoteAudioTrack: IRemoteAudioTrack | null = null;

  private status: VoiceConnectionStatus = 'standby';
  private isMuted = false;
  private isTransmitting = false;
  private pttLocked = false;
  private isAudioBlocked = false;
  private hasRemoteTrack = false;
  private isCleanedUp = false;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private microphoneControlQueue: Promise<void> = Promise.resolve();
  private tokenRequestError: string | null = null;

  private debugEnabled = typeof window !== 'undefined' && (
    (typeof window.location?.search === 'string' && new URLSearchParams(window.location.search).get('audioDebug') === '1') ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('safecomm_debug_audio') === '1') ||
    (typeof import.meta !== 'undefined' && Boolean((import.meta as any).env?.DEV))
  );
  private subscribedUids = new Set<string | number>();
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  private supabaseChannel: ReturnType<typeof supabase.channel> | null = null;
  private broadcastChannel: BroadcastChannel | null = null;
  private isSubscribed = false;

  constructor(roomId: string, role: CommRole, callbacks: AgoraVoiceCallbacks) {
    this.roomId = roomId;
    this.role = role;
    this.callbacks = callbacks;
    this.clientId = Math.random().toString(36).substring(2, 10);
  }

  /**
   * Initializes Agora RTC client, acquires token from Edge Function,
   * configures microphone, and joins the canonical room channel.
   */
  public initialize(): Promise<void> {
    if (this.isCleanedUp || this.isInitialized) return Promise.resolve();
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = this.initializeOnce().finally(() => {
      this.isInitialized = this.client !== null &&
        this.localAudioTrack !== null &&
        this.localAudioPublished;
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  private async initializeOnce(): Promise<void> {
    this.setupPresenceChannels();

    // In non-browser / test environments without navigator
    if (typeof navigator === 'undefined') {
      this.updateStatus('standby', 'Audio transport initialized in test mode');
      return;
    }

    try {
      // 1. Request microphone permission and acquire local track
      await this.acquireMicrophone();

      if (this.isCleanedUp) {
        this.releaseLocalAudioTrack();
        return;
      }

      // Do not join and report a live link when local audio capture failed.
      if (!this.localAudioTrack) {
        return;
      }

      this.updateStatus('connecting', 'Authenticating with Agora RTC frequency...');

      // 2. Fetch short-lived Agora RTC token from Supabase Edge Function
      const tokenData = await this.fetchAgoraToken();

      if (!tokenData || !tokenData.token || !tokenData.appId) {
        this.releaseLocalAudioTrack();
        this.updateStatus(
          'standby',
          this.tokenRequestError
            ? `Agora token request failed: ${this.tokenRequestError}`
            : 'Agora token request failed. Check the Edge Function configuration.'
        );
        return;
      }
      if (
        tokenData.channel !== this.roomId ||
        !Number.isSafeInteger(tokenData.uid) ||
        tokenData.uid <= 0 ||
        tokenData.role !== this.role ||
        !Number.isFinite(tokenData.expiresAt) ||
        tokenData.expiresAt <= Date.now()
      ) {
        this.releaseLocalAudioTrack();
        this.updateStatus('standby', 'Agora token response did not match this room or participant.');
        if (this.debugEnabled) {
          console.error('[SafeComm/Audio] Rejected invalid Agora token metadata', {
            channelMatchesRoom: tokenData.channel === this.roomId,
            uidIsValid: Number.isSafeInteger(tokenData.uid) && tokenData.uid > 0,
            roleMatchesStation: tokenData.role === this.role,
            expiresAtIsValid: Number.isFinite(tokenData.expiresAt) && tokenData.expiresAt > Date.now(),
          });
        }
        return;
      }

      // 3. Create Agora RTC Client dynamically in browser
      const AgoraRTCModule = await import('agora-rtc-sdk-ng');
      const AgoraRTC = AgoraRTCModule.default || AgoraRTCModule;
      AgoraRTC.setLogLevel(this.debugEnabled ? 1 : 3);

      AgoraRTC.onAutoplayFailed = () => {
        if (this.debugEnabled) {
          console.warn('[SafeComm/Audio] AgoraRTC.onAutoplayFailed triggered');
        }
        this.isAudioBlocked = true;
        this.callbacks.onAudioBlocked(true);
        this.updateStatus('audio_blocked', 'Incoming radio audio ready. Tap to listen.');
      };

      this.client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

      // Handle remote incoming audio tracks
      this.client.on('user-published', async (user, mediaType) => {
        if (this.isCleanedUp || !this.client) return;
        if (this.debugEnabled) {
          console.log(`[SafeComm/Audio] user-published: uid=${user.uid}, mediaType=${mediaType}`);
        }
        if (mediaType === 'audio') {
          await this.subscribeRemoteAudio(user);
        }
      });

      this.client.on('user-unpublished', (user, mediaType) => {
        if (this.debugEnabled) {
          console.log(`[SafeComm/Audio] user-unpublished: uid=${user.uid}, mediaType=${mediaType}`);
        }
        if (mediaType === 'audio') {
          this.subscribedUids.delete(user.uid);
          this.hasRemoteTrack = false;
          this.remoteAudioTrack = null;
          this.callbacks.onRemoteTrackReceived(false);
          this.callbacks.onPeerAudioState?.({ isMuted: false, isTransmitting: false, isOnline: true });
          this.callbacks.onRemoteAudioActive?.(false);
        }
      });

      this.client.on('user-joined', (user) => {
        if (this.debugEnabled) {
          console.log(`[SafeComm/Audio] user-joined: uid=${user.uid}`);
        }
        this.callbacks.onPeerAudioState?.({ isMuted: false, isTransmitting: false, isOnline: true });
      });

      this.client.on('user-left', (user, reason) => {
        if (this.debugEnabled) {
          console.log(`[SafeComm/Audio] user-left: uid=${user.uid}, reason=${reason}`);
        }
        this.subscribedUids.delete(user.uid);
        this.hasRemoteTrack = false;
        this.callbacks.onRemoteTrackReceived(false);
        this.callbacks.onRemoteAudioActive?.(false);
        this.callbacks.onPeerAudioState?.({ isMuted: true, isTransmitting: false, isOnline: false });
      });

      this.client.on('connection-state-change', (curState, prevState, reason) => {
        if (this.debugEnabled) {
          console.log(`[SafeComm/Audio] connection-state-change: ${prevState} -> ${curState} (reason: ${reason || 'normal'})`);
        }
        if (reason === 'UID_CONFLICT') {
          this.updateStatus('disconnected', 'UID conflict: This station identity is active in another tab. Please close other session.');
          return;
        }

        if (curState === 'CONNECTED') {
          this.callbacks.onSignalingStatus?.('connected');
          if (!this.isAudioBlocked) {
            this.updateStatus('connected', 'Aeronautical radio frequency active (Agora)');
          }
        } else if (curState === 'CONNECTING') {
          this.callbacks.onSignalingStatus?.('connecting');
          this.updateStatus('connecting', 'Negotiating Agora aeronautical radio frequency...');
        } else if (curState === 'RECONNECTING') {
          this.callbacks.onSignalingStatus?.('reconnecting');
          this.updateStatus('reconnecting', 'Radio link interrupted. Reconnecting...');
        } else if (curState === 'DISCONNECTED') {
          this.callbacks.onSignalingStatus?.('disconnected');
          this.updateStatus('disconnected', 'Radio connection disconnected');
        }
      });

      // Token renewal before expiration
      this.client.on('token-privilege-will-expire', () => {
        if (this.debugEnabled) {
          console.log('[SafeComm/Audio] token-privilege-will-expire received, renewing...');
        }
        void (async () => {
          try {
            const refreshed = await this.fetchAgoraToken();
            if (refreshed?.token && this.client) {
              await this.client.renewToken(refreshed.token);
              if (this.debugEnabled) {
                console.log('[SafeComm/Audio] Token successfully renewed');
              }
            } else if (this.debugEnabled) {
              console.error('[SafeComm/Audio] Token renewal failed; no valid token was returned.');
            }
          } catch (err) {
            if (this.debugEnabled) {
              console.error('[SafeComm/Audio] Token renewal failed:', err);
            }
          }
        })();
      });

      // 4. Join the canonical room channel
      if (this.debugEnabled) {
        console.log('[SafeComm/Audio] Joining Agora channel...', {
          channel: tokenData.channel,
          uid: tokenData.uid,
          appId: tokenData.appId,
        });
      }

      await this.client.join(
        tokenData.appId,
        tokenData.channel,
        tokenData.token,
        tokenData.uid
      );

      if (this.isCleanedUp || !this.client) return;
      if (this.debugEnabled) {
        console.log('[SafeComm/Audio] Agora channel join succeeded', {
          channel: tokenData.channel,
          uid: tokenData.uid,
        });
      }

      if (this.debugEnabled) {
        console.log('[SafeComm/Audio] Channel joined successfully. Subscribing to existing remote users in channel:', this.client.remoteUsers.length);
      }

      // CRITICAL: Subscribe to any peers who were ALREADY in the channel before we joined!
      for (const remoteUser of this.client.remoteUsers) {
        if (remoteUser.hasAudio) {
          await this.subscribeRemoteAudio(remoteUser);
        }
      }

      // 5. Publish local microphone track if available
      if (this.localAudioTrack) {
        if (this.localAudioTrack.enabled === false) {
          throw new Error('Agora microphone track is disabled before publish; refusing to publish.');
        }
        await this.client.publish([this.localAudioTrack]);
        if (this.isCleanedUp) return;
        this.localAudioPublished = true;
        if (this.debugEnabled) {
          console.log('[SafeComm/Audio] Local microphone publication succeeded in muted PTT standby');
        }
      }

      // 6. Enable real-time audio volume indicator
      this.client.enableAudioVolumeIndicator();
      this.client.on('volume-indicator', (volumes) => {
        const remoteSpeaker = volumes.find((v) => v.uid !== tokenData.uid && v.level > 5);
        if (remoteSpeaker) {
          this.callbacks.onRemoteAudioActive?.(true);
          if (this.silenceTimer) clearTimeout(this.silenceTimer);
          this.silenceTimer = setTimeout(() => {
            this.callbacks.onRemoteAudioActive?.(false);
          }, 1200);
        }
      });

      // 7. Periodic telemetry sampling when debugging
      if (this.debugEnabled) {
        this.statsInterval = setInterval(() => {
          if (this.client && (this.isTransmitting || this.hasRemoteTrack)) {
            try {
              const rtc = this.client.getRTCStats();
              const remote = this.client.getRemoteAudioStats();
              console.log('[SafeComm/Audio] Telemetry Sample:', {
                sendBitrate: rtc.SendBitrate,
                recvBitrate: rtc.RecvBitrate,
                remoteTrackCount: Object.keys(remote).length,
              });
            } catch {
              // ignore
            }
          }
        }, 2000);
      }

      this.updateStatus('connected', 'Aeronautical radio frequency active (Agora)');
      this.callbacks.onSignalingStatus?.('connected');

      // Announce readiness to peer
      this.broadcastPresence({
        roomId: this.roomId,
        fromClientId: this.clientId,
        fromRole: this.role,
        type: 'ready',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SafeComm/Audio] Agora initialization failed:', err);
      this.releaseRtcResources();
      if (!this.isCleanedUp) this.updateStatus('standby', `Agora voice standby: ${msg}`);
    }
  }

  /**
   * Subscribes to a remote user audio track and handles autoplay restrictions safely
   */
  private async subscribeRemoteAudio(user: IAgoraRTCRemoteUser): Promise<void> {
    if (this.isCleanedUp || !this.client || this.subscribedUids.has(user.uid)) return;

    try {
      this.subscribedUids.add(user.uid);
      await this.client.subscribe(user, 'audio');
      if (this.isCleanedUp) return;
      if (!user.audioTrack) {
        throw new Error(`Agora subscription for uid=${user.uid} completed without an audio track.`);
      }
      this.remoteAudioTrack = user.audioTrack || null;
      this.hasRemoteTrack = true;
      this.callbacks.onRemoteTrackReceived(true);
      this.callbacks.onPeerAudioState?.({ isMuted: false, isTransmitting: false, isOnline: true });

      if (user.audioTrack) {
        try {
          user.audioTrack.play();
          this.isAudioBlocked = false;
          this.callbacks.onAudioBlocked(false);
          this.updateStatus('connected', 'Aeronautical radio frequency active (Agora)');
          if (this.debugEnabled) {
            console.log(`[SafeComm/Audio] Subscribed & playing remote audio for uid=${user.uid}`);
          }
        } catch {
          // Browser Autoplay restriction encountered
          this.isAudioBlocked = true;
          this.callbacks.onAudioBlocked(true);
          this.updateStatus('audio_blocked', 'Incoming radio audio ready. Tap to listen.');
          if (this.debugEnabled) {
            console.warn(`[SafeComm/Audio] Autoplay blocked for uid=${user.uid}. User gesture required.`);
          }
        }
      }
    } catch (err) {
      this.subscribedUids.delete(user.uid);
      if (!this.remoteAudioTrack) {
        this.hasRemoteTrack = false;
        this.callbacks.onRemoteTrackReceived(false);
      }
      console.error(`[SafeComm/Audio] Failed to subscribe to audio for uid=${user.uid}:`, err);
    }
  }

  /**
   * Fetches token securely from Supabase Edge Function
   */
  private async fetchAgoraToken(): Promise<AgoraTokenPayload | null> {
    try {
      if (this.debugEnabled) {
        console.log(`[SafeComm/Audio] Requesting Agora token from Edge Function (roomId: ${this.roomId}, nonce: ${this.clientId})...`);
      }
      const { data, error } = await supabase.functions.invoke('agora-token', {
        body: { roomId: this.roomId, clientNonce: this.clientId },
      });

      if (error || !data || data.error) {
        this.tokenRequestError = error
          ? await formatAgoraTokenRequestError(error)
          : data?.error || 'The token function returned no data.';
        if (this.debugEnabled) {
          console.warn('[SafeComm/Audio] Token request rejected:', this.tokenRequestError);
        }
        return null;
      }

      if (this.debugEnabled) {
        console.log('[SafeComm/Audio] Token 200 response received:', {
          appId: data.appId,
          channel: data.channel,
          uid: data.uid,
          tokenLength: data.token?.length,
          expiresAt: data.expiresAt,
        });
      }

      if (
        typeof data.appId !== 'string' ||
        !data.appId ||
        data.channel !== this.roomId ||
        typeof data.token !== 'string' ||
        !data.token ||
        !Number.isSafeInteger(data.uid) ||
        data.uid <= 0 ||
        data.role !== this.role ||
        (data.role !== 'atc' && data.role !== 'pilot') ||
        !Number.isFinite(data.expiresAt) ||
        data.expiresAt <= Date.now()
      ) {
        this.tokenRequestError = 'The token function returned an invalid response.';
        if (this.debugEnabled) console.error('[SafeComm/Audio] Token response is missing required fields.');
        return null;
      }
      this.tokenRequestError = null;
      if (this.debugEnabled) {
        console.log('[SafeComm/Audio] Agora token request succeeded.');
      }
      return data as AgoraTokenPayload;
    } catch (err) {
      this.tokenRequestError = err instanceof Error ? err.message : String(err);
      console.error('[SafeComm/Audio] Token request network exception:', err);
      return null;
    }
  }

  /**
   * Acquires local microphone with echo cancellation, noise suppression & AGC
   */
  private async acquireMicrophone(): Promise<void> {
    this.updateStatus('requesting_mic', 'Requesting microphone access...');

    try {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        // In test environments (mocked getUserMedia), verify permission rejection / no device
        const isTestEnv = typeof (globalThis as any).process !== 'undefined' && (globalThis as any).process?.env?.NODE_ENV === 'test';
        if (isTestEnv) {
          const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
          probe?.getTracks?.().forEach((t) => t.stop());
        }

        if (typeof window !== 'undefined') {
          const AgoraRTCModule = await import('agora-rtc-sdk-ng');
          const AgoraRTC = AgoraRTCModule.default || AgoraRTCModule;
          this.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            ANS: true,
            AEC: true,
            AGC: true,
          });
          // Mute before publishing; Agora cannot publish a disabled track.
          await this.localAudioTrack.setMuted(true);
          if (this.debugEnabled) {
            console.log('[SafeComm/Audio] Local microphone track acquired and muted for PTT standby');
          }
        }
      } else {
        this.updateStatus('no_mic', 'Microphone not supported in this environment');
      }
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      console.error('[SafeComm/Audio] Microphone acquisition failed:', err);
      this.releaseLocalAudioTrack();
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        this.updateStatus('mic_blocked', 'Microphone blocked. Please grant microphone access in browser settings.');
      } else if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
        this.updateStatus('no_mic', 'No microphone detected on your system.');
      } else {
        this.updateStatus('standby', `Audio input inactive: ${error?.message || 'Device error'}`);
      }
    }
  }

  /**
   * Set up lightweight Supabase Realtime channel for peer presence & state indicators
   */
  private setupPresenceChannels(): void {
    const channelName = `comm_presence_${this.roomId}`;

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
        .on('broadcast', { event: 'presence_signal' }, ({ payload }) => {
          this.handleIncomingPresence(payload as PresenceBroadcastPayload);
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            this.isSubscribed = true;
            this.broadcastPresence({
              roomId: this.roomId,
              fromClientId: this.clientId,
              fromRole: this.role,
              type: 'ready',
            });
          }
        });
    } catch {
      // ignore
    }

    // 2. BroadcastChannel for same-browser cross-tab delivery
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.broadcastChannel = new BroadcastChannel(`safecomm_presence_${this.roomId}`);
        this.broadcastChannel.onmessage = (event) => {
          this.handleIncomingPresence(event.data as PresenceBroadcastPayload);
        };
      }
    } catch {
      // ignore
    }
  }

  private broadcastPresence(payload: PresenceBroadcastPayload): void {
    if (this.isCleanedUp) return;

    if (this.supabaseChannel && this.isSubscribed) {
      this.supabaseChannel.send({
        type: 'broadcast',
        event: 'presence_signal',
        payload,
      }).catch(() => {});
    }

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage(payload);
      } catch {
        // ignore
      }
    }
  }

  private handleIncomingPresence(signal: PresenceBroadcastPayload): void {
    if (!signal || signal.roomId !== this.roomId || this.isCleanedUp) return;
    if (signal.fromClientId === this.clientId) return;

    switch (signal.type) {
      case 'ready': {
        this.callbacks.onPeerAudioState?.({
          isMuted: false,
          isTransmitting: false,
          isOnline: true,
        });
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
        this.callbacks.onSessionEnded?.();
        break;
      }
    }
  }

  /**
   * Resumes remote audio playback upon user tap / interaction
   */
  public async resumeAudio(): Promise<boolean> {
    if (this.remoteAudioTrack) {
      try {
        this.remoteAudioTrack.play();
        this.isAudioBlocked = false;
        this.callbacks.onAudioBlocked(false);
        if (this.status === 'audio_blocked') {
          this.updateStatus('connected', 'Aeronautical radio frequency active (Agora)');
        }
        return true;
      } catch (err) {
        if (this.debugEnabled) {
          console.warn('[SafeComm/Audio] Remote audio playback failed after user interaction:', err);
        }
        this.isAudioBlocked = true;
        this.callbacks.onAudioBlocked(true);
        this.updateStatus('audio_blocked', 'Incoming radio audio could not start. Tap to retry.');
        return false;
      }
    }
    return false;
  }

  /**
   * Push-to-Talk (PTT): Controls OUTGOING audio track only.
   * NEVER mutes or interrupts incoming remote audio!
   */
  public startPTT(): boolean {
    if (this.isMuted) return false;
    if (!this.canTransmit()) {
      this.isTransmitting = false;
      this.updateStatus('standby', 'Microphone is not connected and published yet; voice transmission is unavailable.');
      return false;
    }
    this.isTransmitting = true;
    void this.setLocalAudioMuted(false, 'transmit');

    if (this.isAudioBlocked) {
      this.resumeBlockedAudio('push-to-talk');
    }

    try { playRadioTone('mic_click'); } catch { /* ignore */ }

    this.broadcastPresence({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'peer-state',
      peerState: { isTransmitting: true },
    });
    return true;
  }

  public stopPTT(): void {
    if (this.pttLocked) return;
    this.isTransmitting = false;
    void this.setLocalAudioMuted(true, 'stop transmitting');

    try { playRadioTone('mic_click'); } catch { /* ignore */ }

    this.broadcastPresence({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'peer-state',
      peerState: { isTransmitting: false },
    });
  }

  public togglePTTLock(): boolean {
    if (!this.pttLocked && !this.canTransmit()) {
      this.updateStatus('standby', 'Microphone is not connected and published yet; open-mic transmission is unavailable.');
      return false;
    }
    this.pttLocked = !this.pttLocked;
    if (this.pttLocked) {
      this.isTransmitting = !this.isMuted;
      void this.setLocalAudioMuted(this.isMuted, 'open microphone');
      try { playRadioTone('mic_click'); } catch { /* ignore */ }
    } else {
      this.isTransmitting = false;
      void this.setLocalAudioMuted(true, 'lock microphone');
    }

    if (this.isAudioBlocked) {
      this.resumeBlockedAudio('open-microphone toggle');
    }

    this.broadcastPresence({
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
      this.isTransmitting = false;
      void this.setLocalAudioMuted(true, 'mute microphone');
    } else if (this.pttLocked) {
      this.isTransmitting = true;
      void this.setLocalAudioMuted(false, 'unmute microphone');
    }

    if (this.isAudioBlocked) {
      this.resumeBlockedAudio('microphone mute toggle');
    }

    this.broadcastPresence({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'peer-state',
      peerState: { isMuted: this.isMuted, isTransmitting: this.isTransmitting },
    });

    return this.isMuted;
  }

  private updateStatus(newStatus: VoiceConnectionStatus, message?: string): void {
    this.status = newStatus;
    this.callbacks.onStatusChange(newStatus, message);
  }

  private resumeBlockedAudio(trigger: string): void {
    void this.resumeAudio()
      .then((resumed) => {
        if (!resumed && this.debugEnabled) {
          console.warn(`[SafeComm/Audio] Remote playback was not resumed after ${trigger}; no remote audio track is available.`);
        }
      })
      .catch((error) => {
        console.error(`[SafeComm/Audio] Unexpected remote playback recovery failure after ${trigger}:`, error);
      });
  }

  private setLocalAudioMuted(muted: boolean, operation: string): Promise<void> {
    const track = this.localAudioTrack;
    if (!track) {
      if (this.debugEnabled) {
        console.error(`[SafeComm/Audio] Cannot ${operation}: microphone track is unavailable.`);
      }
      return Promise.resolve();
    }

    const update = this.microphoneControlQueue.then(async () => {
      if (this.localAudioTrack !== track || this.isCleanedUp) return;
      await track.setMuted(muted);
      if (this.debugEnabled) {
        console.log(`[SafeComm/Audio] Microphone track ${muted ? 'muted' : 'unmuted'} (${operation}).`);
      }
    });
    this.microphoneControlQueue = update.catch(async (err: unknown) => {
      console.error(`[SafeComm/Audio] Failed to ${operation}:`, err);
      if (!this.isCleanedUp) {
        this.isMuted = true;
        this.isTransmitting = false;
        this.pttLocked = false;
        try {
          await this.client?.unpublish(track);
        } catch (unpublishError) {
          console.error('[SafeComm/Audio] Failed to unpublish the microphone after a control error:', unpublishError);
        }
        this.isInitialized = false;
        this.releaseRtcResources();
        this.updateStatus('standby', `Microphone control failed during ${operation}; local audio disabled for safety.`);
        this.broadcastPresence({
          roomId: this.roomId,
          fromClientId: this.clientId,
          fromRole: this.role,
          type: 'peer-state',
          peerState: { isMuted: true, isTransmitting: false },
        });
      }
    });
    return this.microphoneControlQueue;
  }

  private releaseLocalAudioTrack(): void {
    this.localAudioPublished = false;
    if (!this.localAudioTrack) return;
    try {
      this.localAudioTrack.stop();
      this.localAudioTrack.close();
    } catch (err) {
      if (this.debugEnabled) console.warn('[SafeComm/Audio] Failed to release microphone track:', err);
    }
    this.localAudioTrack = null;
  }

  private releaseRtcResources(): void {
    this.releaseLocalAudioTrack();
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      client.removeAllListeners();
      void client.leave().catch((err: unknown) => {
        if (this.debugEnabled) console.warn('[SafeComm/Audio] Failed to leave Agora channel after error:', err);
      });
    } catch (err) {
      if (this.debugEnabled) console.warn('[SafeComm/Audio] Failed to release Agora client:', err);
    }
  }

  public broadcastSessionEnded(): void {
    this.broadcastPresence({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'session-ended',
    });
  }

  public getStatus(): VoiceConnectionStatus {
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

  public getHasRemoteTrack(): boolean {
    return this.hasRemoteTrack;
  }

  public canTransmit(): boolean {
    return !this.isCleanedUp &&
      this.client !== null &&
      this.localAudioTrack !== null &&
      this.localAudioPublished;
  }

  public getLocalAudioStream(): MediaStream | null {
    if (!this.localAudioTrack || typeof MediaStream === 'undefined') return null;
    return new MediaStream([this.localAudioTrack.getMediaStreamTrack()]);
  }

  public setRole(role: CommRole): void {
    this.role = role;
  }

  public setRoomId(newRoomId: string): void {
    if (!newRoomId || this.roomId === newRoomId) return;
    this.roomId = newRoomId;
    this.setupPresenceChannels();
  }

  public cleanup(): void {
    this.isCleanedUp = true;

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    this.subscribedUids.clear();

    this.releaseRtcResources();

    if (this.supabaseChannel) {
      try { supabase.removeChannel(this.supabaseChannel); } catch { /* ignore */ }
      this.supabaseChannel = null;
    }

    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch { /* ignore */ }
      this.broadcastChannel = null;
    }

    this.updateStatus('disconnected', 'Agora radio connection closed');
  }
}
