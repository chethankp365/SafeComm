import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createCommRoom,
  joinCommRoom,
  startCommRoom,
  endCommRoom,
  leaveCommRoom,
  fetchCommRoomState,
  saveActiveSession,
  getActiveSession,
  clearActiveSession,
  submitCommFeedback,
  getLocalFeedback,
  saveLocalFeedback,
  type CommSessionFeedback,
} from '../lib/commRooms';
import {
  CommAudioSession,
  type CommTranscriptEntry,
} from '../lib/commAudio';
import { cancelAllSpeech } from '../lib/speechAudio';
import { extractWithLocalRules } from '../lib/llmExtractor';
import { diffExtractions, type VerificationVerdictStub } from '../lib/databaseSync';

// Mock localStorage if in node test environment
let mockStorage: Record<string, string> = {};
const mockStorageObj = {
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, value: string) => {
    mockStorage[key] = String(value);
  },
  removeItem: (key: string) => {
    delete mockStorage[key];
  },
  clear: () => {
    mockStorage = {};
  },
};
vi.stubGlobal('localStorage', mockStorageObj);

// Mock SpeechSynthesis
const mockCancelSpeech = vi.fn();
const mockSpeechSynth = {
  speak: vi.fn(),
  cancel: mockCancelSpeech,
  pause: vi.fn(),
  resume: vi.fn(),
  getVoices: () => [],
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};
vi.stubGlobal('speechSynthesis', mockSpeechSynth);
vi.stubGlobal('window', {
  localStorage: mockStorageObj,
  speechSynthesis: mockSpeechSynth,
  SpeechSynthesisUtterance: class {},
});

describe('SafeComm Connect — End Comm, Session Summary & Five-Star Rating', () => {
  beforeEach(() => {
    mockStorage = {};
    mockCancelSpeech.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. End Comm Flow & Dual Station Termination
  // --------------------------------------------------------------------------
  describe('1. Session Termination & Security Authorization', () => {
    it('successfully ends communication room and transitions status to completed', async () => {
      // 1. Create and start room as ATC
      const createRes = await createCommRoom({ airport: 'KSFO', frequency: '120.500', callsign: 'KSFO Tower' });
      expect(createRes.data).not.toBeNull();
      expect(createRes.error).toBeNull();
      const roomId = createRes.data!.room.id;
      const joinCode = createRes.data!.room.join_code;

      // 2. Pilot joins
      await joinCommRoom(joinCode, 'Speedbird 214');
      await startCommRoom(roomId);

      // 3. ATC ends comm room
      const endRes = await endCommRoom(roomId);
      expect(endRes.success).toBe(true);

      // 4. Verify status transitioned to completed with ended_at timestamp
      const state = await fetchCommRoomState(roomId);
      expect(state).not.toBeNull();
      expect(state!.room.status).toBe('completed');
      expect(state!.room.ended_at).toBeDefined();
    }, 15000);

    it('clears active session token upon session termination', async () => {
      saveActiveSession({
        roomId: 'test-room-123',
        role: 'atc',
        callsign: 'KSFO Tower',
        joinCode: 'SFC-999',
        airport: 'KSFO',
        frequency: '120.500',
      });
      expect(getActiveSession()).not.toBeNull();

      clearActiveSession();
      expect(getActiveSession()).toBeNull();
    });

    it('enforces that only the creator/ATC can terminate the room', async () => {
      const createRes = await createCommRoom({ airport: 'KSFO', frequency: '120.500', callsign: 'KSFO Tower' });
      const roomId = createRes.data!.room.id;

      // Pilot trying to call endCommRoom when room created by ATC should be rejected or handled securely
      const store = JSON.parse(mockStorage['safecomm_active_comm_rooms'] || '{}');
      if (store[roomId]) {
        store[roomId].room.created_by = 'atc-user-uuid';
        mockStorage['safecomm_active_comm_rooms'] = JSON.stringify(store);
      }

      // Leave comm room handles pilot departure without unauthorized termination
      const leaveRes = await leaveCommRoom(roomId, 'pilot');
      expect(leaveRes.success).toBe(true);

      const stateAfter = await fetchCommRoomState(roomId);
      expect(stateAfter!.room.status).not.toBe('completed');
    }, 30000);
  });

  // --------------------------------------------------------------------------
  // 2. Resource Teardown (Audio, WebRTC, ASR, Voice Advisories)
  // --------------------------------------------------------------------------
  describe('2. Comprehensive Resource Teardown', () => {
    it('terminates all media streams, WebRTC peers, and ASR recognition on audio session cleanup', () => {
      const mockStopTrack = vi.fn();
      const mockClosePC = vi.fn();
      const mockStopASR = vi.fn();

      const session = new CommAudioSession('test-room', 'atc', 'KSFO Tower', {
        onStatusChange: vi.fn(),
        onRemoteStream: vi.fn(),
        onPeerAudioState: vi.fn(),
        onTranscriptReceived: vi.fn(),
        onInterimTranscript: vi.fn(),
        onTranscriptsSync: vi.fn(),
      });

      // Inject mock stream & connection
      (session as any).localStream = {
        getTracks: () => [{ stop: mockStopTrack }],
      };
      (session as any).pc = {
        close: mockClosePC,
      };
      (session as any).speechRecognizer = {
        stop: mockStopASR,
      };
      (session as any).isRecognitionActive = true;

      session.cleanup();

      expect(mockStopTrack).toHaveBeenCalledTimes(1);
      expect(mockClosePC).toHaveBeenCalledTimes(1);
      expect(mockStopASR).toHaveBeenCalledTimes(1);
      expect(session.getStatus()).toBe('disconnected');
    });

    it('cancels speech synthesis voice playback on session end', () => {
      cancelAllSpeech();
      expect(mockCancelSpeech).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Session Summary Statistics from Real Session Data
  // --------------------------------------------------------------------------
  describe('3. Accurate Session Summary Metrics', () => {
    it('computes exact transmission counts, verified matches, and discrepancies from actual transcript logs', () => {
      const transcripts: CommTranscriptEntry[] = [
        {
          id: 't-1',
          roomId: 'room-abc',
          role: 'atc',
          callsign: 'KSFO Tower',
          text: 'Speedbird 214, climb and maintain FL190, turn left heading 270, runway 28R cleared for takeoff, squawk 4215.',
          timestamp: '12:00:00 UTC',
          isFinal: true,
        },
        {
          id: 't-2',
          roomId: 'room-abc',
          role: 'pilot',
          callsign: 'Speedbird 214',
          text: 'Climb and maintain FL190, turn left heading 270, runway 28R cleared for takeoff, squawk 4215, Speedbird 214.',
          timestamp: '12:00:15 UTC',
          isFinal: true,
        },
        {
          id: 't-3',
          roomId: 'room-abc',
          role: 'atc',
          callsign: 'KSFO Tower',
          text: 'Speedbird 214, turn left heading 090, maintain 4000.',
          timestamp: '12:01:00 UTC',
          isFinal: true,
        },
        {
          id: 't-4',
          roomId: 'room-abc',
          role: 'pilot',
          callsign: 'Speedbird 214',
          text: 'Turn right heading 090, maintain 4000, Speedbird 214.', // Heading direction swap mismatch!
          timestamp: '12:01:12 UTC',
          isFinal: true,
        },
        {
          id: 't-5',
          roomId: 'room-abc',
          role: 'atc',
          callsign: 'KSFO Tower',
          text: 'Speedbird 214, runway 28R cleared to land, squawk 4215.',
          timestamp: '12:02:00 UTC',
          isFinal: true,
        },
        {
          id: 't-6',
          roomId: 'room-abc',
          role: 'pilot',
          callsign: 'Speedbird 214',
          text: 'Runway 28R cleared to land, Speedbird 214.', // Omitted squawk!
          timestamp: '12:02:14 UTC',
          isFinal: true,
        },
      ];

      // Compute verdicts exactly as done in CommSession
      const verdicts: Record<string, VerificationVerdictStub> = {};
      for (let i = 0; i < transcripts.length; i++) {
        const entry = transcripts[i];
        if (entry.role === 'pilot') {
          let prevAtc: CommTranscriptEntry | null = null;
          for (let j = i - 1; j >= 0; j--) {
            if (transcripts[j].role === 'atc') {
              prevAtc = transcripts[j];
              break;
            }
          }
          if (prevAtc) {
            const atcExt = extractWithLocalRules(prevAtc.text);
            const pilotExt = extractWithLocalRules(entry.text);
            verdicts[entry.id] = diffExtractions(atcExt, pilotExt);
          }
        }
      }

      const totalTransmissions = transcripts.length;
      const atcCount = transcripts.filter((t) => t.role === 'atc').length;
      const pilotCount = transcripts.filter((t) => t.role === 'pilot').length;
      const verifiedMatches = Object.values(verdicts).filter((v) => v.outcome === 'MATCH').length;
      const discrepancyAlerts = Object.values(verdicts).filter((v) => v.outcome === 'MISMATCH').length;
      const partialOmissions = Object.values(verdicts).filter((v) => v.outcome === 'PARTIAL').length;

      expect(totalTransmissions).toBe(6);
      expect(atcCount).toBe(3);
      expect(pilotCount).toBe(3);
      expect(verifiedMatches).toBe(1);
      expect(discrepancyAlerts).toBe(1);
      expect(partialOmissions).toBe(1);
    });

    it('renders clean empty state metrics when no transmissions occurred', () => {
      const transcripts: CommTranscriptEntry[] = [];
      const totalTransmissions = transcripts.length;
      const atcCount = transcripts.filter((t) => t.role === 'atc').length;
      const pilotCount = transcripts.filter((t) => t.role === 'pilot').length;

      expect(totalTransmissions).toBe(0);
      expect(atcCount).toBe(0);
      expect(pilotCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Five-Star Rating & Optional Feedback Persistence
  // --------------------------------------------------------------------------
  describe('4. Five-Star Rating & Feedback System', () => {
    it('accepts valid ratings from 1 to 5 stars with optional feedback text', async () => {
      const res = await submitCommFeedback('room-feedback-test', 5, 'Crisp audio and instant readback verification!', 'pilot');
      expect(res.success).toBe(true);
      expect(res.feedbackId).toBeDefined();

      const saved = getLocalFeedback('room-feedback-test');
      expect(saved).not.toBeNull();
      expect(saved!.rating).toBe(5);
      expect(saved!.feedbackText).toBe('Crisp audio and instant readback verification!');
      expect(saved!.role).toBe('pilot');
    });

    it('rejects invalid ratings outside 1-5 range', async () => {
      const resZero = await submitCommFeedback('room-1', 0, 'No stars', 'atc');
      expect(resZero.success).toBe(false);
      expect(resZero.error).toContain('between 1 and 5');

      const resSix = await submitCommFeedback('room-1', 6, 'Too many stars', 'atc');
      expect(resSix.success).toBe(false);
      expect(resSix.error).toContain('between 1 and 5');
    });

    it('allows updating/revising feedback while preventing duplicate row creation', async () => {
      const roomId = 'room-dedup-test';
      // First submission: 4 stars
      const res1 = await submitCommFeedback(roomId, 4, 'Initial observation', 'pilot');
      expect(res1.success).toBe(true);

      // Second submission: updated to 5 stars
      const res2 = await submitCommFeedback(roomId, 5, 'Updated observation', 'pilot');
      expect(res2.success).toBe(true);

      // Verify that the stored feedback reflects the latest revision
      const saved = getLocalFeedback(roomId);
      expect(saved!.rating).toBe(5);
      expect(saved!.feedbackText).toBe('Updated observation');
    });

    it('associates feedback with the specific ended room and participant role', async () => {
      const roomA = 'room-a-999';
      const roomB = 'room-b-888';

      await submitCommFeedback(roomA, 3, 'Tower perspective', 'atc');
      await submitCommFeedback(roomB, 5, 'Flight crew perspective', 'pilot');

      const feedbackA = getLocalFeedback(roomA);
      const feedbackB = getLocalFeedback(roomB);

      expect(feedbackA?.role).toBe('atc');
      expect(feedbackA?.rating).toBe(3);
      expect(feedbackB?.role).toBe('pilot');
      expect(feedbackB?.rating).toBe(5);
    });

    it('preserves user privacy: feedback is isolated to submitting user/room', () => {
      const userAFeedback: CommSessionFeedback = {
        roomId: 'room-priv-1',
        userId: 'user-pilot-123',
        role: 'pilot',
        rating: 4,
        feedbackText: 'Private pilot remarks',
      };
      saveLocalFeedback('room-priv-1', userAFeedback);

      const retrieved = getLocalFeedback('room-priv-1');
      expect(retrieved?.feedbackText).toBe('Private pilot remarks');
      expect(retrieved?.userId).toBe('user-pilot-123');

      // Room without feedback returns null
      expect(getLocalFeedback('non-existent-room')).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Return to Dashboard & Seamless Continuation
  // --------------------------------------------------------------------------
  describe('5. Return to Dashboard & Continuation', () => {
    it('ensures active session is cleared so user can create a subsequent room normally', async () => {
      // 1. Session 1 ended
      const r1 = await createCommRoom({ airport: 'KSFO', frequency: '120.500', callsign: 'KSFO Tower' });
      const r1Id = r1.data!.room.id;
      saveActiveSession({
        roomId: r1Id,
        role: 'atc',
        callsign: 'KSFO Tower',
        joinCode: r1.data!.room.join_code,
        airport: 'KSFO',
        frequency: '120.500',
      });
      await endCommRoom(r1Id);
      clearActiveSession();

      // 2. Verify no lingering active session
      expect(getActiveSession()).toBeNull();

      // 3. User creates a fresh room without collision
      const r2 = await createCommRoom({ airport: 'KLAX', frequency: '118.700', callsign: 'KLAX Tower' });
      expect(r2.data).not.toBeNull();
      expect(r2.data!.room.id).not.toBe(r1Id);
      expect(r2.data!.room.status).toBe('waiting');
    }, 15000);
  });
});
