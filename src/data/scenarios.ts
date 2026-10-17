export interface TransmissionScriptItem {
  id: string;
  role: 'controller' | 'pilot';
  speaker: string;
  callsign: string;
  text: string;
  delayMs: number;
}

export interface Scenario {
  id: string;
  name: string;
  shortTag: string;
  description: string;
  type: 'CORRECT' | 'HEADING_MISMATCH' | 'RUNWAY_ALTITUDE_MISMATCH';
  expectedOutcome: 'MATCH' | 'MISMATCH';
  airport: string;
  frequency: string;
  lines: TransmissionScriptItem[];
}

export const ATC_SCENARIOS: Scenario[] = [
  {
    id: 'scenario-correct-readback',
    name: 'Speedbird 214 · Nominal Vector & Altitude Clearance',
    shortTag: '100% Match',
    description: 'Controller issues standard climb to FL100, left heading 270, squawk 4215. Pilot reads back all parameters flawlessly.',
    type: 'CORRECT',
    expectedOutcome: 'MATCH',
    airport: 'EGLL (London Heathrow)',
    frequency: '121.700 MHz',
    lines: [
      {
        id: 's1-line-1',
        role: 'controller',
        speaker: 'Heathrow Departure',
        callsign: 'BAW214',
        text: 'Speedbird 214, London Departure, climb and maintain flight level 100, turn left heading 270, squawk 4215.',
        delayMs: 2500,
      },
      {
        id: 's1-line-2',
        role: 'pilot',
        speaker: 'Flight Crew BAW214',
        callsign: 'BAW214',
        text: 'Climb and maintain flight level 100, turn left heading 270, squawk 4215, Speedbird 214.',
        delayMs: 3000,
      },
      {
        id: 's1-line-3',
        role: 'controller',
        speaker: 'Heathrow Departure',
        callsign: 'BAW214',
        text: 'Speedbird 214, radar contact 5 miles east of London, expedite through flight level 80.',
        delayMs: 2800,
      },
      {
        id: 's1-line-4',
        role: 'pilot',
        speaker: 'Flight Crew BAW214',
        callsign: 'BAW214',
        text: 'Expedite through flight level 80, Speedbird 214.',
        delayMs: 2600,
      },
    ],
  },
  {
    id: 'scenario-heading-swap',
    name: 'United 421 · Heading Direction Swap (Left vs Right)',
    shortTag: 'Critical Heading Mismatch',
    description: 'Controller issues right turn to heading 090 for terrain/traffic avoidance. Pilot inadvertently confirms turn LEFT heading 090.',
    type: 'HEADING_MISMATCH',
    expectedOutcome: 'MISMATCH',
    airport: 'KSFO (San Francisco Tower)',
    frequency: '121.700 MHz',
    lines: [
      {
        id: 's2-line-1',
        role: 'controller',
        speaker: 'San Francisco Tower',
        callsign: 'UAL421',
        text: 'United 421, San Francisco Tower, fly heading 090, turn right heading 090, maintain 3000 until established.',
        delayMs: 2600,
      },
      {
        id: 's2-line-2',
        role: 'pilot',
        speaker: 'Flight Crew UAL421',
        callsign: 'UAL421',
        text: 'Turn left heading 090, maintain 3000 until established, United 421.',
        delayMs: 3200,
      },
      {
        id: 's2-line-3',
        role: 'controller',
        speaker: 'San Francisco Tower',
        callsign: 'UAL421',
        text: 'United 421, negative, turn RIGHT heading 090, traffic 2 o’clock Boeing 777 at 4000 feet.',
        delayMs: 2800,
      },
      {
        id: 's2-line-4',
        role: 'pilot',
        speaker: 'Flight Crew UAL421',
        callsign: 'UAL421',
        text: 'Correcting, turning right heading 090, United 421.',
        delayMs: 2600,
      },
    ],
  },
  {
    id: 'scenario-runway-altitude-mismatch',
    name: 'Delta 882 · Runway Incursion & Altitude Conflict',
    shortTag: 'Runway / Alt Hazard',
    description: 'Controller instructs taxi via Bravo and hold short of Runway 28L at 2000ft. Pilot erroneously reads back crossing 28R and climbing 3000ft.',
    type: 'RUNWAY_ALTITUDE_MISMATCH',
    expectedOutcome: 'MISMATCH',
    airport: 'KSFO (San Francisco Ground)',
    frequency: '121.700 MHz',
    lines: [
      {
        id: 's3-line-1',
        role: 'controller',
        speaker: 'San Francisco Ground',
        callsign: 'DAL882',
        text: 'Delta 882, taxi via Bravo, hold short of runway 28 Left, maintain 2000 feet.',
        delayMs: 2600,
      },
      {
        id: 's3-line-2',
        role: 'pilot',
        speaker: 'Flight Crew DAL882',
        callsign: 'DAL882',
        text: 'Taxi via Bravo, cross runway 28 Right, climb 3000 feet, Delta 882.',
        delayMs: 3400,
      },
      {
        id: 's3-line-3',
        role: 'controller',
        speaker: 'San Francisco Ground',
        callsign: 'DAL882',
        text: 'Delta 882, STOP! Hold short runway 28 Left, do NOT cross runway 28, maintain 2000!',
        delayMs: 2700,
      },
      {
        id: 's3-line-4',
        role: 'pilot',
        speaker: 'Flight Crew DAL882',
        callsign: 'DAL882',
        text: 'Stopping immediately, holding short runway 28 Left, maintain 2000, Delta 882.',
        delayMs: 2600,
      },
    ],
  },
];
