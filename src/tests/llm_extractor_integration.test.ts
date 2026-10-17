import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: { invoke },
  },
}));

import { extractInstructions, extractWithLocalRules } from '../lib/llmExtractor';
import { diffExtractions, verifyTranscriptTimeline } from '../lib/databaseSync';

describe('Live transcript structured extraction integration', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('uses validated Groq extraction as input while deterministic comparison decides the verdict', async () => {
    invoke.mockResolvedValue({
      error: null,
      data: {
        callsign: 'BAW123',
        intent: 'clearance',
        parserType: 'AI Parser (Groq)',
        instructions: [{
          type: 'runway',
          value: '27',
          action: 'cleared_for_takeoff',
          confidence: 0.98,
        }],
      },
    });

    const controller = await extractInstructions('Bird 123, cleared for takeoff runway 27.');
    const pilot = extractWithLocalRules('Bird 123, cleared for takeoff runway 26.');

    expect(invoke).toHaveBeenCalledWith('extract-instructions', {
      body: { text: 'Bird 123, cleared for takeoff runway 27.' },
    });
    expect(controller.parserType).toBe('AI Parser (Groq)');
    expect(diffExtractions(controller, pilot).outcome).toBe('MISMATCH');
    expect(diffExtractions(controller, pilot).mismatchedFields[0]).toContain('Runway Clearance');
  });

  it('falls back to the local parser on malformed structured output rather than trusting it', async () => {
    invoke.mockResolvedValue({
      error: null,
      data: {
        callsign: 'BAW123',
        intent: 'clearance',
        parserType: 'AI Parser (Groq)',
        instructions: [{ type: 'runway', value: '27', confidence: 'high' }],
      },
    });

    const result = await extractInstructions('Bird 123, cleared for takeoff runway 27.');

    expect(result.parserType).toBe('Local Parser');
    expect(result.provider).toBe('local-fallback');
    expect(result.extractionFailed).toBe(false);
    expect(result.callsign).toBe('BAW123');
    expect(result.instructions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'runway', value: '27' })])
    );
  });

  it('uses reliable local fields when the server extraction function is unavailable', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: new Error('The signed-in user is not authorized for this room role. (403)'),
    });

    const result = await extractInstructions('Bird 123, turn right heading 090.');

    expect(result.parserType).toBe('Local Parser');
    expect(result.extractionFailed).toBe(false);
    expect(result.callsign).toBe('BAW123');
    expect(result.intent).toBe('instruction');
    expect(result.instructions).toEqual(
      expect.arrayContaining([expect.objectContaining({
        type: 'heading',
        value: '090',
        direction: 'right',
      })])
    );
    expect(diffExtractions(
      result,
      extractWithLocalRules('Bird 123, turn left heading 090.')
    ).outcome).toBe('MISMATCH');
  });

  it('accepts validated Gemini fallback extraction and keeps deterministic verification authoritative', async () => {
    invoke.mockResolvedValue({
      error: null,
      data: {
        callsign: 'UAL421',
        intent: 'instruction',
        parserType: 'AI Parser (Gemini)',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        latencyMs: 125,
        instructions: [{
          type: 'heading',
          value: '090',
          unit: 'degrees',
          direction: 'right',
          confidence: 0.99,
        }],
      },
    });

    const result = await extractInstructions('United 421, turn right heading 090.');
    const readback = extractWithLocalRules('Turn left heading 090.');

    expect(result.provider).toBe('gemini');
    expect(result.providerModel).toBe('gemini-2.5-flash');
    expect(result.latencyMs).toBe(125);
    expect(diffExtractions(result, readback, 'UAL421').outcome).toBe('MISMATCH');
  });

  it('uses reliable local fields when provider extraction is exhausted', async () => {
    invoke.mockResolvedValue({
      error: null,
      data: {
        extractionFailed: true,
        provider: 'local-fallback',
        parserType: 'Local Parser',
        model: null,
        latencyMs: 900,
        reason: 'AI providers failed validation.',
      },
    });

    const controller = await extractInstructions('United 421, turn right heading 090.');
    const pilot = extractWithLocalRules('Turn right heading 090.');

    expect(controller.provider).toBe('local-fallback');
    expect(controller.extractionFailed).toBe(false);
    expect(diffExtractions(controller, pilot, 'UAL421').outcome).toBe('MATCH');
  });

  it('keeps local parser output unverified when it found no reliable safety fields', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('Function unavailable') });

    const result = await extractInstructions('Roger.');

    expect(result.provider).toBe('local-fallback');
    expect(result.extractionFailed).toBe(true);
    expect(result.instructions).toHaveLength(0);
  });

  it('coalesces duplicate extraction requests for the same room transcript', async () => {
    invoke.mockResolvedValue({
      error: null,
      data: {
        callsign: 'UAL421',
        intent: 'instruction',
        parserType: 'AI Parser (Groq)',
        model: 'openai/gpt-oss-20b',
        instructions: [{
          type: 'heading',
          value: '090',
          unit: 'degrees',
          direction: 'right',
          confidence: 0.99,
        }],
      },
    });
    const context = {
      roomId: '00000000-0000-4000-8000-000000000001',
      role: 'atc' as const,
      transcriptId: 'room-atc-transcript-cache-test',
    };
    const text = 'United 421, turn right heading 090.';

    const [first, duplicate] = await Promise.all([
      extractInstructions(text, context),
      extractInstructions(text, context),
    ]);

    expect(first).toBe(duplicate);
    expect(first.providerModel).toBe('openai/gpt-oss-20b');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('extract-instructions', {
      body: { text, ...context },
    });
  });

  it('extracts ATC and pilot transmissions separately before deterministic timeline verification', async () => {
    invoke.mockImplementation(async (_name: string, { body }: { body: { text: string } }) => ({
      error: null,
      data: {
        callsign: 'UAL421',
        intent: 'instruction',
        parserType: 'AI Parser (Groq)',
        instructions: [{
          type: 'heading',
          value: '090',
          unit: 'degrees',
          direction: body.text.toLowerCase().includes('turn left') ? 'left' : 'right',
          action: null,
          confidence: 0.99,
        }],
      },
    }));

    const atcText = 'United 421, turn right heading zero niner zero.';
    const pilotText = 'Turn left heading 090.';
    const [atcExtraction, pilotExtraction] = await Promise.all([
      extractInstructions(atcText),
      extractInstructions(pilotText),
    ]);
    const timeline = verifyTranscriptTimeline([
      {
        id: 'room-atc',
        roomId: 'room-1',
        role: 'atc',
        callsign: 'KSFO Tower',
        text: atcText,
        timestamp: '12:00:00 UTC',
        isFinal: true,
      },
      {
        id: 'room-pilot',
        roomId: 'room-1',
        role: 'pilot',
        callsign: 'United 421',
        text: pilotText,
        timestamp: '12:00:02 UTC',
        isFinal: true,
      },
    ], {
      'room-atc': atcExtraction,
      'room-pilot': pilotExtraction,
    }, 'room-1');

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(timeline.verdicts['room-pilot'].outcome).toBe('MISMATCH');
    expect(timeline.verdicts['room-pilot'].explanation).toContain('Assigned turn RIGHT');
  });
});
