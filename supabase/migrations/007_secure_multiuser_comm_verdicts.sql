-- SafeComm Migration 007: Authorize Multi-User Comm Room Verdicts, Transmissions and Alerts
-- Fixes RLS policies on sessions, transmissions, instructions, verdicts and alerts to permit
-- authenticated participants of comm_rooms to save and read multi-user session verdicts.

-- 1. Ensure SECURITY DEFINER helpers exist (from Migration 006)
CREATE OR REPLACE FUNCTION public.is_room_participant(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.comm_participants
    WHERE room_id = p_room_id
      AND user_id = auth.uid()
      AND status IN ('connected', 'disconnected')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_room_owner(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.comm_rooms
    WHERE id = p_room_id
      AND created_by = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_room_participant(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_room_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_room_participant(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_room_owner(uuid) TO authenticated, service_role;
REVOKE ALL ON TABLE
    public.sessions,
    public.transmissions,
    public.instructions,
    public.verdicts,
    public.alerts
FROM anon;

-- 2. Update Sessions Policies for Multi-User Rooms
DROP POLICY IF EXISTS "Users can manage own sessions" ON public.sessions;

CREATE POLICY "Users can manage own sessions"
    ON public.sessions
    FOR ALL
    TO authenticated
    USING (
        auth.uid() IS NOT NULL
        AND (auth.uid() = user_id OR public.is_room_participant(id) OR public.is_room_owner(id))
    )
    WITH CHECK (
        auth.uid() IS NOT NULL
        AND (auth.uid() = user_id OR public.is_room_participant(id) OR public.is_room_owner(id))
    );

-- 3. Update Transmissions Policies
DROP POLICY IF EXISTS "Users can manage transmissions in own sessions" ON public.transmissions;

CREATE POLICY "Users can manage transmissions in own sessions"
    ON public.transmissions
    FOR ALL
    TO authenticated
    USING (
        session_id IN (
            SELECT id FROM public.sessions
            WHERE auth.uid() IS NOT NULL
              AND (auth.uid() = user_id OR public.is_room_participant(id) OR public.is_room_owner(id))
        )
        OR public.is_room_participant(session_id)
        OR public.is_room_owner(session_id)
    )
    WITH CHECK (
        session_id IN (
            SELECT id FROM public.sessions
            WHERE auth.uid() IS NOT NULL
              AND (auth.uid() = user_id OR public.is_room_participant(id) OR public.is_room_owner(id))
        )
        OR public.is_room_participant(session_id)
        OR public.is_room_owner(session_id)
    );

-- 4. Update Instructions Policies
DROP POLICY IF EXISTS "Users can manage instructions in own sessions" ON public.instructions;

CREATE POLICY "Users can manage instructions in own sessions"
    ON public.instructions
    FOR ALL
    TO authenticated
    USING (
        transmission_id IN (
            SELECT t.id FROM public.transmissions t
            WHERE public.is_room_participant(t.session_id)
               OR public.is_room_owner(t.session_id)
               OR t.session_id IN (
                   SELECT s.id FROM public.sessions s
                   WHERE auth.uid() IS NOT NULL AND auth.uid() = s.user_id
               )
        )
    )
    WITH CHECK (
        transmission_id IN (
            SELECT t.id FROM public.transmissions t
            WHERE public.is_room_participant(t.session_id)
               OR public.is_room_owner(t.session_id)
               OR t.session_id IN (
                   SELECT s.id FROM public.sessions s
                   WHERE auth.uid() IS NOT NULL AND auth.uid() = s.user_id
               )
        )
    );

-- 5. Update Verdicts Policies
DROP POLICY IF EXISTS "Users can manage verdicts in own sessions" ON public.verdicts;

CREATE POLICY "Users can manage verdicts in own sessions"
    ON public.verdicts
    FOR ALL
    TO authenticated
    USING (
        instruction_id IN (
            SELECT i.id FROM public.instructions i
            JOIN public.transmissions t ON i.transmission_id = t.id
            WHERE public.is_room_participant(t.session_id)
               OR public.is_room_owner(t.session_id)
               OR t.session_id IN (
                   SELECT s.id FROM public.sessions s
                   WHERE auth.uid() IS NOT NULL AND auth.uid() = s.user_id
               )
        )
    )
    WITH CHECK (
        instruction_id IN (
            SELECT i.id FROM public.instructions i
            JOIN public.transmissions t ON i.transmission_id = t.id
            WHERE public.is_room_participant(t.session_id)
               OR public.is_room_owner(t.session_id)
               OR t.session_id IN (
                   SELECT s.id FROM public.sessions s
                   WHERE auth.uid() IS NOT NULL AND auth.uid() = s.user_id
               )
        )
    );

-- 6. Update Alerts Policies
DROP POLICY IF EXISTS "Users can manage alerts in own sessions" ON public.alerts;

CREATE POLICY "Users can manage alerts in own sessions"
    ON public.alerts
    FOR ALL
    TO authenticated
    USING (
        verdict_id IN (
            SELECT v.id FROM public.verdicts v
            JOIN public.instructions i ON v.instruction_id = i.id
            JOIN public.transmissions t ON i.transmission_id = t.id
            WHERE public.is_room_participant(t.session_id)
               OR public.is_room_owner(t.session_id)
               OR t.session_id IN (
                   SELECT s.id FROM public.sessions s
                   WHERE auth.uid() IS NOT NULL AND auth.uid() = s.user_id
               )
        )
    )
    WITH CHECK (
        verdict_id IN (
            SELECT v.id FROM public.verdicts v
            JOIN public.instructions i ON v.instruction_id = i.id
            JOIN public.transmissions t ON i.transmission_id = t.id
            WHERE public.is_room_participant(t.session_id)
               OR public.is_room_owner(t.session_id)
               OR t.session_id IN (
                   SELECT s.id FROM public.sessions s
                   WHERE auth.uid() IS NOT NULL AND auth.uid() = s.user_id
               )
        )
    );
