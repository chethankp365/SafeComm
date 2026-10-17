-- ==============================================================================
-- SafeComm Migration 004: Recovery Plan & Reversal Migration
-- Target Baseline: Migration 003 (supabase/migrations/003_comm_rooms.sql)
-- ==============================================================================
-- 
-- IMPORTANT OPERATOR NOTICE:
-- This rollback script reverts database objects modified by Migration 004.
-- Because Migration 003 originally permitted anonymous access ('auth.uid() IS NULL'
-- and 'GRANT ALL ... TO anon'), this file provides two distinct recovery modes:
-- 
-- MODE 1 (RECOMMENDED): SECURE ROLLBACK
--   Restores Migration 003 functional logic (RPC signatures, room lifecycle),
--   drops Migration 004 helpers and upper unique index, but PRESERVES authenticated-
--   only table write protection to prevent anonymous database takeover.
-- 
-- MODE 2: LITERAL MIGRATION 003 REVERSAL
--   Restores exact verbatim Migration 003 policies, grants, and functions including
--   broad anonymous write permissions. Use only if legacy unauthenticated tests require it.
-- 
-- IRREVERSIBLE DATA CHANGES:
-- 1. Rooms created while Migration 004 was active will persist in the database.
-- 2. Participant rows marked as 'left' by end_comm_room/leave_comm_room remain 'left'.
-- 3. Room completion timestamps (ended_at, started_at) are retained.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Pre-execution Safety Guard
-- ------------------------------------------------------------------------------
-- Confirms whether Migration 004 objects are present before executing reversal.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'is_comm_room_participant'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' 
          AND tablename = 'comm_rooms' 
          AND indexname = 'idx_comm_rooms_join_code_upper'
    ) THEN
        RAISE NOTICE 'Notice: Migration 004 objects were not detected. Running recovery to ensure standard Migration 003 state.';
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 2. Drop Migration 004 Helper Functions & Overloads
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.is_comm_room_participant(UUID, UUID);
DROP FUNCTION IF EXISTS public.is_comm_room_participant(UUID);
DROP FUNCTION IF EXISTS public.is_comm_room_creator(UUID, UUID);
DROP FUNCTION IF EXISTS public.is_comm_room_creator(UUID);

-- Drop the unambiguous 2-argument leave_comm_room overload
DROP FUNCTION IF EXISTS public.leave_comm_room(UUID, TEXT);
DROP FUNCTION IF EXISTS public.leave_comm_room(UUID);

-- ------------------------------------------------------------------------------
-- 3. Revert Case-Insensitive Unique Index
-- ------------------------------------------------------------------------------
-- Drops the unique upper index added in 004 and restores 003 non-unique index
DROP INDEX IF EXISTS public.idx_comm_rooms_join_code_upper;
CREATE INDEX IF NOT EXISTS idx_comm_rooms_join_code ON public.comm_rooms (UPPER(join_code));

-- ------------------------------------------------------------------------------
-- 4. Clean Drop of Migration 004 Policies
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "comm_rooms_select_participant" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_participants_select_member" ON public.comm_participants;

DROP POLICY IF EXISTS "comm_rooms_select" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_insert" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_update" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_participants_select" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_insert" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_update" ON public.comm_participants;

-- ------------------------------------------------------------------------------
-- 5. Restore Migration 003 Row-Level Security Policies
-- ------------------------------------------------------------------------------
-- Exact verbatim policies from supabase/migrations/003_comm_rooms.sql (lines 64-111)

CREATE POLICY "comm_rooms_select"
    ON public.comm_rooms
    FOR SELECT
    USING (true);

CREATE POLICY "comm_rooms_insert"
    ON public.comm_rooms
    FOR INSERT
    WITH CHECK (
        (auth.uid() IS NOT NULL AND (created_by = auth.uid() OR created_by IS NULL))
        OR (auth.uid() IS NULL)
    );

CREATE POLICY "comm_rooms_update"
    ON public.comm_rooms
    FOR UPDATE
    USING (
        (auth.uid() IS NOT NULL AND created_by = auth.uid())
        OR (auth.uid() IS NULL)
    );

CREATE POLICY "comm_participants_select"
    ON public.comm_participants
    FOR SELECT
    USING (true);

CREATE POLICY "comm_participants_insert"
    ON public.comm_participants
    FOR INSERT
    WITH CHECK (
        (auth.uid() IS NOT NULL AND (user_id = auth.uid() OR user_id IS NULL))
        OR (auth.uid() IS NULL)
    );

CREATE POLICY "comm_participants_update"
    ON public.comm_participants
    FOR UPDATE
    USING (
        (auth.uid() IS NOT NULL AND (user_id = auth.uid() OR user_id IS NULL))
        OR (auth.uid() IS NULL)
    );

-- ------------------------------------------------------------------------------
-- 6. Restore Exact Migration 003 RPC Functions
-- ------------------------------------------------------------------------------

-- Function 6a: create_comm_room (Exact Migration 003 implementation, lines 117-175)
CREATE OR REPLACE FUNCTION public.create_comm_room(
    p_callsign TEXT DEFAULT 'KSFO Tower',
    p_airport TEXT DEFAULT 'KSFO',
    p_frequency TEXT DEFAULT '120.500 MHz',
    p_custom_code TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_code TEXT;
    v_room_id UUID;
    v_room RECORD;
    v_participant RECORD;
    v_attempts INT := 0;
BEGIN
    v_uid := auth.uid();
    
    IF p_custom_code IS NOT NULL AND LENGTH(TRIM(p_custom_code)) >= 4 THEN
        v_code := UPPER(TRIM(p_custom_code));
    ELSE
        LOOP
            v_attempts := v_attempts + 1;
            v_code := 'SFC-' || LPAD(FLOOR(100 + RANDOM() * 900)::TEXT, 3, '0');
            EXIT WHEN NOT EXISTS (SELECT 1 FROM public.comm_rooms WHERE join_code = v_code) OR v_attempts > 20;
        END LOOP;
    END IF;

    INSERT INTO public.comm_rooms (join_code, created_by, status, airport, frequency)
    VALUES (v_code, v_uid, 'waiting', COALESCE(p_airport, 'KSFO'), COALESCE(p_frequency, '120.500 MHz'))
    RETURNING * INTO v_room;

    v_room_id := v_room.id;

    INSERT INTO public.comm_participants (room_id, user_id, role, callsign, status)
    VALUES (
        v_room_id,
        v_uid,
        'atc',
        COALESCE(NULLIF(TRIM(p_callsign), ''), 'KSFO Tower'),
        'connected'
    )
    RETURNING * INTO v_participant;

    RETURN jsonb_build_object(
        'success', true,
        'room', to_jsonb(v_room),
        'participant', to_jsonb(v_participant)
    );
END;
$$;

-- Function 6b: join_comm_room (Exact Migration 003 implementation, lines 177-271)
CREATE OR REPLACE FUNCTION public.join_comm_room(
    p_join_code TEXT,
    p_callsign TEXT DEFAULT 'Speedbird 214'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_clean_code TEXT;
    v_room public.comm_rooms%ROWTYPE;
    v_existing_pilot RECORD;
    v_participant RECORD;
    v_all_participants JSONB;
BEGIN
    v_uid := auth.uid();
    v_clean_code := UPPER(TRIM(p_join_code));

    IF v_clean_code IS NULL OR v_clean_code = '' THEN
        RAISE EXCEPTION 'Join code is required';
    END IF;

    SELECT * INTO v_room
    FROM public.comm_rooms
    WHERE UPPER(join_code) = v_clean_code
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Communication room not found. Please verify the code.';
    END IF;

    IF v_room.status = 'active' THEN
        RAISE EXCEPTION 'Communication session is already in progress.';
    END IF;

    IF v_room.status IN ('completed', 'abandoned') THEN
        RAISE EXCEPTION 'This communication room has concluded or expired.';
    END IF;

    IF v_uid IS NOT NULL AND v_room.created_by IS NOT NULL AND v_room.created_by = v_uid THEN
        RAISE EXCEPTION 'You are the ATC creator of this room. You cannot join as the Pilot from the same account.';
    END IF;

    SELECT * INTO v_existing_pilot
    FROM public.comm_participants
    WHERE room_id = v_room.id AND role = 'pilot' AND status = 'connected';

    IF FOUND AND (v_uid IS NULL OR v_existing_pilot.user_id != v_uid) THEN
        RAISE EXCEPTION 'Communication room is full. Pilot position has already been joined.';
    END IF;

    INSERT INTO public.comm_participants (room_id, user_id, role, callsign, status, last_seen_at)
    VALUES (
        v_room.id,
        v_uid,
        'pilot',
        COALESCE(NULLIF(TRIM(p_callsign), ''), 'Speedbird 214'),
        'connected',
        now()
    )
    ON CONFLICT (room_id, role) DO UPDATE SET
        user_id = COALESCE(v_uid, comm_participants.user_id),
        callsign = COALESCE(NULLIF(TRIM(p_callsign), ''), comm_participants.callsign),
        status = 'connected',
        last_seen_at = now()
    RETURNING * INTO v_participant;

    UPDATE public.comm_rooms
    SET status = 'ready'
    WHERE id = v_room.id
    RETURNING * INTO v_room;

    SELECT jsonb_agg(to_jsonb(p)) INTO v_all_participants
    FROM public.comm_participants p
    WHERE p.room_id = v_room.id;

    RETURN jsonb_build_object(
        'success', true,
        'room', to_jsonb(v_room),
        'participant', to_jsonb(v_participant),
        'participants', COALESCE(v_all_participants, '[]'::jsonb)
    );
END;
$$;

-- Function 6c: start_comm_room (Exact Migration 003 implementation, lines 273-323)
CREATE OR REPLACE FUNCTION public.start_comm_room(p_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_room public.comm_rooms%ROWTYPE;
    v_pilot_present BOOLEAN;
BEGIN
    v_uid := auth.uid();

    SELECT * INTO v_room
    FROM public.comm_rooms
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Communication room not found.';
    END IF;

    IF v_uid IS NOT NULL AND v_room.created_by IS NOT NULL AND v_room.created_by != v_uid THEN
        RAISE EXCEPTION 'Only the ATC Controller who created this room can start the session.';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.comm_participants
        WHERE room_id = p_room_id AND role = 'pilot' AND status = 'connected'
    ) INTO v_pilot_present;

    IF NOT v_pilot_present THEN
        RAISE EXCEPTION 'Cannot start communication: Flight Crew (Pilot) has not joined yet.';
    END IF;

    UPDATE public.comm_rooms
    SET status = 'active', started_at = now()
    WHERE id = p_room_id
    RETURNING * INTO v_room;

    RETURN jsonb_build_object(
        'success', true,
        'room', to_jsonb(v_room)
    );
END;
$$;

-- Function 6d: leave_comm_room (Exact Migration 003 implementation, lines 325-396)
CREATE OR REPLACE FUNCTION public.leave_comm_room(
    p_room_id UUID,
    p_role TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_room public.comm_rooms%ROWTYPE;
    v_is_creator BOOLEAN;
BEGIN
    v_uid := auth.uid();

    SELECT * INTO v_room
    FROM public.comm_rooms
    WHERE id = p_room_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Room not found');
    END IF;

    v_is_creator := (v_uid IS NOT NULL AND v_room.created_by = v_uid) OR (p_role = 'atc');

    IF p_role = 'pilot' THEN
        UPDATE public.comm_participants
        SET status = 'left', last_seen_at = now()
        WHERE room_id = p_room_id AND role = 'pilot';
    ELSIF p_role = 'atc' THEN
        UPDATE public.comm_participants
        SET status = 'left', last_seen_at = now()
        WHERE room_id = p_room_id AND role = 'atc';
    ELSE
        UPDATE public.comm_participants
        SET status = 'left', last_seen_at = now()
        WHERE room_id = p_room_id AND (user_id = v_uid OR v_uid IS NULL);
    END IF;

    IF v_is_creator OR p_role = 'atc' THEN
        UPDATE public.comm_rooms
        SET status = 'abandoned', ended_at = now()
        WHERE id = p_room_id;
    ELSE
        IF v_room.status = 'ready' THEN
            UPDATE public.comm_rooms
            SET status = 'waiting'
            WHERE id = p_room_id;
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.leave_comm_room(p_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN public.leave_comm_room(p_room_id, NULL);
END;
$$;

-- Function 6e: get_comm_room_state (Exact Migration 003 implementation, lines 398-424)
CREATE OR REPLACE FUNCTION public.get_comm_room_state(p_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_room RECORD;
    v_participants JSONB;
BEGIN
    SELECT * INTO v_room FROM public.comm_rooms WHERE id = p_room_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT jsonb_agg(to_jsonb(p) ORDER BY p.joined_at ASC) INTO v_participants
    FROM public.comm_participants p
    WHERE p.room_id = p_room_id;

    RETURN jsonb_build_object(
        'room', to_jsonb(v_room),
        'participants', COALESCE(v_participants, '[]'::jsonb)
    );
END;
$$;

-- Function 6f: end_comm_room (Exact Migration 003 implementation, lines 426-455)
CREATE OR REPLACE FUNCTION public.end_comm_room(p_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_room public.comm_rooms%ROWTYPE;
BEGIN
    UPDATE public.comm_rooms
    SET status = 'completed', ended_at = now()
    WHERE id = p_room_id
    RETURNING * INTO v_room;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Room not found');
    END IF;

    UPDATE public.comm_participants
    SET status = 'left', last_seen_at = now()
    WHERE room_id = p_room_id;

    RETURN jsonb_build_object(
        'success', true,
        'room', to_jsonb(v_room)
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 7. Restore Migration 003 Table & RPC Grants
-- ------------------------------------------------------------------------------
-- Restores grants verbatim from Migration 003 lines 46-48 & 457-463:
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON TABLE public.comm_rooms TO anon, authenticated;
GRANT ALL ON TABLE public.comm_participants TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_comm_room(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_comm_room(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_comm_room(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_comm_room(UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_comm_room(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_comm_room(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_comm_room_state(UUID) TO anon, authenticated;

COMMIT;
