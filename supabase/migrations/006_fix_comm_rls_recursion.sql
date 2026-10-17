-- ==============================================================================
-- SafeComm Migration 006: Repair Circular RLS Policies on Comm Tables
-- Idempotent forward migration: Breaks mutual recursion between comm_rooms and
-- comm_participants using SECURITY DEFINER helper functions.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Helper Functions (SECURITY DEFINER with fixed search_path)
-- ------------------------------------------------------------------------------
-- These functions run with table owner privileges, bypassing table RLS inside
-- their subqueries and breaking the mutual recursion between tables.

CREATE OR REPLACE FUNCTION public.is_room_participant(p_room_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL OR p_room_id IS NULL THEN
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

CREATE OR REPLACE FUNCTION public.is_room_owner(p_room_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL OR p_room_id IS NULL THEN
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

-- Lock down helper function execution
REVOKE ALL ON FUNCTION public.is_room_participant(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_room_owner(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_room_participant(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_room_owner(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 2. Drop Recursing Policies on comm_rooms and comm_participants
-- ------------------------------------------------------------------------------

DROP POLICY IF EXISTS "comm_rooms_select" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_select_participant" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_insert" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_insert_creator" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_update" ON public.comm_rooms;
DROP POLICY IF EXISTS "comm_rooms_update_creator" ON public.comm_rooms;

DROP POLICY IF EXISTS "comm_participants_select" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_select_member" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_insert" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_insert_self" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_update" ON public.comm_participants;
DROP POLICY IF EXISTS "comm_participants_update_self" ON public.comm_participants;

-- Ensure RLS is enabled
ALTER TABLE public.comm_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comm_participants ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- 3. Re-create Clean Non-Recursive Policies
-- ------------------------------------------------------------------------------

-- comm_rooms: Authenticated creators and room participants can view room metadata
CREATE POLICY "comm_rooms_select_participant"
    ON public.comm_rooms
    FOR SELECT
    TO authenticated
    USING (
        auth.uid() IS NOT NULL AND (
            created_by = auth.uid()
            OR public.is_room_participant(id)
        )
    );

-- comm_rooms: Authenticated users can insert rooms where they are the creator
CREATE POLICY "comm_rooms_insert_creator"
    ON public.comm_rooms
    FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() IS NOT NULL AND (
            created_by = auth.uid() 
            OR created_by IS NULL
        )
    );

-- comm_rooms: Only the room creator can update the room
CREATE POLICY "comm_rooms_update_creator"
    ON public.comm_rooms
    FOR UPDATE
    TO authenticated
    USING (
        auth.uid() IS NOT NULL AND created_by = auth.uid()
    );

-- comm_participants: Participants can view members in their own room; creators can view all members
CREATE POLICY "comm_participants_select_member"
    ON public.comm_participants
    FOR SELECT
    TO authenticated
    USING (
        auth.uid() IS NOT NULL AND (
            user_id = auth.uid()
            OR public.is_room_owner(room_id)
            OR public.is_room_participant(room_id)
        )
    );

-- comm_participants: Users can insert their own participant entry
CREATE POLICY "comm_participants_insert_self"
    ON public.comm_participants
    FOR INSERT
    TO authenticated
    WITH CHECK (
        auth.uid() IS NOT NULL AND (
            user_id = auth.uid() 
            OR user_id IS NULL
        )
    );

-- comm_participants: Users can only update their own participant row
CREATE POLICY "comm_participants_update_self"
    ON public.comm_participants
    FOR UPDATE
    TO authenticated
    USING (
        auth.uid() IS NOT NULL AND user_id = auth.uid()
    );

COMMIT;
