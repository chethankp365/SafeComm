import { supabase } from './supabase';

export type TransmissionIntent =
  | 'instruction'
  | 'clearance'
  | 'question'
  | 'request'
  | 'acknowledgement'
  | 'correction'
  | 'other';

export interface ExtractedInstruction {
  type: 'altitude' | 'heading' | 'runway' | 'squawk' | 'speed' | 'other';
  value: string;
  unit?: string | null;
  direction?: 'left' | 'right' | null;
  action?: 'climb' | 'descend' | 'maintain' | 'hold_short' | 'cross' | 'line_up_and_wait' | 'cleared_to_land' | 'cleared_for_takeoff' | 'taxi' | null;
  confidence: number;
}

export interface ExtractionResult {
  callsign: string;
  instructions: ExtractedInstruction[];
  parserType: 'AI Parser (Groq)' | 'AI Parser (Gemini)' | 'Local Parser';
  provider?: 'groq' | 'gemini' | 'local-fallback';
  extractionFailed?: boolean;
  providerModel?: string;
  latencyMs?: number;
  intent: TransmissionIntent;
  rawText: string;
  timestamp: string;
}

export interface ExtractionContext {
  roomId: string;
  role: 'atc' | 'pilot';
  transcriptId: string;
}

const VALID_INTENTS = new Set<TransmissionIntent>([
  'instruction',
  'clearance',
  'question',
  'request',
  'acknowledgement',
  'correction',
  'other',
]);

const VALID_INSTRUCTION_TYPES = new Set<ExtractedInstruction['type']>([
  'altitude',
  'heading',
  'runway',
  'squawk',
  'speed',
  'other',
]);

const VALID_ACTIONS = new Set<NonNullable<ExtractedInstruction['action']>>([
  'climb',
  'descend',
  'maintain',
  'hold_short',
  'cross',
  'line_up_and_wait',
  'cleared_to_land',
  'cleared_for_takeoff',
  'taxi',
]);

const VALID_PARSER_TYPES = new Set<ExtractionResult['parserType']>([
  'AI Parser (Groq)',
  'AI Parser (Gemini)',
  'Local Parser',
]);

export function classifyTransmissionIntent(transcript: string): TransmissionIntent {
  const text = transcript.trim().toLowerCase();
  if (!text) return 'other';

  if (/\b(?:request(?:ing)?|may we|could we|can we)\b/.test(text)) return 'request';
  if (/\b(?:correction|negative|disregard|cancel(?:led)?)\b/.test(text)) return 'correction';

  if (/[?]\s*$/.test(text) || /\b(?:is\s+it|are\s+you|do\s+you)\b/.test(text)) {
    return 'question';
  }

  const explicitClearance =
    /\bcleared\s+(?:for\s+takeoff|to\s+land)\b/.test(text);
  if (explicitClearance) return 'clearance';

  const explicitInstruction =
    /\b(?:climb|climbing|descend|descending|maintain|turn|heading|runway|squawk|hold\s*short|cross|line\s*up|taxi|reduce\s+speed|speed\s+\d)\b/.test(text);
  if (explicitInstruction) return 'instruction';

  if (/^\s*(?:roger|wilco|affirmative|negative|copy|standby|acknowledged)\b/.test(text)) {
    return 'acknowledgement';
  }
  return 'other';
}

function isValidExtractionPayload(value: unknown): value is {
  callsign: string;
  instructions: ExtractedInstruction[];
  intent: TransmissionIntent;
  parserType: ExtractionResult['parserType'];
  provider?: ExtractionResult['provider'];
  extractionFailed?: boolean;
  latencyMs?: number;
  model?: string;
} {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (
    typeof data.callsign !== 'string' ||
    typeof data.intent !== 'string' ||
    !VALID_INTENTS.has(data.intent as TransmissionIntent) ||
    !Array.isArray(data.instructions) ||
    typeof data.parserType !== 'string' ||
    !VALID_PARSER_TYPES.has(data.parserType as ExtractionResult['parserType']) ||
    (data.provider !== undefined &&
      data.provider !== 'groq' &&
      data.provider !== 'gemini' &&
      data.provider !== 'local-fallback') ||
    (data.extractionFailed !== undefined && typeof data.extractionFailed !== 'boolean') ||
    (data.latencyMs !== undefined &&
      (typeof data.latencyMs !== 'number' || !Number.isFinite(data.latencyMs))) ||
    (data.model !== undefined && typeof data.model !== 'string')
  ) {
    return false;
  }

  return data.instructions.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const instruction = item as Record<string, unknown>;
    return (
      typeof instruction.type === 'string' &&
      VALID_INSTRUCTION_TYPES.has(instruction.type as ExtractedInstruction['type']) &&
      typeof instruction.value === 'string' &&
      instruction.value.trim().length > 0 &&
      (instruction.unit === undefined || instruction.unit === null || typeof instruction.unit === 'string') &&
      (instruction.direction === undefined ||
        instruction.direction === null ||
        instruction.direction === 'left' ||
        instruction.direction === 'right') &&
      (instruction.action === undefined ||
        instruction.action === null ||
        (typeof instruction.action === 'string' &&
          VALID_ACTIONS.has(instruction.action as NonNullable<ExtractedInstruction['action']>))) &&
      typeof instruction.confidence === 'number' &&
      Number.isFinite(instruction.confidence) &&
      instruction.confidence >= 0 &&
      instruction.confidence <= 1
    );
  });
}

export function isValidExtractionResult(value: unknown): value is ExtractionResult {
  return isValidExtractionPayload(value) &&
    'rawText' in value &&
    typeof value.rawText === 'string' &&
    'timestamp' in value &&
    typeof value.timestamp === 'string';
}

const WORD_TO_DIGIT: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  tree: '3',
  four: '4',
  fife: '5',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  niner: '9',
};

export function normalizeAviationSpokenPhrases(input: string): string {
  let s = input;

  // Speech recognition commonly confuses "wait" with "weight" in runway phraseology.
  s = s.replace(/\bline\s*up\s+and\s+weight\b/gi, 'line up and wait');
  s = s.replace(/\b(\d{1,2}),(\d{3})\b/g, '$1$2');

  // Replace spoken thousand / hundred (e.g., "four thousand" -> "4000")
  s = s.replace(/(\b(?:one|two|three|tree|four|five|fife|six|seven|eight|nine|niner|\d+)\b)\s*thousand/gi, (_, num) => {
    const digit = WORD_TO_DIGIT[num.toLowerCase()] || num;
    const n = parseInt(digit, 10);
    return isNaN(n) ? num : `${n * 1000}`;
  });

  // Convert sequences of spoken digits (e.g. "one nine zero" -> "190", "two seven zero" -> "270", "four two one five" -> "4215")
  const digitWordsRegex = /\b(?:zero|one|two|three|tree|four|five|fife|six|seven|eight|nine|niner)(?:\s+(?:zero|one|two|three|tree|four|five|fife|six|seven|eight|nine|niner))+\b/gi;
  s = s.replace(digitWordsRegex, (match) => {
    return match
      .split(/\s+/)
      .map((w) => WORD_TO_DIGIT[w.toLowerCase()] ?? w)
      .join('');
  });

  // Single spoken digits following keywords like "heading", "runway", "squawk", "flight level"
  s = s.replace(/\b(?:flight\s*level|FL|heading|squawk)\s+([a-zA-Z\s]+)/gi, (full, words) => {
    const parts = words.trim().split(/\s+/);
    if (parts.every((p: string) => WORD_TO_DIGIT[p.toLowerCase()])) {
      const converted = parts.map((p: string) => WORD_TO_DIGIT[p.toLowerCase()]).join('');
      return full.replace(words, converted);
    }
    return full;
  });

  // Runway right/left/center words (e.g. "runway 28 right" -> "runway 28R")
  s = s.replace(/runway\s*(\d{1,2})\s*right/gi, 'runway $1R');
  s = s.replace(/runway\s*(\d{1,2})\s*left/gi, 'runway $1L');
  s = s.replace(/runway\s*(\d{1,2})\s*center/gi, 'runway $1C');

  return s;
}

/**
 * Local deterministic rule-based extractor (fallback when LLM key is absent or on parse failure)
 */
export function extractWithLocalRules(transcript: string): ExtractionResult {
  const normalized = normalizeAviationSpokenPhrases(transcript.trim());
  const text = normalized;
  const instructions: ExtractedInstruction[] = [];

  // 1. Extract Callsign
  let callsign = 'UNKNOWN';
  if (/\bspeed\s*bird\s*214\b/i.test(text) || /\bspeedb(?:ird)?\s*214\b/i.test(text) || /\bbaw\s*214\b/i.test(text)) {
    callsign = 'BAW214';
  } else if (/united\s*421/i.test(text) || /ual\s*421/i.test(text)) {
    callsign = 'UAL421';
  } else if (/delta\s*882/i.test(text) || /dal\s*882/i.test(text)) {
    callsign = 'DAL882';
  } else {
    const callsignMatch = text.match(/\b([a-zA-Z]{2,})\s*(\d{2,4})\b/);
    const nonCallsignWords = new Set([
      'CLIMB', 'CLIMBING', 'DESCEND', 'DESCENDING', 'MAINTAIN', 'MAINTAINING',
      'HEADING', 'RUNWAY', 'SQUAWK', 'SPEED', 'FLIGHT', 'LEVEL', 'TURN',
      'HOLD', 'CROSS', 'TAXI', 'CLEARED', 'EXPEDITE', 'CONTINUE', 'REDUCE',
      'FL', 'RWY', 'FEET', 'KNOTS',
    ]);
    if (callsignMatch && !nonCallsignWords.has(callsignMatch[1].toUpperCase())) {
      const prefix = callsignMatch[1].toUpperCase();
      const normalizedPrefix = prefix === 'BIRD' || prefix === 'SPEEDBIRD'
        ? 'BAW'
        : prefix === 'UNITED'
        ? 'UAL'
        : prefix === 'DELTA'
        ? 'DAL'
        : prefix;
      callsign = `${normalizedPrefix}${callsignMatch[2]}`;
    }
  }

  // 2. Extract Altitude / Flight Level
  const flMatch = text.match(/(?:flight\s*level|FL)\s*(\d{2,3})/i);
  if (flMatch) {
    const flNum = parseInt(flMatch[1], 10);
    const altitudeFt = flNum * 100;
    const clauseStart = Math.max(
      text.lastIndexOf('.', flMatch.index),
      text.lastIndexOf(',', flMatch.index),
      text.lastIndexOf(';', flMatch.index)
    ) + 1;
    const altitudeContext = text.slice(clauseStart, flMatch.index);
    const action = /\bdescend(?:ing)?\b/i.test(altitudeContext)
      ? 'descend'
      : /\bclimb(?:ing)?\b/i.test(altitudeContext)
      ? 'climb'
      : 'maintain';
    instructions.push({
      type: 'altitude',
      value: `FL${flNum} (${altitudeFt}ft)`,
      unit: 'feet',
      action,
      confidence: 0.98,
    });
  } else {
    const altMatch = text.match(/(?:maintain(?:ing)?|climb(?:ing)?(?:\s*to)?|descend(?:ing)?(?:\s*to)?)\s*(\d{3,5})\s*(?:feet|ft)?/i);
    if (altMatch) {
      const altNum = altMatch[1];
      const clauseStart = Math.max(
        text.lastIndexOf('.', altMatch.index),
        text.lastIndexOf(',', altMatch.index),
        text.lastIndexOf(';', altMatch.index)
      ) + 1;
      const altitudeContext = text.slice(clauseStart, (altMatch.index ?? 0) + altMatch[0].length);
      const action = /\bdescend(?:ing)?\b/i.test(altitudeContext)
        ? 'descend'
        : /\bclimb(?:ing)?\b/i.test(altitudeContext)
        ? 'climb'
        : 'maintain';
      instructions.push({
        type: 'altitude',
        value: `${altNum}ft`,
        unit: 'feet',
        action,
        confidence: 0.95,
      });
    }
  }

  // 3. Extract Heading & Direction
  const headingPattern = /(?:(?:turn\s+(left|right)\b[\s,]*(?:(?:to|and|then|fly|proceed)\s+)*)|(left|right)\s+)?heading\s*(\d{1,3})/gi;
  for (const headingMatch of text.matchAll(headingPattern)) {
    const dirToken = headingMatch[1] || headingMatch[2];
    const direction = dirToken ? dirToken.toLowerCase() as 'left' | 'right' : null;
    const value = headingMatch[3].padStart(3, '0');
    const existingHeading = instructions.find((instruction) =>
      instruction.type === 'heading' && instruction.value === value
    );
    if (existingHeading) {
      if (!existingHeading.direction && direction) existingHeading.direction = direction;
      continue;
    }

    instructions.push({
      type: 'heading',
      value,
      unit: 'degrees',
      direction,
      confidence: 0.96,
    });
  }

  // 4. Extract Runway & Actions
  const rwyMatch = text.match(/\brunway\s*((?:0?[1-9]|[12]\d|3[0-6])(?:\s*(?:left|right|center|[A-Z]))?)(?!\d)\b/i);
  if (rwyMatch) {
    let rwyStr = rwyMatch[1].toUpperCase();
    const runwayStart = rwyMatch.index ?? 0;
    if (rwyStr.includes('LEFT')) rwyStr = rwyStr.replace(/LEFT/g, 'L').trim();
    if (rwyStr.includes('RIGHT')) rwyStr = rwyStr.replace(/RIGHT/g, 'R').trim();
    if (rwyStr.includes('CENTER')) rwyStr = rwyStr.replace(/CENTER/g, 'C').trim();

    let action: 'hold_short' | 'cross' | 'line_up_and_wait' | 'cleared_to_land' | 'cleared_for_takeoff' | 'taxi' | null = null;
    const runwayContext = text.slice(
      Math.max(0, runwayStart - 48),
      Math.min(text.length, runwayStart + rwyMatch[0].length + 48)
    );
    if (/hold\s*short/i.test(runwayContext)) action = 'hold_short';
    else if (/\bcross\b/i.test(runwayContext)) action = 'cross';
    else if (/line(?:d)?[\s-]*up\s*(?:and\s*wait)?/i.test(runwayContext)) action = 'line_up_and_wait';
    else if (/cleared\s*to\s*land/i.test(runwayContext)) action = 'cleared_to_land';
    else if (/cleared\s*for\s*takeoff/i.test(runwayContext)) action = 'cleared_for_takeoff';
    else if (/\btaxi\b/i.test(runwayContext)) action = 'taxi';

    instructions.push({
      type: 'runway',
      value: rwyStr,
      action,
      confidence: 0.95,
    });
  }

  // 5. Extract Squawk
  const squawkMatch = text.match(/squawk\s*(\d{4})/i);
  if (squawkMatch) {
    instructions.push({
      type: 'squawk',
      value: squawkMatch[1],
      confidence: 0.99,
    });
  }

  // 6. Extract Speed
  const spdMatch = text.match(/(?:speed|maintain\s*speed)\s*(\d{2,3})(?:\s*knots)?/i);
  if (spdMatch) {
    instructions.push({
      type: 'speed',
      value: spdMatch[1],
      unit: 'knots',
      confidence: 0.95,
    });
  }

  return {
    callsign,
    instructions,
    parserType: 'Local Parser',
    provider: 'local-fallback',
    intent: classifyTransmissionIntent(text),
    rawText: transcript,
    timestamp: new Date().toISOString(),
  };
}

export function extractWithLocalFallback(transcript: string): ExtractionResult {
  const extraction = extractWithLocalRules(transcript);
  const hasReliableSafetyFields = extraction.instructions.some(
    (instruction) => instruction.type !== 'other' && instruction.confidence >= 0.75
  );
  return {
    ...extraction,
    extractionFailed: !hasReliableSafetyFields,
  };
}

/**
 * Main Extraction Function:
 * Uses the authenticated Supabase Edge Function, then deterministic local rules.
 */
const extractionCache = new Map<string, Promise<ExtractionResult>>();
const EXTRACTION_CACHE_LIMIT = 500;

function verificationDebugEnabled(): boolean {
  return Boolean(
    import.meta.env?.DEV ||
    (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('verifyDebug'))
  );
}

function verificationTrace(event: string, details: Record<string, string | number | undefined>): void {
  if (verificationDebugEnabled()) {
    console.info('[SafeComm/Verify]', event, details);
  }
}

export function extractInstructions(
  transcriptLine: string,
  context?: ExtractionContext
): Promise<ExtractionResult> {
  const cacheKey = context
    ? `${context.roomId}:${context.transcriptId}:${context.role}:${transcriptLine.trim()}`
    : null;
  if (cacheKey && context && extractionCache.has(cacheKey)) {
    verificationTrace('extraction cache hit', {
      roomId: context.roomId,
      transcriptId: context.transcriptId,
      role: context.role,
    });
    return extractionCache.get(cacheKey)!;
  }

  const request = extractInstructionsUncached(transcriptLine, context);
  if (cacheKey) {
    extractionCache.set(cacheKey, request);
    if (extractionCache.size > EXTRACTION_CACHE_LIMIT) {
      const oldestKey = extractionCache.keys().next().value;
      if (oldestKey) extractionCache.delete(oldestKey);
    }
  }
  return request;
}

async function extractInstructionsUncached(
  transcriptLine: string,
  context?: ExtractionContext
): Promise<ExtractionResult> {
  const localExtraction = extractWithLocalFallback(transcriptLine);
  const startedAt = Date.now();
  const localFallback = (): ExtractionResult => ({
    ...localExtraction,
    provider: 'local-fallback',
    latencyMs: Date.now() - startedAt,
  });

  const toValidatedExtraction = (data: unknown): ExtractionResult | null => {
    if (!isValidExtractionPayload(data) || data.extractionFailed) return null;
    const authoritativeLocalIntent =
      localExtraction.intent === 'question' ||
      localExtraction.intent === 'request' ||
      localExtraction.intent === 'acknowledgement';
    return {
      callsign: localExtraction.callsign !== 'UNKNOWN'
        ? localExtraction.callsign
        : data.callsign,
      instructions: data.instructions,
      intent: authoritativeLocalIntent ? localExtraction.intent : data.intent,
      parserType: data.parserType,
      provider: data.provider || (data.parserType === 'AI Parser (Gemini)' ? 'gemini' : 'groq'),
      providerModel: data.model,
      latencyMs: data.latencyMs ?? Date.now() - startedAt,
      rawText: transcriptLine,
      timestamp: new Date().toISOString(),
    };
  };

  try {
    const { data, error } = await supabase.functions.invoke('extract-instructions', {
      body: {
        text: transcriptLine,
        ...(context || {}),
      },
    });
    if (!error) {
      const extraction = toValidatedExtraction(data);
      if (extraction) {
        verificationTrace('extraction validated', {
          roomId: context?.roomId,
          transcriptId: context?.transcriptId,
          role: context?.role,
          provider: extraction.provider,
          model: extraction.providerModel,
          latencyMs: extraction.latencyMs ?? Date.now() - startedAt,
          textLength: transcriptLine.length,
          fieldCount: extraction.instructions.length,
        });
        return extraction;
      }
    }
    if (!error && data && typeof data === 'object' && 'extractionFailed' in data) {
      verificationTrace('AI providers exhausted; extraction unverified', {
        roomId: context?.roomId,
        transcriptId: context?.transcriptId,
        role: context?.role,
        provider: 'local-fallback',
        latencyMs: Date.now() - startedAt,
      });
      return localFallback();
    }
    verificationTrace('provider fallback', {
      roomId: context?.roomId,
      transcriptId: context?.transcriptId,
      role: context?.role,
      provider: 'local-fallback',
      latencyMs: Date.now() - startedAt,
      textLength: transcriptLine.length,
      functionError: error ? 1 : 0,
    });
  } catch {
    verificationTrace('provider request failed', {
      roomId: context?.roomId,
      transcriptId: context?.transcriptId,
      role: context?.role,
      provider: 'local-fallback',
      latencyMs: Date.now() - startedAt,
      textLength: transcriptLine.length,
    });
  }
  return localFallback();
}
