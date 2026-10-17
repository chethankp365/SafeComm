/**
 * SafeComm — Ledger and Radar Scope Data Service
 * 
 * Fetches real Supabase transmission + verdict audit records and aircraft tracks,
 * with deterministic positioning and client-side CSV export utilities.
 */

import { supabase } from './supabase';

export interface LedgerRecord {
  verdict_id: string;
  session_id: string;
  scenario_name: string;
  created_at: string;
  callsign: string;
  instruction_type: string;
  instruction_value: string;
  direction: string | null;
  controller_text: string | null;
  readback_text: string | null;
  outcome: 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED';
  severity: 'OK' | 'WARNING' | 'CRITICAL';
  explanation: string;
}

export interface RadarAircraft {
  session_id: string;
  scenario_name: string;
  callsign: string;
  last_seen: string;
  latest_instruction: string;
  latest_readback: string;
  latest_outcome: 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED';
  latest_severity: 'OK' | 'WARNING' | 'CRITICAL';
  latest_explanation: string;
  assigned_altitude: string;
  assigned_heading: string;
  assigned_runway: string;
  assigned_squawk: string;
  total_verdicts: number;
}

export interface SessionOption {
  id: string;
  name: string;
  date: string;
}

/**
 * Fetch joined transmission + verdict pairs from Supabase
 */
export async function fetchLedgerRecords(params?: {
  sessionId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ records: LedgerRecord[]; error: string | null }> {
  try {
    const { data, error } = await supabase.rpc('get_comm_ledger_records', {
      p_session_id: params?.sessionId || null,
      p_limit: params?.limit ?? 1000,
      p_offset: params?.offset ?? 0,
    });

    if (error) {
      console.error('[SafeComm Ledger] Failed to fetch records:', error);
      return { records: [], error: error.message };
    }

    const records: LedgerRecord[] = (data || []).map((row: any) => ({
      verdict_id: row.verdict_id,
      session_id: row.session_id,
      scenario_name: row.scenario_name || 'Aeronautical Comm Session',
      created_at: row.created_at,
      callsign: row.callsign || 'UNKNOWN',
      instruction_type: row.instruction_type || 'general',
      instruction_value: row.instruction_value || '',
      direction: row.direction || null,
      controller_text: row.controller_text || null,
      readback_text: row.readback_text || null,
      outcome: (row.outcome as LedgerRecord['outcome']) || 'UNVERIFIED',
      severity: (row.severity as LedgerRecord['severity']) || 'OK',
      explanation: row.explanation || '',
    }));

    return { records, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected ledger retrieval error';
    console.error('[SafeComm Ledger Exception]', err);
    return { records: [], error: message };
  }
}

/**
 * Fetch distinct aircraft tracks from session data for the Radar Scope
 */
export async function fetchRadarScopeAircraft(params?: {
  sessionId?: string;
}): Promise<{ aircraft: RadarAircraft[]; error: string | null }> {
  try {
    const { data, error } = await supabase.rpc('get_radar_scope_aircraft', {
      p_session_id: params?.sessionId || null,
    });

    if (error) {
      console.error('[SafeComm Radar] Failed to fetch aircraft tracks:', error);
      return { aircraft: [], error: error.message };
    }

    const aircraft: RadarAircraft[] = (data || []).map((row: any) => ({
      session_id: row.session_id,
      scenario_name: row.scenario_name || 'Aeronautical Comm Session',
      callsign: row.callsign || 'UNKNOWN',
      last_seen: row.last_seen,
      latest_instruction: row.latest_instruction || 'No preceding ATC transmission recorded.',
      latest_readback: row.latest_readback || 'No pilot readback text recorded.',
      latest_outcome: (row.latest_outcome as RadarAircraft['latest_outcome']) || 'UNVERIFIED',
      latest_severity: (row.latest_severity as RadarAircraft['latest_severity']) || 'OK',
      latest_explanation: row.latest_explanation || '',
      assigned_altitude: row.assigned_altitude || '3000',
      assigned_heading: row.assigned_heading || '090',
      assigned_runway: row.assigned_runway || '28R',
      assigned_squawk: row.assigned_squawk || '4215',
      total_verdicts: Number(row.total_verdicts) || 1,
    }));

    return { aircraft, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected radar aircraft retrieval error';
    console.error('[SafeComm Radar Exception]', err);
    return { aircraft: [], error: message };
  }
}

/**
 * Deterministically position an aircraft on the radar scope
 * Converts callsign + session into angle (degrees) and normalized radius (0.2 to 0.85).
 */
export function calculateDeterministicRadarPosition(
  callsign: string,
  sessionId?: string,
  assignedHeading?: string
): { angleDeg: number; radiusFactor: number; headingDeg: number } {
  let hash = 0;
  const seed = `${callsign}:${sessionId || 'default'}`;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const positiveHash = Math.abs(hash);

  // Deterministic bearing between 0 and 359 degrees
  const angleDeg = positiveHash % 360;

  // Normalized distance from center between 0.22 and 0.82 (inside scope bounds)
  const radiusRange = 0.60;
  const radiusFactor = 0.22 + ((positiveHash >> 3) % 1000) / 1000 * radiusRange;

  // Derived heading from assigned heading or deterministic fallback
  let headingDeg = 90;
  if (assignedHeading && !isNaN(Number(assignedHeading))) {
    headingDeg = Number(assignedHeading) % 360;
  } else {
    headingDeg = ((positiveHash >> 5) % 36) * 10;
  }

  return { angleDeg, radiusFactor, headingDeg };
}

/**
 * Client-side CSV export of ledger records
 */
export function exportLedgerToCsv(records: LedgerRecord[], customFilename?: string): void {
  if (!records || records.length === 0) {
    alert('No ledger records available to export.');
    return;
  }

  const headers = [
    'Time (UTC)',
    'Callsign',
    'Preceding ATC Instruction',
    'Pilot Read-Back',
    'Verdict Outcome',
    'Severity Level',
    'Sentinel Explanation',
    'Instruction Type',
    'Assigned Value',
    'Direction',
    'Session Name',
    'Session UUID',
    'Verdict UUID',
  ];

  const escapeCsvValue = (val: string | null | undefined): string => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = records.map((r) => [
    escapeCsvValue(r.created_at),
    escapeCsvValue(r.callsign),
    escapeCsvValue(r.controller_text || `${r.instruction_type}: ${r.instruction_value}`),
    escapeCsvValue(r.readback_text),
    escapeCsvValue(r.outcome),
    escapeCsvValue(r.severity),
    escapeCsvValue(r.explanation),
    escapeCsvValue(r.instruction_type),
    escapeCsvValue(r.instruction_value),
    escapeCsvValue(r.direction),
    escapeCsvValue(r.scenario_name),
    escapeCsvValue(r.session_id),
    escapeCsvValue(r.verdict_id),
  ]);

  const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.setAttribute('href', url);
  link.setAttribute('download', customFilename || `safecomm-ledger-export-${timestamp}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
