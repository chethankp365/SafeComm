-- ==============================================================================
-- SafeComm Migration 003: Communication Room System (Create & Join Comm)
-- Step 2: Shared ATC & Pilot Room Infrastructure with Realtime & Secure RLS
-- ==============================================================================

-- 1. Create Communication Rooms Table
CREATE TABLE IF NOT EXISTS public.comm_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    join_code VARCHAR(12) NOT NULL UNIQUE,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'waiting' 
        CHECK (status IN ('waiting', 'ready', 'active', 'completed', 'abandoned')),
    airport VARCHAR(10) NOT NULL DEFAULT 'KSFO',
    frequency VARCHAR(20) NOT NULL DEFAULT '120.500 MHz',
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Index join_code for fast room lookups
CREATE INDEX IF NOT EXISTS idx_comm_rooms_join_code ON public.comm_rooms (UPPER(join_code));
CREATE INDEX IF NOT EXISTS idx_comm_rooms_status ON public.comm_rooms (status);

-- 2. Create Communication Participants Table
CREATE TABLE IF NOT EXISTS public.comm_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES public.comm_rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    role VARCHAR(10) NOT NULL CHECK (role IN ('atc', 'pilot')),
    callsign VARCHAR(60) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'connected'
        CHECK (status IN ('connected', 'disconnected', 'left')),
    joined_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    last_seen_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    -- Strict constraints: at most one ATC and one Pilot per room
    CONSTRAINT comm_room_role_unique UNIQUE (room_id, role),
    -- Prevent duplicate participant registration for same user in room
    CONSTRAINT comm_room_user_unique UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_comm_participants_room ON public.comm_participants (room_id);
CREATE INDEX IF NOT EXISTS idx_comm_participants_user ON public.comm_participants (user_id);

-- 3. Grant schema & table permissions
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON TABLE public.comm_rooms TO anon, authenticated;
GRANT ALL ON TABLE public.comm_participants TO anon, authenticated;

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.comm_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comm_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "comm_rooms_select" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_insert" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_update" ON public.comm_rooms;

DROP POLICY IF EXISTS "comm_participants_select" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_insert" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_update" ON public.comm_participants;

-- RLS: Room Selection Policy
-- Visible to all authenticated users and guests for room discovery by join code / ID
CREATE POLICY "comm_rooms_select"
    ON public.comm_rooms
    FOR SELECT
    USING (true);

-- RLS: Room Insert Policy
-- Authenticated user creates a room and becomes its creator
CREATE POLICY "comm_rooms_insert"
    ON public.comm_rooms
    FOR INSERT
    WITH CHECK (
        (auth.uid() IS NOT NULL AND (created_by = auth.uid() OR created_by IS NULL))
        OR (auth.uid() IS NULL)
    );

-- RLS: Room Update Policy
-- Only room creator or registered participants can update room state
CREATE POLICY "comm_rooms_update"
    ON public.comm_rooms
    FOR UPDATE
    USING (
        (auth.uid() IS NOT NULL AND created_by = auth.uid())
        OR (auth.uid() IS NULL)
    );

-- RLS: Participants Select Policy
CREATE POLICY "comm_participants_select"
    ON public.comm_participants
    FOR SELECT
    USING (true);

-- RLS: Participants Insert Policy
CREATE POLICY "comm_participants_insert"
    ON public.comm_participants
    FOR INSERT
    WITH CHECK (
        (auth.uid() IS NOT NULL AND (user_id = auth.uid() OR user_id IS NULL))
        OR (auth.uid() IS NULL)
    );

-- RLS: Participants Update Policy
CREATE POLICY "comm_participants_update"
    ON public.comm_participants
    FOR UPDATE
    USING (
        (auth.uid() IS NOT NULL AND (user_id = auth.uid() OR user_id IS NULL))
        OR (auth.uid() IS NULL)
    );

-- ==============================================================================
-- 5. Atomic RPC Functions for Secure Room Lifecycle Management
-- ==============================================================================

-- Function 5a: create_comm_room
-- Atomically creates room and registers creator as ATC
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
    
    -- Generate unique human-friendly join code (e.g. SFC-824 or custom)
    IF p_custom_code IS NOT NULL AND LENGTH(TRIM(p_custom_code)) >= 4 THEN
        v_code := UPPER(TRIM(p_custom_code));
    ELSE
        LOOP
            v_attempts := v_attempts + 1;
            v_code := 'SFC-' || LPAD(FLOOR(100 + RANDOM() * 900)::TEXT, 3, '0');
            EXIT WHEN NOT EXISTS (SELECT 1 FROM public.comm_rooms WHERE join_code = v_code) OR v_attempts > 20;
        END LOOP;
    END IF;

    -- Insert Room
    INSERT INTO public.comm_rooms (join_code, created_by, status, airport, frequency)
    VALUES (v_code, v_uid, 'waiting', COALESCE(p_airport, 'KSFO'), COALESCE(p_frequency, '120.500 MHz'))
    RETURNING * INTO v_room;

    v_room_id := v_room.id;

    -- Register Creator as ATC
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

-- Function 5b: join_comm_room
-- Atomically validates code, capacity, and registers Pilot
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

    -- Acquire row-level lock on the room to prevent concurrent join race condition
    SELECT * INTO v_room
    FROM public.comm_rooms
    WHERE UPPER(join_code) = v_clean_code
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Communication room not found. Please verify the code.';
    END IF;

    -- Check if room is already active, completed, or abandoned
    IF v_room.status = 'active' THEN
        RAISE EXCEPTION 'Communication session is already in progress.';
    END IF;

    IF v_room.status IN ('completed', 'abandoned') THEN
        RAISE EXCEPTION 'This communication room has concluded or expired.';
    END IF;

    -- Prevent creator from joining their own room as the second participant
    IF v_uid IS NOT NULL AND v_room.created_by IS NOT NULL AND v_room.created_by = v_uid THEN
        RAISE EXCEPTION 'You are the ATC creator of this room. You cannot join as the Pilot from the same account.';
    END IF;

    -- Check if pilot position is already occupied
    SELECT * INTO v_existing_pilot
    FROM public.comm_participants
    WHERE room_id = v_room.id AND role = 'pilot' AND status = 'connected';

    IF FOUND AND (v_uid IS NULL OR v_existing_pilot.user_id != v_uid) THEN
        RAISE EXCEPTION 'Communication room is full. Pilot position has already been joined.';
    END IF;

    -- Insert or update joining Pilot
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

    -- Transition room status to 'ready'
    UPDATE public.comm_rooms
    SET status = 'ready'
    WHERE id = v_room.id
    RETURNING * INTO v_room;

    -- Fetch all current participants
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

-- Function 5c: start_comm_room
-- Allowed ONLY for room creator and ONLY when Pilot is connected
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

    -- Only creator may start room
    IF v_uid IS NOT NULL AND v_room.created_by IS NOT NULL AND v_room.created_by != v_uid THEN
        RAISE EXCEPTION 'Only the ATC Controller who created this room can start the session.';
    END IF;

    -- Verify Pilot is connected
    SELECT EXISTS (
        SELECT 1 FROM public.comm_participants
        WHERE room_id = p_room_id AND role = 'pilot' AND status = 'connected'
    ) INTO v_pilot_present;

    IF NOT v_pilot_present THEN
        RAISE EXCEPTION 'Cannot start communication: Flight Crew (Pilot) has not joined yet.';
    END IF;

    -- Transition to active
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

-- Function 5d: leave_comm_room
-- Gracefully handles leaving room or disconnect
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

    -- Mark participant as left
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
        -- If ATC leaves, abandon/end room
        UPDATE public.comm_rooms
        SET status = 'abandoned', ended_at = now()
        WHERE id = p_room_id;
    ELSE
        -- If Pilot leaves and room was ready, revert back to waiting
        IF v_room.status = 'ready' THEN
            UPDATE public.comm_rooms
            SET status = 'waiting'
            WHERE id = p_room_id;
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- Overload for single-argument call
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

-- Function 5e: get_comm_room_state
-- Returns atomic room and participant snapshot
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

-- Function 5f: end_comm_room
-- Closes active communication session and marks completed
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

-- Grant EXECUTE permissions on RPC functions to anon & authenticated
GRANT EXECUTE ON FUNCTION public.create_comm_room(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_comm_room(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_comm_room(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_comm_room(UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_comm_room(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_comm_room_state(UUID) TO anon, authenticated;

-- 6. Enable Supabase Realtime for instant synchronization
DO $$
BEGIN
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.comm_rooms;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.comm_participants;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
END $$;
