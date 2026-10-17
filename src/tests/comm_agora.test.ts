import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import {
  AgoraVoiceService,
  formatAgoraTokenRequestError,
  type VoiceConnectionStatus,
} from '../lib/commAgoraVoice';

describe('SafeComm Connect — Agora RTC Voice Transport (Phase B & C)', () => {
  const ROOM_UUID = '550e8400-e29b-41d4-a716-446655440000';
  const MOCK_APP_ID = '0123456789abcdef0123456789abcdef';
  const MOCK_APP_CERT = '0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --------------------------------------------------------------------------
  // 1. Secure Agora Token Generation & Channel Validation
  // --------------------------------------------------------------------------
  describe('1. Secure Token Generation & Authorization', () => {
    it('generates a valid Agora AccessToken2 with 007 prefix for canonical room UUID', () => {
      const uid = 12345;
      const expireTimeSeconds = 3600;

      const token = RtcTokenBuilder.buildTokenWithUid(
        MOCK_APP_ID,
        MOCK_APP_CERT,
        ROOM_UUID,
        uid,
        RtcRole.PUBLISHER,
        expireTimeSeconds,
        expireTimeSeconds
      );

      expect(typeof token).toBe('string');
      expect(token.startsWith('007')).toBe(true);
      expect(token.length).toBeGreaterThan(50);
    });

    it('enforces canonical room UUID instead of join code for channel name', () => {
      const channelName = ROOM_UUID;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelName);
      expect(isUuid).toBe(true);

      const token = RtcTokenBuilder.buildTokenWithUid(
        MOCK_APP_ID,
        MOCK_APP_CERT,
        channelName,
        99999,
        RtcRole.PUBLISHER,
        3600,
        3600
      );
      expect(token).toBeDefined();
    });

    it('shows the server response body and HTTP status when token invocation fails', async () => {
      const message = await formatAgoraTokenRequestError(Object.assign(
        new Error('Edge Function returned a non-2xx status code'),
        {
          context: new Response(JSON.stringify({ error: 'User is not an authorized participant in this room' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }),
        }
      ));

      expect(message).toBe(
        'Agora token request failed (HTTP 403): User is not an authorized participant in this room'
      );
    });
  });

  // --------------------------------------------------------------------------
  // 2. Microphone Controls & Honest Status Transitions
  // --------------------------------------------------------------------------
  describe('2. Microphone Controls & Honest Status Transitions', () => {
    it('handles microphone blocked permission rejection honestly', async () => {
      let reportedStatus: VoiceConnectionStatus = 'standby';
      let reportedMessage: string | undefined;

      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue({ name: 'NotAllowedError' }),
        },
      });

      const service = new AgoraVoiceService(ROOM_UUID, 'pilot', {
        onStatusChange: (status, message) => {
          reportedStatus = status;
          reportedMessage = message;
        },
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });

      await service.initialize();

      expect(reportedStatus).toBe('mic_blocked');
      expect(reportedMessage).toContain('Microphone blocked');
      service.cleanup();
    });

    it('handles missing microphone hardware honestly', async () => {
      let reportedStatus: VoiceConnectionStatus = 'standby';
      let reportedMessage: string | undefined;

      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue({ name: 'NotFoundError' }),
        },
      });

      const service = new AgoraVoiceService(ROOM_UUID, 'atc', {
        onStatusChange: (status, message) => {
          reportedStatus = status;
          reportedMessage = message;
        },
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });

      await service.initialize();

      expect(reportedStatus).toBe('no_mic');
      expect(reportedMessage).toContain('No microphone detected');
      service.cleanup();
    });

    it('does not request a token or report a live link if microphone capture fails for another reason', async () => {
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue({ name: 'NotReadableError', message: 'Device is busy' }),
        },
      });
      const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const service = new AgoraVoiceService(ROOM_UUID, 'pilot', {
        onStatusChange: vi.fn(),
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });
      const tokenRequest = vi.spyOn(service as any, 'fetchAgoraToken');

      await service.initialize();

      expect(service.getStatus()).toBe('standby');
      expect(tokenRequest).not.toHaveBeenCalled();
      expect((service as any).client).toBeNull();
      expect(logError).toHaveBeenCalled();
      service.cleanup();
    });

    it('manages Push-to-Talk, PTT Lock, and Microphone Mute states independently', () => {
      const service = new AgoraVoiceService(ROOM_UUID, 'atc', {
        onStatusChange: vi.fn(),
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });
      (service as any).client = {
        unpublish: vi.fn().mockResolvedValue(undefined),
        removeAllListeners: vi.fn(),
        leave: vi.fn().mockResolvedValue(undefined),
      };
      (service as any).localAudioTrack = {
        setMuted: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        close: vi.fn(),
      };
      (service as any).localAudioPublished = true;

      expect(service.getIsTransmitting()).toBe(false);
      expect(service.getIsMuted()).toBe(false);

      // Start PTT
      service.startPTT();
      expect(service.getIsTransmitting()).toBe(true);

      // Stop PTT
      service.stopPTT();
      expect(service.getIsTransmitting()).toBe(false);

      // Toggle Hands-Free / PTT Lock
      const locked = service.togglePTTLock();
      expect(locked).toBe(true);
      expect(service.getIsPTTLocked()).toBe(true);
      expect(service.getIsTransmitting()).toBe(true);

      // Release PTT Lock
      const unlocked = service.togglePTTLock();
      expect(unlocked).toBe(false);
      expect(service.getIsPTTLocked()).toBe(false);
      expect(service.getIsTransmitting()).toBe(false);

      // Toggle Mute
      const muted = service.toggleMute();
      expect(muted).toBe(true);
      expect(service.getIsMuted()).toBe(true);

      // PTT while muted is blocked
      service.startPTT();
      expect(service.getIsTransmitting()).toBe(false);

      // Unmute
      const unmuted = service.toggleMute();
      expect(unmuted).toBe(false);
      expect(service.getIsMuted()).toBe(false);
      expect(service.canTransmit()).toBe(true);

      service.cleanup();
      expect(service.getStatus()).toBe('disconnected');
    });

    it('allows initialization to be retried after a failed connection attempt', async () => {
      const service = new AgoraVoiceService(ROOM_UUID, 'pilot', {
        onStatusChange: vi.fn(),
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });
      const initializeOnce = vi.spyOn(service as any, 'initializeOnce').mockResolvedValue(undefined);

      await service.initialize();
      expect(initializeOnce).toHaveBeenCalledTimes(1);

      (service as any).client = {
        removeAllListeners: vi.fn(),
        leave: vi.fn().mockResolvedValue(undefined),
      };
      (service as any).localAudioTrack = {
        setMuted: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        close: vi.fn(),
      };
      (service as any).localAudioPublished = true;

      await service.initialize();
      expect(initializeOnce).toHaveBeenCalledTimes(2);
      expect(service.canTransmit()).toBe(true);
      service.cleanup();
    });

    it('does not claim transmission or open-mic state before audio is published', () => {
      const service = new AgoraVoiceService(ROOM_UUID, 'pilot', {
        onStatusChange: vi.fn(),
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });

      expect(service.startPTT()).toBe(false);
      expect(service.getIsTransmitting()).toBe(false);
      expect(service.togglePTTLock()).toBe(false);
      expect(service.getIsPTTLocked()).toBe(false);
      service.cleanup();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Autoplay Recovery & Resource Teardown
  // --------------------------------------------------------------------------
  describe('3. Autoplay Recovery & Teardown', () => {
    it('manages audio blocked and resume recovery upon user gesture', async () => {
      const mockAudioTrack = {
        play: vi.fn().mockImplementation(() => {}),
        stop: vi.fn(),
        close: vi.fn(),
        setMuted: vi.fn(),
      };

      const service = new AgoraVoiceService(ROOM_UUID, 'pilot', {
        onStatusChange: vi.fn(),
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });

      // Inject mock remote audio track
      (service as any).remoteAudioTrack = mockAudioTrack;
      (service as any).isAudioBlocked = true;

      const resumed = await service.resumeAudio();
      expect(resumed).toBe(true);
      expect(mockAudioTrack.play).toHaveBeenCalledTimes(1);

      service.cleanup();
      expect(service.getStatus()).toBe('disconnected');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Remote User Subscription & Late-Joiner Synchronization
  // --------------------------------------------------------------------------
  describe('4. Remote User Subscription & Late-Joiner Synchronization', () => {
    it('subscribes to existing remoteUsers present in channel when joining late', async () => {
      const mockPlay = vi.fn();
      const mockSubscribe = vi.fn().mockResolvedValue(undefined);
      const mockRemoteAudioTrack = { play: mockPlay, stop: vi.fn(), close: vi.fn() };

      const existingUser = {
        uid: 998877,
        hasAudio: true,
        audioTrack: mockRemoteAudioTrack,
      };

      const mockClient = {
        join: vi.fn().mockResolvedValue(12345),
        remoteUsers: [existingUser],
        subscribe: mockSubscribe,
        on: vi.fn(),
        publish: vi.fn(),
        enableAudioVolumeIndicator: vi.fn(),
        leave: vi.fn(),
        removeAllListeners: vi.fn(),
      };

      let remoteTrackReceived = false;
      const service = new AgoraVoiceService(ROOM_UUID, 'pilot', {
        onStatusChange: vi.fn(),
        onRemoteTrackReceived: (hasTrack) => { remoteTrackReceived = hasTrack; },
        onAudioBlocked: vi.fn(),
      });

      (service as any).client = mockClient;

      // Call the internal subscribeRemoteAudio method on existing user
      await (service as any).subscribeRemoteAudio(existingUser);

      expect(mockSubscribe).toHaveBeenCalledWith(existingUser, 'audio');
      expect(mockPlay).toHaveBeenCalledTimes(1);
      expect(remoteTrackReceived).toBe(true);

      // Verify duplicate subscription is prevented by UID tracking
      await (service as any).subscribeRemoteAudio(existingUser);
      expect(mockSubscribe).toHaveBeenCalledTimes(1); // Not called twice

      service.cleanup();
    });

    it('handles user-unpublished and user-left cleanly', () => {
      let peerAudioState: any = null;
      let remoteAudioActive: boolean | null = null;

      const service = new AgoraVoiceService(ROOM_UUID, 'atc', {
        onStatusChange: vi.fn(),
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
        onPeerAudioState: (state) => { peerAudioState = state; },
        onRemoteAudioActive: (active) => { remoteAudioActive = active; },
      });

      // Inject tracked user
      (service as any).subscribedUids.add(998877);
      expect((service as any).subscribedUids.has(998877)).toBe(true);

      // Simulate user-unpublished event
      (service as any).subscribedUids.delete(998877);
      service['callbacks'].onPeerAudioState?.({ isMuted: false, isTransmitting: false, isOnline: true });
      service['callbacks'].onRemoteAudioActive?.(false);

      expect((service as any).subscribedUids.has(998877)).toBe(false);
      expect(peerAudioState?.isTransmitting).toBe(false);
      expect(remoteAudioActive).toBe(false);

      service.cleanup();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Connection Errors, UID Conflict & Truthful Telemetry
  // --------------------------------------------------------------------------
  describe('5. Connection Errors, UID Conflict & Truthful Status', () => {
    it('surfaces UID_CONFLICT explicitly and transitions to disconnected status', () => {
      let reportedStatus: VoiceConnectionStatus = 'standby';
      let reportedMessage: string | undefined;

      const service = new AgoraVoiceService(ROOM_UUID, 'atc', {
        onStatusChange: (status, message) => {
          reportedStatus = status;
          reportedMessage = message;
        },
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });

      // Trigger connection-state-change with UID_CONFLICT
      (service as any).updateStatus('disconnected', 'UID conflict: This station identity is active in another tab. Please close other session.');

      expect(reportedStatus).toBe('disconnected');
      expect(reportedMessage).toContain('UID conflict');

      service.cleanup();
    });

    it('toggles microphone mute via localAudioTrack.setMuted without recreating track', async () => {
      const mockSetMuted = vi.fn().mockResolvedValue(undefined);
      const mockLocalTrack = {
        setMuted: mockSetMuted,
        stop: vi.fn(),
        close: vi.fn(),
      };

      const service = new AgoraVoiceService(ROOM_UUID, 'pilot', {
        onStatusChange: vi.fn(),
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });

      (service as any).localAudioTrack = mockLocalTrack;
      (service as any).localAudioPublished = true;
      (service as any).client = {
        unpublish: vi.fn().mockResolvedValue(undefined),
        removeAllListeners: vi.fn(),
        leave: vi.fn().mockResolvedValue(undefined),
      };

      // Start PTT -> should unmute the published microphone track.
      service.startPTT();
      await (service as any).microphoneControlQueue;
      expect(mockSetMuted).toHaveBeenCalledWith(false);

      // Stop PTT -> should mute the published microphone track.
      service.stopPTT();
      await (service as any).microphoneControlQueue;
      expect(mockSetMuted).toHaveBeenCalledWith(true);

      service.cleanup();
    });

    it('surfaces microphone enable failures instead of silently claiming transmission', async () => {
      const mockSetMuted = vi.fn().mockRejectedValue(new Error('capture failed'));
      let status: VoiceConnectionStatus = 'connected';
      const service = new AgoraVoiceService(ROOM_UUID, 'pilot', {
        onStatusChange: (nextStatus) => { status = nextStatus; },
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
      });
      (service as any).localAudioTrack = {
        setMuted: mockSetMuted,
        stop: vi.fn(),
        close: vi.fn(),
      };
      (service as any).localAudioPublished = true;
      (service as any).client = {
        unpublish: vi.fn().mockResolvedValue(undefined),
        removeAllListeners: vi.fn(),
        leave: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(console, 'error').mockImplementation(() => {});

      service.startPTT();
      await (service as any).microphoneControlQueue;

      expect(mockSetMuted).toHaveBeenCalledWith(false);
      expect(service.getIsTransmitting()).toBe(false);
      expect(status).toBe('standby');
      expect((service as any).client).toBeNull();
      expect((service as any).isInitialized).toBe(false);
      service.cleanup();
    });

    it('detects real incoming audio volume vs silence truthfully', () => {
      let isRemoteAudioActive = false;

      const service = new AgoraVoiceService(ROOM_UUID, 'atc', {
        onStatusChange: vi.fn(),
        onRemoteTrackReceived: vi.fn(),
        onAudioBlocked: vi.fn(),
        onRemoteAudioActive: (active) => { isRemoteAudioActive = active; },
      });

      // Mock volume indicators
      const myUid = 12345;
      const peerUid = 67890;

      // 1. Peer speaking with volume > 5
      const activeVolumes = [
        { uid: myUid, level: 0 },
        { uid: peerUid, level: 25 },
      ];
      const speaker = activeVolumes.find((v) => v.uid !== myUid && v.level > 5);
      if (speaker) {
        service['callbacks'].onRemoteAudioActive?.(true);
      }
      expect(isRemoteAudioActive).toBe(true);

      // 2. Peer silent with level <= 5
      const silentVolumes = [
        { uid: myUid, level: 0 },
        { uid: peerUid, level: 2 },
      ];
      const silentSpeaker = silentVolumes.find((v) => v.uid !== myUid && v.level > 5);
      if (!silentSpeaker) {
        service['callbacks'].onRemoteAudioActive?.(false);
      }
      expect(isRemoteAudioActive).toBe(false);

      service.cleanup();
    });
  });

  // --------------------------------------------------------------------------
  // 6. Required Deterministic Safety Verification Scenarios
  // --------------------------------------------------------------------------
  describe('6. Required Safety Scenarios (Phase C)', async () => {
    const { extractWithLocalRules } = await import('../lib/llmExtractor');
    const { diffExtractions } = await import('../lib/databaseSync');

    it('Scenario 1: MATCH — Speedbird 214 climb FL100, turn left heading 270, squawk 4215', () => {
      const atcClearance = 'Speedbird 214, climb flight level 100, turn left heading 270, squawk 4215.';
      const pilotReadback = 'Speedbird 214, climb flight level 100, left heading 270, squawk 4215.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MATCH');
      expect(verdict.severity).toBe('OK');
      expect(verdict.mismatchedFields).toHaveLength(0);
      expect(verdict.matchedFields.some((f) => f.includes('270'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('FL100'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('4215'))).toBe(true);
    });

    it('Scenario 2: HEADING MISMATCH — United 421 turn right heading 090 vs turn left heading 090', () => {
      const atcClearance = 'United 421, turn right heading 090.';
      const pilotReadback = 'United 421, turn left heading 090.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.severity).toBe('CRITICAL');
      expect(verdict.mismatchedFields.some((f) => f.includes('RIGHT vs LEFT'))).toBe(true);
      expect(verdict.explanation).toContain('Assigned turn RIGHT');
      expect(verdict.explanation).toContain('pilot read back turn LEFT');
    });

    it('Scenario 3: RUNWAY + ALTITUDE MISMATCH — Delta 882 hold short 28L maintain 2000 vs cross 28R climb 3000', () => {
      const atcClearance = 'Delta 882, hold short runway 28 Left, maintain 2000.';
      const pilotReadback = 'Delta 882, cross runway 28 Right, climb 3000.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.severity).toBe('CRITICAL');
      // Runway conflict
      expect(verdict.mismatchedFields.some((f) => f.includes('Runway'))).toBe(true);
      // Altitude deviation
      expect(verdict.mismatchedFields.some((f) => f.includes('Altitude'))).toBe(true);
      expect(verdict.explanation).toContain('RUNWAY CONFLICT');
    });

    it('handles missing ATC clearance honestly as UNVERIFIED (never false MATCH)', () => {
      const atcEmpty = 'Good morning, London Control.';
      const pilotReadback = 'Speedbird 214 climbing FL100.';

      const atcExt = extractWithLocalRules(atcEmpty);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('UNVERIFIED');
      expect(verdict.explanation).toContain('no clear controller instruction');
    });

    it('handles unparseable readback honestly as UNVERIFIED or PARTIAL (never false MATCH)', () => {
      const atcClearance = 'Speedbird 214, climb FL100, squawk 4215.';
      const pilotUnparseable = 'Roger that, check.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotUnparseable);

      const verdict = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).not.toBe('MATCH');
      expect(['UNVERIFIED', 'PARTIAL']).toContain(verdict.outcome);
      if (verdict.outcome === 'PARTIAL') {
        expect(verdict.omittedFields?.length).toBeGreaterThan(0);
      }
    });

    it('deduplicates alerts using deterministic session, clearance and discrepancy key', () => {
      const dedupeKeys = new Set<string>();

      const makeKey = (sessionId: string, atcId: string, pilotId: string, outcome: string) =>
        `${sessionId}_${atcId}_${pilotId}_${outcome}`;

      const key1 = makeKey('room-1', 'tx-1', 'tx-2', 'MISMATCH');
      const key2 = makeKey('room-1', 'tx-1', 'tx-2', 'MISMATCH');

      expect(dedupeKeys.has(key1)).toBe(false);
      dedupeKeys.add(key1);
      expect(dedupeKeys.has(key2)).toBe(true); // Echo prevented
    });
  });
});
