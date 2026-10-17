import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { authorizeRoomParticipant } from '../_shared/roomAuthorization.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/wav',
  'audio/mpeg',
  'audio/mp3',
]);

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'POST required' }, 405);
  }

  try {
    const form = await request.formData();
    const audio = form.get('audio');
    const roomId = form.get('roomId');
    const role = form.get('role');

    if (
      !(audio instanceof File) || audio.size === 0 ||
      audio.size > MAX_AUDIO_SIZE_BYTES
    ) {
      return jsonResponse({
        error: 'A non-empty audio recording under 5 MB is required.',
      }, 400);
    }
    if (
      typeof roomId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        roomId,
      ) ||
      (role !== 'atc' && role !== 'pilot')
    ) {
      return jsonResponse(
        { error: 'Room and participant role are required.' },
        400,
      );
    }
    const contentType = audio.type.split(';')[0]?.trim().toLowerCase();
    if (!contentType || !SUPPORTED_AUDIO_TYPES.has(contentType)) {
      return jsonResponse(
        { error: 'The recording format is not supported.' },
        415,
      );
    }

    const authorization = await authorizeRoomParticipant(request, roomId, role);
    if (!authorization.authorized) {
      return jsonResponse({ error: authorization.error }, authorization.status);
    }

    const apiKey = Deno.env.get('GROQ_API_KEY');
    if (!apiKey) {
      return jsonResponse({
        error: 'Hosted speech transcription is not configured.',
      }, 503);
    }

    const model = Deno.env.get('GROQ_ASR_MODEL') || 'whisper-large-v3-turbo';
    const providerForm = new FormData();
    providerForm.set('file', audio, audio.name || 'transmission.webm');
    providerForm.set('model', model);
    providerForm.set('language', 'en');
    providerForm.set(
      'prompt',
      'Aviation radio phraseology. Preserve aircraft callsigns, headings, runways, altitudes, and squawk codes. Write spoken digits as numbers.',
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: providerForm,
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      console.warn(
        '[SafeComm/ASR] Hosted transcription provider failed:',
        response.status,
      );
      return jsonResponse({
        error: `Hosted speech transcription failed (HTTP ${response.status}).`,
      }, 502);
    }

    const payload: unknown = await response.json();
    const text = payload && typeof payload === 'object' && 'text' in payload &&
        typeof payload.text === 'string'
      ? payload.text.trim()
      : '';
    if (!text) {
      return jsonResponse({
        error: 'The hosted speech recognizer returned no transcript.',
      }, 422);
    }

    return jsonResponse({ text, provider: 'groq', model });
  } catch (error) {
    console.error('[SafeComm/ASR] Hosted transcription request failed:', error);
    return jsonResponse({
      error: 'Hosted speech transcription request failed.',
    }, 500);
  }
});
