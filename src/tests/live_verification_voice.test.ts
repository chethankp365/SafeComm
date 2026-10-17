import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractWithLocalRules, normalizeAviationSpokenPhrases } from '../lib/llmExtractor';
import {
  claimVerificationAlert,
  diffExtractions,
  formatVerificationAlertMessage,
  getVerificationFeedbackPolicy,
  verificationAlertKey,
  verifyTranscriptTimeline,
  type VerificationVerdictStub,
} from '../lib/databaseSync';
import {
  speakSafeCommAlert,
  speakSafeCommVerification,
  shouldSpeakSafeCommAlert,
  saveVoiceSettings,
  cancelAllSpeech,
  DEFAULT_VOICE_SETTINGS,
} from '../lib/speechAudio';

describe('SafeComm Connect — Live Readback Verification & Female Voice Corrections', () => {
  let mockStorage: Record<string, string> = {};
  const mockSpeak = vi.fn();
  const mockCancel = vi.fn();
  const mockVoices = [
    { name: 'Microsoft Jenny Online (Natural) - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
    { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US' } as SpeechSynthesisVoice,
  ];

  class MockSpeechSynthesisUtterance {
    text: string;
    voice: SpeechSynthesisVoice | null = null;
    pitch: number = 1;
    rate: number = 1;
    volume: number = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  beforeEach(() => {
    mockStorage = {};
    mockSpeak.mockClear();
    mockCancel.mockClear();

    const mockSpeechSynth = {
      speak: (utterance: any) => {
        mockSpeak(utterance);
        setTimeout(() => utterance.onend?.(), 10);
      },
      cancel: mockCancel,
      pause: vi.fn(),
      resume: vi.fn(),
      getVoices: () => mockVoices,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const mockStorageObj = {
      getItem: (k: string) => mockStorage[k] || null,
      setItem: (k: string, v: string) => { mockStorage[k] = String(v); },
      removeItem: (k: string) => { delete mockStorage[k]; },
      clear: () => { mockStorage = {}; },
    };

    vi.stubGlobal('localStorage', mockStorageObj);
    vi.stubGlobal('SpeechSynthesisUtterance', MockSpeechSynthesisUtterance);
    vi.stubGlobal('speechSynthesis', mockSpeechSynth);
    vi.stubGlobal('window', {
      speechSynthesis: mockSpeechSynth,
      SpeechSynthesisUtterance: MockSpeechSynthesisUtterance,
      localStorage: mockStorageObj,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --------------------------------------------------------------------------
  // 1. Deterministic Multi-Parameter Live Verification
  // --------------------------------------------------------------------------
  describe('Immediate visual safety notifications', () => {
    const verdict = (
      outcome: VerificationVerdictStub['outcome'],
      mismatchedFields: string[] = [],
      explanation = 'A verification discrepancy was detected.'
    ): VerificationVerdictStub => ({
      outcome,
      severity: outcome === 'MISMATCH' ? 'CRITICAL' : 'OK',
      explanation,
      matchedFields: [],
      mismatchedFields,
    });

    it('formats a concise runway mismatch using assigned and readback values', () => {
      const message = formatVerificationAlertMessage(
        verdict('MISMATCH', ['Runway Clearance (cleared_for_takeoff 27 vs cleared_for_takeoff 26)']),
        extractWithLocalRules('United 421, cleared for takeoff runway 27.'),
        extractWithLocalRules('United 421, cleared for takeoff runway 26.')
      );

      expect(message).toBe('RUNWAY MISMATCH — Assigned 27, readback 26.');
    });

    it('includes runway action when the hold-short/cross action conflicts', () => {
      const message = formatVerificationAlertMessage(
        verdict('MISMATCH', ['Runway Clearance (hold_short 28L vs cross 28R)']),
        extractWithLocalRules('Delta 882, hold short runway 28 left.'),
        extractWithLocalRules('Delta 882, cross runway 28 right.')
      );

      expect(message).toContain('RUNWAY MISMATCH — Assigned HOLD SHORT 28L');
      expect(message).toContain('readback CROSS 28R.');
    });

    it('formats heading direction conflicts with both directions and values', () => {
      const message = formatVerificationAlertMessage(
        verdict('MISMATCH', ['Heading Direction (RIGHT vs LEFT)']),
        extractWithLocalRules('United 421, turn right heading 090.'),
        extractWithLocalRules('United 421, turn left heading 090.')
      );

      expect(message).toBe('HEADING MISMATCH — Assigned RIGHT 090, readback LEFT 090.');
    });

    it('formats altitude and squawk mismatches with both values', () => {
      const altitude = formatVerificationAlertMessage(
        verdict('MISMATCH', ['Altitude (2000ft vs 3000ft)']),
        extractWithLocalRules('United 421, maintain 2000 feet.'),
        extractWithLocalRules('United 421, maintain 3000 feet.')
      );
      const squawk = formatVerificationAlertMessage(
        verdict('MISMATCH', ['Squawk Code (4215 vs 4216)']),
        extractWithLocalRules('United 421, squawk 4215.'),
        extractWithLocalRules('United 421, squawk 4216.')
      );

      expect(altitude).toBe('ALTITUDE MISMATCH — Assigned 2000 ft, readback 3000 ft.');
      expect(squawk).toBe('SQUAWK MISMATCH — Assigned 4215, readback 4216.');
    });

    it('reports every mismatched safety field in a combined runway and altitude alert', () => {
      const atc = extractWithLocalRules(
        'Delta 882, hold short runway 28 left, maintain 2000 feet.'
      );
      const pilot = extractWithLocalRules(
        'Delta 882, cross runway 28 right, climb 3000 feet.'
      );
      const result = diffExtractions(atc, pilot);

      expect(result.outcome).toBe('MISMATCH');
      const message = formatVerificationAlertMessage(result, atc, pilot);
      expect(message).toContain('RUNWAY MISMATCH — Assigned HOLD SHORT 28L, readback CROSS 28R.');
      expect(message).toContain('ALTITUDE ACTION MISMATCH — Assigned MAINTAIN 2000 ft, readback CLIMB 3000 ft.');
    });

    it('formats final match and unverified results without inventing values', () => {
      expect(formatVerificationAlertMessage(verdict('MATCH')))
        .toBe('MATCH — Readback verified.');
      expect(formatVerificationAlertMessage(
        verdict('UNVERIFIED', [], 'No matching clearance was found for this pilot station.')
      )).toBe('UNVERIFIED — No matching ATC instruction found.');
    });

    it('labels an omitted required clearance as unverified without claiming a mismatch', () => {
      expect(formatVerificationAlertMessage({
        outcome: 'PARTIAL',
        severity: 'WARNING',
        explanation: 'Required clearance items were omitted.',
        matchedFields: [],
        mismatchedFields: [],
        omittedFields: ['Missing squawk (4215)'],
      })).toBe('UNVERIFIED — Readback is missing assigned items: Missing squawk (4215).');
    });

    it('deduplicates a repeated event within a room without suppressing another room', () => {
      const seen = new Set<string>();
      const roomOne = verificationAlertKey('room-1', 'pilot-transmission-1');
      const roomTwo = verificationAlertKey('room-2', 'pilot-transmission-1');

      expect(claimVerificationAlert(seen, roomOne)).toBe(true);
      expect(claimVerificationAlert(seen, roomOne)).toBe(false);
      expect(claimVerificationAlert(seen, roomTwo)).toBe(true);
    });

    it('allows a late clearance pairing to replace an earlier unverified result once', () => {
      const seen = new Set<string>();
      const unpaired = verificationAlertKey('room-1', 'pilot-1:unpaired:UNVERIFIED');
      const pairedMismatch = verificationAlertKey('room-1', 'pilot-1:atc-1:MISMATCH');

      expect(claimVerificationAlert(seen, unpaired)).toBe(true);
      expect(claimVerificationAlert(seen, pairedMismatch)).toBe(true);
      expect(claimVerificationAlert(seen, pairedMismatch)).toBe(false);
    });
  });

  describe('Final Safety Sentinel side effects', () => {
    const transcript = (
      id: string,
      role: 'atc' | 'pilot',
      text: string,
      timestamp: string,
      callsign: string
    ) => ({
      id,
      roomId: 'room-1',
      role,
      callsign,
      text,
      timestamp,
      isFinal: true,
    });

    const runFeedback = async (entries: ReturnType<typeof transcript>[]) => {
      const timeline = verifyTranscriptTimeline(entries);
      const notificationKeys = new Set<string>();
      const warningKeys = new Set<string>();
      const notifications: string[] = [];
      const warningCalls = vi.fn();

      for (const entry of entries.filter((item) => item.role === 'pilot')) {
        const verdict = timeline.verdicts[entry.id];
        const policy = getVerificationFeedbackPolicy(verdict.outcome);
        const message = formatVerificationAlertMessage(
          verdict,
          timeline.atcByPilotId[entry.id]
            ? extractWithLocalRules(timeline.atcByPilotId[entry.id].text)
            : null,
          extractWithLocalRules(entry.text)
        );
        if (
          policy.notificationOutcome &&
          claimVerificationAlert(
            notificationKeys,
            verificationAlertKey(entry.roomId, `${entry.id}:${policy.notificationOutcome}`)
          )
        ) {
          notifications.push(message);
        }
        if (
          policy.speakWarning &&
          shouldSpeakSafeCommAlert(verdict.outcome) &&
          claimVerificationAlert(warningKeys, verificationAlertKey(entry.roomId, entry.id))
        ) {
          warningCalls();
          await speakSafeCommVerification(verdict.outcome, message, mockVoices);
        }
      }
      return { timeline, notifications, warningCalls };
    };

    it('matches a correct readback without a mismatch alert or warning voice', async () => {
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);
      const entries = [
        transcript('atc-match', 'atc', 'United 421, turn right heading 090, runway 27.', '12:00:01 UTC', 'KSFO Tower'),
        transcript('pilot-match', 'pilot', 'United 421, turn right heading 090, runway 27.', '12:00:02 UTC', 'United 421'),
      ];

      const result = await runFeedback(entries);

      expect(result.timeline.verdicts['pilot-match'].outcome).toBe('MATCH');
      expect(result.notifications).toHaveLength(0);
      expect(result.warningCalls).not.toHaveBeenCalled();
      expect(mockSpeak).not.toHaveBeenCalled();
    });

    it('raises exactly one alert and warning for an incorrect runway readback', async () => {
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);
      const entries = [
        transcript('atc-runway', 'atc', 'United 421, runway 27 assigned.', '12:00:01 UTC', 'KSFO Tower'),
        transcript('pilot-runway', 'pilot', 'United 421, runway 26.', '12:00:02 UTC', 'United 421'),
      ];

      const result = await runFeedback(entries);

      expect(result.timeline.verdicts['pilot-runway'].outcome).toBe('MISMATCH');
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0]).toBe('RUNWAY MISMATCH — Assigned 27, readback 26.');
      expect(result.warningCalls).toHaveBeenCalledTimes(1);
      expect(mockSpeak).toHaveBeenCalledTimes(1);
      expect((mockSpeak.mock.calls[0][0] as MockSpeechSynthesisUtterance).text).toContain('Warning.');
    });

    it('raises exactly one alert and warning for a wrong heading direction', async () => {
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);
      const entries = [
        transcript('atc-heading', 'atc', 'United 421, turn right heading 090.', '12:00:01 UTC', 'KSFO Tower'),
        transcript('pilot-heading', 'pilot', 'United 421, turn left heading 090.', '12:00:02 UTC', 'United 421'),
      ];

      const result = await runFeedback(entries);

      expect(result.timeline.verdicts['pilot-heading'].outcome).toBe('MISMATCH');
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0]).toBe('HEADING MISMATCH — Assigned RIGHT 090, readback LEFT 090.');
      expect(result.warningCalls).toHaveBeenCalledTimes(1);
      expect(mockSpeak).toHaveBeenCalledTimes(1);
      expect((mockSpeak.mock.calls[0][0] as MockSpeechSynthesisUtterance).text).toContain('Warning.');
    });

    it('shows a neutral UNVERIFIED status and no warning when there is no preceding instruction', async () => {
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);
      const entries = [
        transcript('pilot-unpaired', 'pilot', 'United 421, runway 26.', '12:00:02 UTC', 'United 421'),
      ];

      const result = await runFeedback(entries);

      expect(result.timeline.verdicts['pilot-unpaired'].outcome).toBe('UNVERIFIED');
      expect(result.notifications).toEqual(['UNVERIFIED — No matching ATC instruction found.']);
      expect(result.warningCalls).not.toHaveBeenCalled();
      expect(mockSpeak).not.toHaveBeenCalled();
    });

    it('deduplicates repeated pilot transcript events by room and transmission ID', async () => {
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);
      const atc = transcript('atc-duplicate', 'atc', 'United 421, runway 27 assigned.', '12:00:01 UTC', 'KSFO Tower');
      const pilot = transcript('pilot-duplicate', 'pilot', 'United 421, runway 26.', '12:00:02 UTC', 'United 421');

      const result = await runFeedback([atc, pilot, { ...pilot }]);

      expect(Object.keys(result.timeline.verdicts)).toEqual(['pilot-duplicate']);
      expect(result.timeline.verdicts['pilot-duplicate'].outcome).toBe('MISMATCH');
      expect(result.notifications).toHaveLength(1);
      expect(result.warningCalls).toHaveBeenCalledTimes(1);
      expect(mockSpeak).toHaveBeenCalledTimes(1);
    });

    it('does not pair different aircraft or rooms', () => {
      const entries = [
        transcript('atc-aircraft', 'atc', 'United 421, runway 27 assigned.', '12:00:01 UTC', 'KSFO Tower'),
        transcript('pilot-aircraft', 'pilot', 'Delta 882, runway 26.', '12:00:02 UTC', 'Delta 882'),
        {
          ...transcript('pilot-room', 'pilot', 'United 421, runway 26.', '12:00:03 UTC', 'United 421'),
          roomId: 'room-2',
        },
      ];

      const result = verifyTranscriptTimeline(entries, undefined, 'room-1');

      expect(result.verdicts['pilot-aircraft'].outcome).toBe('UNVERIFIED');
      expect(result.atcByPilotId['pilot-aircraft']).toBeUndefined();
      expect(result.verdicts['pilot-room']).toBeUndefined();
    });
  });

  describe('1. Deterministic Readback Verification Engine', () => {
    it('matches spoken aviation numbers against the equivalent numeric readback', () => {
      const atc = extractWithLocalRules(
        'Speedbird 214, climb and maintain flight level one zero zero, turn left heading two seven zero, squawk four two one five.'
      );
      const pilot = extractWithLocalRules(
        'Climb FL100, left heading 270, squawk 4215.'
      );

      expect(diffExtractions(atc, pilot, 'BAW214').outcome).toBe('MATCH');
    });

    it('normalizes runway designators, flight levels, squawk digits, and callsign variants', () => {
      const atc = extractWithLocalRules(
        'Speedbird two one four, climb flight level one zero zero, hold short runway two eight left, squawk four two one five.'
      );
      const pilot = extractWithLocalRules(
        'BAW 214, climb 10,000 feet, hold short runway 28L, squawk 4215.'
      );

      expect(atc.callsign).toBe('BAW214');
      expect(diffExtractions(atc, pilot, 'Speedbird 214').outcome).toBe('MATCH');
      expect(diffExtractions(
        extractWithLocalRules('United 421, turn right heading 90.'),
        extractWithLocalRules('Turn right heading 090.'),
        'UAL421'
      ).outcome).toBe('MATCH');
    });

    it('never treats an acknowledgement or question as a verified readback', () => {
      const atc = extractWithLocalRules('United 421, turn right heading 090.');
      const acknowledgement = extractWithLocalRules('Roger.');
      const question = extractWithLocalRules('Are you ready for takeoff on runway 27?');

      expect(diffExtractions(atc, acknowledgement, 'UAL421').outcome).toBe('UNVERIFIED');
      expect(diffExtractions(atc, question, 'UAL421').outcome).toBe('UNVERIFIED');
    });

    it('detects heading direction mismatch and never speaks on a correct match', async () => {
      const atc = extractWithLocalRules('United 421, turn right heading zero niner zero.');
      const correct = extractWithLocalRules('Right heading 090.');
      const incorrect = extractWithLocalRules('Turn left heading 090.');
      const correctVerdict = diffExtractions(atc, correct, 'UAL421');
      const incorrectVerdict = diffExtractions(atc, incorrect, 'UAL421');

      expect(correctVerdict.outcome).toBe('MATCH');
      expect(shouldSpeakSafeCommAlert(correctVerdict.outcome)).toBe(false);
      expect(incorrectVerdict.outcome).toBe('MISMATCH');
      expect(formatVerificationAlertMessage(incorrectVerdict, atc, incorrect))
        .toBe('HEADING MISMATCH — Assigned RIGHT 090, readback LEFT 090.');

      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);
      await speakSafeCommVerification(correctVerdict.outcome, correctVerdict.explanation, mockVoices);
      expect(mockSpeak).toHaveBeenCalledTimes(1);
      expect((mockSpeak.mock.calls[0][0] as MockSpeechSynthesisUtterance).text).toBe('Readback verified.');
    });

    it('verifies 100% MATCH when all clearance parameters (altitude, heading, runway, squawk) are correctly read back', () => {
      const atcClearance = 'Speedbird 214, climb and maintain FL190, turn left heading 270, runway 28R cleared for takeoff, squawk 4215.';
      const pilotReadback = 'Climb and maintain FL190, turn left heading 270, runway 28R cleared for takeoff, squawk 4215, Speedbird 214.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MATCH');
      expect(verdict.severity).toBe('OK');
      expect(verdict.mismatchedFields).toHaveLength(0);
      expect(verdict.matchedFields.length).toBeGreaterThanOrEqual(4);
      expect(verdict.matchedFields.some((f) => f.includes('Altitude'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('Heading'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('Runway'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('Squawk'))).toBe(true);
    });

    it('detects MISMATCH on altitude value deviation (e.g. FL190 vs FL180 or 5000 vs 4000)', () => {
      const atcClearance = 'Speedbird 214, descend and maintain FL190.';
      const pilotReadback = 'Descending FL180, Speedbird 214.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.mismatchedFields.some((f) => f.includes('Altitude'))).toBe(true);
      expect(verdict.explanation).toContain('Altitude deviation');
      expect(verdict.explanation).toContain('FL190');
      expect(verdict.explanation).toContain('FL180');
    });

    it('detects critical MISMATCH on heading direction swap (LEFT vs RIGHT)', () => {
      const atcClearance = 'United 421, turn left heading 090 for traffic.';
      const pilotReadback = 'Turn right heading 090, United 421.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.severity).toBe('CRITICAL');
      expect(verdict.mismatchedFields.some((f) => f.includes('LEFT vs RIGHT'))).toBe(true);
      expect(verdict.explanation).toContain('CRITICAL: Assigned turn LEFT');
      expect(verdict.explanation).toContain('turn RIGHT');
    });

    it('marks an omitted assigned heading direction unverified rather than mismatched', () => {
      const atcExt = extractWithLocalRules('United 421, turn right heading 090.');
      const pilotExt = extractWithLocalRules('United 421, heading 090.');
      const verdict = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('PARTIAL');
      expect(verdict.mismatchedFields).toHaveLength(0);
      expect(verdict.omittedFields?.some((field) => field.includes('heading direction'))).toBe(true);
    });

    it('retains heading direction when speech inserts pauses and filler words', () => {
      const atcExt = extractWithLocalRules('United 421, turn right and fly heading niner zero.');
      const pilotExt = extractWithLocalRules('United 421, turn left, and fly heading zero niner zero.');
      const verdict = diffExtractions(atcExt, pilotExt);

      expect(atcExt.instructions.find((instruction) => instruction.type === 'heading'))
        .toMatchObject({ value: '090', direction: 'right' });
      expect(pilotExt.instructions.find((instruction) => instruction.type === 'heading'))
        .toMatchObject({ value: '090', direction: 'left' });
      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.mismatchedFields.some((field) => field.includes('Heading Direction'))).toBe(true);
    });

    it('keeps heading direction and altitude action associated with their own parameters', () => {
      const atcExt = extractWithLocalRules('United 421, turn right heading 090, descend to 3000.');
      const pilotExt = extractWithLocalRules('United 421, turn right heading 090, climb to 3000.');
      const verdict = diffExtractions(atcExt, pilotExt);

      expect(atcExt.instructions.find((i) => i.type === 'heading')?.direction).toBe('right');
      expect(atcExt.instructions.find((i) => i.type === 'altitude')?.action).toBe('descend');
      expect(pilotExt.instructions.find((i) => i.type === 'altitude')?.action).toBe('climb');
      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.mismatchedFields.some((field) => field.includes('Altitude Action'))).toBe(true);
    });

    it('detects critical MISMATCH on runway incursion / hold short violation', () => {
      const atcClearance = 'Delta 882, hold short of runway 28L.';
      const pilotReadback = 'Cross runway 28R, Delta 882.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.severity).toBe('CRITICAL');
      expect(verdict.mismatchedFields.some((f) => f.includes('Runway'))).toBe(true);
      expect(verdict.explanation).toContain('RUNWAY CONFLICT');
    });

    describe('Transcript-time verification association', () => {
      const transcript = (
        id: string,
        role: 'atc' | 'pilot',
        text: string,
        timestamp: string
      ) => ({
        id,
        roomId: 'room-1',
        role,
        callsign: role === 'atc' ? 'KSFO Tower' : 'Flight Crew',
        text,
        timestamp,
        isFinal: true,
      });

      it('extracts an explicit Bird callsign and classifies a ready-for-takeoff question as non-clearance', () => {
        const atcText = 'Bird 123. Ready for take off on the Runway 27?';
        const atcExtraction = extractWithLocalRules(atcText);
        const pilot = {
          ...transcript('room-1-pilot-1700000002000-readback', 'pilot', 'Ready for takeoff on runway 26.', '12:00:02 UTC'),
          callsign: 'Speedbird 214',
        };
        const result = verifyTranscriptTimeline([
          transcript('room-1-atc-1700000001000-question', 'atc', atcText, '12:00:01 UTC'),
          pilot,
        ]);

        expect(atcExtraction.callsign).toBe('BAW123');
        expect(atcExtraction.intent).toBe('question');
        expect(result.verdicts[pilot.id].outcome).toBe('UNVERIFIED');
        expect(result.verdicts[pilot.id].explanation).toContain('was a question, not an authoritative clearance');
        expect(result.verdicts[pilot.id].explanation).toContain('Speedbird 214');
        expect(result.verdicts[pilot.id].explanation).not.toContain('UNKNOWN');
        expect(result.atcByPilotId[pilot.id]).toBeUndefined();
      });

      it('keeps the preceding authoritative clearance when a later ATC question is not a clearance', () => {
        const entries = [
          transcript(
            'room-1-atc-1700000001000-clearance',
            'atc',
            'Speedbird 214, cleared for takeoff runway 27.',
            '12:00:01 UTC'
          ),
          transcript(
            'room-1-atc-1700000002000-question',
            'atc',
            'Bird 123, ready for takeoff on runway 27?',
            '12:00:02 UTC'
          ),
          {
            ...transcript(
              'room-1-pilot-1700000003000-readback',
              'pilot',
              'Ready for takeoff runway 26.',
              '12:00:03 UTC'
            ),
            callsign: 'Speedbird 214',
          },
        ];
        const result = verifyTranscriptTimeline(entries);

        expect(result.atcByPilotId[entries[2].id].id).toBe(entries[0].id);
        expect(result.verdicts[entries[2].id].outcome).toBe('MISMATCH');
        expect(result.verdicts[entries[2].id].mismatchedFields.join(' ')).toContain('Runway Clearance');
      });

      it('treats a runway assignment as an authoritative instruction', () => {
        const atcText = 'United 421, runway 27 assigned.';
        const pilotText = 'United 421, runway 26.';
        const atc = transcript('room-1-atc-1700000001000-runway', 'atc', atcText, '12:00:01 UTC');
        const pilot = transcript('room-1-pilot-1700000002000-runway', 'pilot', pilotText, '12:00:02 UTC');
        const result = verifyTranscriptTimeline([atc, pilot]);

        expect(extractWithLocalRules(atcText).intent).toBe('instruction');
        expect(result.atcByPilotId[pilot.id]?.id).toBe(atc.id);
        expect(result.verdicts[pilot.id].outcome).toBe('MISMATCH');
        expect(formatVerificationAlertMessage(
          result.verdicts[pilot.id],
          extractWithLocalRules(atcText),
          extractWithLocalRules(pilotText)
        )).toBe('RUNWAY MISMATCH — Assigned 27, readback 26.');
      });

      it('keeps provisional interim-only speech unverified', () => {
        const atc = transcript(
          'room-1-atc-1700000001000-clearance',
          'atc',
          'United 421, turn right heading 090.',
          '12:00:01 UTC'
        );
        const pilot = {
          ...transcript(
            'room-1-pilot-1700000002000-provisional',
            'pilot',
            'United 421, turn left heading 090.',
            '12:00:02 UTC'
          ),
          provisional: true,
        };
        const result = verifyTranscriptTimeline([atc, pilot]);

        expect(result.verdicts[pilot.id].outcome).toBe('UNVERIFIED');
        expect(result.verdicts[pilot.id].explanation).toContain('remains provisional');
      });

      it('does not pair transmissions from different rooms', () => {
        const atc = transcript(
          'room-1-atc-1700000001000-clearance',
          'atc',
          'United 421, turn right heading 090.',
          '12:00:01 UTC'
        );
        const pilot = {
          ...transcript(
            'room-2-pilot-1700000002000-readback',
            'pilot',
            'United 421, turn right heading 090.',
            '12:00:02 UTC'
          ),
          roomId: 'room-2',
        };
        const result = verifyTranscriptTimeline([atc, pilot], undefined, 'room-2');

        expect(result.latestAtcEntry).toBeNull();
        expect(result.verdicts[pilot.id].outcome).toBe('UNVERIFIED');
      });

      it('does not compare a readback with a later clearance', () => {
        const entries = [
          transcript('atc-before', 'atc', 'United 421, turn right heading 090.', '12:00:00 UTC'),
          transcript('pilot-readback', 'pilot', 'United 421, turn left heading 090.', '12:00:05 UTC'),
          transcript('atc-after', 'atc', 'United 421, turn left heading 090.', '12:00:10 UTC'),
        ];
        const result = verifyTranscriptTimeline(entries);

        expect(result.verdicts['pilot-readback'].outcome).toBe('MISMATCH');
        expect(result.atcByPilotId['pilot-readback'].id).toBe('atc-before');
        expect(result.activeVerdict).toBeNull();
        expect(result.matchingAtcEntry?.id).toBe('atc-after');
      });

      it('does not associate a readback to another aircraft callsign', () => {
        const entries = [
          transcript('atc-united', 'atc', 'United 421, turn right heading 090.', '12:00:00 UTC'),
          transcript('pilot-delta', 'pilot', 'Delta 882, turn right heading 090.', '12:00:05 UTC'),
        ];
        const result = verifyTranscriptTimeline(entries);

        expect(result.verdicts['pilot-delta'].outcome).toBe('UNVERIFIED');
        expect(result.atcByPilotId['pilot-delta']).toBeUndefined();
        expect(result.matchingAtcEntry).toBeNull();
      });

      it('associates spoken "speed bird" callsign variants and verifies the actual readback fields', () => {
        const entries = [
          transcript(
            'room-1-atc-1700000001000-clearance',
            'atc',
            'speed bird 214 descending 3000',
            '12:00:01 UTC'
          ),
          transcript(
            'room-1-pilot-1700000002000-readback',
            'pilot',
            'speedbird 214 descending 300',
            '12:00:02 UTC'
          ),
        ];
        const atcExtraction = extractWithLocalRules(entries[0].text);
        const pilotExtraction = extractWithLocalRules(entries[1].text);
        const result = verifyTranscriptTimeline(entries);

        expect(atcExtraction.callsign).toBe('BAW214');
        expect(pilotExtraction.callsign).toBe('BAW214');
        expect(result.atcByPilotId[entries[1].id].id).toBe(entries[0].id);
        expect(result.verdicts[entries[1].id].outcome).toBe('MISMATCH');
        expect(result.verdicts[entries[1].id].mismatchedFields.some((field) => field.includes('Altitude'))).toBe(true);
      });

      it('does not alert for a correct readback when the pilot callsign is established by station identity', () => {
        const entries = [
          {
            ...transcript(
              'room-1-atc-1700000001000-clearance',
              'atc',
              'Speedbird 214, turn right heading 090, squawk 4215.',
              '12:00:01 UTC'
            ),
          },
          {
            ...transcript(
              'room-1-pilot-1700000002000-readback',
              'pilot',
              'Right heading 090, squawk 4215.',
              '12:00:02 UTC'
            ),
            callsign: 'Speedbird 214',
          },
        ];
        const result = verifyTranscriptTimeline(entries);
        const verdict = result.verdicts[entries[1].id];

        expect(result.atcByPilotId[entries[1].id].id).toBe(entries[0].id);
        expect(verdict.outcome).toBe('MATCH');
        expect(verdict.mismatchedFields).toHaveLength(0);
        expect(shouldSpeakSafeCommAlert(verdict.outcome)).toBe(false);
        expect(formatVerificationAlertMessage(verdict)).toBe('MATCH — Readback verified.');
      });

      it('still reports a mismatch when spoken callsign conflicts with the identified pilot station', () => {
        const atc = extractWithLocalRules(
          'Speedbird 214, turn right heading 090.'
        );
        const pilot = extractWithLocalRules(
          'Speedbird 123, turn right heading 090.'
        );
        const verdict = diffExtractions(atc, pilot, 'BAW214');

        expect(verdict.outcome).toBe('MISMATCH');
        expect(verdict.mismatchedFields.join(' ')).toContain('Callsign');
      });

      it('does not treat descending altitude phrase as a callsign and uses pilot identity metadata', () => {
        const entries = [
          {
            ...transcript(
              'room-1-atc-1700000001000-clearance',
              'atc',
              'speedb214 descending 3000',
              '12:00:01 UTC'
            ),
            callsign: 'KSFO Tower',
          },
          {
            ...transcript(
              'room-1-pilot-1700000002000-readback',
              'pilot',
              'descending 300',
              '12:00:02 UTC'
            ),
            callsign: 'Speedbird 214',
          },
        ];
        const result = verifyTranscriptTimeline(entries);

        expect(extractWithLocalRules(entries[0].text).callsign).toBe('BAW214');
        expect(extractWithLocalRules(entries[1].text).callsign).toBe('UNKNOWN');
        expect(result.atcByPilotId[entries[1].id].id).toBe(entries[0].id);
        expect(result.verdicts[entries[1].id].outcome).toBe('MISMATCH');
        expect(result.verdicts[entries[1].id].mismatchedFields.some((field) => field.includes('Altitude'))).toBe(true);
      });

      it('does not cross-pair a readback with a clearance addressed to another aircraft', () => {
        const entries = [
          {
            ...transcript(
              'room-1-atc-1700000001000-clearance',
              'atc',
              'Speedbird 123, line up and wait runway 27 left.',
              '12:00:01 UTC'
            ),
          },
          {
            ...transcript(
              'room-1-pilot-1700000002000-readback',
              'pilot',
              'lineup and weight runway 27e speedbird 123.',
              '12:00:02 UTC'
            ),
            callsign: 'Speedbird 214',
          },
        ];
        const result = verifyTranscriptTimeline(entries);

        expect(result.atcByPilotId[entries[1].id]).toBeUndefined();
        expect(result.verdicts[entries[1].id].outcome).toBe('UNVERIFIED');
        expect(result.verdicts[entries[1].id].explanation)
          .toContain('No preceding clearance is associated with pilot station Speedbird 214');
        expect(result.verdicts[entries[1].id].explanation).not.toContain('UNKNOWN');
      });

      it('verifies out-of-order broadcast arrivals against the preceding clearance', () => {
        const entries = [
          transcript(
            'room-1-atc-1700000003000-newer',
            'atc',
            'United 421, turn left heading 090.',
            '12:00:03 UTC'
          ),
          transcript(
            'room-1-pilot-1700000002000-readback',
            'pilot',
            'United 421, turn left heading 090.',
            '12:00:02 UTC'
          ),
          transcript(
            'room-1-atc-1700000001000-earlier',
            'atc',
            'United 421, turn right heading 090.',
            '12:00:01 UTC'
          ),
        ];
        const result = verifyTranscriptTimeline(entries);

        expect(result.verdicts['room-1-pilot-1700000002000-readback'].outcome).toBe('MISMATCH');
        expect(result.atcByPilotId['room-1-pilot-1700000002000-readback'].id)
          .toBe('room-1-atc-1700000001000-earlier');
      });

      it('normalizes spoken flight levels, headings, runway designators, and squawk codes', () => {
        const normalized = normalizeAviationSpokenPhrases(
          'flight level one zero zero, heading two seven zero, runway two eight left, squawk four two one five'
        );
        expect(normalized).toContain('flight level 100');
        expect(normalized).toContain('heading 270');
        expect(normalized).toContain('runway 28L');
        expect(normalized).toContain('squawk 4215');

        const atcExt = extractWithLocalRules(
          'Speedbird 214, climb flight level one zero zero, turn left heading two seven zero, squawk four two one five.'
        );
        const pilotExt = extractWithLocalRules(
          'Speedbird 214, climb FL100, left heading 270, squawk 4215.'
        );
        const verdict = diffExtractions(atcExt, pilotExt);

        expect(verdict.outcome).toBe('MATCH');
        expect(verdict.severity).toBe('OK');
      });
    });

    it('detects MISMATCH on squawk code discrepancy (e.g. 4201 vs 4210)', () => {
      const atcClearance = 'Speedbird 214, squawk 4201.';
      const pilotReadback = 'Squawk 4210, Speedbird 214.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.mismatchedFields.some((f) => f.includes('Squawk'))).toBe(true);
      expect(verdict.explanation).toContain('Squawk code mismatch');
    });

    it('does not fabricate a mismatch for an extra pilot field ATC never assigned', () => {
      const atcClearance = 'Speedbird 214, turn left heading 280.';
      const pilotReadback = 'Left heading 280, runway 28R cleared to land, Speedbird 214.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MATCH');
      expect(verdict.mismatchedFields).toHaveLength(0);
    });

    it('detects PARTIAL outcome when pilot omits one mandatory clearance without false values', () => {
      const atcClearance = 'Speedbird 214, descend and maintain FL190, runway 28R cleared to land.';
      const pilotReadback = 'Descending FL190, Speedbird 214.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('PARTIAL');
      expect(verdict.severity).toBe('WARNING');
      expect(verdict.matchedFields.some((f) => f.includes('Altitude'))).toBe(true);
      expect(verdict.omittedFields?.some((f) => f.includes('runway'))).toBe(true);
      expect(verdict.explanation).toContain('unverified');
      expect(verdict.explanation).toContain('Missing or uncertain');
    });

    it('does not mark a readback MATCH when the assigned callsign is omitted', () => {
      const atcExt = extractWithLocalRules('Speedbird 214, climb FL100.');
      const pilotExt = extractWithLocalRules('Climb FL100.');
      const verdict = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('PARTIAL');
      expect(verdict.omittedFields).toContain('Missing callsign (BAW214)');
    });

    it('returns UNVERIFIED when controller gives only greeting without clearances', () => {
      const atcClearance = 'Speedbird 214, good morning, radar contact.';
      const pilotReadback = 'Good morning London, Speedbird 214.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('UNVERIFIED');
      expect(verdict.explanation).toContain('no clear controller instruction');
    });

    it('does NOT mark a readback verified merely because words look similar without parameter match', () => {
      const atcClearance = 'United 421, climb and maintain 7000 feet.';
      const pilotReadback = 'United 421, climbing 9000 feet.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).not.toBe('MATCH');
      expect(verdict.outcome).toBe('MISMATCH');
    });

    it('correctly normalizes and verifies spoken-word digits (e.g. one nine zero, two eight right, four two one five)', () => {
      const atcClearance = 'Speedbird 214, climb and maintain flight level one nine zero, turn left heading two seven zero, runway two eight right cleared for takeoff, squawk four two one five.';
      const pilotReadback = 'Climb and maintain flight level one nine zero, turn left heading two seven zero, runway two eight right cleared for takeoff, squawk four two one five, Speedbird 214.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MATCH');
      expect(verdict.matchedFields.some((f) => f.includes('FL190'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('270'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('28R'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('4215'))).toBe(true);
    });

    it('Scenario A: MATCH — Speedbird 214, climb flight level 100, turn left heading 270, squawk 4215', () => {
      const atcClearance = 'Speedbird 214, climb flight level 100, turn left heading 270, squawk 4215.';
      const pilotReadback = 'Speedbird 214, climb flight level 100, left heading 270, squawk 4215.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MATCH');
      expect(verdict.severity).toBe('OK');
      expect(verdict.mismatchedFields).toHaveLength(0);
      expect(verdict.matchedFields.some((f) => f.includes('FL100'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('270'))).toBe(true);
      expect(verdict.matchedFields.some((f) => f.includes('4215'))).toBe(true);
    });

    it('Scenario B: HEADING DIRECTION MISMATCH — United 421, turn right heading 090 vs turn left heading 090', () => {
      const atcClearance = 'United 421, turn right heading 090.';
      const pilotReadback = 'United 421, turn left heading 090.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.severity).toBe('CRITICAL');
      expect(verdict.mismatchedFields.some((f) => f.includes('RIGHT vs LEFT') || f.includes('LEFT vs RIGHT'))).toBe(true);
      expect(verdict.explanation).toContain('CRITICAL');
    });

    it('Scenario C: RUNWAY + ALTITUDE MISMATCH — Delta 882, hold short runway 28 Left, maintain 2000 vs cross runway 28 Right, climb 3000', () => {
      const atcClearance = 'Delta 882, hold short runway 28 Left, maintain 2000.';
      const pilotReadback = 'Delta 882, cross runway 28 Right, climb 3000.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MISMATCH');
      expect(verdict.severity).toBe('CRITICAL');
      expect(verdict.mismatchedFields.some((f) => f.includes('Runway'))).toBe(true);
      expect(verdict.mismatchedFields.some((f) => f.includes('Altitude'))).toBe(true);
      expect(verdict.explanation).toContain('RUNWAY CONFLICT');
    });

    it('normalizes heading with leading zeros (e.g. 90 vs 090)', () => {
      const atcClearance = 'United 421, turn right heading 90.';
      const pilotReadback = 'United 421, turn right heading 090.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MATCH');
      expect(verdict.matchedFields.some((f) => f.includes('090'))).toBe(true);
    });

    it('normalizes runway designators (28 Left vs 28L)', () => {
      const atcClearance = 'Delta 882, cleared to land runway 28 Left.';
      const pilotReadback = 'Cleared to land runway 28L, Delta 882.';

      const atcExt = extractWithLocalRules(atcClearance);
      const pilotExt = extractWithLocalRules(pilotReadback);

      const verdict: VerificationVerdictStub = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('MATCH');
      expect(verdict.matchedFields.some((f) => f.includes('28L'))).toBe(true);
    });

    it('rejects impossible runway numbers instead of truncating them into a valid runway', () => {
      const extraction = extractWithLocalRules('Tower Flight 123 lined up and ready on runway 127.');

      expect(extraction.instructions.some((instruction) => instruction.type === 'runway')).toBe(false);
    });

    it('recognizes spoken runway number and line-up phrase without changing its safety action', () => {
      const extraction = extractWithLocalRules('Delta 882, lined up and wait runway two eight left.');

      expect(extraction.instructions.find((instruction) => instruction.type === 'runway'))
        .toMatchObject({ value: '28L', action: 'line_up_and_wait' });
    });

    it('does not classify an invalid runway designator as a verified mismatch', () => {
      const atcExt = extractWithLocalRules('Speedbird 123, line up and wait runway 27 left.');
      const pilotExt = extractWithLocalRules('lineup and weight runway 27e speedbird 123.');
      const verdict = diffExtractions(atcExt, pilotExt);

      expect(pilotExt.instructions.find((instruction) => instruction.type === 'runway'))
        .toMatchObject({ value: '27E', action: 'line_up_and_wait' });
      expect(verdict.outcome).toBe('PARTIAL');
      expect(verdict.severity).toBe('WARNING');
      expect(verdict.mismatchedFields).toHaveLength(0);
      expect(verdict.omittedFields?.some((field) => field.includes('Unverified runway'))).toBe(true);
    });

    it('consistently verifies the same misheard runway transcript through the live timeline', () => {
      const entries = [
        {
          id: 'room-1-atc-1700000001000-clearance',
          roomId: 'room-1',
          role: 'atc' as const,
          callsign: 'KSFO Tower',
          text: 'Speedbird 123, line up and wait runway 27 left.',
          timestamp: '12:00:01 UTC',
          isFinal: true,
        },
        {
          id: 'room-1-pilot-1700000002000-readback',
          roomId: 'room-1',
          role: 'pilot' as const,
          callsign: 'Speedbird 123',
          text: 'lineup and weight runway 27e speedbird 123.',
          timestamp: '12:00:02 UTC',
          isFinal: true,
        },
      ];
      const result = verifyTranscriptTimeline(entries);

      expect(result.atcByPilotId[entries[1].id]?.id).toBe(entries[0].id);
      expect(result.verdicts[entries[1].id]).toMatchObject({
        outcome: 'PARTIAL',
        severity: 'WARNING',
      });
      expect(shouldSpeakSafeCommAlert(result.verdicts[entries[1].id].outcome)).toBe(false);
    });

    it('surfaces omitted required instructions as unverified, not as a fabricated mismatch', () => {
      const atcExt = extractWithLocalRules('Speedbird 214, climb FL100, squawk 4215.');
      const pilotExt = extractWithLocalRules('Climb FL100, Speedbird 214.');
      const verdict = diffExtractions(atcExt, pilotExt);

      expect(verdict.outcome).toBe('PARTIAL');
      expect(verdict.explanation).toContain('Readback unverified');
      expect(verdict.omittedFields?.some((field) => field.includes('squawk'))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 2. SafeComm Female Assistant Voice Feedback & Discrepancy Announcements
  // --------------------------------------------------------------------------
  describe('2. Female SafeComm Voice Corrections & Settings Compliance', () => {
    it('speaks alerts for conflicts and omitted required readbacks only', () => {
      expect(shouldSpeakSafeCommAlert('MISMATCH')).toBe(true);
      expect(shouldSpeakSafeCommAlert('PARTIAL')).toBe(false);
      expect(shouldSpeakSafeCommAlert('MATCH')).toBe(false);
      expect(shouldSpeakSafeCommAlert('UNVERIFIED')).toBe(false);
    });

    it('speaks a SafeComm alert followed by the discrepancy message', async () => {
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);

      const message = 'Altitude deviation: Controller assigned FL190, pilot read back FL180';
      await speakSafeCommAlert(message, mockVoices);

      expect(mockSpeak).toHaveBeenCalledTimes(1);
      const utterance = mockSpeak.mock.calls[0][0] as MockSpeechSynthesisUtterance;
      expect(utterance.text).toBe(`SafeComm alert. ${message}`);
      expect(utterance.text).not.toContain('simulated');
      expect(utterance.text).toContain('Altitude deviation');
      expect(utterance.text).toContain('FL190');
    });

    it('speaks the advisory when the readback cannot be verified', async () => {
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);

      await speakSafeCommAlert(
        'Readback could not be verified because no preceding clearance was associated.',
        mockVoices
      );

      expect(mockSpeak).toHaveBeenCalledTimes(1);
      expect((mockSpeak.mock.calls[0][0] as MockSpeechSynthesisUtterance).text)
        .toContain('could not be verified');
    });

    it('speaks neutral confirmation for MATCH and does not phrase it as a warning', async () => {
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);

      await speakSafeCommVerification('MATCH', 'All assigned heading and runway fields match.', mockVoices);

      expect(mockSpeak).toHaveBeenCalledTimes(1);
      const matchText = (mockSpeak.mock.calls[0][0] as MockSpeechSynthesisUtterance).text;
      expect(matchText).toBe('Readback verified.');
      expect(matchText).not.toContain('Warning');
    });

    it('speaks UNVERIFIED neutrally without claiming a mismatch or successful verification', async () => {
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS);

      await speakSafeCommVerification('UNVERIFIED', 'UNVERIFIED — No matching ATC instruction found.', mockVoices);

      expect(mockSpeak).toHaveBeenCalledTimes(1);
      const text = (mockSpeak.mock.calls[0][0] as MockSpeechSynthesisUtterance).text;
      expect(text).toContain('Readback unverified.');
      expect(text).not.toContain('Warning');
      expect(text).not.toContain('MATCH');
      expect(text).not.toMatch(/\breadback verified\b/i);
    });

    it('respects user mute setting and does NOT speak when muted', async () => {
      saveVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, muted: true });

      await speakSafeCommAlert('Critical heading deviation', mockVoices);

      expect(mockSpeak).not.toHaveBeenCalled();
    });

    it('respects user disabled voice setting and does NOT speak when disabled', async () => {
      saveVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, enabled: false });

      await speakSafeCommAlert('Critical runway conflict', mockVoices);

      expect(mockSpeak).not.toHaveBeenCalled();
    });

    it('cancels speech immediately on cancelAllSpeech (session termination)', () => {
      cancelAllSpeech();
      expect(mockCancel).toHaveBeenCalledTimes(1);
    });
  });
});
