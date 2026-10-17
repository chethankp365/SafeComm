-- ==============================================================================
-- SafeComm Migration 004: Hardened Recovery Strategy (Secure Alternative)
-- Use this script instead of a literal 003 rollback if you wish to revert
-- Migration 004 changes without re-opening anonymous write access.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Drop Migration 004 Helper Functions & Overloads
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.is_comm_room_participant(UUID, UUID);
DROP FUNCTION IF EXISTS public.is_comm_room_participant(UUID);
DROP FUNCTION IF EXISTS public.is_comm_room_creator(UUID, UUID);
DROP FUNCTION IF EXISTS public.is_comm_room_creator(UUID);

DROP FUNCTION IF EXISTS public.leave_comm_room(UUID, TEXT);
DROP FUNCTION IF EXISTS public.leave_comm_room(UUID);

-- ------------------------------------------------------------------------------
-- 2. Revert Case-Insensitive Unique Index
-- ------------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_comm_rooms_join_code_upper;
CREATE INDEX IF NOT EXISTS idx_comm_rooms_join_code ON public.comm_rooms (UPPER(join_code));

-- ------------------------------------------------------------------------------
-- 3. Hardened RLS Policies (Authenticated Only, No Anonymous Data Leakage)
-- ------------------------------------------------------------------------------
ALTER TABLE public.comm_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comm_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "comm_rooms_select_participant" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_participants_select_member" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_rooms_select" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_insert" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_update" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_participants_select" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_insert" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_update" ON public.comm_participants;

-- Authenticated users can discover rooms and read participants; anonymous blocked
CREATE POLICY "comm_rooms_select_auth"
    ON public.comm_rooms
    FOR SELECT
    TO authenticated
    USING (auth.uid() IS NOT NULL);

CREATE POLICY "comm_participants_select_auth"
    ON public.comm_participants
    FOR SELECT
    TO authenticated
    USING (auth.uid() IS NOT NULL);

-- ------------------------------------------------------------------------------
-- 4. Restore Migration 003 RPC Functions (Executed Under Safe Search Path)
-- ------------------------------------------------------------------------------

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
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required: You must be signed in to create a room.';
    END IF;
    
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
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required: You must be signed in to join a room.';
    END IF;

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

    IF v_room.created_by = v_uid THEN
        RAISE EXCEPTION 'You are the ATC creator of this room. You cannot join as the Pilot from the same account.';
    END IF;

    SELECT * INTO v_existing_pilot
    FROM public.comm_participants
    WHERE room_id = v_room.id AND role = 'pilot' AND status = 'connected';

    IF FOUND AND v_existing_pilot.user_id != v_uid THEN
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
        user_id = v_uid,
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
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required: You must be signed in to start communication.';
    END IF;

    SELECT * INTO v_room
    FROM public.comm_rooms
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Communication room not found.';
    END IF;

    IF v_room.created_by != v_uid THEN
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
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required: You must be signed in to leave the room.';
    END IF;

    SELECT * INTO v_room
    FROM public.comm_rooms
    WHERE id = p_room_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Room not found');
    END IF;

    v_is_creator := (v_room.created_by = v_uid) OR (p_role = 'atc');

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
        WHERE room_id = p_room_id AND user_id = v_uid;
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

CREATE OR REPLACE FUNCTION public.get_comm_room_state(p_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_room RECORD;
    v_participants JSONB;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required: You must be signed in to access room state.';
    END IF;

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

CREATE OR REPLACE FUNCTION public.end_comm_room(p_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_room public.comm_rooms%ROWTYPE;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required: You must be signed in to end communication.';
    END IF;

    SELECT * INTO v_room FROM public.comm_rooms WHERE id = p_room_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Room not found');
    END IF;

    IF v_room.created_by != v_uid THEN
        RAISE EXCEPTION 'Only the ATC Controller who created this room can end the session.';
    END IF;

    UPDATE public.comm_rooms
    SET status = 'completed', ended_at = now()
    WHERE id = p_room_id
    RETURNING * INTO v_room;

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
-- 5. Privileges & Grants: Authenticated Only (No Anonymous Table Writes)
-- ------------------------------------------------------------------------------
GRANT SELECT ON TABLE public.comm_rooms TO authenticated;
GRANT SELECT ON TABLE public.comm_participants TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.comm_rooms FROM authenticated, anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.comm_participants FROM authenticated, anon, PUBLIC;
REVOKE ALL ON TABLE public.comm_rooms FROM anon, PUBLIC;
REVOKE ALL ON TABLE public.comm_participants FROM anon, PUBLIC;

REVOKE ALL ON FUNCTION public.create_comm_room(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_comm_room(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_comm_room(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_comm_room(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_comm_room(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.end_comm_room(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_comm_room_state(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_comm_room(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_comm_room(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_comm_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_comm_room(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_comm_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_comm_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_comm_room_state(UUID) TO authenticated;

COMMIT;
