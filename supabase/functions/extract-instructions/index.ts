import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { authorizeRoomParticipant } from '../_shared/roomAuthorization.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `You extract explicit facts from one aviation radio transcript. You do not verify safety, compare messages, or decide a verdict.
Return only a JSON object with this schema:
{"callsign":"string or UNKNOWN","intent":"instruction|clearance|question|request|acknowledgement|correction|other","instructions":[{"type":"altitude|heading|runway|squawk|speed|other","value":"string","unit":"feet|degrees|knots|null","direction":"left|right|null","action":"climb|descend|maintain|hold_short|cross|line_up_and_wait|cleared_to_land|cleared_for_takeoff|taxi|null","confidence":0.0}]}
Extract only facts explicitly spoken. Use null for omitted direction, unit, or action; never infer missing values. Preserve leading zeros in headings and squawk codes. Convert spoken aviation numbers to digits, treating "niner" as 9, "tree" as 3, and "fife" as 5. Include heading direction and the action paired with its altitude/runway. A question, readiness check, request, or acknowledgement is not a clearance. For those, return an empty instructions array unless an explicit instruction is present. Never infer values or permissions.`;

type Instruction = {
  type: 'altitude' | 'heading' | 'runway' | 'squawk' | 'speed' | 'other';
  value: string;
  unit: 'feet' | 'degrees' | 'knots' | null;
  direction: 'left' | 'right' | null;
  action:
    | 'climb'
    | 'descend'
    | 'maintain'
    | 'hold_short'
    | 'cross'
    | 'line_up_and_wait'
    | 'cleared_to_land'
    | 'cleared_for_takeoff'
    | 'taxi'
    | null;
  confidence: number;
};

const intents = new Set([
  'instruction',
  'clearance',
  'question',
  'request',
  'acknowledgement',
  'correction',
  'other',
]);
const instructionTypes = new Set(['altitude', 'heading', 'runway', 'squawk', 'speed', 'other']);
const actions = new Set([
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

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function validExtraction(value: unknown): value is {
  callsign: string;
  intent: string;
  instructions: Instruction[];
} {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.callsign === 'string' &&
    typeof result.intent === 'string' &&
    intents.has(result.intent) &&
    Array.isArray(result.instructions) &&
    result.instructions.length <= 20 &&
    result.instructions.every((item) => {
      if (!item || typeof item !== 'object') return false;
      const instruction = item as Record<string, unknown>;
      return (
        typeof instruction.type === 'string' &&
        instructionTypes.has(instruction.type) &&
        typeof instruction.value === 'string' &&
        instruction.value.trim().length > 0 &&
        (instruction.unit === undefined ||
          instruction.unit === null ||
          instruction.unit === 'feet' ||
          instruction.unit === 'degrees' ||
          instruction.unit === 'knots') &&
        (instruction.direction === undefined ||
          instruction.direction === null ||
          instruction.direction === 'left' ||
          instruction.direction === 'right') &&
        (instruction.action === undefined ||
          instruction.action === null ||
          (typeof instruction.action === 'string' && actions.has(instruction.action))) &&
        typeof instruction.confidence === 'number' &&
        Number.isFinite(instruction.confidence) &&
        instruction.confidence >= 0 &&
        instruction.confidence <= 1
      );
    })
  );
}

function hasOnlyReliableSafetyFields(value: {
  instructions: Instruction[];
}): boolean {
  return value.instructions
    .filter((instruction) => instruction.type !== 'other')
    .every((instruction) => instruction.confidence >= 0.75);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status !== 429 || attempt === 1) return response;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error('Provider retry limit reached.');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

  try {
    const body = await req.json();
    const text = body?.text;
    const roomId = body?.roomId;
    const role = body?.role;
    const transcriptId = body?.transcriptId;
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
      return jsonResponse({ error: 'Text transcript required' }, 400);
    }
    if (
      typeof roomId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomId) ||
      (role !== 'atc' && role !== 'pilot') ||
      typeof transcriptId !== 'string' ||
      !transcriptId.trim()
    ) {
      return jsonResponse({ error: 'Room, participant role, and transcript identifiers are required.' }, 400);
    }

    const authorization = await authorizeRoomParticipant(req, roomId, role);
    if (!authorization.authorized) {
      return jsonResponse({ error: authorization.error }, authorization.status);
    }

    const startedAt = Date.now();
    const failures: Array<{ provider: string; status?: number }> = [];
    const groqKey = Deno.env.get('GROQ_API_KEY');
    if (groqKey) {
      const model = Deno.env.get('GROQ_MODEL') || 'llama-3.3-70b-versatile';
      try {
        const response = await fetchWithRetry(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${groqKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: JSON.stringify({ transcript: text }) },
              ],
              response_format: { type: 'json_object' },
              temperature: 0,
            }),
          }
        );
        if (response.ok) {
          const data = await response.json();
          const content = data?.choices?.[0]?.message?.content;
          const extraction: unknown = typeof content === 'string' ? JSON.parse(content) : null;
          if (validExtraction(extraction) && hasOnlyReliableSafetyFields(extraction)) {
            console.info('[SafeComm/Extract]', {
              provider: 'groq',
              model,
              status: response.status,
              latencyMs: Date.now() - startedAt,
            });
            return jsonResponse({
              ...extraction,
              provider: 'groq',
              parserType: 'AI Parser (Groq)',
              model,
              latencyMs: Date.now() - startedAt,
            });
          }
          failures.push({ provider: 'groq', status: 422 });
        } else {
          failures.push({ provider: 'groq', status: response.status });
        }
      } catch {
        failures.push({ provider: 'groq' });
      }
    } else {
      failures.push({ provider: 'groq', status: 503 });
    }

    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (geminiKey) {
      const model = Deno.env.get('GEMINI_MODEL') || 'gemini-1.5-flash';
      try {
        const response = await fetchWithRetry(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': geminiKey,
            },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: [{ role: 'user', parts: [{ text: JSON.stringify({ transcript: text }) }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0,
              },
            }),
          }
        );
        if (response.ok) {
          const data = await response.json();
          const content = data?.candidates?.[0]?.content?.parts
            ?.map((part: { text?: string }) => part.text || '')
            .join('');
          const extraction: unknown = typeof content === 'string' ? JSON.parse(content) : null;
          if (validExtraction(extraction) && hasOnlyReliableSafetyFields(extraction)) {
            console.info('[SafeComm/Extract]', {
              provider: 'gemini',
              model,
              status: response.status,
              latencyMs: Date.now() - startedAt,
            });
            return jsonResponse({
              ...extraction,
              provider: 'gemini',
              parserType: 'AI Parser (Gemini)',
              model,
              latencyMs: Date.now() - startedAt,
            });
          }
          failures.push({ provider: 'gemini', status: 422 });
        } else {
          failures.push({ provider: 'gemini', status: response.status });
        }
      } catch {
        failures.push({ provider: 'gemini' });
      }
    } else {
      failures.push({ provider: 'gemini', status: 503 });
    }

    console.warn('[SafeComm/Extract]', {
      provider: 'local-fallback',
      extractionFailed: true,
      providerFailures: failures,
      latencyMs: Date.now() - startedAt,
    });
    return jsonResponse({
      extractionFailed: true,
      provider: 'local-fallback',
      parserType: 'Local Parser',
      model: null,
      latencyMs: Date.now() - startedAt,
      reason: 'Groq and Gemini extraction failed validation or were unavailable.',
    });
  } catch {
    return jsonResponse({
      extractionFailed: true,
      provider: 'local-fallback',
      parserType: 'Local Parser',
      model: null,
      latencyMs: null,
      reason: 'Instruction extraction could not be completed.',
    });
  }
});
