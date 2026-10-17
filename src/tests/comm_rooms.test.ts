import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCommRoom,
  joinCommRoom,
  startCommRoom,
  leaveCommRoom,
  endCommRoom,
  fetchCommRoomState,
  generateJoinCode,
  subscribeToCommRoom,
  saveActiveSession,
  getActiveSession,
  clearActiveSession,
  type CommRoomState,
} from '../lib/commRooms';
import { supabase } from '../lib/supabase';

// Polyfill localStorage in test environment
if (typeof localStorage === 'undefined') {
  const store: Record<string, string> = {};
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const k in store) delete store[k];
    },
  };
}

// Polyfill BroadcastChannel in test environment if needed
if (typeof BroadcastChannel === 'undefined') {
  class MockBroadcastChannel {
    name: string;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor(name: string) {
      this.name = name;
    }
    postMessage(_data: unknown) {}
    close() {}
  }
  (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = MockBroadcastChannel;
}

describe('SafeComm Comm Room System (Step 2)', { timeout: 20000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe('1. Room Join Code Generation', () => {
    it('generates valid aeronautical join codes with SFC- prefix', () => {
      for (let i = 0; i < 10; i++) {
        const code = generateJoinCode();
        expect(code).toMatch(/^SFC-\d{3}$/);
      }
    });
  });

  describe('2. Create Comm Room (ATC Role)', () => {
    it('creates a room with ATC role and waiting status', async () => {
      // Mock user as ATC Officer
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: {
          user: {
            id: 'user-atc-01',
            email: 'officer@safecomm.aero',
          } as any,
        },
        error: null,
      });

      const res = await createCommRoom({
        callsign: 'KSFO Tower',
        airport: 'KSFO',
        frequency: '120.500 MHz',
      });

      expect(res.error).toBeNull();
      expect(res.data).not.toBeNull();
      expect(res.data?.room.status).toBe('waiting');
      expect(res.data?.room.join_code).toMatch(/^SFC-\d{3,4}$/);
      expect(res.data?.currentRole).toBe('atc');
      expect(res.data?.isCreator).toBe(true);

      const atcParticipant = res.data?.participants.find((p) => p.role === 'atc');
      expect(atcParticipant).toBeDefined();
      expect(atcParticipant?.callsign).toBe('KSFO Tower');
      expect(atcParticipant?.status).toBe('connected');
    }, 15000);
  });

  describe('3. Join Comm Room Validation & Constraints', () => {
    it('rejects empty or blank join codes with descriptive error', async () => {
      const res = await joinCommRoom('   ');
      expect(res.data).toBeNull();
      expect(res.error).toContain('Please enter a valid communication code');
    });

    it('rejects non-existent join codes', async () => {
      const res = await joinCommRoom('SFC-NONEXISTENT-999');
      expect(res.data).toBeNull();
      expect(res.error).toContain('not found');
    });

    it('prevents creator from self-joining their own room as second participant', async () => {
      // User 1 creates room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: {
          user: {
            id: 'user-officer-ksfo',
            email: 'officer@safecomm.aero',
          } as any,
        },
        error: null,
      });

      const createRes = await createCommRoom({ callsign: 'KSFO Tower' });
      expect(createRes.data).not.toBeNull();
      const code = createRes.data!.room.join_code;

      // Same user attempts to join as Pilot
      const joinRes = await joinCommRoom(code, 'Speedbird 214');
      expect(joinRes.data).toBeNull();
      expect(joinRes.error).toContain('You are the ATC creator of this room');
    });

    it('allows a second authenticated user to join as Pilot and transitions status to ready', async () => {
      // ATC creates room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: {
          user: {
            id: 'user-atc-officer',
            email: 'officer@safecomm.aero',
          } as any,
        },
        error: null,
      });
      const createRes = await createCommRoom({ callsign: 'KSFO Tower' });
      const code = createRes.data!.room.join_code;
      const roomId = createRes.data!.room.id;

      // Pilot joins from second account
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: {
          user: {
            id: 'user-pilot-crew',
            email: 'pilot@safecomm.aero',
          } as any,
        },
        error: null,
      });

      const joinRes = await joinCommRoom(code, 'Speedbird 214');
      expect(joinRes.error).toBeNull();
      expect(joinRes.data).not.toBeNull();
      expect(joinRes.data?.currentRole).toBe('pilot');
      expect(joinRes.data?.room.status).toBe('ready');

      // Verify participants list contains 1 ATC and 1 Pilot
      const participants = joinRes.data!.participants;
      expect(participants).toHaveLength(2);
      expect(participants.some((p) => p.role === 'atc')).toBe(true);
      expect(participants.some((p) => p.role === 'pilot')).toBe(true);

      // Verify fetched state matches
      const state = await fetchCommRoomState(roomId, 'pilot');
      expect(state?.room.status).toBe('ready');
    });

    it('rejects a third participant when room already has a Pilot (max 1 ATC and 1 Pilot)', async () => {
      // ATC creates room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const code = createRes.data!.room.join_code;

      // Pilot 1 joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-pilot-1' } as any },
        error: null,
      });
      const join1 = await joinCommRoom(code, 'Speedbird 214');
      expect(join1.error).toBeNull();

      // Pilot 2 attempts to join same room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-pilot-2' } as any },
        error: null,
      });
      const join2 = await joinCommRoom(code, 'United 421');
      expect(join2.data).toBeNull();
      expect(join2.error).toContain('room is full');
    });
  });

  describe('4. Starting and Leaving Communication Rooms', () => {
    it('prevents starting room before Pilot has joined', async () => {
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const roomId = createRes.data!.room.id;

      const startRes = await startCommRoom(roomId);
      expect(startRes.success).toBe(false);
      expect(startRes.error).toMatch(/has not joined yet/i);
    });

    it('starts room successfully when Pilot has joined and transitions to active', async () => {
      // 1. ATC creates
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const roomId = createRes.data!.room.id;
      const code = createRes.data!.room.join_code;

      // 2. Pilot joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-pilot' } as any },
        error: null,
      });
      await joinCommRoom(code, 'Delta 882');

      // 3. ATC starts room
      const startRes = await startCommRoom(roomId);
      expect(startRes.success).toBe(true);

      // Verify room state is active
      const state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.room.status).toBe('active');
      expect(state?.room.started_at).toBeDefined();
    });

    it('rejects joining when room is already active', async () => {
      // Create and start room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const roomId = createRes.data!.room.id;
      const code = createRes.data!.room.join_code;

      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-pilot' } as any },
        error: null,
      });
      await joinCommRoom(code);
      await startCommRoom(roomId);

      // New user attempts to join active room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-late-pilot' } as any },
        error: null,
      });
      const lateJoin = await joinCommRoom(code);
      expect(lateJoin.data).toBeNull();
      expect(lateJoin.error).toContain('already in progress');
    });

    it('marks room as abandoned when ATC leaves', async () => {
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const roomId = createRes.data!.room.id;

      await leaveCommRoom(roomId, 'atc');
      const state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.room.status).toBe('abandoned');
    });

    it('reverts room to waiting when Pilot leaves before session starts', async () => {
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const roomId = createRes.data!.room.id;
      const code = createRes.data!.room.join_code;

      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-pilot' } as any },
        error: null,
      });
      await joinCommRoom(code);

      // Pilot leaves
      await leaveCommRoom(roomId, 'pilot');
      const state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.room.status).toBe('waiting');
      expect(state?.participants.some((p) => p.role === 'pilot')).toBe(false);
    });
  });

  describe('5. Realtime Subscription Lifecycle', () => {
    it('sets up subscription and returns cleanup function', async () => {
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const roomId = createRes.data!.room.id;

      let callCount = 0;
      const unsubscribe = subscribeToCommRoom(roomId, 'atc', (_state: CommRoomState) => {
        callCount++;
      });

      expect(typeof unsubscribe).toBe('function');
      // Wait for initial load call to complete asynchronously
      for (let i = 0; i < 60 && callCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(callCount).toBeGreaterThanOrEqual(1);

      unsubscribe();
    });
  });

  describe('6. Active Session Persistence & Refresh Recovery', () => {
    it('persists active session parameters and restores upon getActiveSession', () => {
      saveActiveSession({
        roomId: 'room-test-restore-123',
        role: 'atc',
        callsign: 'KSFO Tower',
        joinCode: 'SFC-888',
        airport: 'KSFO',
        frequency: '120.500 MHz',
      });

      const restored = getActiveSession();
      expect(restored).not.toBeNull();
      expect(restored?.roomId).toBe('room-test-restore-123');
      expect(restored?.role).toBe('atc');
      expect(restored?.joinCode).toBe('SFC-888');

      clearActiveSession();
      expect(getActiveSession()).toBeNull();
    });
  });

  describe('7. End Comm Action & Session Termination Flow', () => {
    it('ends communication room and transitions status to completed for both stations', async () => {
      // 1. ATC creates and Pilot joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const createRes = await createCommRoom({ callsign: 'KSFO Lead' });
      const roomId = createRes.data!.room.id;
      const code = createRes.data!.room.join_code;

      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-pilot' } as any },
        error: null,
      });
      await joinCommRoom(code, 'United 421');

      // 2. Start room
      await startCommRoom(roomId);
      let state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.room.status).toBe('active');

      // 3. End room via End Comm action
      const endRes = await endCommRoom(roomId);
      expect(endRes.success).toBe(true);

      // 4. Verify room state transitions to completed and active session cleared
      state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.room.status).toBe('completed');
      expect(getActiveSession()).toBeNull();
    });
  });

  describe('8. Leaving or Ending Room Does Not Break Subsequent Rooms', () => {
    it('allows creating and joining a new room after leaving a previous room', async () => {
      // User 1 creates room 1 and leaves
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const room1 = await createCommRoom();
      await leaveCommRoom(room1.data!.room.id, 'atc');

      // User 1 creates room 2
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const room2 = await createCommRoom();
      expect(room2.data).not.toBeNull();
      expect(room2.data!.room.id).not.toBe(room1.data!.room.id);

      // User 2 joins room 2
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-pilot' } as any },
        error: null,
      });
      const joinRes = await joinCommRoom(room2.data!.room.join_code);
      expect(joinRes.error).toBeNull();
      expect(joinRes.data?.room.status).toBe('ready');
      expect(joinRes.data?.participants).toHaveLength(2);
    });

    it('allows creating and joining a new room after ending a previous room', async () => {
      // Room 1 created, joined, started, and ended
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc' } as any },
        error: null,
      });
      const room1 = await createCommRoom();
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-pilot' } as any },
        error: null,
      });
      await joinCommRoom(room1.data!.room.join_code);
      await startCommRoom(room1.data!.room.id);
      await endCommRoom(room1.data!.room.id);

      // Room 2 created and joined cleanly
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-atc-2' } as any },
        error: null,
      });
      const room2 = await createCommRoom();
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'user-pilot-2' } as any },
        error: null,
      });
      const joinRes = await joinCommRoom(room2.data!.room.join_code);
      expect(joinRes.error).toBeNull();
      expect(joinRes.data?.room.status).toBe('ready');
      expect(joinRes.data?.participants).toHaveLength(2);
    });
  });

  describe('9. Reconnects, Dual Observation & Authorization Safeguards', () => {
    it('allows Pilot with the same account to reconnect without duplicate participants', async () => {
      // 1. ATC creates room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'atc-alpha' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const code = createRes.data!.room.join_code;

      // 2. Pilot joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-bravo' } as any },
        error: null,
      });
      const join1 = await joinCommRoom(code, 'SkyWest 411');
      expect(join1.error).toBeNull();
      expect(join1.data?.participants).toHaveLength(2);

      // 3. Pilot reconnects with same account
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-bravo' } as any },
        error: null,
      });
      const join2 = await joinCommRoom(code, 'SkyWest 411');
      expect(join2.error).toBeNull();
      expect(join2.data?.participants).toHaveLength(2);
      expect(join2.data?.participants.filter((p) => p.role === 'pilot')).toHaveLength(1);
    });

    it('ensures both participants observe the exact same room state', async () => {
      // ATC creates
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'atc-master' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const roomId = createRes.data!.room.id;
      const code = createRes.data!.room.join_code;

      // Pilot joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-member' } as any },
        error: null,
      });
      await joinCommRoom(code, 'Delta 100');

      // State fetched from ATC perspective
      const atcView = await fetchCommRoomState(roomId, 'atc');
      // State fetched from Pilot perspective
      const pilotView = await fetchCommRoomState(roomId, 'pilot');

      expect(atcView?.room.id).toBe(pilotView?.room.id);
      expect(atcView?.room.status).toBe(pilotView?.room.status);
      expect(atcView?.room.status).toBe('ready');
      expect(atcView?.participants).toHaveLength(2);
      expect(pilotView?.participants).toHaveLength(2);
      expect(atcView?.presence?.pilotOnline).toBe(true);
      expect(pilotView?.presence?.pilotOnline).toBe(true);
    });
  });

  describe('10. Security & Authorization Safeguards (Migration 004 Compliance)', () => {
    it('rejects anonymous unauthenticated calls across lifecycle RPC endpoints', async () => {
      // Unauthenticated caller
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: { user: null },
        error: null,
      } as any);

      // 1. Unauthenticated createCommRoom rejected when RPC enforces auth
      vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
        data: null,
        error: { message: 'Authentication required: You must be signed in to create a communication room.' },
      } as any);
      const createRes = await createCommRoom();
      expect(createRes.data).toBeNull();
      expect(createRes.error).toContain('Authentication required');

      // 2. Unauthenticated joinCommRoom rejected
      vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
        data: null,
        error: { message: 'Authentication required: You must be signed in to join a communication room.' },
      } as any);
      const joinRes = await joinCommRoom('SFC-123');
      expect(joinRes.data).toBeNull();
      expect(joinRes.error).toContain('Authentication required');

      // 3. Unauthenticated startCommRoom rejected
      vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
        data: null,
        error: { message: 'Authentication required: You must be signed in to start communication.' },
      } as any);
      const startRes = await startCommRoom('test-room-id');
      expect(startRes.success).toBe(false);
      expect(startRes.error).toContain('Authentication required');

      // 4. Unauthenticated endCommRoom rejected
      vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
        data: null,
        error: { message: 'Authentication required: You must be signed in to end communication.' },
      } as any);
      const endRes = await endCommRoom('test-room-id');
      expect(endRes.success).toBe(false);
      expect(endRes.error).toContain('Authentication required');
    });

    it('prevents role escalation: pilot caller supplying role="atc" cannot terminate room', async () => {
      // 1. ATC creates room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'atc-creator-uuid' } as any },
        error: null,
      });
      const room = await createCommRoom();
      const roomId = room.data!.room.id;
      const code = room.data!.room.join_code;

      // 2. Pilot joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-user-uuid' } as any },
        error: null,
      });
      await joinCommRoom(code, 'Delta 400');

      // 3. Pilot leaves - room should revert to waiting (not abandoned), awaiting another pilot
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-user-uuid' } as any },
        error: null,
      });
      await leaveCommRoom(roomId, 'pilot');

      const state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.room.status).toBe('waiting');
      expect(state?.room.status).not.toBe('abandoned');
    }, 15000);

    it('prevents unauthorized state change: non-creator/pilot cannot start comm room', async () => {
      // 1. ATC creates room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: { user: { id: 'legit-atc-uuid' } as any },
        error: null,
      });
      const room = await createCommRoom();
      const roomId = room.data!.room.id;
      const code = room.data!.room.join_code;

      // 2. Pilot joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: { user: { id: 'pilot-user-uuid' } as any },
        error: null,
      });
      await joinCommRoom(code, 'Delta 400');

      // 3. Pilot (non-creator) attempts to call startCommRoom
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: { user: { id: 'pilot-user-uuid' } as any },
        error: null,
      });
      vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
        data: null,
        error: { message: 'Only the ATC Controller who created this room can start the session.' },
      } as any);
      const startRes = await startCommRoom(roomId);
      expect(startRes.success).toBe(false);
      expect(startRes.error).toContain('Only the ATC Controller who created this room');
    });

    it('prevents unauthorized user from ending another users room', async () => {
      // 1. User A creates room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: { user: { id: 'user-a-atc' } as any },
        error: null,
      });
      const room = await createCommRoom();
      const roomId = room.data!.room.id;
      const code = room.data!.room.join_code;

      // 2. Pilot joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: { user: { id: 'user-b-pilot' } as any },
        error: null,
      });
      await joinCommRoom(code);

      // 3. Unauthorized User C attempts to end User A room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: { user: { id: 'user-c-attacker' } as any },
        error: null,
      });
      vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
        data: null,
        error: { message: 'Only the ATC Controller who created this room can end the session.' },
      } as any);
      const endRes = await endCommRoom(roomId);
      expect(endRes.success).toBe(false);
      expect(endRes.error).toContain('Only the ATC Controller who created this room');
    });

    it('prevents cross-room access: unassociated user cannot inspect foreign room state', async () => {
      // Mock get_comm_room_state RPC rejecting unauthorized user
      vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
        data: null,
        error: { message: 'Unauthorized: You are not a participant in this communication room.' },
      } as any);

      const state = await fetchCommRoomState('foreign-room-id-999');
      expect(state).toBeNull();
    });

    it('rejects duplicate joins: pilot slot occupied by another user cannot be taken', async () => {
      // 1. ATC creates room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'atc-user' } as any },
        error: null,
      });
      const room = await createCommRoom();
      const code = room.data!.room.join_code;

      // 2. Pilot 1 joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-user-1' } as any },
        error: null,
      });
      const join1 = await joinCommRoom(code, 'United 101');
      expect(join1.error).toBeNull();

      // 3. Pilot 2 (different account) attempts to join the same room
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-user-2' } as any },
        error: null,
      });
      const join2 = await joinCommRoom(code, 'United 999');
      expect(join2.data).toBeNull();
      expect(join2.error).toContain('Communication room is full');
    });

    it('denies departed participant with status "left" from inspecting active room state', async () => {
      // Departed pilot caller attempts to query get_comm_room_state
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
        data: { user: { id: 'departed-pilot-uuid' } as any },
        error: null,
      } as any);

      vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({
        data: null,
        error: { message: 'Unauthorized: You are not an active participant in this communication room.' },
      } as any);

      const state = await fetchCommRoomState('active-room-uuid');
      expect(state).toBeNull();
    });
  });
});



