import { verifyTranscriptTimeline } from '../src/lib/databaseSync.ts';
import { extractWithLocalRules } from '../src/lib/llmExtractor.ts';

console.log('Testing three core live scenarios from prompt:');

// Scenario 1: Correct readback produces MATCH
// ATC: “Turn right heading 090, squawk 4215.”
// Pilot: “Right heading 090, squawk 4215.”
const s1Transcripts = [
  {
    id: 't-atc-1',
    roomId: 'room-101',
    role: 'atc',
    callsign: 'KSFO Tower',
    text: 'Turn right heading 090, squawk 4215.',
    timestamp: '12:00:01 UTC',
    isFinal: true,
  },
  {
    id: 't-pilot-1',
    roomId: 'room-101',
    role: 'pilot',
    callsign: 'Speedbird 214',
    text: 'Right heading 090, squawk 4215.',
    timestamp: '12:00:02 UTC',
    isFinal: true,
  },
];
const s1Result = verifyTranscriptTimeline(s1Transcripts);
const s1Verdict = s1Result.verdicts['t-pilot-1'];
console.log('Scenario 1 Verdict:', s1Verdict.outcome, '| Explanation:', s1Verdict.explanation);
if (s1Verdict.outcome !== 'MATCH') {
  console.error('FAIL Scenario 1: Expected MATCH, got', s1Verdict.outcome);
  process.exit(1);
}

// Scenario 2: Incorrect readback produces MISMATCH with the exact reason
// ATC: “Turn right heading 090.”
// Pilot: “Turn left heading 090.”
const s2Transcripts = [
  {
    id: 't-atc-2',
    roomId: 'room-101',
    role: 'atc',
    callsign: 'KSFO Tower',
    text: 'Turn right heading 090.',
    timestamp: '12:00:03 UTC',
    isFinal: true,
  },
  {
    id: 't-pilot-2',
    roomId: 'room-101',
    role: 'pilot',
    callsign: 'Speedbird 214',
    text: 'Turn left heading 090.',
    timestamp: '12:00:04 UTC',
    isFinal: true,
  },
];
const s2Result = verifyTranscriptTimeline(s2Transcripts);
const s2Verdict = s2Result.verdicts['t-pilot-2'];
console.log('Scenario 2 Verdict:', s2Verdict.outcome, '| Explanation:', s2Verdict.explanation, '| Mismatches:', s2Verdict.mismatchedFields);
if (s2Verdict.outcome !== 'MISMATCH') {
  console.error('FAIL Scenario 2: Expected MISMATCH, got', s2Verdict.outcome);
  process.exit(1);
}

// Scenario 3: Missing or ambiguous instruction produces UNVERIFIED with actual reason
const s3Transcripts = [
  {
    id: 't-pilot-3',
    roomId: 'room-102',
    role: 'pilot',
    callsign: 'Speedbird 214',
    text: 'Turn right heading 090.',
    timestamp: '12:00:05 UTC',
    isFinal: true,
  },
];
const s3Result = verifyTranscriptTimeline(s3Transcripts);
const s3Verdict = s3Result.verdicts['t-pilot-3'];
console.log('Scenario 3 Verdict:', s3Verdict.outcome, '| Explanation:', s3Verdict.explanation);
if (s3Verdict.outcome !== 'UNVERIFIED') {
  console.error('FAIL Scenario 3: Expected UNVERIFIED, got', s3Verdict.outcome);
  process.exit(1);
}

console.log('ALL THREE LIVE SCENARIOS VERIFIED SUCCESSFULLY!');
