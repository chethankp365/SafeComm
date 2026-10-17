import { supabase } from './supabase';
import type { ExtractionResult, ExtractedInstruction } from './llmExtractor';
import { extractWithLocalRules } from './llmExtractor';
import {
  compareTranscriptChronology,
  type CommTranscriptEntry,
} from './commTranscripts';

export interface VerificationVerdictStub {
  outcome: 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED';
  severity: 'OK' | 'WARNING' | 'CRITICAL';
  explanation: string;
  matchedFields: string[];
  mismatchedFields: string[];
  omittedFields?: string[];
}

export interface VerificationFeedbackPolicy {
  notificationOutcome: 'MISMATCH' | 'UNVERIFIED' | null;
  speakWarning: boolean;
  persistAlert: boolean;
}

export function getVerificationFeedbackPolicy(
  outcome: VerificationVerdictStub['outcome']
): VerificationFeedbackPolicy {
  const isMismatch = outcome === 'MISMATCH';
  return {
    notificationOutcome: outcome === 'MATCH' ? null : isMismatch ? 'MISMATCH' : 'UNVERIFIED',
    speakWarning: isMismatch,
    persistAlert: isMismatch,
  };
}

export interface SyncResult {
  success: boolean;
  transmissionId: string | null;
  verdictId: string | null;
  instructionsCount: number;
  alertId: string | null;
  error: string | null;
}

export interface TranscriptVerification {
  verdicts: Record<string, VerificationVerdictStub>;
  atcByPilotId: Record<string, CommTranscriptEntry>;
  latestAtcEntry: CommTranscriptEntry | null;
  latestPilotEntry: CommTranscriptEntry | null;
  matchingAtcEntry: CommTranscriptEntry | null;
  activeVerdict: VerificationVerdictStub | null;
  isPending: boolean;
}

export function formatVerificationAlertMessage(
  verdict: VerificationVerdictStub,
  controllerExtraction?: ExtractionResult | null,
  pilotExtraction?: ExtractionResult | null
): string {
  if (verdict.outcome === 'MATCH') return 'MATCH — Readback verified.';
  if (verdict.outcome === 'UNVERIFIED') {
    if (/no preceding|no matching|not paired|no authoritative/i.test(verdict.explanation)) {
      return 'UNVERIFIED — No matching ATC instruction found.';
    }
    return `UNVERIFIED — ${verdict.explanation}`;
  }
  if (verdict.outcome === 'PARTIAL') {
    const omitted = verdict.omittedFields?.join(', ') || 'required clearance items';
    return `UNVERIFIED — Readback is missing assigned items: ${omitted}.`;
  }

  const assigned = controllerExtraction?.instructions || [];
  const readback = pilotExtraction?.instructions || [];
  const mismatch = verdict.mismatchedFields.join(' ').toLowerCase();
  const mismatchTypes = (['runway', 'heading', 'altitude', 'squawk', 'speed'] as const)
    .filter((type) => mismatch.includes(type));
  const specificMessages = mismatchTypes.flatMap((instructionType) => {
    const assignedInstruction = assigned.find((item) => item.type === instructionType);
    const readbackInstruction = readback.find((item) => item.type === instructionType);
    if (!assignedInstruction || !readbackInstruction) return [];

    if (instructionType === 'heading') {
      const assignedDirection = assignedInstruction.direction?.toUpperCase();
      const readbackDirection = readbackInstruction.direction?.toUpperCase();
      const assignedValue = `${assignedDirection ? `${assignedDirection} ` : ''}${assignedInstruction.value.padStart(3, '0')}`;
      const readbackValue = `${readbackDirection ? `${readbackDirection} ` : ''}${readbackInstruction.value.padStart(3, '0')}`;
      return [`HEADING MISMATCH — Assigned ${assignedValue}, readback ${readbackValue}.`];
    }
    if (instructionType === 'altitude') {
      const displayAltitude = (value: string) => {
        const flightLevel = value.match(/FL\s*(\d+)/i);
        if (flightLevel) return `FL${flightLevel[1]}`;
        const feet = value.match(/\d+/)?.[0];
        return feet ? `${feet} ft` : value;
      };
      const actionDiffers = assignedInstruction.action !== readbackInstruction.action;
      const label = actionDiffers ? 'ALTITUDE ACTION MISMATCH' : 'ALTITUDE MISMATCH';
      const describeAltitude = (instruction: ExtractedInstruction) =>
        `${actionDiffers && instruction.action ? `${instruction.action.toUpperCase()} ` : ''}${displayAltitude(instruction.value)}`;
      return [`${label} — Assigned ${describeAltitude(assignedInstruction)}, readback ${describeAltitude(readbackInstruction)}.`];
    }
    if (instructionType === 'squawk') {
      return [`SQUAWK MISMATCH — Assigned ${assignedInstruction.value}, readback ${readbackInstruction.value}.`];
    }
    if (instructionType === 'runway') {
      const actionDiffers = assignedInstruction.action !== readbackInstruction.action;
      const describeRunway = (instruction: ExtractedInstruction) => {
        const action = actionDiffers ? instruction.action?.replace(/_/g, ' ').toUpperCase() : undefined;
        return `${action ? `${action} ` : ''}${instruction.value}`;
      };
      return [`RUNWAY MISMATCH — Assigned ${describeRunway(assignedInstruction)}, readback ${describeRunway(readbackInstruction)}.`];
    }
    return [`SPEED MISMATCH — Assigned ${assignedInstruction.value}, readback ${readbackInstruction.value}.`];
  });
  if (specificMessages.length) return specificMessages.join(' ');
  const reason = verdict.mismatchedFields[0] || verdict.explanation;
  return `READBACK MISMATCH — ${reason}.`;
}

export function verificationAlertKey(roomId: string, pilotTransmissionId: string): string {
  return `${roomId}:${pilotTransmissionId}`;
}

export function claimVerificationAlert(seenAlerts: Set<string>, key: string): boolean {
  if (seenAlerts.has(key)) return false;
  seenAlerts.add(key);
  return true;
}

function normalizeCallsign(cs: string): string {
  let c = cs.toUpperCase().replace(/\s+/g, '');
  if (c.startsWith('SPEEDBIRD')) c = c.replace('SPEEDBIRD', 'BAW');
  if (c.startsWith('BIRD')) c = c.replace('BIRD', 'BAW');
  if (c.startsWith('UNITED')) c = c.replace('UNITED', 'UAL');
  if (c.startsWith('DELTA')) c = c.replace('DELTA', 'DAL');
  return c;
}

function isAuthoritativeAtcEntry(entry: CommTranscriptEntry, extraction: ExtractionResult): boolean {
  if (
    extraction.extractionFailed ||
    /\?\s*$/.test(entry.text) ||
    /\b(?:ready\s+for\s+(?:take\s*off|takeoff)|request(?:ing)?|may\s+we|can\s+we)\b/i.test(entry.text)
  ) {
    return false;
  }
  if (extraction.intent !== 'instruction' && extraction.intent !== 'clearance' && extraction.intent !== 'correction') {
    return false;
  }
  const safetyInstructions = extraction.instructions.filter((instruction) => instruction.type !== 'other');
  return safetyInstructions.length > 0;
}

function normalizeHeading(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  const heading = Number(digits);
  return digits.length > 0 && digits.length <= 3 && heading >= 1 && heading <= 360
    ? String(heading).padStart(3, '0')
    : null;
}

function normalizeAltitude(alt: string): number | null {
  const flMatch = alt.match(/\bFL\s*(\d{2,3})\b/i);
  if (flMatch) return parseInt(flMatch[1], 10) * 100;
  const numMatch = alt.replace(/,/g, '').match(/(\d{3,5})(?:\s*(?:ft|feet))?/i);
  return numMatch ? parseInt(numMatch[1], 10) : null;
}

function normalizeRunway(value: string): string | null {
  const normalized = value.toUpperCase().replace(/\s+/g, '');
  const match = normalized.match(/^(\d{1,2})([LRC])?$/);
  if (!match) return null;
  const number = Number(match[1]);
  return number >= 1 && number <= 36
    ? `${String(number).padStart(2, '0')}${match[2] || ''}`
    : null;
}

function isReliable(instruction: ExtractedInstruction): boolean {
  return Number.isFinite(instruction.confidence) && instruction.confidence >= 0.75;
}

/**
 * Compare controller extraction vs pilot extraction
 * (Deterministic phraseology verification engine)
 */
export function diffExtractions(
  controllerExt: ExtractionResult,
  pilotExt: ExtractionResult,
  pilotIdentityCallsign?: string | null
): VerificationVerdictStub {
  if (controllerExt.extractionFailed || pilotExt.extractionFailed) {
    return {
      outcome: 'UNVERIFIED',
      severity: 'OK',
      explanation: 'AI extraction failed; no reliable readback comparison is available.',
      matchedFields: [],
      mismatchedFields: [],
    };
  }
  const matchedFields: string[] = [];
  const mismatchedFields: string[] = [];
  const omittedFields: string[] = [];
  const issues: string[] = [];

  const controllerCallsignKnown = Boolean(controllerExt.callsign) && controllerExt.callsign !== 'UNKNOWN';
  const spokenPilotCallsignKnown = Boolean(pilotExt.callsign) && pilotExt.callsign !== 'UNKNOWN';
  const stationCallsignKnown = Boolean(pilotIdentityCallsign) && pilotIdentityCallsign !== 'UNKNOWN';
  const pilotCallsign = spokenPilotCallsignKnown
    ? pilotExt.callsign
    : stationCallsignKnown
      ? pilotIdentityCallsign!
      : null;

  if (controllerCallsignKnown && pilotCallsign) {
    const assigned = normalizeCallsign(controllerExt.callsign);
    const readback = normalizeCallsign(pilotCallsign);
    if (assigned !== readback) {
      mismatchedFields.push(`Callsign (${controllerExt.callsign} vs ${pilotCallsign})`);
      issues.push(`Callsign mismatch: assigned ${controllerExt.callsign}, read back ${pilotCallsign}`);
    } else {
      matchedFields.push(`Callsign (${controllerExt.callsign})`);
    }
  } else if (controllerCallsignKnown) {
    omittedFields.push(`Missing callsign (${controllerExt.callsign})`);
  }

  const assignedInstructions = controllerExt.instructions.filter(
    (instruction) => instruction.type !== 'other'
  );
  if (assignedInstructions.length === 0) {
    return {
      outcome: 'UNVERIFIED',
      severity: 'OK',
      explanation: 'Readback not verified: no clear controller instruction was detected.',
      matchedFields,
      mismatchedFields,
      omittedFields,
    };
  }
  if (pilotExt.intent === 'question' || pilotExt.intent === 'request' ||
      pilotExt.intent === 'acknowledgement') {
    return {
      outcome: 'UNVERIFIED',
      severity: 'OK',
      explanation: `Pilot transmission intent was ${pilotExt.intent}; it is not a readback to verify.`,
      matchedFields,
      mismatchedFields,
    };
  }

  const readbackByType = new Map<string, ExtractedInstruction[]>();
  for (const instruction of pilotExt.instructions) {
    if (instruction.type === 'other') continue;
    const group = readbackByType.get(instruction.type) || [];
    group.push(instruction);
    readbackByType.set(instruction.type, group);
  }
  const indexes = new Map<string, number>();
  let criticalMismatch = false;

  for (const assigned of assignedInstructions) {
    const index = indexes.get(assigned.type) || 0;
    indexes.set(assigned.type, index + 1);
    const readback = readbackByType.get(assigned.type)?.[index];
    if (!readback) {
      omittedFields.push(`Missing ${assigned.type} (${assigned.value})`);
      continue;
    }
    if (!isReliable(assigned) || !isReliable(readback)) {
      omittedFields.push(`Uncertain ${assigned.type} value`);
      continue;
    }

    if (assigned.type === 'heading') {
      const assignedHeading = normalizeHeading(assigned.value);
      const readbackHeading = normalizeHeading(readback.value);
      if (!assignedHeading || !readbackHeading) {
        omittedFields.push(`Unverified heading (${assigned.value})`);
        continue;
      }
      let fieldMatched = false;
      if (assignedHeading !== readbackHeading) {
        mismatchedFields.push(`Heading Value (${assignedHeading} vs ${readbackHeading})`);
        issues.push(`Heading mismatch: assigned ${assignedHeading}, read back ${readbackHeading}`);
        criticalMismatch = true;
      } else {
        matchedFields.push(`Heading value (${assignedHeading})`);
        fieldMatched = true;
      }
      if (assigned.direction) {
        if (!readback.direction) {
          omittedFields.push(`Missing heading direction (${assigned.direction})`);
          fieldMatched = false;
        } else if (assigned.direction !== readback.direction) {
          mismatchedFields.push(`Heading Direction (${assigned.direction.toUpperCase()} vs ${readback.direction.toUpperCase()})`);
          issues.push(`CRITICAL: Assigned turn ${assigned.direction.toUpperCase()} heading ${assignedHeading}, but pilot read back turn ${readback.direction.toUpperCase()}`);
          criticalMismatch = true;
          fieldMatched = false;
        } else {
          matchedFields.push(`Heading direction (${assigned.direction.toUpperCase()})`);
        }
      }
      if (!fieldMatched && assigned.direction && !readback.direction) continue;
      continue;
    }

    if (assigned.type === 'altitude') {
      const assignedAltitude = normalizeAltitude(assigned.value);
      const readbackAltitude = normalizeAltitude(readback.value);
      if (assignedAltitude === null || readbackAltitude === null) {
        omittedFields.push(`Unverified altitude (${assigned.value})`);
        continue;
      }
      let conflict = false;
      if (assignedAltitude !== readbackAltitude) {
        mismatchedFields.push(`Altitude (${assigned.value} vs ${readback.value})`);
        issues.push(`Altitude deviation: assigned ${assigned.value}, read back ${readback.value}`);
        conflict = true;
      } else {
        matchedFields.push(`Altitude (${assigned.value})`);
      }
      if (assigned.action) {
        if (!readback.action) {
          omittedFields.push(`Missing altitude action (${assigned.action})`);
        } else if (assigned.action !== readback.action) {
          mismatchedFields.push(`Altitude Action (${assigned.action.toUpperCase()} vs ${readback.action.toUpperCase()})`);
          issues.push(`Altitude action mismatch: assigned ${assigned.action}, read back ${readback.action}`);
          conflict = true;
        } else {
          matchedFields.push(`Altitude action (${assigned.action})`);
        }
      }
      if (conflict) criticalMismatch = true;
      continue;
    }

    if (assigned.type === 'runway') {
      const assignedRunway = normalizeRunway(assigned.value);
      const readbackRunway = normalizeRunway(readback.value);
      if (!assignedRunway || !readbackRunway) {
        omittedFields.push(`Unverified runway (${assigned.value})`);
        continue;
      }
      let conflict = false;
      if (assignedRunway !== readbackRunway) {
        mismatchedFields.push(`Runway Clearance (${assigned.action || ''} ${assignedRunway} vs ${readback.action || ''} ${readbackRunway})`);
        issues.push(`RUNWAY CONFLICT: Assigned runway ${assignedRunway}, pilot read back runway ${readbackRunway}`);
        conflict = true;
      } else {
        matchedFields.push(`Runway (${assignedRunway})`);
      }
      if (assigned.action) {
        if (!readback.action) {
          omittedFields.push(`Missing runway action (${assigned.action})`);
        } else if (assigned.action !== readback.action) {
          mismatchedFields.push(`Runway Action (${assigned.action} vs ${readback.action})`);
          issues.push(`RUNWAY CONFLICT: Assigned ${assigned.action}, pilot read back ${readback.action}`);
          conflict = true;
        } else {
          matchedFields.push(`Runway action (${assigned.action})`);
        }
      }
      if (conflict) criticalMismatch = true;
      continue;
    }

    if (assigned.type === 'squawk') {
      const assignedSquawk = assigned.value.trim();
      const readbackSquawk = readback.value.trim();
      if (!/^[0-7]{4}$/.test(assignedSquawk) || !/^[0-7]{4}$/.test(readbackSquawk)) {
        omittedFields.push('Unverified squawk code');
      } else if (assignedSquawk !== readbackSquawk) {
        mismatchedFields.push(`Squawk Code (${assignedSquawk} vs ${readbackSquawk})`);
        issues.push(`Squawk code mismatch: assigned ${assignedSquawk}, read back ${readbackSquawk}`);
      } else {
        matchedFields.push(`Squawk (${assignedSquawk})`);
      }
      continue;
    }

    if (assigned.type === 'speed') {
      const assignedSpeed = Number(assigned.value.match(/\d+/)?.[0]);
      const readbackSpeed = Number(readback.value.match(/\d+/)?.[0]);
      if (!Number.isFinite(assignedSpeed) || !Number.isFinite(readbackSpeed)) {
        omittedFields.push(`Unverified speed (${assigned.value})`);
      } else if (assignedSpeed !== readbackSpeed) {
        mismatchedFields.push(`Speed (${assignedSpeed} vs ${readbackSpeed})`);
        issues.push(`Speed mismatch: assigned ${assignedSpeed}, read back ${readbackSpeed}`);
      } else {
        matchedFields.push(`Speed (${assignedSpeed})`);
      }
    }
  }

  if (mismatchedFields.length > 0) {
    return {
      outcome: 'MISMATCH',
      severity: criticalMismatch ? 'CRITICAL' : 'WARNING',
      explanation: issues.join('. '),
      matchedFields,
      mismatchedFields,
      omittedFields,
    };
  }
  if (omittedFields.length > 0) {
    return {
      outcome: 'PARTIAL',
      severity: 'WARNING',
      explanation: `Readback unverified. Missing or uncertain items: ${omittedFields.join(', ')}.`,
      matchedFields,
      mismatchedFields,
      omittedFields,
    };
  }
  return {
    outcome: 'MATCH',
    severity: 'OK',
    explanation: 'All explicitly assigned safety-critical values were read back correctly.',
    matchedFields,
    mismatchedFields,
    omittedFields,
  };
}

/**
 * Compare each pilot readback only with clearances that were already issued
 * in the same room, preserving temporal and callsign association.
 */
export function verifyTranscriptTimeline(
  transcripts: CommTranscriptEntry[],
  extractions?: Record<string, ExtractionResult>,
  roomId?: string
): TranscriptVerification {
  const verdicts: Record<string, VerificationVerdictStub> = {};
  const atcByPilotId: Record<string, CommTranscriptEntry> = {};
  const activeClearances = new Map<string, CommTranscriptEntry>();
  let latestAtcEntry: CommTranscriptEntry | null = null;
  let latestPilotEntry: CommTranscriptEntry | null = null;
  let matchingAtcEntry: CommTranscriptEntry | null = null;
  let activeVerdict: VerificationVerdictStub | null = null;
  let isPending = false;

  const seenTransmissionIds = new Set<string>();
  const chronologicalTranscripts = transcripts
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      entry?.isFinal &&
      Boolean(entry.id) &&
      Boolean(entry.text?.trim()) &&
      (!roomId || entry.roomId === roomId)
    )
    .sort((a, b) => compareTranscriptChronology(a.entry, b.entry) || a.index - b.index)
    .flatMap(({ entry }) => {
      if (seenTransmissionIds.has(entry.id)) return [];
      seenTransmissionIds.add(entry.id);
      return [entry];
    });

  for (const entry of chronologicalTranscripts) {
    if (entry.role === 'atc') {
      latestAtcEntry = entry;
      const extracted = extractions ? extractions[entry.id] : extractWithLocalRules(entry.text);
      if (!extracted) {
        isPending = true;
        activeVerdict = null;
        continue;
      }
      const callsignKey = `${entry.roomId}:${extracted.callsign === 'UNKNOWN' ? 'DEFAULT' : normalizeCallsign(extracted.callsign)}`;
      if (/\b(?:disregard|cancel(?:led)?)\b/i.test(entry.text)) {
        activeClearances.delete(callsignKey);
        matchingAtcEntry = Array.from(activeClearances.values()).at(-1) || null;
      } else if (isAuthoritativeAtcEntry(entry, extracted)) {
        activeClearances.set(callsignKey, entry);
        matchingAtcEntry = entry;
      }
      activeVerdict = null;
      continue;
    }

    if (entry.role !== 'pilot') continue;
    latestPilotEntry = entry;
    const pilotExtraction = extractions ? extractions[entry.id] : extractWithLocalRules(entry.text);
    if (!pilotExtraction) {
      isPending = true;
      activeVerdict = {
        outcome: 'UNVERIFIED',
        severity: 'OK',
        explanation: 'Verification is waiting for structured transcript extraction.',
        matchedFields: [],
        mismatchedFields: [],
      };
      verdicts[entry.id] = activeVerdict;
      matchingAtcEntry = null;
      continue;
    }
    if (pilotExtraction.extractionFailed) {
      const verdict: VerificationVerdictStub = {
        outcome: 'UNVERIFIED',
        severity: 'OK',
        explanation: 'AI extraction failed; no reliable readback comparison is available.',
        matchedFields: [],
        mismatchedFields: [],
      };
      verdicts[entry.id] = verdict;
      activeVerdict = verdict;
      matchingAtcEntry = null;
      continue;
    }
    if (entry.provisional) {
      const verdict: VerificationVerdictStub = {
        outcome: 'UNVERIFIED',
        severity: 'OK',
        explanation: 'Readback remains provisional pending final speech capture.',
        matchedFields: [],
        mismatchedFields: [],
      };
      verdicts[entry.id] = verdict;
      activeVerdict = verdict;
      matchingAtcEntry = null;
      continue;
    }
    const spokenPilotCallsign = pilotExtraction.callsign === 'UNKNOWN'
      ? null
      : normalizeCallsign(pilotExtraction.callsign);
    const extractedIdentity = extractWithLocalRules(entry.callsign).callsign;
    const pilotIdentityCallsign = extractedIdentity === 'UNKNOWN'
      ? null
      : normalizeCallsign(extractedIdentity);

    let clearance: CommTranscriptEntry | null = null;
    if (pilotIdentityCallsign) {
      clearance = activeClearances.get(`${entry.roomId}:${pilotIdentityCallsign}`) || null;
    } else if (spokenPilotCallsign) {
      clearance = activeClearances.get(`${entry.roomId}:${spokenPilotCallsign}`) || null;
    }
    if (!clearance) {
      clearance = activeClearances.get(`${entry.roomId}:DEFAULT`) || null;
    }

    if (clearance) {
      const atcExtraction = extractions
        ? extractions[clearance.id]
        : extractWithLocalRules(clearance.text);
      if (!atcExtraction) {
        isPending = true;
        activeVerdict = {
          outcome: 'UNVERIFIED',
          severity: 'OK',
          explanation: 'Verification is waiting for structured extraction of the preceding ATC instruction.',
          matchedFields: [],
          mismatchedFields: [],
        };
        verdicts[entry.id] = activeVerdict;
        continue;
      }
      const verdict = diffExtractions(
        atcExtraction,
        pilotExtraction,
        pilotIdentityCallsign
      );
      verdicts[entry.id] = verdict;
      atcByPilotId[entry.id] = clearance;
      matchingAtcEntry = clearance;
      activeVerdict = verdict;
    } else {
      const verdict: VerificationVerdictStub = {
        outcome: 'UNVERIFIED',
        severity: 'OK',
        explanation: (() => {
          const pilotLabel = pilotIdentityCallsign || spokenPilotCallsign;
          if (!latestAtcEntry) {
            return `No preceding ATC transmission is available to verify the readback${pilotLabel ? ` for ${pilotLabel}` : ''}.`;
          }
          const latestAtcExtraction = extractions
            ? extractions[latestAtcEntry.id]
            : extractWithLocalRules(latestAtcEntry.text);
          if (!latestAtcExtraction) {
            isPending = true;
            return 'Verification is waiting for structured extraction of the latest ATC transmission.';
          }
          const atcLabel = latestAtcExtraction.callsign !== 'UNKNOWN'
            ? normalizeCallsign(latestAtcExtraction.callsign)
            : 'an unknown aircraft';
          if (!isAuthoritativeAtcEntry(latestAtcEntry, latestAtcExtraction)) {
            return `The latest ATC transmission addressed ${atcLabel} but was a ${latestAtcExtraction.intent}, not an authoritative clearance. No preceding clearance is associated with pilot station ${entry.callsign || pilotLabel || 'unknown'}.`;
          }
          return `No preceding clearance is associated with pilot station ${entry.callsign || pilotLabel || 'unknown'}. The latest authoritative clearance addressed ${atcLabel}; it was not paired across aircraft.`;
        })(),
        matchedFields: [],
        mismatchedFields: [],
        omittedFields: ['Awaiting authoritative clearance'],
      };
      verdicts[entry.id] = verdict;
      activeVerdict = verdict;
      matchingAtcEntry = null;
    }
  }

  return {
    verdicts,
    atcByPilotId,
    latestAtcEntry,
    latestPilotEntry,
    matchingAtcEntry,
    activeVerdict,
    isPending,
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function deterministicUuid(key: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto is required for idempotent verification persistence.');
  }
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  );
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function loadPersistedReadbackVerdict(
  sessionId: string,
  transcriptId: string
): Promise<{ verdict: VerificationVerdictStub | null; error: string | null }> {
  try {
    const id = await deterministicUuid(`${sessionId}:verdict:${transcriptId}`);
    const { data, error } = await supabase
      .from('verdicts')
      .select('outcome, severity, explanation')
      .eq('id', id)
      .maybeSingle();
    if (error) return { verdict: null, error: error.message };
    if (!data) return { verdict: null, error: null };
    if (
      !['MATCH', 'MISMATCH', 'PARTIAL', 'UNVERIFIED'].includes(data.outcome) ||
      !['OK', 'WARNING', 'CRITICAL'].includes(data.severity) ||
      typeof data.explanation !== 'string'
    ) {
      return { verdict: null, error: 'Stored verification result has an invalid schema.' };
    }
    return {
      verdict: {
        outcome: data.outcome,
        severity: data.severity,
        explanation: data.explanation,
        matchedFields: [],
        mismatchedFields: [],
      },
      error: null,
    };
  } catch (error) {
    return {
      verdict: null,
      error: error instanceof Error ? error.message : 'Unable to load persisted verification result.',
    };
  }
}

/**
 * Stores transmission, extracted instructions, verdicts, and alerts into Supabase with strict validation
 */
export async function syncTransmissionToSupabase(
  sessionId: string,
  role: 'controller' | 'pilot',
  text: string,
  callsign: string,
  instructions: ExtractedInstruction[],
  verdict?: VerificationVerdictStub,
  transcriptId?: string,
  displayMessage?: string
): Promise<SyncResult> {
  // Validate UUID format
  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    const err = `Invalid session UUID: "${sessionId}". A valid Supabase sessions row must exist first.`;
    console.error('[SafeComm Supabase Error]', err);
    return {
      success: false,
      transmissionId: null,
      verdictId: null,
      instructionsCount: 0,
      alertId: null,
      error: err,
    };
  }

  try {
    if (!transcriptId) {
      throw new Error('A finalized transcript identifier is required for idempotent persistence.');
    }
    const transmissionId = await deterministicUuid(`${sessionId}:transcript:${transcriptId}`);

    // 1. Insert transmission row
    const { data: transData, error: transError } = await supabase
      .from('transmissions')
      .upsert({
        id: transmissionId,
        session_id: sessionId,
        role,
        text,
        confidence: 0.99,
      }, { onConflict: 'id' })
      .select('id')
      .single();

    if (transError || !transData) {
      console.error('[SafeComm Supabase Error] Failed inserting transmission:', transError);
      return {
        success: false,
        transmissionId: null,
        verdictId: null,
        instructionsCount: 0,
        alertId: null,
        error: transError?.message || 'Failed to insert transmission row',
      };
    }

    let instructionsCount = 0;
    let firstInstructionId: string | null = null;

    // 2. Upsert extracted instructions (or a deterministic placeholder to support the verdict FK).
    const records = instructions.length > 0
      ? await Promise.all(instructions.map(async (i, index) => ({
          id: await deterministicUuid(`${transmissionId}:instruction:${index}`),
          transmission_id: transmissionId,
          type: i.type,
          value: i.value,
          direction: i.direction || null,
          callsign: callsign || 'ACTIVE',
          confidence: i.confidence,
        })))
      : [{
          id: await deterministicUuid(`${transmissionId}:instruction:unparsed`),
          transmission_id: transmissionId,
          type: 'other' as const,
          value: 'UNPARSED_TRANSMISSION',
          direction: null,
          callsign: callsign || 'ACTIVE',
          confidence: 0.5,
        }];

    const { data: instData, error: instError } = await supabase
      .from('instructions')
      .upsert(records, { onConflict: 'id' })
      .select('id');

    if (instError) {
      console.error('[SafeComm Supabase Error] Failed inserting instructions:', instError);
      return {
        success: false,
        transmissionId,
        verdictId: null,
        instructionsCount: 0,
        alertId: null,
        error: instError.message,
      };
    } else if (instData && instData.length > 0) {
      instructionsCount = instData.length;
      firstInstructionId = instData[0].id;
    } else {
      return {
        success: false,
        transmissionId,
        verdictId: null,
        instructionsCount: 0,
        alertId: null,
        error: 'Supabase did not return the inserted instruction records.',
      };
    }

    // 3. Insert verdict & alert if provided and instruction exists
    let verdictId: string | null = null;
    let alertId: string | null = null;

    if (verdict && !firstInstructionId) {
      return {
        success: false,
        transmissionId,
        verdictId: null,
        instructionsCount,
        alertId: null,
        error: 'Cannot persist the verdict without an instruction record.',
      };
    }

    if (verdict && firstInstructionId) {
      const { data: vData, error: vError } = await supabase
        .from('verdicts')
        .upsert({
          id: await deterministicUuid(`${sessionId}:verdict:${transcriptId}`),
          instruction_id: firstInstructionId,
          outcome: verdict.outcome,
          severity: verdict.severity,
          explanation: displayMessage || verdict.explanation,
        }, { onConflict: 'id' })
        .select('id')
        .single();

      if (vError) {
        console.error('[SafeComm Supabase Error] Failed inserting verdict:', vError);
        return {
          success: false,
          transmissionId,
          verdictId: null,
          instructionsCount,
          alertId: null,
          error: vError.message,
        };
      } else if (vData) {
        verdictId = vData.id;

        // 4. Persist alerts only for verified conflicts; incomplete results stay neutral.
        if (getVerificationFeedbackPolicy(verdict.outcome).persistAlert) {
          const { data: aData, error: aError } = await supabase
            .from('alerts')
            .upsert({
              id: await deterministicUuid(`${verdictId}:alert`),
              verdict_id: verdictId,
              acknowledged: false,
            }, { onConflict: 'id' })
            .select('id')
            .single();

          if (aError) {
            console.error('[SafeComm Supabase Error] Failed inserting alert:', aError);
            return {
              success: false,
              transmissionId,
              verdictId,
              instructionsCount,
              alertId: null,
              error: aError.message,
            };
          } else if (aData) {
            alertId = aData.id;
          } else {
            return {
              success: false,
              transmissionId,
              verdictId,
              instructionsCount,
              alertId: null,
              error: 'Supabase did not return the inserted alert record.',
            };
          }
        } else {
          const { error: staleAlertError } = await supabase
            .from('alerts')
            .delete()
            .eq('verdict_id', verdictId);
          if (staleAlertError) {
            return {
              success: false,
              transmissionId,
              verdictId,
              instructionsCount,
              alertId: null,
              error: staleAlertError.message,
            };
          }
        }
      } else {
        return {
          success: false,
          transmissionId,
          verdictId: null,
          instructionsCount,
          alertId: null,
          error: 'Supabase did not return the inserted verdict record.',
        };
      }
    }

    return {
      success: true,
      transmissionId,
      verdictId,
      instructionsCount,
      alertId,
      error: null,
    };
  } catch (err: unknown) {
    const message = (err as Error).message || 'Unexpected database sync exception';
    console.error('[SafeComm Supabase Exception]', err);
    return {
      success: false,
      transmissionId: null,
      verdictId: null,
      instructionsCount: 0,
      alertId: null,
      error: message,
    };
  }
}
