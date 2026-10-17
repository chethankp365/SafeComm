-- SafeComm Migration 010: Safety Analytics RPC
-- Computes real metrics from public.transmissions, public.verdicts, and public.sessions
-- for /analytics dashboard without mock or hardcoded numbers.

CREATE OR REPLACE FUNCTION public.get_safety_analytics()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_total_transmissions bigint;
    v_total_verdicts bigint;
    v_match_count bigint;
    v_mismatch_count bigint;
    v_partial_count bigint;
    v_unverified_count bigint;
    v_high_severity bigint;
    v_medium_severity bigint;
    v_low_severity bigint;
    v_error_rate numeric;
    v_trend_data jsonb;
    v_outcome_distribution jsonb;
    v_result jsonb;
BEGIN
    -- 1. Transmissions total
    SELECT COUNT(*) INTO v_total_transmissions FROM public.transmissions;

    -- 2. Verdicts totals & breakdown
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE outcome = 'MATCH'),
        COUNT(*) FILTER (WHERE outcome = 'MISMATCH'),
        COUNT(*) FILTER (WHERE outcome = 'PARTIAL'),
        COUNT(*) FILTER (WHERE outcome = 'UNVERIFIED'),
        COUNT(*) FILTER (WHERE severity = 'CRITICAL'),
        COUNT(*) FILTER (WHERE severity = 'WARNING'),
        COUNT(*) FILTER (WHERE severity = 'OK')
    INTO 
        v_total_verdicts,
        v_match_count,
        v_mismatch_count,
        v_partial_count,
        v_unverified_count,
        v_high_severity,
        v_medium_severity,
        v_low_severity
    FROM public.verdicts;

    -- 3. Error rate: % of verdicts that aren't MATCH
    IF v_total_verdicts > 0 THEN
        v_error_rate := ROUND((((v_total_verdicts - v_match_count)::numeric / v_total_verdicts::numeric) * 100.0), 1);
    ELSE
        v_error_rate := 0.0;
    END IF;

    -- 4. Trend data grouped by session timestamp
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'sessionId', session_id,
                'sessionName', scenario_name,
                'timestamp', session_time,
                'formattedDate', to_char(session_time, 'Mon DD HH24:MI'),
                'total', session_total,
                'matches', session_matches,
                'errors', session_errors,
                'mismatches', session_mismatches,
                'errorRate', CASE 
                    WHEN session_total > 0 THEN ROUND(((session_errors::numeric / session_total::numeric) * 100.0), 1)
                    ELSE 0.0 
                END
            ) ORDER BY session_time ASC
        ),
        '[]'::jsonb
    )
    INTO v_trend_data
    FROM (
        SELECT 
            s.id AS session_id,
            COALESCE(s.scenario_name, 'Aeronautical Session') AS scenario_name,
            COALESCE(s.created_at, MIN(v.created_at)) AS session_time,
            COUNT(v.id) AS session_total,
            COUNT(v.id) FILTER (WHERE v.outcome = 'MATCH') AS session_matches,
            COUNT(v.id) FILTER (WHERE v.outcome != 'MATCH') AS session_errors,
            COUNT(v.id) FILTER (WHERE v.outcome = 'MISMATCH') AS session_mismatches
        FROM public.sessions s
        JOIN public.transmissions t ON t.session_id = s.id
        JOIN public.instructions i ON i.transmission_id = t.id
        JOIN public.verdicts v ON v.instruction_id = i.id
        GROUP BY s.id, s.scenario_name, s.created_at
        ORDER BY session_time ASC
    ) sub;

    -- 5. Outcome distribution for donut chart
    v_outcome_distribution := jsonb_build_array(
        jsonb_build_object('name', 'MATCH', 'label', 'Exact Match', 'value', v_match_count, 'color', '#10b981'),
        jsonb_build_object('name', 'MISMATCH', 'label', 'Critical Mismatch', 'value', v_mismatch_count, 'color', '#ef4444'),
        jsonb_build_object('name', 'PARTIAL', 'label', 'Partial Readback', 'value', v_partial_count, 'color', '#f59e0b'),
        jsonb_build_object('name', 'UNVERIFIED', 'label', 'Unverified / Ambiguous', 'value', v_unverified_count, 'color', '#64748b')
    );

    -- 6. Build consolidated response object
    v_result := jsonb_build_object(
        'totalTransmissions', v_total_transmissions,
        'totalVerdicts', v_total_verdicts,
        'matchCount', v_match_count,
        'mismatchCount', v_mismatch_count,
        'partialCount', v_partial_count,
        'unverifiedCount', v_unverified_count,
        'errorRate', v_error_rate,
        'highSeverityCount', v_high_severity,
        'mediumSeverityCount', v_medium_severity,
        'lowSeverityCount', v_low_severity,
        'trendData', v_trend_data,
        'outcomeDistribution', v_outcome_distribution
    );

    RETURN v_result;
END;
$$;

-- Grant execution permissions
REVOKE ALL ON FUNCTION public.get_safety_analytics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_safety_analytics() TO anon, authenticated, service_role;
