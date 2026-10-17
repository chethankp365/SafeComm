-- SafeComm Migration 011: Reset Demo Data RPC
-- Cleans up demo/test sessions, transmissions, verdicts, alerts, and rooms for a clean slate.

CREATE OR REPLACE FUNCTION public.reset_demo_data(
    p_user_id uuid DEFAULT NULL,
    p_force_all boolean DEFAULT FALSE
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_target_user uuid;
    v_sessions_deleted integer := 0;
    v_rooms_deleted integer := 0;
    v_alerts_deleted integer := 0;
BEGIN
    v_target_user := COALESCE(p_user_id, auth.uid());
    
    IF p_force_all THEN
        -- Wipe all simulation sessions & alerts for full reset
        DELETE FROM public.alerts;
        GET DIAGNOSTICS v_alerts_deleted = ROW_COUNT;

        DELETE FROM public.sessions;
        GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;

        DELETE FROM public.comm_rooms;
        GET DIAGNOSTICS v_rooms_deleted = ROW_COUNT;
    ELSIF v_target_user IS NOT NULL THEN
        -- Delete this user's sessions (cascades to transmissions, instructions, verdicts, alerts)
        DELETE FROM public.sessions WHERE user_id = v_target_user;
        GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;

        -- Delete rooms created by this user
        DELETE FROM public.comm_rooms WHERE created_by = v_target_user;
        GET DIAGNOSTICS v_rooms_deleted = ROW_COUNT;
    ELSE
        -- Delete sessions created anonymously or in demo mode
        DELETE FROM public.sessions 
        WHERE scenario_name ILIKE '%Demo%' 
           OR scenario_name ILIKE '%Approach%' 
           OR scenario_name ILIKE '%Comm Session%'
           OR scenario_name ILIKE '%Aeronautical%';
        GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'sessions_deleted', v_sessions_deleted,
        'rooms_deleted', v_rooms_deleted,
        'alerts_deleted', v_alerts_deleted
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reset_demo_data(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_demo_data(uuid, boolean) TO anon, authenticated, service_role;
