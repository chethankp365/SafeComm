-- ==============================================================================
-- SafeComm Migration 004: Revised Enterprise Two-User Communication Rooms
-- Non-Recursive RLS, Zero Direct-Write Privileges, Strict Identity Validation,
-- Collision-Safe Code Allocation, and Complete Lifecycle RPC Security
-- ==============================================================================
-- 
-- REVISION SUMMARY (Final Security & Compatibility):
-- 1. Transactional prerequisites: Validates schema and aborts safely if duplicate
--    join codes or duplicate participant roles exist before modifying policies.
-- 2. Unique index verification: Inspects pg_indexes for UPPER(join_code) definition,
--    not merely index name, guaranteeing uniqueness enforcement.
-- 3. Pilot upsert safeguard: Validates UNIQUE(room_id, role) constraint exists; aborts
--    with actionable deduplication remediation plan if duplicates are present.
-- 4. Precise unique-violation filtering: Stack diagnostics inspect CONSTRAINT_NAME
--    so only join_code collisions trigger retry; unrelated DB errors re-raise.
-- 5. Anti-probing helper security: is_comm_room_participant and is_comm_room_creator
--    reject queries for other users' IDs, preventing enumeration attacks.
-- 6. Consistent departed-participant access: Departed users (status = 'left') lose
--    access to room state across both RPC and RLS until reconnected via join_comm_room.
-- 7. Zero direct-write privileges: Authenticated users have SELECT only; all mutations
--    occur strictly through authorized SECURITY DEFINER RPC functions.
-- 8. Overload collision removed: leave_comm_room(uuid) is primary;
--    leave_comm_room(uuid, text) has NO default argument.
-- 
-- ROLLBACK FILE:
-- supabase/migrations/004_rollback_secure_comm_rooms.sql
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Prerequisites & Schema Validation
-- ------------------------------------------------------------------------------
-- Aborts immediately if prerequisites are not met, before touching any existing
-- policies or functions.
DO $$
DECLARE
    v_has_role_constraint BOOLEAN;
    v_has_upper_index BOOLEAN;
BEGIN
    -- 1a. Fail safely on duplicate join codes (case-insensitive)
    IF EXISTS (
        SELECT UPPER(join_code), COUNT(*) 
        FROM public.comm_rooms 
        GROUP BY UPPER(join_code) 
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'MIGRATION 004 ABORTED: Duplicate case-insensitive join_code values exist in public.comm_rooms. Remediation required: Deduplicate comm_rooms before running this migration.';
    END IF;

    -- 1b. Verify existing index definition for UPPER(join_code), not merely its name
    SELECT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE schemaname = 'public' 
          AND tablename = 'comm_rooms' 
          AND indexdef ILIKE '%UNIQUE INDEX%upper(%join_code%'
    ) INTO v_has_upper_index;

    IF NOT v_has_upper_index THEN
        CREATE UNIQUE INDEX idx_comm_rooms_join_code_upper 
            ON public.comm_rooms (UPPER(join_code));
    END IF;

    -- 1c. Verify that the unique constraint/index on comm_participants(room_id, role) exists
    SELECT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'public'
          AND t.relname = 'comm_participants'
          AND c.contype = 'u'
          AND (
            SELECT ARRAY_AGG(a.attname ORDER BY array_position(c.conkey, a.attnum))
            FROM pg_attribute a
            WHERE a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
          ) = ARRAY['room_id', 'role']
    ) OR EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'comm_participants'
          AND indexdef ILIKE '%UNIQUE INDEX%'
          AND indexdef ILIKE '%(room_id, role)%'
    ) INTO v_has_role_constraint;

    IF NOT v_has_role_constraint THEN
        -- Check if duplicate (room_id, role) data exists
        IF EXISTS (
            SELECT room_id, role, COUNT(*)
            FROM public.comm_participants
            GROUP BY room_id, role
            HAVING COUNT(*) > 1
        ) THEN
            RAISE EXCEPTION 'MIGRATION 004 ABORTED: comm_participants is missing a unique constraint on (room_id, role), and duplicate rows exist. Remediation required: Deduplicate comm_participants by preserving the latest row per (room_id, role) before adding the constraint.';
        ELSE
            ALTER TABLE public.comm_participants 
                ADD CONSTRAINT comm_room_role_unique UNIQUE (room_id, role);
        END IF;
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 2. Helper Functions (Non-Recursive RLS with Anti-Probing Defense)
-- ------------------------------------------------------------------------------
-- Prevents probing other users' room membership or creation.
-- Callers can only evaluate their own authenticated ID (auth.uid()).

CREATE OR REPLACE FUNCTION public.is_comm_room_participant(p_room_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Anti-probing defense: caller may only inspect their own participation
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM v_uid THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1 
        FROM public.comm_participants
        WHERE room_id = p_room_id 
          AND user_id = v_uid
          AND status IN ('connected', 'disconnected')
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_comm_room_creator(p_room_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Anti-probing defense: caller may only inspect their own room ownership
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM v_uid THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1 
        FROM public.comm_rooms
        WHERE id = p_room_id 
          AND created_by = v_uid
    );
END;
$$;

REVOKE ALL ON FUNCTION public.is_comm_room_participant(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_comm_room_creator(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_comm_room_participant(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_comm_room_creator(UUID, UUID) TO authenticated;

-- ------------------------------------------------------------------------------
-- 3. Row-Level Security Policies (SELECT Only)
-- ------------------------------------------------------------------------------
-- Direct INSERT/UPDATE/DELETE are completely revoked below. Only SELECT policies
-- are required for authenticated client reading and Realtime websocket streaming.

ALTER TABLE public.comm_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comm_participants ENABLE ROW LEVEL SECURITY;

-- Drop all previous policies cleanly
DROP POLICY IF EXISTS "comm_rooms_select" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_insert" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_update" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_select_participant" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_insert_creator" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_update_creator" ON public.comm_rooms;

DROP POLICY IF EXISTS "comm_participants_select" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_insert" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_update" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_select_member" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_insert_self" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_update_self" ON public.comm_participants;

-- comm_rooms: Only the room creator or an active participant can SELECT
CREATE POLICY "comm_rooms_select_participant"
    ON public.comm_rooms
    FOR SELECT
    TO authenticated
    USING (
        auth.uid() IS NOT NULL AND (
            created_by = auth.uid()
            OR public.is_comm_room_participant(id, auth.uid())
        )
    );

-- comm_participants: Only room creator or active participants can SELECT participants
CREATE POLICY "comm_participants_select_member"
    ON public.comm_participants
    FOR SELECT
    TO authenticated
    USING (
        auth.uid() IS NOT NULL AND (
            user_id = auth.uid()
            OR public.is_comm_room_creator(room_id, auth.uid())
            OR public.is_comm_room_participant(room_id, auth.uid())
        )
    );

-- ------------------------------------------------------------------------------
-- 4. Authorized Room Lifecycle RPC Functions (SECURITY DEFINER)
-- ------------------------------------------------------------------------------

-- Function 4a: create_comm_room
-- Collision-safe under concurrent execution with precise unique-violation filtering
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
    v_constraint TEXT;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required: You must be signed in to create a communication room.';
    END IF;

    LOOP
        v_attempts := v_attempts + 1;

        IF p_custom_code IS NOT NULL AND LENGTH(TRIM(p_custom_code)) >= 4 THEN
            v_code := UPPER(TRIM(p_custom_code));
            IF EXISTS (
                SELECT 1 FROM public.comm_rooms 
                WHERE UPPER(join_code) = v_code 
                  AND status IN ('waiting', 'ready', 'active')
            ) THEN
                RAISE EXCEPTION 'Communication code % is currently in use by an active room. Please choose another code.', v_code;
            END IF;
        ELSE
            v_code := 'SFC-' || LPAD(FLOOR(100 + RANDOM() * 900)::TEXT, 3, '0');
        END IF;

        BEGIN
            INSERT INTO public.comm_rooms (join_code, created_by, status, airport, frequency)
            VALUES (
                v_code, 
                v_uid, 
                'waiting', 
                COALESCE(NULLIF(TRIM(p_airport), ''), 'KSFO'), 
                COALESCE(NULLIF(TRIM(p_frequency), ''), '120.500 MHz')
            )
            RETURNING * INTO v_room;

            EXIT; -- Success, leave loop
        EXCEPTION
            WHEN unique_violation THEN
                -- Inspect constraint name: only handle join_code collisions, re-raise unrelated errors
                GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
                IF v_constraint IS NOT NULL AND v_constraint NOT IN (
                    'comm_rooms_join_code_key', 
                    'idx_comm_rooms_join_code_upper',
                    'comm_rooms_pkey'
                ) THEN
                    RAISE;
                END IF;

                IF p_custom_code IS NOT NULL AND LENGTH(TRIM(p_custom_code)) >= 4 THEN
                    RAISE EXCEPTION 'Communication code % was just taken by another user. Please choose a different code.', v_code;
                END IF;
                IF v_attempts > 50 THEN
                    RAISE EXCEPTION 'Unable to allocate a unique communication code after multiple attempts. Please try again.';
                END IF;
        END;
    END LOOP;

    v_room_id := v_room.id;

    -- Register Creator strictly as ATC Officer
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

-- Function 4b: join_comm_room
-- Atomic join validation with row lock and NULL-safe reconnect handling
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
        RAISE EXCEPTION 'Authentication required: You must be signed in to join a communication room.';
    END IF;

    v_clean_code := UPPER(TRIM(COALESCE(p_join_code, '')));
    IF v_clean_code = '' THEN
        RAISE EXCEPTION 'Join code is required.';
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

    -- Prohibit creator self-join
    IF v_room.created_by = v_uid THEN
        RAISE EXCEPTION 'You are the ATC creator of this room. You cannot join as the Pilot from the same account.';
    END IF;

    -- Check if pilot position is occupied by another user
    SELECT * INTO v_existing_pilot
    FROM public.comm_participants
    WHERE room_id = v_room.id AND role = 'pilot' AND status = 'connected';

    IF FOUND AND (v_existing_pilot.user_id IS DISTINCT FROM v_uid) THEN
        RAISE EXCEPTION 'Communication room is full. Pilot position has already been joined.';
    END IF;

    -- Register or reconnect Pilot strictly via verified ON CONFLICT constraint
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

    SELECT jsonb_agg(to_jsonb(p) ORDER BY p.joined_at ASC) INTO v_all_participants
    FROM public.comm_participants p
    WHERE p.room_id = v_room.id
      AND p.status IN ('connected', 'disconnected');

    RETURN jsonb_build_object(
        'success', true,
        'room', to_jsonb(v_room),
        'participant', to_jsonb(v_participant),
        'participants', COALESCE(v_all_participants, '[]'::jsonb)
    );
END;
$$;

-- Function 4c: start_comm_room
-- ATC creator only, verified Pilot required, idempotent if already active
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

    -- Idempotent return if already started
    IF v_room.status = 'active' THEN
        RETURN jsonb_build_object('success', true, 'room', to_jsonb(v_room));
    END IF;

    IF v_room.status IN ('completed', 'abandoned') THEN
        RAISE EXCEPTION 'This communication room has concluded or expired.';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.comm_participants
        WHERE room_id = p_room_id AND role = 'pilot' AND status = 'connected'
    ) INTO v_pilot_present;

    IF NOT v_pilot_present THEN
        RAISE EXCEPTION 'Cannot start communication: Flight Crew (Pilot) has not joined yet.';
    END IF;

    UPDATE public.comm_rooms
    SET status = 'active', started_at = COALESCE(started_at, now())
    WHERE id = p_room_id
    RETURNING * INTO v_room;

    RETURN jsonb_build_object(
        'success', true,
        'room', to_jsonb(v_room)
    );
END;
$$;

-- Function 4d: end_comm_room
-- ATC creator only, idempotent if already completed
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

    SELECT * INTO v_room
    FROM public.comm_rooms
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Communication room not found.';
    END IF;

    IF v_room.created_by != v_uid THEN
        RAISE EXCEPTION 'Only the ATC Controller who created this room can end the session.';
    END IF;

    -- Idempotent return if already completed
    IF v_room.status = 'completed' THEN
        RETURN jsonb_build_object('success', true, 'room', to_jsonb(v_room));
    END IF;

    UPDATE public.comm_rooms
    SET status = 'completed', ended_at = COALESCE(ended_at, now())
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

-- Function 4e: leave_comm_room (Canonical single-parameter signature)
-- Resolves caller identity solely via auth.uid(). Never trusts caller-supplied roles.
CREATE OR REPLACE FUNCTION public.leave_comm_room(p_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_room public.comm_rooms%ROWTYPE;
    v_participant public.comm_participants%ROWTYPE;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required: You must be signed in to leave the room.';
    END IF;

    SELECT * INTO v_room
    FROM public.comm_rooms
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Room not found');
    END IF;

    -- Find the caller's verified participant record
    SELECT * INTO v_participant
    FROM public.comm_participants
    WHERE room_id = p_room_id AND user_id = v_uid;

    IF NOT FOUND THEN
        -- Check if creator without participant row
        IF v_room.created_by = v_uid THEN
            UPDATE public.comm_rooms
            SET status = 'abandoned', ended_at = now()
            WHERE id = p_room_id;
            RETURN jsonb_build_object('success', true);
        END IF;
        RETURN jsonb_build_object('success', false, 'message', 'You are not a participant in this room');
    END IF;

    -- Update only the caller's verified participant row
    UPDATE public.comm_participants
    SET status = 'left', last_seen_at = now()
    WHERE id = v_participant.id;

    -- ATC creator departure terminates room; Pilot departure reverts ready room to waiting
    IF v_room.created_by = v_uid OR v_participant.role = 'atc' THEN
        UPDATE public.comm_rooms
        SET status = 'abandoned', ended_at = now()
        WHERE id = p_room_id;
    ELSIF v_participant.role = 'pilot' THEN
        IF v_room.status = 'ready' THEN
            UPDATE public.comm_rooms
            SET status = 'waiting'
            WHERE id = p_room_id;
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- Function 4e (Overload): leave_comm_room with explicit two arguments (NO DEFAULT)
-- Completely eliminates schema cache resolution ambiguity
CREATE OR REPLACE FUNCTION public.leave_comm_room(
    p_room_id UUID,
    p_role TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Ignores untrusted p_role and safely delegates to canonical leave_comm_room
    RETURN public.leave_comm_room(p_room_id);
END;
$$;

-- Function 4f: get_comm_room_state
-- Authenticated creator or active participant only (status in 'connected', 'disconnected')
-- Consistent with RLS policy: departed participants ('left') are strictly denied access.
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

    -- Strict authorization: caller must be creator or an active participant
    IF v_room.created_by != v_uid AND NOT EXISTS (
        SELECT 1 FROM public.comm_participants
        WHERE room_id = p_room_id 
          AND user_id = v_uid
          AND status IN ('connected', 'disconnected')
    ) THEN
        RAISE EXCEPTION 'Unauthorized: You are not an active participant in this communication room.';
    END IF;

    SELECT jsonb_agg(to_jsonb(p) ORDER BY p.joined_at ASC) INTO v_participants
    FROM public.comm_participants p
    WHERE p.room_id = p_room_id
      AND p.status IN ('connected', 'disconnected');

    RETURN jsonb_build_object(
        'room', to_jsonb(v_room),
        'participants', COALESCE(v_participants, '[]'::jsonb)
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 5. Revocations & Grants (Principle of Least Privilege)
-- ------------------------------------------------------------------------------

-- Revoke all function execution privileges from PUBLIC and anonymous users
REVOKE ALL ON FUNCTION public.create_comm_room(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_comm_room(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_comm_room(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.end_comm_room(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_comm_room(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_comm_room(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_comm_room_state(UUID) FROM PUBLIC, anon;

-- Grant execution strictly to authenticated users
GRANT EXECUTE ON FUNCTION public.create_comm_room(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_comm_room(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_comm_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_comm_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_comm_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_comm_room(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_comm_room_state(UUID) TO authenticated;

-- Table Permissions: SELECT only for authenticated users (for queries & Realtime)
-- All INSERT, UPDATE, DELETE, TRUNCATE privileges completely revoked
GRANT SELECT ON TABLE public.comm_rooms TO authenticated;
GRANT SELECT ON TABLE public.comm_participants TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.comm_rooms FROM authenticated, anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.comm_participants FROM authenticated, anon, PUBLIC;
REVOKE ALL ON TABLE public.comm_rooms FROM anon, PUBLIC;
REVOKE ALL ON TABLE public.comm_participants FROM anon, PUBLIC;

COMMIT;
