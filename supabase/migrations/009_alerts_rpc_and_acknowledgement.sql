-- SafeComm Migration 009: Safety Alerts RPCs & Persistence
-- Supports listing HIGH/MEDIUM alerts, live acknowledgement updates in Supabase, and unread counts.

-- 1. Function: get_safety_alerts
-- Retrieves all alerts for HIGH (CRITICAL) and MEDIUM (WARNING) safety deviations, joined with clearance telemetry.
CREATE OR REPLACE FUNCTION public.get_safety_alerts(
    p_severity_filter text DEFAULT NULL,
    p_limit integer DEFAULT 200
)
RETURNS TABLE (
    alert_id uuid,
    verdict_id uuid,
    acknowledged boolean,
    created_at timestamptz,
    callsign text,
    outcome text,
    severity text,
    severity_tier text,
    explanation text,
    controller_text text,
    readback_text text,
    session_id uuid,
    scenario_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(a.id, v.id) AS alert_id,
        v.id AS verdict_id,
        COALESCE(a.acknowledged, false) AS acknowledged,
        v.created_at,
        COALESCE(NULLIF(TRIM(i.callsign), ''), 'UNKNOWN')::text AS callsign,
        v.outcome::text AS outcome,
        v.severity::text AS severity,
        CASE 
            WHEN v.severity = 'CRITICAL' THEN 'HIGH'
            WHEN v.severity = 'WARNING' THEN 'MEDIUM'
            ELSE 'LOW'
        END::text AS severity_tier,
        v.explanation::text AS explanation,
        atc.text::text AS controller_text,
        t_pilot.text::text AS readback_text,
        s.id AS session_id,
        COALESCE(s.scenario_name, 'Aeronautical Comm Session')::text AS scenario_name
    FROM public.verdicts v
    JOIN public.instructions i ON v.instruction_id = i.id
    JOIN public.transmissions t_pilot ON i.transmission_id = t_pilot.id
    JOIN public.sessions s ON t_pilot.session_id = s.id
    LEFT JOIN public.alerts a ON a.verdict_id = v.id
    LEFT JOIN LATERAL (
        SELECT t_atc.text
        FROM public.transmissions t_atc
        WHERE t_atc.session_id = t_pilot.session_id
          AND t_atc.role = 'controller'
          AND t_atc.timestamp <= t_pilot.timestamp
        ORDER BY t_atc.timestamp DESC
        LIMIT 1
    ) atc ON true
    WHERE (
        p_severity_filter IS NULL 
        OR (p_severity_filter = 'HIGH' AND v.severity = 'CRITICAL')
        OR (p_severity_filter = 'MEDIUM' AND v.severity = 'WARNING')
        OR (p_severity_filter = 'LOW' AND v.severity = 'OK')
        OR (p_severity_filter = 'ALL')
    )
    ORDER BY v.created_at DESC
    LIMIT p_limit;
END;
$$;

-- 2. Function: acknowledge_safety_alert
-- Updates or inserts the acknowledgement status in public.alerts table in Supabase.
CREATE OR REPLACE FUNCTION public.acknowledge_safety_alert(
    p_alert_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated boolean := false;
BEGIN
    -- 1. Attempt update existing alert row by id or verdict_id
    UPDATE public.alerts
    SET acknowledged = true
    WHERE id = p_alert_id OR verdict_id = p_alert_id;

    IF FOUND THEN
        RETURN true;
    END IF;

    -- 2. If verdict exists but no alert row yet, insert acknowledged alert
    IF EXISTS (SELECT 1 FROM public.verdicts WHERE id = p_alert_id) THEN
        INSERT INTO public.alerts (id, verdict_id, acknowledged, created_at)
        VALUES (p_alert_id, p_alert_id, true, timezone('utc'::text, now()))
        ON CONFLICT (id) DO UPDATE SET acknowledged = true;
        RETURN true;
    END IF;

    -- 3. Fallback insert
    INSERT INTO public.alerts (id, verdict_id, acknowledged, created_at)
    VALUES (p_alert_id, p_alert_id, true, timezone('utc'::text, now()))
    ON CONFLICT (id) DO UPDATE SET acknowledged = true;

    RETURN true;
END;
$$;

-- 3. Function: get_unread_alerts_count
-- Computes the count of unacknowledged HIGH and MEDIUM safety alerts
CREATE OR REPLACE FUNCTION public.get_unread_alerts_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    SELECT COUNT(*)::integer INTO v_count
    FROM public.verdicts v
    LEFT JOIN public.alerts a ON a.verdict_id = v.id
    WHERE v.severity IN ('CRITICAL', 'WARNING')
      AND COALESCE(a.acknowledged, false) = false;
    RETURN COALESCE(v_count, 0);
END;
$$;

-- 4. Grant execution permissions
REVOKE ALL ON FUNCTION public.get_safety_alerts(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acknowledge_safety_alert(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_unread_alerts_count() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_safety_alerts(text, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.acknowledge_safety_alert(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_unread_alerts_count() TO anon, authenticated, service_role;
