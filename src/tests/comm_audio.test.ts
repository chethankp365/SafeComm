import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CommAudioSession,
  type CommTranscriptEntry,
  type AudioConnectionStatus,
  loadPersistedTranscripts,
  savePersistedTranscripts,
  getZuluTimestamp,
} from '../lib/commAudio';
import { extractWithLocalRules } from '../lib/llmExtractor';

describe('SafeComm Connect — Real-Time Audio, Mic Controls & Shared ASR (Step 3)', () => {
  const ROOM_ID = 'test-room-audio-101';
  let mockLocalStorage: Record<string, string> = {};

  beforeEach(() => {
    mockLocalStorage = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => mockLocalStorage[key] || null,
      setItem: (key: string, val: string) => {
        mockLocalStorage[key] = val;
      },
      removeItem: (key: string) => {
        delete mockLocalStorage[key];
      },
      clear: () => {
        mockLocalStorage = {};
      },
    });

    // Mock document for audio element
    const mockDoc = {
      createElement: vi.fn((tagName: string) => {
        if (tagName === 'audio') {
          return {
            autoplay: false,
            style: {},
            play: vi.fn().mockResolvedValue(undefined),
            srcObject: null,
            setAttribute: vi.fn(),
            parentNode: {
              removeChild: vi.fn(),
            },
          } as unknown as HTMLAudioElement;
        }
        return { style: {} } as unknown as HTMLElement;
      }),
      getElementById: vi.fn(() => null),
      body: {
        appendChild: vi.fn(),
      },
    };
    vi.stubGlobal('document', mockDoc);

    // Mock RTCPeerConnection for WebRTC tests in node
    class MockRTCPeerConnection {
      ontrack: ((event: unknown) => void) | null = null;
      onicecandidate: ((event: unknown) => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;
      onnegotiationneeded: (() => void) | null = null;
      iceConnectionState: string = 'new';
      signalingState: string = 'stable';
      addTrack = vi.fn();
      addTransceiver = vi.fn();
      createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'v=0' });
      createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0' });
      setLocalDescription = vi.fn().mockResolvedValue(undefined);
      setRemoteDescription = vi.fn().mockResolvedValue(undefined);
      addIceCandidate = vi.fn().mockResolvedValue(undefined);
      restartIce = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --------------------------------------------------------------------------
  // 1. Zulu Timestamp & Storage Utilities
  // --------------------------------------------------------------------------
  describe('1. Audio & Transcript Utilities', () => {
    it('generates a valid aeronautical Zulu timestamp with UTC suffix', () => {
      const zulu = getZuluTimestamp();
      expect(zulu).toMatch(/^\d{2}:\d{2}:\d{2}\sUTC$/);
    });

    it('persists and retrieves shared room transcripts in local storage', () => {
      const sampleTranscripts: CommTranscriptEntry[] = [
        {
          id: 'tx-1',
          roomId: ROOM_ID,
          role: 'atc',
          callsign: 'KSFO Tower',
          text: 'Speedbird 214, descend and maintain FL190',
          timestamp: '12:00:00 UTC',
          isFinal: true,
        },
      ];

      savePersistedTranscripts(ROOM_ID, sampleTranscripts);
      const retrieved = loadPersistedTranscripts(ROOM_ID);

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].callsign).toBe('KSFO Tower');
      expect(retrieved[0].text).toContain('maintain FL190');
    });

    it('returns empty array when no persisted transcripts exist', () => {
      expect(loadPersistedTranscripts('empty-room')).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Microphone Controls & Honest Status Transitions
  // --------------------------------------------------------------------------
  describe('2. Microphone Controls & Honest Status Transitions', () => {
    it('initializes audio session in requesting_mic state and manages mute state', async () => {
      let currentStatus: AudioConnectionStatus = 'standby';
      const callbacks = {
        onStatusChange: (status: AudioConnectionStatus) => {
          currentStatus = status;
        },
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      };

      const session = new CommAudioSession(ROOM_ID, 'atc', 'KSFO Tower', callbacks);

      expect(session.getStatus()).toBe('standby');
      expect(currentStatus).toBe('standby');
      expect(session.getIsMuted()).toBe(false);

      // Toggle Mute
      const muted = session.toggleMute();
      expect(muted).toBe(true);
      expect(session.getIsMuted()).toBe(true);

      const unmuted = session.toggleMute();
      expect(unmuted).toBe(false);
      expect(session.getIsMuted()).toBe(false);

      session.cleanup();
    });

    it('handles microphone blocked permission rejection honestly', async () => {
      let reportedStatus: AudioConnectionStatus = 'standby';
      let reportedMessage: string | undefined;

      // Mock getUserMedia rejecting with NotAllowedError
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue({ name: 'NotAllowedError' }),
        },
      });

      const session = new CommAudioSession(ROOM_ID, 'pilot', 'Speedbird 214', {
        onStatusChange: (status, message) => {
          reportedStatus = status;
          reportedMessage = message;
        },
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      await session.initialize();

      expect(reportedStatus).toBe('mic_blocked');
      expect(reportedMessage).toContain('Microphone blocked');
      session.cleanup();
    });

    it('handles missing microphone hardware honestly', async () => {
      let reportedStatus: AudioConnectionStatus = 'standby';
      let reportedMessage: string | undefined;

      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue({ name: 'NotFoundError' }),
        },
      });

      const session = new CommAudioSession(ROOM_ID, 'atc', 'KSFO Tower', {
        onStatusChange: (status, message) => {
          reportedStatus = status;
          reportedMessage = message;
        },
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      await session.initialize();

      expect(reportedStatus).toBe('no_mic');
      expect(reportedMessage).toContain('No microphone detected');
      session.cleanup();
    });

    it('manages Push-To-Talk and PTT Lock modes', () => {
      const session = new CommAudioSession(ROOM_ID, 'atc', 'KSFO Tower', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });
      const voiceService = (session as any).voiceService;
      voiceService.client = {
        unpublish: vi.fn().mockResolvedValue(undefined),
        removeAllListeners: vi.fn(),
        leave: vi.fn().mockResolvedValue(undefined),
      };
      voiceService.localAudioTrack = {
        setEnabled: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        close: vi.fn(),
      };
      voiceService.localAudioPublished = true;

      expect(session.getIsTransmitting()).toBe(false);

      // Start PTT
      session.startPTT();
      expect(session.getIsTransmitting()).toBe(true);

      // Stop PTT
      session.stopPTT();
      expect(session.getIsTransmitting()).toBe(false);

      // Toggle PTT Lock (Hands-free open frequency)
      const locked = session.togglePTTLock();
      expect(locked).toBe(true);
      expect(session.getIsPTTLocked()).toBe(true);
      expect(session.getIsTransmitting()).toBe(true);

      // Unlocking PTT Lock
      const unlocked = session.togglePTTLock();
      expect(unlocked).toBe(false);
      expect(session.getIsPTTLocked()).toBe(false);
      expect(session.getIsTransmitting()).toBe(false);

      session.cleanup();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Shared Transcript Synchronization & Deduplication
  // --------------------------------------------------------------------------
  describe('3. Shared Transcript Synchronization & Deduplication', () => {
    it('appends and deduplicates transcript transmissions across stations', () => {
      const received: CommTranscriptEntry[] = [];
      const session = new CommAudioSession(ROOM_ID, 'atc', 'KSFO Tower', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: (entry) => received.push(entry),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      const entry1: CommTranscriptEntry = {
        id: 'msg-unique-1',
        roomId: ROOM_ID,
        role: 'atc',
        callsign: 'KSFO Tower',
        text: 'Speedbird 214, turn left heading 280, descend to 3000',
        timestamp: '12:01:00 UTC',
        isFinal: true,
      };

      // First append
      session.appendTranscript(entry1);
      expect(received).toHaveLength(1);
      expect(session.getTranscripts()).toHaveLength(1);

      // Duplicate append attempt (same ID)
      session.appendTranscript(entry1);
      expect(received).toHaveLength(1); // Not duplicated
      expect(session.getTranscripts()).toHaveLength(1);

      // Second unique entry
      const entry2: CommTranscriptEntry = {
        id: 'msg-unique-2',
        roomId: ROOM_ID,
        role: 'pilot',
        callsign: 'Speedbird 214',
        text: 'Left heading 280, descending 3000, Speedbird 214',
        timestamp: '12:01:08 UTC',
        isFinal: true,
      };

      session.appendTranscript(entry2);
      expect(received).toHaveLength(2);
      expect(session.getTranscripts()).toHaveLength(2);

      session.cleanup();
    });

    it('rejects transcript events with a mismatched room or sender role', async () => {
      const session = new CommAudioSession(ROOM_ID, 'atc', 'KSFO Tower', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });
      const baseEntry: CommTranscriptEntry = {
        id: 'untrusted-transcript',
        roomId: ROOM_ID,
        role: 'pilot',
        callsign: 'Speedbird 214',
        text: 'Climb FL100.',
        timestamp: '12:01:00 UTC',
        isFinal: true,
      };

      await session.handleIncomingSignal({
        roomId: ROOM_ID,
        fromRole: 'atc',
        fromClientId: 'remote-client',
        type: 'transcript-entry',
        transcript: baseEntry,
      });
      await session.handleIncomingSignal({
        roomId: 'another-room',
        fromRole: 'pilot',
        fromClientId: 'remote-client',
        type: 'transcript-entry',
        transcript: { ...baseEntry, role: 'pilot', roomId: 'another-room' },
      });

      expect(session.getTranscripts()).toHaveLength(0);
      session.cleanup();
    });

    it('correctly attributes speaker roles and formats manual dispatch', () => {
      const received: CommTranscriptEntry[] = [];
      const session = new CommAudioSession(ROOM_ID, 'pilot', 'Speedbird 214', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: (entry) => received.push(entry),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      session.transmitManualText('San Francisco Tower, Speedbird 214 established ILS 28R');

      expect(received).toHaveLength(1);
      expect(received[0].role).toBe('pilot');
      expect(received[0].callsign).toBe('Speedbird 214');
      expect(received[0].text).toContain('established ILS 28R');
      expect(received[0].timestamp).toMatch(/\d{2}:\d{2}:\d{2}\sUTC/);

      session.cleanup();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Aeronautical Discrepancy Parsing in Transcripts
  // --------------------------------------------------------------------------
  describe('4. Aeronautical Clearance & Readback Parsing', () => {
    it('correctly extracts parameters from controller clearance and verifies matching readback', () => {
      const atcTransmission = 'Speedbird 214, descend and maintain 4000 feet, runway 28R cleared to land';
      const pilotReadback = 'Descending 4000 feet, runway 28R cleared to land, Speedbird 214';

      const atcParsed = extractWithLocalRules(atcTransmission);
      const pilotParsed = extractWithLocalRules(pilotReadback);

      const atcAlt = atcParsed.instructions.find((i) => i.type === 'altitude');
      const pilotAlt = pilotParsed.instructions.find((i) => i.type === 'altitude');

      expect(atcAlt?.value).toBe('4000ft');
      expect(pilotAlt?.value).toBe('4000ft');
      expect(atcAlt?.value).toBe(pilotAlt?.value); // MATCH
    });

    it('detects critical altitude mismatch between clearance and readback', () => {
      const atcTransmission = 'Speedbird 214, descend and maintain 5000 feet';
      const pilotReadback = 'Descending to 4000 feet, Speedbird 214';

      const atcParsed = extractWithLocalRules(atcTransmission);
      const pilotParsed = extractWithLocalRules(pilotReadback);

      const atcAlt = atcParsed.instructions.find((i) => i.type === 'altitude');
      const pilotAlt = pilotParsed.instructions.find((i) => i.type === 'altitude');

      expect(atcAlt?.value).toBe('5000ft');
      expect(pilotAlt?.value).toBe('4000ft');
      expect(atcAlt?.value).not.toBe(pilotAlt?.value); // MISMATCH DETECTED
    });
  });

  // --------------------------------------------------------------------------
  // 5. Bidirectional WebRTC Voice Audio Attachment & Autoplay Resolution
  // --------------------------------------------------------------------------
  describe('5. Bidirectional WebRTC Voice Audio Attachment & Autoplay Resolution', () => {
    it('updates callsign dynamically without resetting session state', () => {
      const session = new CommAudioSession(ROOM_ID, 'pilot', 'Initial Callsign', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      session.setCallsign('Delta 400');
      session.transmitManualText('Delta 400 ready for departure');
      const transcripts = session.getTranscripts();
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0].callsign).toBe('Delta 400');
      session.cleanup();
    });

    it('attaches remote incoming track to audio element with unmuted configuration', async () => {
      let attachedStream: MediaStream | null = null;
      const mockAudioElement = {
        id: `safecomm_remote_audio_${ROOM_ID}`,
        autoplay: true,
        muted: true, // starts muted in mock to check if session unmutes it
        volume: 0.5,
        play: vi.fn().mockResolvedValue(undefined),
        srcObject: null as unknown,
        setAttribute: vi.fn(),
        style: {},
        parentNode: { removeChild: vi.fn() },
      };

      vi.spyOn(document, 'getElementById').mockReturnValue(mockAudioElement as unknown as HTMLElement);

      const session = new CommAudioSession(ROOM_ID, 'atc', 'KSFO Tower', {
        onStatusChange: vi.fn(),
        onRemoteStream: (stream) => {
          attachedStream = stream;
        },
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      await session.initialize();

      // Verify unmuted and full volume configuration
      expect(mockAudioElement.muted).toBe(false);
      expect(mockAudioElement.volume).toBe(1.0);

      // Simulate incoming WebRTC track event
      const mockTrack = {
        kind: 'audio',
        enabled: true,
        onunmute: null as (() => void) | null,
      } as unknown as MediaStreamTrack;
      const mockRemoteMediaStream = {
        getTracks: () => [mockTrack],
      } as unknown as MediaStream;

      const pc = (session as unknown as { pc: RTCPeerConnection }).pc;
      if (pc && pc.ontrack) {
        pc.ontrack({
          track: mockTrack,
          streams: [mockRemoteMediaStream],
        } as unknown as RTCTrackEvent);
      }

      expect(attachedStream).toBe(mockRemoteMediaStream);
      expect(mockAudioElement.srcObject).toBe(mockRemoteMediaStream);
      expect(mockAudioElement.play).toHaveBeenCalled();

      session.cleanup();
    });

    it('handles browser autoplay rejection by entering audio_blocked state and allows resuming on user gesture', async () => {
      let isBlockedCallbackFired = false;
      let reportedStatus: AudioConnectionStatus = 'standby';

      const mockAudioElement = {
        id: `safecomm_remote_audio_${ROOM_ID}`,
        autoplay: true,
        muted: false,
        volume: 1.0,
        paused: true,
        play: vi.fn().mockRejectedValueOnce(new Error('NotAllowedError: play() failed because the user did not interact')),
        srcObject: null as unknown,
        setAttribute: vi.fn(),
        style: {},
        parentNode: { removeChild: vi.fn() },
      };

      vi.spyOn(document, 'getElementById').mockReturnValue(mockAudioElement as unknown as HTMLElement);

      const session = new CommAudioSession(ROOM_ID, 'pilot', 'Speedbird 214', {
        onStatusChange: (status) => {
          reportedStatus = status;
        },
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
        onAudioBlocked: (blocked) => {
          isBlockedCallbackFired = blocked;
        },
      });

      await session.initialize();

      // Trigger track with rejected play
      const mockTrack = { kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
      const mockStream = { getTracks: () => [mockTrack] } as unknown as MediaStream;

      const pc = (session as unknown as { pc: RTCPeerConnection }).pc;
      if (pc && pc.ontrack) {
        pc.ontrack({
          track: mockTrack,
          streams: [mockStream],
        } as unknown as RTCTrackEvent);
      }

      // Allow promise rejection chain to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(isBlockedCallbackFired).toBe(true);
      expect(reportedStatus).toBe('audio_blocked');

      // Now user interacts (e.g. clicks Enable Audio / Tap to Hear)
      mockAudioElement.play.mockResolvedValueOnce(undefined);
      const resumeSuccess = await session.resumeRemoteAudio();

      expect(resumeSuccess).toBe(true);
      expect(reportedStatus).toBe('connected');
      expect(isBlockedCallbackFired).toBe(false);

      session.cleanup();
    });

    it('isolates local microphone mute and PTT without muting incoming remote audio', async () => {
      const mockLocalTrack = {
        kind: 'audio',
        enabled: true,
        stop: vi.fn(),
      };
      const mockLocalStream = {
        getAudioTracks: () => [mockLocalTrack],
        getTracks: () => [mockLocalTrack],
      };

      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(mockLocalStream),
        },
      });

      const mockAudioElement = {
        id: `safecomm_remote_audio_${ROOM_ID}`,
        muted: false,
        volume: 1.0,
        play: vi.fn().mockResolvedValue(undefined),
        setAttribute: vi.fn(),
        style: {},
        parentNode: { removeChild: vi.fn() },
      };
      vi.spyOn(document, 'getElementById').mockReturnValue(mockAudioElement as unknown as HTMLElement);

      const session = new CommAudioSession(ROOM_ID, 'atc', 'KSFO Tower', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      await session.initialize();

      // Initially, local mic track is muted for Push-To-Talk default
      expect(mockLocalTrack.enabled).toBe(false);
      // Incoming audio playback element remains unmuted
      expect(mockAudioElement.muted).toBe(false);

      // Pressing PTT enables local outgoing microphone track
      session.startPTT();
      expect(mockLocalTrack.enabled).toBe(true);
      expect(mockAudioElement.muted).toBe(false);

      // Releasing PTT silences local outgoing track
      session.stopPTT();
      expect(mockLocalTrack.enabled).toBe(false);
      expect(mockAudioElement.muted).toBe(false);

      // Muting local mic
      session.toggleMute();
      expect(session.getIsMuted()).toBe(true);
      expect(mockLocalTrack.enabled).toBe(false);
      // Incoming audio is never muted
      expect(mockAudioElement.muted).toBe(false);

      session.cleanup();
    });
  });

  // --------------------------------------------------------------------------
  // 6. Regression Suite — Role Enforcement, ASR Grace Period & Truthful Status
  // --------------------------------------------------------------------------
  describe('6. Regression Suite — Role Enforcement, ASR Grace Period & Truthful Status', () => {
    it('dynamically updates session role and callsign without resetting peer connection', () => {
      const session = new CommAudioSession(ROOM_ID, 'atc', 'Initial Lead', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      // Initially ATC
      session.transmitManualText('Initial ATC clearance');
      let tx = session.getTranscripts();
      expect(tx[0].role).toBe('atc');
      expect(tx[0].callsign).toBe('Initial Lead');

      // Dynamically switch role to Pilot upon room state resolution
      session.setRole('pilot');
      session.setCallsign('Speedbird 214');
      session.transmitManualText('Speedbird 214 readback');

      tx = session.getTranscripts();
      expect(tx).toHaveLength(2);
      expect(tx[1].role).toBe('pilot');
      expect(tx[1].callsign).toBe('Speedbird 214');

      session.cleanup();
    });

    it('enforces station role and callsign on manual text, rejecting spoofed client overrides', () => {
      const session = new CommAudioSession(ROOM_ID, 'pilot', 'Delta 101', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      // Pilot session attempts to spoof role as 'atc'
      session.transmitManualText('Spoofed clearance instruction', 'atc', 'Tower Lead');

      const tx = session.getTranscripts();
      expect(tx).toHaveLength(1);
      // Strictly enforced as pilot and Delta 101
      expect(tx[0].role).toBe('pilot');
      expect(tx[0].callsign).toBe('Delta 101');

      session.cleanup();
    });

    it('notifies truthful remote track arrival and signaling status callbacks', async () => {
      let trackReceived = false;
      let signaledState = '';

      const session = new CommAudioSession(ROOM_ID, 'atc', 'KSFO Tower', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onRemoteTrackReceived: (hasTrack) => {
          trackReceived = hasTrack;
        },
        onSignalingStatus: (state) => {
          signaledState = state;
        },
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      await session.initialize();

      const pc = (session as unknown as { pc: RTCPeerConnection }).pc;
      const mockTrack = { kind: 'audio', enabled: true, onunmute: null } as unknown as MediaStreamTrack;
      const mockStream = { getTracks: () => [mockTrack] } as unknown as MediaStream;

      if (pc && pc.ontrack) {
        pc.ontrack({
          track: mockTrack,
          streams: [mockStream],
        } as unknown as RTCTrackEvent);
      }

      expect(trackReceived).toBe(true);

      // Simulate ICE connected
      (pc as unknown as { iceConnectionState: string }).iceConnectionState = 'connected';
      if (pc && pc.oniceconnectionstatechange) {
        pc.oniceconnectionstatechange(new Event('iceconnectionstatechange'));
      }

      expect(signaledState).toBe('connected');

      session.cleanup();
    });

    it('synchronizes transcripts end-to-end between ATC and Pilot across join sequences', async () => {
      localStorage.removeItem('safecomm_transcripts_room-handshake-999');
      const atcTranscripts: CommTranscriptEntry[] = [];
      const pilotTranscripts: CommTranscriptEntry[] = [];

      const atcSession = new CommAudioSession('room-handshake-999', 'atc', 'KSFO Tower', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: (entry) => atcTranscripts.push(entry),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: (synced) => {
          atcTranscripts.length = 0;
          atcTranscripts.push(...synced);
        },
      });

      // 1. ATC transmits 2 clearance items
      atcSession.transmitManualText('Speedbird 214, San Francisco Tower, descend to 3000 feet');
      atcSession.transmitManualText('Speedbird 214, runway 28R cleared to land');

      expect(atcSession.getTranscripts()).toHaveLength(2);
      expect(atcTranscripts).toHaveLength(2);

      // 2. Clear storage to simulate a fresh remote client connecting without local storage
      localStorage.removeItem('safecomm_transcripts_room-handshake-999');

      // Pilot connects to the same room
      const pilotSession = new CommAudioSession('room-handshake-999', 'pilot', 'Speedbird 214', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: (entry) => pilotTranscripts.push(entry),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: (synced) => {
          pilotTranscripts.length = 0;
          pilotTranscripts.push(...synced);
        },
      });

      expect(pilotSession.getTranscripts()).toHaveLength(0);

      // 3. ATC syncs existing 2 transmissions to Pilot via 'transcripts-sync'
      await (pilotSession as any).handleIncomingSignal({
        roomId: 'room-handshake-999',
        fromRole: 'atc',
        fromClientId: (atcSession as any).clientId,
        type: 'transcripts-sync',
        transcripts: atcSession.getTranscripts(),
      });

      // Pilot now has both ATC transmissions via sync
      expect(pilotSession.getTranscripts()).toHaveLength(2);
      expect(pilotTranscripts).toHaveLength(2);
      expect(pilotTranscripts[0].text).toContain('descend to 3000 feet');
      expect(pilotTranscripts[1].text).toContain('cleared to land');

      // 4. Pilot transmits readback
      pilotSession.transmitManualText('Descending 3000 feet, runway 28R cleared to land, Speedbird 214');
      expect(pilotSession.getTranscripts()).toHaveLength(3);

      const latestPilotTx = pilotSession.getTranscripts()[2];
      expect(latestPilotTx.role).toBe('pilot');
      expect(latestPilotTx.callsign).toBe('Speedbird 214');

      // 5. Broadcast of Pilot readback arrives at ATC
      await (atcSession as any).handleIncomingSignal({
        roomId: 'room-handshake-999',
        fromRole: 'pilot',
        fromClientId: (pilotSession as any).clientId,
        type: 'transcript-entry',
        transcript: latestPilotTx,
      });

      // Both stations now have 3 transcripts in exact order
      expect(atcSession.getTranscripts()).toHaveLength(3);
      expect(pilotSession.getTranscripts()).toHaveLength(3);
      expect(atcTranscripts).toHaveLength(3);
      expect(pilotTranscripts).toHaveLength(3);

      atcSession.cleanup();
      pilotSession.cleanup();
      localStorage.removeItem('safecomm_transcripts_room-handshake-999');
    });

    it('resolves SDP offer/answer without glare or collisions', async () => {
      const atcSession = new CommAudioSession('room-sdp-test-isolated', 'atc', 'KSFO Tower', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      const pilotSession = new CommAudioSession('room-sdp-test-isolated', 'pilot', 'Speedbird 214', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      (atcSession as any).setupPeerConnection();
      (pilotSession as any).setupPeerConnection();

      const atcPc = (atcSession as any).pc;
      const pilotPc = (pilotSession as any).pc;

      // ATC creates offer and sets local description
      await atcSession.initiateOffer();
      expect(atcPc.setLocalDescription).toHaveBeenCalledWith(expect.objectContaining({ type: 'offer' }));

      // Pilot receives ATC offer and sets remote description
      await (pilotSession as any).handleIncomingSignal({
        roomId: 'room-sdp-test-isolated',
        fromRole: 'atc',
        fromClientId: (atcSession as any).clientId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'v=0' },
      });

      expect(pilotPc.setRemoteDescription).toHaveBeenCalled();
      expect(pilotPc.setLocalDescription).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer' }));

      // ATC receives Pilot answer and sets remote description
      (atcPc as any).signalingState = 'have-local-offer';
      await (atcSession as any).handleIncomingSignal({
        roomId: 'room-sdp-test-isolated',
        fromRole: 'pilot',
        fromClientId: (pilotSession as any).clientId,
        type: 'answer',
        sdp: { type: 'answer', sdp: 'v=0' },
      });

      expect(atcPc.setRemoteDescription).toHaveBeenCalled();

      atcSession.cleanup();
      pilotSession.cleanup();
    });
  });
});
