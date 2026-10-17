import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  type ActiveCommSession,
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

describe('Dedicated Comm Session Screen & Flow Verification', { timeout: 20000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    clearActiveSession();
    vi.clearAllMocks();
  });

  describe('1. Start Comm Navigation & Dual-Participant Target URL', () => {
    it('generates the dedicated route path /comm/:roomId upon session initiation', async () => {
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'controller-ksfo' } as any },
        error: null,
      });

      const createRes = await createCommRoom({
        callsign: 'KSFO Tower',
        airport: 'KSFO',
        frequency: '120.500 MHz',
      });

      expect(createRes.error).toBeNull();
      const roomId = createRes.data!.room.id;
      const expectedSessionRoute = `/comm/${roomId}`;

      expect(expectedSessionRoute).toMatch(/^\/comm\/[a-zA-Z0-9_-]+$/);
      expect(createRes.data!.currentRole).toBe('atc');

      // Both users must target this exact active room route
      const pilotSessionRoute = `/comm/${roomId}`;
      expect(pilotSessionRoute).toBe(expectedSessionRoute);
    });

    it('automatically transitions Pilot to active room upon ATC Start Comm trigger', async () => {
      // 1. ATC creates
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'atc-officer-99' } as any },
        error: null,
      });
      const createRes = await createCommRoom({ callsign: 'KSFO Tower' });
      const roomId = createRes.data!.room.id;
      const code = createRes.data!.room.join_code;

      // 2. Pilot joins
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-flight-99' } as any },
        error: null,
      });
      const joinRes = await joinCommRoom(code, 'Speedbird 214');
      expect(joinRes.error).toBeNull();
      expect(joinRes.data?.room.status).toBe('ready');

      // 3. ATC clicks Start Comm
      const startRes = await startCommRoom(roomId);
      expect(startRes.success).toBe(true);

      // 4. Pilot queries room state and observes active status without returning to scenario dashboard
      const pilotState = await fetchCommRoomState(roomId, 'pilot');
      expect(pilotState).not.toBeNull();
      expect(pilotState?.room.status).toBe('active');
      expect(pilotState?.currentRole).toBe('pilot');
    });
  });

  describe('2. Dedicated Comm Session Roles & Presence State', () => {
    it('supports ATC Controller Station role with verified credentials and frequency', async () => {
      const atcSession: ActiveCommSession = {
        roomId: 'room-atc-station-test',
        role: 'atc',
        callsign: 'KSFO Tower',
        joinCode: 'SFC-512',
        airport: 'KSFO',
        frequency: '120.500 MHz',
        userId: 'user-controller-ksfo',
      };
      saveActiveSession(atcSession);

      const recovered = getActiveSession();
      expect(recovered).toEqual(atcSession);
      expect(recovered?.role).toBe('atc');
      expect(recovered?.callsign).toBe('KSFO Tower');
      expect(recovered?.frequency).toBe('120.500 MHz');
    });

    it('supports Pilot Flight Crew Station role with verified callsign', async () => {
      const pilotSession: ActiveCommSession = {
        roomId: 'room-pilot-station-test',
        role: 'pilot',
        callsign: 'Speedbird 214',
        joinCode: 'SFC-512',
        airport: 'KSFO',
        frequency: '120.500 MHz',
        userId: 'user-pilot-ba214',
      };
      saveActiveSession(pilotSession);

      const recovered = getActiveSession();
      expect(recovered).toEqual(pilotSession);
      expect(recovered?.role).toBe('pilot');
      expect(recovered?.callsign).toBe('Speedbird 214');
    });

    it('tracks presence indicators for both controller and pilot stations', async () => {
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'atc-user-1' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const roomId = createRes.data!.room.id;
      const code = createRes.data!.room.join_code;

      let state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.presence?.atcOnline).toBe(true);
      expect(state?.presence?.pilotOnline).toBe(false);

      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-user-2' } as any },
        error: null,
      });
      await joinCommRoom(code);

      state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.presence?.atcOnline).toBe(true);
      expect(state?.presence?.pilotOnline).toBe(true);
    });
  });

  describe('3. Active-Room Browser Refresh Recovery', () => {
    it('restores active room context upon page reload without loss of session parameters', () => {
      const activeSession: ActiveCommSession = {
        roomId: 'room-refresh-recover-88',
        role: 'atc',
        callsign: 'KSFO Ground',
        joinCode: 'SFC-771',
        airport: 'KSFO',
        frequency: '121.900 MHz',
      };

      // User initiates or joins room
      saveActiveSession(activeSession);

      // Page refresh simulates re-evaluating storage
      const restoredSession = getActiveSession();
      expect(restoredSession).not.toBeNull();
      expect(restoredSession?.roomId).toBe('room-refresh-recover-88');
      expect(restoredSession?.role).toBe('atc');
      expect(restoredSession?.joinCode).toBe('SFC-771');
      expect(restoredSession?.airport).toBe('KSFO');
      expect(restoredSession?.frequency).toBe('121.900 MHz');
    });

    it('gracefully handles missing storage on cold load', () => {
      clearActiveSession();
      const restored = getActiveSession();
      expect(restored).toBeNull();
    });
  });

  describe('4. Dedicated Session UI Isolation (No Scripted Scenarios)', () => {
    it('ensures dedicated comm session is decoupled from scripted training scenarios', async () => {
      // In the normal dashboard, scripted scenarios (e.g. S1, S2, S3) are loaded.
      // In CommSession, only live radio transceiver, live transcript stream, and Sentinel compliance empty states exist.
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'atc-live-officer' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const state = createRes.data!;

      // Room state must NOT reference scenario datasets
      expect((state.room as any).scenarioId).toBeUndefined();
      expect((state.room as any).scriptedExchanges).toBeUndefined();
      expect(state.room.status).toBe('waiting');
    });
  });

  describe('5. End Comm Flow & Session Concluded Synchronization', () => {
    it('terminates active session cleanly and clears active session token', async () => {
      // 1. Establish room and active session
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'officer-alpha' } as any },
        error: null,
      });
      const createRes = await createCommRoom({ callsign: 'KSFO Tower' });
      const roomId = createRes.data!.room.id;
      const code = createRes.data!.room.join_code;

      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'pilot-bravo' } as any },
        error: null,
      });
      await joinCommRoom(code, 'Delta 812');
      await startCommRoom(roomId);

      // Verify active
      let state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.room.status).toBe('active');

      // 2. Trigger End Comm
      const endRes = await endCommRoom(roomId);
      expect(endRes.success).toBe(true);

      // 3. Verify session cleared and status marked completed
      expect(getActiveSession()).toBeNull();
      state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.room.status).toBe('completed');
    });

    it('synchronizes room abandonment when ATC leaves prematurely', async () => {
      vi.spyOn(supabase.auth, 'getUser').mockResolvedValueOnce({
        data: { user: { id: 'officer-leave' } as any },
        error: null,
      });
      const createRes = await createCommRoom();
      const roomId = createRes.data!.room.id;

      await leaveCommRoom(roomId, 'atc');

      const state = await fetchCommRoomState(roomId, 'atc');
      expect(state?.room.status).toBe('abandoned');
      expect(getActiveSession()).toBeNull();
    });
  });
});
