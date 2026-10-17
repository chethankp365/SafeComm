-- SafeComm Migration 008: Comm Ledger and Terminal Radar Scope RPCs
-- Provides high-performance, secure RPC functions for /ledger and /map querying real Supabase data.

-- 1. Ensure helper functions are executable
GRANT EXECUTE ON FUNCTION public.is_room_participant(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_room_owner(uuid) TO anon, authenticated, service_role;

-- 2. Function: get_comm_ledger_records
-- Retrieves joined transmission + verdict pairs across sessions or for a specific session.
CREATE OR REPLACE FUNCTION public.get_comm_ledger_records(
    p_session_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 500,
    p_offset integer DEFAULT 0
)
RETURNS TABLE (
    verdict_id uuid,
    session_id uuid,
    scenario_name text,
    created_at timestamptz,
    callsign text,
    instruction_type text,
    instruction_value text,
    direction text,
    controller_text text,
    readback_text text,
    outcome text,
    severity text,
    explanation text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        v.id AS verdict_id,
        s.id AS session_id,
        COALESCE(s.scenario_name, 'Aeronautical Comm Session')::text AS scenario_name,
        v.created_at,
        COALESCE(i.callsign, 'UNKNOWN')::text AS callsign,
        COALESCE(i.type, 'general')::text AS instruction_type,
        COALESCE(i.value, '')::text AS instruction_value,
        i.direction::text AS direction,
        atc.text::text AS controller_text,
        t_pilot.text::text AS readback_text,
        v.outcome::text AS outcome,
        v.severity::text AS severity,
        v.explanation::text AS explanation
    FROM public.verdicts v
    JOIN public.instructions i ON v.instruction_id = i.id
    JOIN public.transmissions t_pilot ON i.transmission_id = t_pilot.id
    JOIN public.sessions s ON t_pilot.session_id = s.id
    LEFT JOIN LATERAL (
        SELECT t_atc.text, t_atc.timestamp
        FROM public.transmissions t_atc
        WHERE t_atc.session_id = t_pilot.session_id
          AND t_atc.role = 'controller'
          AND t_atc.timestamp <= t_pilot.timestamp
        ORDER BY t_atc.timestamp DESC
        LIMIT 1
    ) atc ON true
    WHERE (p_session_id IS NULL OR s.id = p_session_id)
    ORDER BY v.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- 3. Function: get_radar_scope_aircraft
-- Summarizes active/recent aircraft callsigns with their latest instruction, readback, and verdict for radar plotting.
CREATE OR REPLACE FUNCTION public.get_radar_scope_aircraft(
    p_session_id uuid DEFAULT NULL
)
RETURNS TABLE (
    session_id uuid,
    scenario_name text,
    callsign text,
    last_seen timestamptz,
    latest_instruction text,
    latest_readback text,
    latest_outcome text,
    latest_severity text,
    latest_explanation text,
    assigned_altitude text,
    assigned_heading text,
    assigned_runway text,
    assigned_squawk text,
    total_verdicts bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    WITH RankedAircraftVerdicts AS (
        SELECT 
            s.id AS r_session_id,
            COALESCE(s.scenario_name, 'Aeronautical Comm Session')::text AS r_scenario_name,
            COALESCE(NULLIF(TRIM(i.callsign), ''), 'UNKNOWN')::text AS r_callsign,
            v.created_at AS r_created_at,
            atc.text::text AS r_controller_text,
            t_pilot.text::text AS r_readback_text,
            v.outcome::text AS r_outcome,
            v.severity::text AS r_severity,
            v.explanation::text AS r_explanation,
            i.type AS r_type,
            i.value AS r_value,
            ROW_NUMBER() OVER (
                PARTITION BY s.id, COALESCE(NULLIF(TRIM(i.callsign), ''), 'UNKNOWN')
                ORDER BY v.created_at DESC
            ) AS rn,
            COUNT(*) OVER (
                PARTITION BY s.id, COALESCE(NULLIF(TRIM(i.callsign), ''), 'UNKNOWN')
            ) AS r_total
        FROM public.verdicts v
        JOIN public.instructions i ON v.instruction_id = i.id
        JOIN public.transmissions t_pilot ON i.transmission_id = t_pilot.id
        JOIN public.sessions s ON t_pilot.session_id = s.id
        LEFT JOIN LATERAL (
            SELECT t_atc.text
            FROM public.transmissions t_atc
            WHERE t_atc.session_id = t_pilot.session_id
              AND t_atc.role = 'controller'
              AND t_atc.timestamp <= t_pilot.timestamp
            ORDER BY t_atc.timestamp DESC
            LIMIT 1
        ) atc ON true
        WHERE (p_session_id IS NULL OR s.id = p_session_id)
          AND i.callsign IS NOT NULL
          AND TRIM(i.callsign) NOT IN ('', 'UNKNOWN', 'ACTIVE')
    )
    SELECT
        rav.r_session_id AS session_id,
        rav.r_scenario_name AS scenario_name,
        rav.r_callsign AS callsign,
        rav.r_created_at AS last_seen,
        COALESCE(rav.r_controller_text, 'No preceding ATC transmission recorded.')::text AS latest_instruction,
        COALESCE(rav.r_readback_text, 'No pilot readback text recorded.')::text AS latest_readback,
        rav.r_outcome AS latest_outcome,
        rav.r_severity AS latest_severity,
        rav.r_explanation AS latest_explanation,
        COALESCE((
            SELECT i2.value FROM public.instructions i2
            JOIN public.transmissions t2 ON i2.transmission_id = t2.id
            WHERE t2.session_id = rav.r_session_id AND i2.callsign = rav.r_callsign AND i2.type = 'altitude'
            ORDER BY t2.timestamp DESC LIMIT 1
        ), '3000')::text AS assigned_altitude,
        COALESCE((
            SELECT i2.value FROM public.instructions i2
            JOIN public.transmissions t2 ON i2.transmission_id = t2.id
            WHERE t2.session_id = rav.r_session_id AND i2.callsign = rav.r_callsign AND i2.type = 'heading'
            ORDER BY t2.timestamp DESC LIMIT 1
        ), '090')::text AS assigned_heading,
        COALESCE((
            SELECT i2.value FROM public.instructions i2
            JOIN public.transmissions t2 ON i2.transmission_id = t2.id
            WHERE t2.session_id = rav.r_session_id AND i2.callsign = rav.r_callsign AND i2.type = 'runway'
            ORDER BY t2.timestamp DESC LIMIT 1
        ), '28R')::text AS assigned_runway,
        COALESCE((
            SELECT i2.value FROM public.instructions i2
            JOIN public.transmissions t2 ON i2.transmission_id = t2.id
            WHERE t2.session_id = rav.r_session_id AND i2.callsign = rav.r_callsign AND i2.type = 'squawk'
            ORDER BY t2.timestamp DESC LIMIT 1
        ), '4215')::text AS assigned_squawk,
        rav.r_total AS total_verdicts
    FROM RankedAircraftVerdicts rav
    WHERE rav.rn = 1
    ORDER BY rav.r_created_at DESC;
END;
$$;

-- 4. Grant permissions
REVOKE ALL ON FUNCTION public.get_comm_ledger_records(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_radar_scope_aircraft(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_comm_ledger_records(uuid, integer, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_radar_scope_aircraft(uuid) TO anon, authenticated, service_role;
