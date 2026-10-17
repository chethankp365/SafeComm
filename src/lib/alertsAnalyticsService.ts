/**
 * SafeComm — Safety Alerts & Analytics Service
 * 
 * Interacts directly with Supabase RPCs to fetch real, un-mocked telemetry:
 * - Alerts listing & live acknowledgment persistence
 * - Unread count for the navigation rail
 * - Analytics KPI aggregation and session trend timelines
 */

import { supabase } from './supabase';

export interface SafetyAlert {
  alert_id: string;
  verdict_id: string;
  acknowledged: boolean;
  created_at: string;
  callsign: string;
  outcome: 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED';
  severity: 'OK' | 'WARNING' | 'CRITICAL';
  severity_tier: 'HIGH' | 'MEDIUM' | 'LOW';
  explanation: string;
  controller_text: string | null;
  readback_text: string | null;
  session_id: string;
  scenario_name: string;
}

export interface AnalyticsTrendPoint {
  sessionId: string;
  sessionName: string;
  timestamp: string;
  formattedDate: string;
  total: number;
  matches: number;
  errors: number;
  mismatches: number;
  errorRate: number;
}

export interface AnalyticsOutcomeSlice {
  name: string;
  label: string;
  value: number;
  color: string;
}

export interface SafetyAnalyticsData {
  totalTransmissions: number;
  totalVerdicts: number;
  matchCount: number;
  mismatchCount: number;
  partialCount: number;
  unverifiedCount: number;
  errorRate: number;
  highSeverityCount: number;
  mediumSeverityCount: number;
  lowSeverityCount: number;
  trendData: AnalyticsTrendPoint[];
  outcomeDistribution: AnalyticsOutcomeSlice[];
}

/**
 * Fetch safety alert cards from Supabase
 */
export async function fetchSafetyAlerts(
  filter: 'ALL' | 'HIGH' | 'MEDIUM' | 'LOW' = 'ALL',
  limit: number = 200
): Promise<{ alerts: SafetyAlert[]; error: string | null }> {
  try {
    const { data, error } = await supabase.rpc('get_safety_alerts', {
      p_severity_filter: filter === 'ALL' ? null : filter,
      p_limit: limit,
    });

    if (error) {
      console.error('[SafeComm Alerts] RPC get_safety_alerts error:', error);
      return { alerts: [], error: error.message };
    }

    const alerts: SafetyAlert[] = (data || []).map((row: any) => ({
      alert_id: row.alert_id,
      verdict_id: row.verdict_id,
      acknowledged: Boolean(row.acknowledged),
      created_at: row.created_at,
      callsign: row.callsign || 'UNKNOWN',
      outcome: row.outcome || 'UNVERIFIED',
      severity: row.severity || 'OK',
      severity_tier: row.severity_tier || 'LOW',
      explanation: row.explanation || 'No verification details recorded.',
      controller_text: row.controller_text || null,
      readback_text: row.readback_text || null,
      session_id: row.session_id,
      scenario_name: row.scenario_name || 'Aeronautical Comm Session',
    }));

    return { alerts, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected alerts retrieval error';
    console.error('[SafeComm Alerts Exception]', err);
    return { alerts: [], error: msg };
  }
}

/**
 * Acknowledge an alert and persist to Supabase public.alerts table
 */
export async function acknowledgeAlert(
  alertId: string
): Promise<{ success: boolean; error: string | null }> {
  try {
    const { data, error } = await supabase.rpc('acknowledge_safety_alert', {
      p_alert_id: alertId,
    });

    if (error) {
      console.error('[SafeComm Alerts] Failed to acknowledge alert:', error);
      return { success: false, error: error.message };
    }

    // Broadcast update event so navigation badge and other subscribers sync immediately
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('safecomm-alerts-updated', { detail: { alertId } }));
    }

    return { success: Boolean(data), error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to persist alert acknowledgement';
    console.error('[SafeComm Alerts Acknowledge Exception]', err);
    return { success: false, error: msg };
  }
}

/**
 * Fetch the current unacknowledged HIGH and MEDIUM safety alerts count
 */
export async function fetchUnreadAlertsCount(): Promise<number> {
  try {
    const { data, error } = await supabase.rpc('get_unread_alerts_count');
    if (error) {
      console.warn('[SafeComm Alerts] get_unread_alerts_count warning:', error.message);
      return 0;
    }
    return typeof data === 'number' ? data : 0;
  } catch (err) {
    console.warn('[SafeComm Alerts] get_unread_alerts_count failed', err);
    return 0;
  }
}

/**
 * Fetch computed analytics metrics from Supabase without mock data
 */
export async function fetchSafetyAnalytics(): Promise<{
  data: SafetyAnalyticsData | null;
  error: string | null;
}> {
  try {
    const { data, error } = await supabase.rpc('get_safety_analytics');

    if (error) {
      console.error('[SafeComm Analytics] RPC get_safety_analytics error:', error);
      return { data: null, error: error.message };
    }

    if (!data || typeof data !== 'object') {
      return {
        data: {
          totalTransmissions: 0,
          totalVerdicts: 0,
          matchCount: 0,
          mismatchCount: 0,
          partialCount: 0,
          unverifiedCount: 0,
          errorRate: 0,
          highSeverityCount: 0,
          mediumSeverityCount: 0,
          lowSeverityCount: 0,
          trendData: [],
          outcomeDistribution: [],
        },
        error: null,
      };
    }

    const payload = data as Record<string, any>;

    const analytics: SafetyAnalyticsData = {
      totalTransmissions: Number(payload.totalTransmissions) || 0,
      totalVerdicts: Number(payload.totalVerdicts) || 0,
      matchCount: Number(payload.matchCount) || 0,
      mismatchCount: Number(payload.mismatchCount) || 0,
      partialCount: Number(payload.partialCount) || 0,
      unverifiedCount: Number(payload.unverifiedCount) || 0,
      errorRate: Number(payload.errorRate) || 0,
      highSeverityCount: Number(payload.highSeverityCount) || 0,
      mediumSeverityCount: Number(payload.mediumSeverityCount) || 0,
      lowSeverityCount: Number(payload.lowSeverityCount) || 0,
      trendData: Array.isArray(payload.trendData) ? payload.trendData : [],
      outcomeDistribution: Array.isArray(payload.outcomeDistribution) ? payload.outcomeDistribution : [],
    };

    return { data: analytics, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unexpected analytics computation error';
    console.error('[SafeComm Analytics Exception]', err);
    return { data: null, error: msg };
  }
}
