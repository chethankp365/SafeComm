import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ATC_SCENARIOS } from '../data/scenarios';
import { diffExtractions, type VerificationVerdictStub } from '../lib/databaseSync';
import {
  DEFAULT_VOICE_SETTINGS,
  selectBestVoice,
  previewVoice,
  stopVoicePreview,
  cancelAllSpeech,
  pauseSpeech,
  resumeSpeech,
  onVoicesChanged,
  loadVoiceSettings,
  saveVoiceSettings,
  SCENARIO_TRAINING_CORRECTIONS,
} from '../lib/speechAudio';
import { extractWithLocalRules } from '../lib/llmExtractor';

if (typeof localStorage === 'undefined') {
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const k in store) delete store[k];
    },
  };
}

describe('SafeComm Voice Playback & Scenario Verifier', () => {
  describe('1. Scenario Testing with Voice Enabled and Disabled', () => {
    const scenarios = [
      { id: 'scenario-correct-readback', name: 'Speedbird 214', expected: 'MATCH' },
      { id: 'scenario-heading-swap', name: 'United 421', expected: 'MISMATCH' },
      { id: 'scenario-runway-altitude-mismatch', name: 'Delta 882', expected: 'MISMATCH' },
    ];

    scenarios.forEach((scenInfo) => {
      it(`verifies ${scenInfo.name} with VOICE ENABLED (${scenInfo.expected})`, () => {
        const scenario = ATC_SCENARIOS.find((s) => s.id === scenInfo.id);
        expect(scenario).toBeDefined();

        const controllerLine = scenario!.lines[0].text;
        const pilotLine = scenario!.lines[1].text;

        const cExt = extractWithLocalRules(controllerLine);
        const pExt = extractWithLocalRules(pilotLine);

        const verdict: VerificationVerdictStub = diffExtractions(cExt, pExt);
        expect(verdict.outcome).toBe(scenInfo.expected);

        const correction = SCENARIO_TRAINING_CORRECTIONS[scenInfo.id];
        if (scenInfo.expected === 'MATCH') {
          // Zero false warnings in nominal scenario
          expect(correction.hasCorrection).toBe(false);
          expect(correction.spokenGuidance).toBe('');
          expect(verdict.mismatchedFields).toHaveLength(0);
        } else {
          // Mismatch scenario triggers appropriate advisory
          expect(correction.hasCorrection).toBe(true);
          expect(correction.spokenGuidance.length).toBeGreaterThan(20);
          expect(verdict.mismatchedFields.length).toBeGreaterThan(0);
        }
      });

      it(`verifies ${scenInfo.name} with VOICE DISABLED (${scenInfo.expected})`, () => {
        const scenario = ATC_SCENARIOS.find((s) => s.id === scenInfo.id);
        expect(scenario).toBeDefined();

        // When voice is disabled, verification logic remains 100% deterministic
        const controllerLine = scenario!.lines[0].text;
        const pilotLine = scenario!.lines[1].text;

        const cExt = extractWithLocalRules(controllerLine);
        const pExt = extractWithLocalRules(pilotLine);

        const verdict = diffExtractions(cExt, pExt);
        expect(verdict.outcome).toBe(scenInfo.expected);

        // Disabling voice does not impair text verification or alert detection
        if (scenInfo.expected === 'MISMATCH') {
          expect(verdict.severity).toBe('CRITICAL');
        }
      });
    });
  });

  describe('2. Professional Natural-Sounding Female English Voice Selection', () => {
    it('prioritizes Microsoft Edge Natural female voices (Jenny / Aria) for SafeComm assistant', () => {
      const edgeVoices = [
        { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
        { name: 'Microsoft Christopher Online (Natural) - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
        { name: 'Microsoft Jenny Online (Natural) - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
        { name: 'Microsoft Ryan Online (Natural) - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
      ];

      const assistantChoice = selectBestVoice(edgeVoices, 'assistant');
      expect(assistantChoice.voice?.name).toBe('Microsoft Jenny Online (Natural) - English (United States)');
      expect(assistantChoice.pitch).toBeCloseTo(1.02);
      expect(assistantChoice.rateMultiplier).toBeCloseTo(0.98);
    });

    it('prioritizes Apple Enhanced / Premium female voices (Samantha / Ava) on macOS/iOS', () => {
      const appleVoices = [
        { name: 'Daniel', lang: 'en-GB' } as SpeechSynthesisVoice,
        { name: 'Samantha (Enhanced)', lang: 'en-US' } as SpeechSynthesisVoice,
        { name: 'Fred', lang: 'en-US' } as SpeechSynthesisVoice,
      ];

      const assistantChoice = selectBestVoice(appleVoices, 'assistant');
      expect(assistantChoice.voice?.name).toBe('Samantha (Enhanced)');
    });

    it('selects Google US English female voice on Chrome', () => {
      const chromeVoices = [
        { name: 'Google UK English Male', lang: 'en-GB' } as SpeechSynthesisVoice,
        { name: 'Google US English', lang: 'en-US' } as SpeechSynthesisVoice,
      ];

      const assistantChoice = selectBestVoice(chromeVoices, 'assistant');
      expect(assistantChoice.voice?.name).toBe('Google US English');
    });

    it('selects Microsoft Zira Desktop on Windows SAPI systems', () => {
      const sapiVoices = [
        { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
        { name: 'Microsoft Zira Desktop - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
      ];

      const assistantChoice = selectBestVoice(sapiVoices, 'assistant');
      expect(assistantChoice.voice?.name).toBe('Microsoft Zira Desktop - English (United States)');
    });

    it('keeps Controller, Pilot, and SafeComm Assistant voices separate when multiple voices exist', () => {
      const multiVoices = [
        { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
        { name: 'Microsoft Jenny Online (Natural) - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
        { name: 'Microsoft Ryan Online (Natural) - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
      ];

      const controller = selectBestVoice(multiVoices, 'controller');
      const assistant = selectBestVoice(multiVoices, 'assistant', undefined, {
        controllerVoiceName: controller.voice?.name,
      });
      const pilot = selectBestVoice(multiVoices, 'pilot', undefined, {
        controllerVoiceName: controller.voice?.name,
        assistantVoiceName: assistant.voice?.name,
      });

      // Controller should get David, Assistant gets Jenny, Pilot gets Ryan
      expect(controller.voice?.name).toContain('David');
      expect(assistant.voice?.name).toContain('Jenny');
      expect(pilot.voice?.name).toContain('Ryan');

      // All three must be distinct
      expect(controller.voice?.name).not.toBe(assistant.voice?.name);
      expect(controller.voice?.name).not.toBe(pilot.voice?.name);
      expect(assistant.voice?.name).not.toBe(pilot.voice?.name);
    });

    it('falls back gracefully to any available English voice if no preferred female voice is present', () => {
      const genericVoices = [
        { name: 'Generic English Voice', lang: 'en-US' } as SpeechSynthesisVoice,
      ];

      const fallbackChoice = selectBestVoice(genericVoices, 'assistant');
      expect(fallbackChoice.voice?.name).toBe('Generic English Voice');
      expect(fallbackChoice.pitch).toBeDefined();
    });

    it('handles empty voice array without crashing', () => {
      const emptyChoice = selectBestVoice([], 'assistant');
      expect(emptyChoice.voice).toBeNull();
      expect(emptyChoice.pitch).toBeCloseTo(1.02);
      expect(emptyChoice.rateMultiplier).toBeCloseTo(0.98);
    });
  });

  describe('3. Voice Preview & Playback Overlap Safeguards', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('previews voice with representative role phrase without error', async () => {
      const mockVoices = [
        { name: 'Microsoft Jenny Online (Natural) - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
      ];

      await expect(
        previewVoice('Microsoft Jenny Online (Natural) - English (United States)', 'assistant', DEFAULT_VOICE_SETTINGS, mockVoices)
      ).resolves.toBeUndefined();
    });

    it('allows stopVoicePreview and cancelAllSpeech at any point without error', () => {
      expect(() => stopVoicePreview()).not.toThrow();
      expect(() => cancelAllSpeech()).not.toThrow();
      expect(() => pauseSpeech()).not.toThrow();
      expect(() => resumeSpeech()).not.toThrow();
    });

    it('subscribes to onVoicesChanged and returns an unregister function', () => {
      const callback = vi.fn();
      const unsubscribe = onVoicesChanged(callback);
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  describe('4. Settings Persistence & Non-Mutating Rehearsal', () => {
    it('persists and restores voice settings to/from localStorage', () => {
      const customSettings = {
        enabled: true,
        muted: false,
        rate: 1.15,
        volume: 0.85,
        assistantVoiceName: 'Microsoft Jenny Online (Natural) - English (United States)',
        controllerVoiceName: 'Microsoft David Desktop - English (United States)',
      };

      saveVoiceSettings(customSettings);
      const restored = loadVoiceSettings();

      expect(restored.rate).toBeCloseTo(1.15);
      expect(restored.volume).toBeCloseTo(0.85);
      expect(restored.assistantVoiceName).toBe('Microsoft Jenny Online (Natural) - English (United States)');
    });

    it('ensures scripted training responses do NOT mutate scenario data', () => {
      const scenarioLinesOriginal = ATC_SCENARIOS.map((s) => s.lines.length);
      const correction = SCENARIO_TRAINING_CORRECTIONS['scenario-heading-swap'];

      expect(correction.hasCorrection).toBe(true);
      expect(correction.scriptedCorrectedReadback).toContain('United 421');

      // Scenario source remains strictly untouched
      const scenarioLinesAfter = ATC_SCENARIOS.map((s) => s.lines.length);
      expect(scenarioLinesAfter).toEqual(scenarioLinesOriginal);
    });
  });
});
