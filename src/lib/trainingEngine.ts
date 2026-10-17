/**
 * SafeComm — Training Mode Grading Engine
 * 
 * Uses the exact same deterministic verification engine (extractInstructions / extractWithLocalRules
 * and diffExtractions from Prompt 4 / databaseSync.ts) to grade pilot readbacks.
 */

import { extractWithLocalRules, type ExtractionResult } from './llmExtractor';
import { diffExtractions, formatVerificationAlertMessage, type VerificationVerdictStub } from './databaseSync';

export interface TrainingScenarioItem {
  id: string;
  source: 'scenarios.ts' | 'challenge';
  callsign: string;
  station: string;
  clearanceText: string;
  referenceReadback: string;
  difficulty: 'Standard' | 'Intermediate' | 'Advanced';
  safetyTrapNote: string;
  exampleErrors: Array<{
    label: string;
    text: string;
    expectedOutcome: 'MISMATCH' | 'PARTIAL';
  }>;
}

export interface TrainingGradeResult {
  verdict: VerificationVerdictStub;
  controllerExtraction: ExtractionResult;
  pilotExtraction: ExtractionResult;
  formattedMessage: string;
  isMatch: boolean;
}

/**
 * Curated Training Scenarios:
 * 8–10 items from src/data/scenarios.ts plus intentional error variations
 */
export const TRAINING_SCENARIOS: TrainingScenarioItem[] = [
  // 1. Heathrow Nominals (from scenarios.ts)
  {
    id: 'tr-baw214-climb',
    source: 'scenarios.ts',
    callsign: 'BAW214',
    station: 'Heathrow Departure (121.700 MHz)',
    clearanceText: 'Speedbird 214, London Departure, climb and maintain flight level 100, turn left heading 270, squawk 4215.',
    referenceReadback: 'Climb and maintain flight level 100, turn left heading 270, squawk 4215, Speedbird 214.',
    difficulty: 'Standard',
    safetyTrapNote: 'Verify 3 distinct parameters: FL100, left heading 270, and transponder squawk 4215.',
    exampleErrors: [
      {
        label: 'Heading Direction Swap (Right instead of Left)',
        text: 'Climb and maintain flight level 100, turn right heading 270, squawk 4215, Speedbird 214.',
        expectedOutcome: 'MISMATCH',
      },
      {
        label: 'Omitted Squawk Code',
        text: 'Climb and maintain flight level 100, turn left heading 270, Speedbird 214.',
        expectedOutcome: 'PARTIAL',
      },
    ],
  },
  // 2. Expedite Altitude (from scenarios.ts)
  {
    id: 'tr-baw214-expedite',
    source: 'scenarios.ts',
    callsign: 'BAW214',
    station: 'Heathrow Departure (121.700 MHz)',
    clearanceText: 'Speedbird 214, radar contact 5 miles east of London, expedite through flight level 80.',
    referenceReadback: 'Expedite through flight level 80, Speedbird 214.',
    difficulty: 'Standard',
    safetyTrapNote: 'Maintain flight level 80 altitude parameter and expedite action.',
    exampleErrors: [
      {
        label: 'Wrong Flight Level (FL90)',
        text: 'Expedite through flight level 90, Speedbird 214.',
        expectedOutcome: 'MISMATCH',
      },
    ],
  },
  // 3. SFO Heading Avoidance (from scenarios.ts)
  {
    id: 'tr-ual421-heading',
    source: 'scenarios.ts',
    callsign: 'UAL421',
    station: 'San Francisco Tower (121.700 MHz)',
    clearanceText: 'United 421, San Francisco Tower, fly heading 090, turn right heading 090, maintain 3000 until established.',
    referenceReadback: 'Turn right heading 090, maintain 3000 until established, United 421.',
    difficulty: 'Intermediate',
    safetyTrapNote: 'Crucial right-turn instruction for terrain avoidance. Left turn creates imminent obstacle conflict.',
    exampleErrors: [
      {
        label: 'Turn Left 090 (Critical Swap)',
        text: 'Turn left heading 090, maintain 3000 until established, United 421.',
        expectedOutcome: 'MISMATCH',
      },
      {
        label: 'Altitude Deviation (Maintain 4000)',
        text: 'Turn right heading 090, maintain 4000 until established, United 421.',
        expectedOutcome: 'MISMATCH',
      },
    ],
  },
  // 4. Ground Hold Short & Crossing (from scenarios.ts)
  {
    id: 'tr-dal882-taxi',
    source: 'scenarios.ts',
    callsign: 'DAL882',
    station: 'San Francisco Ground (121.700 MHz)',
    clearanceText: 'Delta 882, taxi via Bravo, hold short of runway 28 Left, maintain 2000 feet.',
    referenceReadback: 'Taxi via Bravo, hold short of runway 28 Left, maintain 2000 feet, Delta 882.',
    difficulty: 'Advanced',
    safetyTrapNote: 'Runway incursion hazard! Do NOT cross runway 28L or alter the 2000ft constraint.',
    exampleErrors: [
      {
        label: 'Runway Incursion (Crossing 28R)',
        text: 'Taxi via Bravo, cross runway 28 Right, climb 3000 feet, Delta 882.',
        expectedOutcome: 'MISMATCH',
      },
      {
        label: 'Hold Short Wrong Runway (Hold Short 28R)',
        text: 'Taxi via Bravo, hold short runway 28 Right, maintain 2000, Delta 882.',
        expectedOutcome: 'MISMATCH',
      },
    ],
  },
  // 5. Emergency Ground Stop (from scenarios.ts)
  {
    id: 'tr-dal882-stop',
    source: 'scenarios.ts',
    callsign: 'DAL882',
    station: 'San Francisco Ground (121.700 MHz)',
    clearanceText: 'Delta 882, STOP! Hold short runway 28 Left, do NOT cross runway 28, maintain 2000!',
    referenceReadback: 'Stopping immediately, holding short runway 28 Left, maintain 2000, Delta 882.',
    difficulty: 'Advanced',
    safetyTrapNote: 'Mandatory hold short acknowledgment for runway 28 Left.',
    exampleErrors: [
      {
        label: 'Omitting Runway Designation',
        text: 'Stopping immediately, maintain 2000, Delta 882.',
        expectedOutcome: 'PARTIAL',
      },
    ],
  },
  // 6. En Route Descent & Speed Restriction
  {
    id: 'tr-aal1042-speed',
    source: 'challenge',
    callsign: 'AAL1042',
    station: 'NorCal Approach (134.500 MHz)',
    clearanceText: 'American 1042, descend and maintain flight level 240, reduce speed to 250 knots.',
    referenceReadback: 'Descend and maintain flight level 240, reduce speed to 250 knots, American 1042.',
    difficulty: 'Intermediate',
    safetyTrapNote: 'Dual restriction: altitude FL240 and speed reduction to 250 knots for sequencing.',
    exampleErrors: [
      {
        label: 'Speed Error (210 knots)',
        text: 'Descend and maintain flight level 240, speed 210 knots, American 1042.',
        expectedOutcome: 'MISMATCH',
      },
      {
        label: 'Flight Level Error (FL210)',
        text: 'Descend and maintain flight level 210, speed 250 knots, American 1042.',
        expectedOutcome: 'MISMATCH',
      },
    ],
  },
  // 7. Runway Line Up and Wait vs Cleared for Takeoff
  {
    id: 'tr-swa843-luaw',
    source: 'challenge',
    callsign: 'SWA843',
    station: 'San Francisco Tower (120.500 MHz)',
    clearanceText: 'Southwest 843, runway 28 Right, line up and wait.',
    referenceReadback: 'Runway 28 Right, line up and wait, Southwest 843.',
    difficulty: 'Advanced',
    safetyTrapNote: 'Never confuse Line Up and Wait with Cleared for Takeoff! Severe runway collision hazard.',
    exampleErrors: [
      {
        label: 'Anticipated Takeoff (Cleared for Takeoff)',
        text: 'Cleared for takeoff runway 28 Right, Southwest 843.',
        expectedOutcome: 'MISMATCH',
      },
      {
        label: 'Runway Swap (Runway 28 Left)',
        text: 'Runway 28 Left, line up and wait, Southwest 843.',
        expectedOutcome: 'MISMATCH',
      },
    ],
  },
  // 8. General Aviation VFR Vector & Transponder
  {
    id: 'tr-n34b-vfr',
    source: 'challenge',
    callsign: 'N34B',
    station: 'Oakland Tower (118.300 MHz)',
    clearanceText: 'Cessna 34Bravo, turn left heading 180, maintain 2500 feet, squawk 5312.',
    referenceReadback: 'Turn left heading 180, maintain 2500 feet, squawk 5312, Cessna 34Bravo.',
    difficulty: 'Standard',
    safetyTrapNote: 'Verify 3 safety items: Left heading 180, 2500 feet, squawk 5312.',
    exampleErrors: [
      {
        label: 'Transponder Digit Transposition (5132 vs 5312)',
        text: 'Turn left heading 180, maintain 2500 feet, squawk 5132, Cessna 34Bravo.',
        expectedOutcome: 'MISMATCH',
      },
    ],
  },
  // 9. Approach Clearance ILS
  {
    id: 'tr-dlh458-ils',
    source: 'challenge',
    callsign: 'DLH458',
    station: 'San Francisco Approach (128.650 MHz)',
    clearanceText: 'Lufthansa 458, turn right heading 040, maintain 4000 until established, cleared ILS runway 28 Left approach.',
    referenceReadback: 'Turn right heading 040, maintain 4000 until established, cleared ILS runway 28 Left, Lufthansa 458.',
    difficulty: 'Advanced',
    safetyTrapNote: 'Parallel runway precision approach: runway 28 Left must not be confused with parallel 28 Right.',
    exampleErrors: [
      {
        label: 'Parallel Runway Incursion (Runway 28 Right)',
        text: 'Turn right heading 040, maintain 4000 until established, cleared ILS runway 28 Right, Lufthansa 458.',
        expectedOutcome: 'MISMATCH',
      },
    ],
  },
  // 10. Heading and Altitude Vectoring
  {
    id: 'tr-skw5129-climb',
    source: 'challenge',
    callsign: 'SKW5129',
    station: 'Los Angeles Center (125.100 MHz)',
    clearanceText: 'SkyWest 5129, climb and maintain 14000 feet, turn right heading 320.',
    referenceReadback: 'Climb and maintain 14000 feet, turn right heading 320, SkyWest 5129.',
    difficulty: 'Intermediate',
    safetyTrapNote: 'Ensure altitude is 14000 feet and direction is right heading 320.',
    exampleErrors: [
      {
        label: 'Turn Left Heading 320',
        text: 'Climb and maintain 14000 feet, turn left heading 320, SkyWest 5129.',
        expectedOutcome: 'MISMATCH',
      },
    ],
  },
];

/**
 * Grade pilot readback with the actual Prompt 4 deterministic verification engine
 */
export function gradeTrainingReadback(
  controllerText: string,
  pilotReadbackText: string
): TrainingGradeResult {
  const controllerExtraction = extractWithLocalRules(controllerText);
  const pilotExtraction = extractWithLocalRules(pilotReadbackText);

  // Grade using diffExtractions from Prompt 4
  const verdict = diffExtractions(
    controllerExtraction,
    pilotExtraction,
    controllerExtraction.callsign
  );

  const formattedMessage = formatVerificationAlertMessage(
    verdict,
    controllerExtraction,
    pilotExtraction
  );

  const isMatch = verdict.outcome === 'MATCH';

  return {
    verdict,
    controllerExtraction,
    pilotExtraction,
    formattedMessage,
    isMatch,
  };
}
