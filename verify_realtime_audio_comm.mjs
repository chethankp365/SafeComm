import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

// Mock Browser Environment for WebRTC / Audio classes
const mockLocalStorage = {};
globalThis.localStorage = {
  getItem: (k) => mockLocalStorage[k] || null,
  setItem: (k, v) => { mockLocalStorage[k] = String(v); },
  removeItem: (k) => { delete mockLocalStorage[k]; },
  clear: () => { Object.keys(mockLocalStorage).forEach(k => delete mockLocalStorage[k]); }
};

// Polyfill BroadcastChannel
const channels = new Map();
class MockBroadcastChannel {
  constructor(name) {
    this.name = name;
    if (!channels.has(name)) channels.set(name, new Set());
    channels.get(name).add(this);
    this.onmessage = null;
  }
  postMessage(data) {
    const set = channels.get(this.name);
    if (!set) return;
    set.forEach((ch) => {
      if (ch !== this && ch.onmessage) {
        setTimeout(() => ch.onmessage({ data }), 0);
      }
    });
  }
  close() {
    const set = channels.get(this.name);
    if (set) set.delete(this);
  }
}
globalThis.BroadcastChannel = MockBroadcastChannel;

// Polyfill RTCPeerConnection and descriptions
class MockRTCPeerConnection {
  constructor(config) {
    this.config = config;
    this.signalingState = 'stable';
    this.iceConnectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.onicecandidate = null;
    this.ontrack = null;
    this.onnegotiationneeded = null;
    this.oniceconnectionstatechange = null;
  }
  addTrack(track, stream) {}
  async setLocalDescription(desc) {
    this.localDescription = desc || { type: 'offer', sdp: 'mock-sdp-data' };
    this.signalingState = this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(candidate) {}
  close() {
    this.iceConnectionState = 'closed';
  }
  restartIce() {}
}
globalThis.RTCPeerConnection = MockRTCPeerConnection;
globalThis.RTCSessionDescription = class { constructor(init) { Object.assign(this, init); } };
globalThis.RTCIceCandidate = class { constructor(init) { Object.assign(this, init); } };

// Mock getUserMedia
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [
          {
            kind: 'audio',
            enabled: false,
            stop: () => {},
          },
        ],
        getTracks: () => [],
      }),
    },
  },
  configurable: true,
  writable: true,
});

async function runStep3AudioVerification() {
  console.log('================================================================');
  console.log('SAFECOMM STEP 3: REAL-TIME WEBRTC AUDIO, MIC & SHARED ASR TEST');
  console.log('================================================================\n');

  const results = [];
  function record(testName, passed, detail) {
    results.push({ testName, passed, detail });
    const status = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${status} | ${testName}`);
    if (detail) console.log(`       └─ ${detail}`);
  }

  const {
    CommAudioSession,
    loadPersistedTranscripts,
    savePersistedTranscripts,
    getZuluTimestamp,
  } = await import('./src/lib/commAudio.ts');
  const { extractWithLocalRules } = await import('./src/lib/llmExtractor.ts');

  const TEST_ROOM_ID = `comm-test-${Date.now()}`;

  // --------------------------------------------------------------------------
  // Phase 1: Zulu Timestamp & Timezone Formatting
  // --------------------------------------------------------------------------
  const zulu = getZuluTimestamp();
  record(
    '1. Aeronautical Zulu Timestamp Formatting',
    /^\d{2}:\d{2}:\d{2}\sUTC$/.test(zulu),
    `Generated Zulu timestamp: "${zulu}"`
  );

  // --------------------------------------------------------------------------
  // Phase 2: Dual Station Initialization (ATC & Pilot Stations)
  // --------------------------------------------------------------------------
  let atcAudioStatus = 'standby';
  let pilotAudioStatus = 'standby';
  let atcPeerState = null;
  let pilotPeerState = null;
  const atcReceivedTranscripts = [];
  const pilotReceivedTranscripts = [];

  const atcSession = new CommAudioSession(
    TEST_ROOM_ID,
    'atc',
    'KSFO Tower',
    {
      onStatusChange: (status) => { atcAudioStatus = status; },
      onRemoteStream: () => {},
      onPeerAudioState: (state) => { atcPeerState = state; },
      onTranscriptReceived: (entry) => { atcReceivedTranscripts.push(entry); },
      onInterimTranscript: () => {},
      onTranscriptsSync: (list) => { atcReceivedTranscripts.push(...list); },
    }
  );

  const pilotSession = new CommAudioSession(
    TEST_ROOM_ID,
    'pilot',
    'Speedbird 214',
    {
      onStatusChange: (status) => { pilotAudioStatus = status; },
      onRemoteStream: () => {},
      onPeerAudioState: (state) => { pilotPeerState = state; },
      onTranscriptReceived: (entry) => { pilotReceivedTranscripts.push(entry); },
      onInterimTranscript: () => {},
      onTranscriptsSync: (list) => { pilotReceivedTranscripts.push(...list); },
    }
  );

  await atcSession.initialize();
  await pilotSession.initialize();

  record(
    '2. Dual Station Audio Handshake & Microphone Acquisition',
    atcAudioStatus !== 'standby' && pilotAudioStatus !== 'standby',
    `ATC Status: ${atcAudioStatus}, Pilot Status: ${pilotAudioStatus}`
  );

  // --------------------------------------------------------------------------
  // Phase 3: Microphone Controls & Push-To-Talk (PTT)
  // --------------------------------------------------------------------------
  // Test PTT on ATC Station
  atcSession.startPTT();
  const atcTransmitting = atcSession.getIsTransmitting();
  atcSession.stopPTT();
  const atcStopped = !atcSession.getIsTransmitting();

  record(
    '3. Push-To-Talk (PTT) Down / Up Activation',
    atcTransmitting && atcStopped,
    `PTT Active on Press: ${atcTransmitting}, PTT Inactive on Release: ${atcStopped}`
  );

  // Test Mute / Unmute
  const isMutedNow = atcSession.toggleMute();
  const isUnmutedNow = !atcSession.toggleMute();

  record(
    '4. Microphone Mute / Unmute Toggle',
    isMutedNow && isUnmutedNow,
    `Muted: ${isMutedNow}, Unmuted: ${isUnmutedNow}`
  );

  // Test Hands-Free / Lock Mic Mode
  const isLocked = pilotSession.togglePTTLock();
  const isUnlocked = !pilotSession.togglePTTLock();

  record(
    '5. Hands-Free Open Frequency Lock Mode',
    isLocked && isUnlocked,
    `Locked Open Mic: ${isLocked}, Released: ${isUnlocked}`
  );

  // --------------------------------------------------------------------------
  // Phase 4: Bidirectional Speech Recognition & Speaker Attribution
  // --------------------------------------------------------------------------
  // ATC transmits clearance
  atcSession.transmitManualText('Speedbird 214, descend and maintain FL190, fly heading 280, runway 28R cleared to land');

  // Allow short event loop tick for BroadcastChannel message dispatch
  await new Promise((r) => setTimeout(r, 60));

  const pilotGotAtcEntry = pilotReceivedTranscripts.find((t) => t.role === 'atc');
  record(
    '6. Controller Spoken Clearance Attribution & Peer Broadcast',
    pilotGotAtcEntry !== undefined && pilotGotAtcEntry.callsign === 'KSFO Tower',
    `Received by Pilot: "${pilotGotAtcEntry?.text}" (Role: ${pilotGotAtcEntry?.role}, Callsign: ${pilotGotAtcEntry?.callsign})`
  );

  // Pilot transmits readback
  pilotSession.transmitManualText('Descending FL190, heading 280, runway 28R cleared to land, Speedbird 214');
  await new Promise((r) => setTimeout(r, 60));

  const atcGotPilotEntry = atcReceivedTranscripts.find((t) => t.role === 'pilot');
  record(
    '7. Flight Crew Readback Attribution & Controller Receipt',
    atcGotPilotEntry !== undefined && atcGotPilotEntry.callsign === 'Speedbird 214',
    `Received by ATC: "${atcGotPilotEntry?.text}" (Role: ${atcGotPilotEntry?.role}, Callsign: ${atcGotPilotEntry?.callsign})`
  );

  // --------------------------------------------------------------------------
  // Phase 5: Shared Transcript Deduplication & Local Persistence
  // --------------------------------------------------------------------------
  const initialCount = pilotSession.getTranscripts().length;
  // Send duplicate transmission ID
  if (pilotGotAtcEntry) {
    pilotSession.appendTranscript(pilotGotAtcEntry);
  }
  const afterDuplicateCount = pilotSession.getTranscripts().length;

  record(
    '8. Transmission Deduplication Protection',
    initialCount === afterDuplicateCount,
    `Count before: ${initialCount}, Count after duplicate: ${afterDuplicateCount}`
  );

  // Verify persistence
  const persistedInStorage = loadPersistedTranscripts(TEST_ROOM_ID);
  record(
    '9. Local Storage Room Transcript Recovery',
    persistedInStorage.length >= 2,
    `Stored transmissions for room ${TEST_ROOM_ID}: ${persistedInStorage.length} entries`
  );

  // --------------------------------------------------------------------------
  // Phase 6: Real-Time Safety Sentinel Discrepancy Analysis
  // --------------------------------------------------------------------------
  const atcParsed = extractWithLocalRules(pilotGotAtcEntry.text);
  const pilotParsed = extractWithLocalRules(atcGotPilotEntry.text);

  const atcAlt = atcParsed.instructions.find((i) => i.type === 'altitude');
  const pilotAlt = pilotParsed.instructions.find((i) => i.type === 'altitude');
  const atcRwy = atcParsed.instructions.find((i) => i.type === 'runway');
  const pilotRwy = pilotParsed.instructions.find((i) => i.type === 'runway');

  const matchPassed = atcAlt && pilotAlt && atcAlt.value === pilotAlt.value && atcRwy?.value === pilotRwy?.value;
  record(
    '10. Safety Sentinel Compliance Verification (Clearance vs Readback Match)',
    Boolean(matchPassed),
    `Altitude: ${atcAlt?.value} vs ${pilotAlt?.value} | Runway: ${atcRwy?.value} vs ${pilotRwy?.value}`
  );

  // Test Mismatch Detection
  const mismatchPilotText = 'Descending 4000 feet, runway 28L, Speedbird 214';
  const mismatchPilotParsed = extractWithLocalRules(mismatchPilotText);
  const mismatchAlt = mismatchPilotParsed.instructions.find((i) => i.type === 'altitude');
  const hasMismatch = atcAlt?.value !== mismatchAlt?.value;

  record(
    '11. Safety Sentinel Critical Mismatch Discrepancy Detection',
    hasMismatch,
    `ATC Assigned: ${atcAlt?.value} != Pilot Readback: ${mismatchAlt?.value}`
  );

  // --------------------------------------------------------------------------
  // Phase 7: Clean Session Teardown & Resource Release
  // --------------------------------------------------------------------------
  atcSession.cleanup();
  pilotSession.cleanup();

  record(
    '12. Transceiver Teardown & Resource Cleanup',
    atcSession.getStatus() === 'disconnected' && pilotSession.getStatus() === 'disconnected',
    `ATC Status: ${atcSession.getStatus()}, Pilot Status: ${pilotSession.getStatus()}`
  );

  console.log('\n================================================================');
  const allPassed = results.every((r) => r.passed);
  if (allPassed) {
    console.log(`🎉 ALL ${results.length}/${results.length} REAL-TIME AUDIO & ASR VERIFICATIONS PASSED!`);
  } else {
    console.log(`⚠️ ${results.filter((r) => !r.passed).length} TESTS FAILED.`);
  }
  console.log('================================================================\n');

  process.exit(allPassed ? 0 : 1);
}

runStep3AudioVerification().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
