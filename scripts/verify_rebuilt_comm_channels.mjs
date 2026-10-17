import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

const atcClient = createClient(url, key);
const pilotClient = createClient(url, key);

async function runAcceptanceSimulation() {
  console.log('--- SafeComm: End-to-End Rebuilt Subsystem Verification ---');
  const testRoomId = `sim-room-${Date.now()}`;
  console.log(`Canonical Room UUID: ${testRoomId}`);

  // Channel names defined by rebuild architecture:
  const transcriptChannelName = `comm_transcripts_${testRoomId}`;
  const webrtcChannelName = `comm_webrtc_${testRoomId}`;

  const atcReceivedTranscripts = [];
  const pilotReceivedTranscripts = [];
  const atcWebrtcSignals = [];
  const pilotWebrtcSignals = [];

  // 1. Subscribe Pilot to Transcript and WebRTC Channels
  const pilotTranscriptChan = pilotClient.channel(transcriptChannelName, { config: { broadcast: { self: false } } });
  pilotTranscriptChan.on('broadcast', { event: 'transcript_event' }, ({ payload }) => {
    console.log('[Pilot Received Transcript Broadcast]:', payload.type, payload.transcript?.text || payload.transcripts?.length);
    if (payload.type === 'transcript-entry') pilotReceivedTranscripts.push(payload.transcript);
  });

  const pilotWebrtcChan = pilotClient.channel(webrtcChannelName, { config: { broadcast: { self: false } } });
  pilotWebrtcChan.on('broadcast', { event: 'webrtc_signal' }, ({ payload }) => {
    console.log('[Pilot Received WebRTC Signal]:', payload.type);
    pilotWebrtcSignals.push(payload);
  });

  await new Promise((resolve) => {
    pilotTranscriptChan.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve();
    });
  });

  await new Promise((resolve) => {
    pilotWebrtcChan.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve();
    });
  });

  // 2. Subscribe ATC to Transcript and WebRTC Channels
  const atcTranscriptChan = atcClient.channel(transcriptChannelName, { config: { broadcast: { self: false } } });
  atcTranscriptChan.on('broadcast', { event: 'transcript_event' }, ({ payload }) => {
    console.log('[ATC Received Transcript Broadcast]:', payload.type, payload.transcript?.text || payload.transcripts?.length);
    if (payload.type === 'transcript-entry') atcReceivedTranscripts.push(payload.transcript);
  });

  const atcWebrtcChan = atcClient.channel(webrtcChannelName, { config: { broadcast: { self: false } } });
  atcWebrtcChan.on('broadcast', { event: 'webrtc_signal' }, ({ payload }) => {
    console.log('[ATC Received WebRTC Signal]:', payload.type);
    atcWebrtcSignals.push(payload);
  });

  await new Promise((resolve) => {
    atcTranscriptChan.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve();
    });
  });

  await new Promise((resolve) => {
    atcWebrtcChan.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve();
    });
  });

  console.log('✓ Both ATC and Pilot successfully subscribed to independent channels!');

  // Phase 1: Test Transcripts
  console.log('\n--- Phase 1: Verifying Transcript Synchronization ---');
  // ATC transmits clearance
  const clearanceEntry = {
    id: `${testRoomId}-atc-1`,
    roomId: testRoomId,
    role: 'atc',
    callsign: 'KSFO Tower',
    text: 'Speedbird 214, descend and maintain 3000 feet, runway 28R cleared to land',
    timestamp: '16:40:00 UTC',
    isFinal: true,
  };
  await atcTranscriptChan.send({
    type: 'broadcast',
    event: 'transcript_event',
    payload: {
      roomId: testRoomId,
      fromClientId: 'atc-client-1',
      fromRole: 'atc',
      type: 'transcript-entry',
      transcript: clearanceEntry,
    },
  });

  // Pilot transmits readback
  const readbackEntry = {
    id: `${testRoomId}-pilot-1`,
    roomId: testRoomId,
    role: 'pilot',
    callsign: 'Speedbird 214',
    text: 'Descending 3000 feet, runway 28R cleared to land, Speedbird 214',
    timestamp: '16:40:08 UTC',
    isFinal: true,
  };
  await pilotTranscriptChan.send({
    type: 'broadcast',
    event: 'transcript_event',
    payload: {
      roomId: testRoomId,
      fromClientId: 'pilot-client-1',
      fromRole: 'pilot',
      type: 'transcript-entry',
      transcript: readbackEntry,
    },
  });

  // Wait 1.5s for delivery
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`Pilot received ATC clearance: ${pilotReceivedTranscripts.some((t) => t.id === clearanceEntry.id)}`);
  console.log(`ATC received Pilot readback: ${atcReceivedTranscripts.some((t) => t.id === readbackEntry.id)}`);

  // Phase 2: Test WebRTC Signaling Exchange
  console.log('\n--- Phase 2: Verifying WebRTC Signaling Exchange ---');
  // Pilot announces ready
  await pilotWebrtcChan.send({
    type: 'broadcast',
    event: 'webrtc_signal',
    payload: {
      roomId: testRoomId,
      fromClientId: 'pilot-client-1',
      fromRole: 'pilot',
      type: 'ready',
    },
  });

  // ATC sends offer
  await atcWebrtcChan.send({
    type: 'broadcast',
    event: 'webrtc_signal',
    payload: {
      roomId: testRoomId,
      fromClientId: 'atc-client-1',
      fromRole: 'atc',
      type: 'offer',
      sdp: { type: 'offer', sdp: 'v=0\r\no=ATC 1234 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' },
    },
  });

  // Pilot sends answer
  await pilotWebrtcChan.send({
    type: 'broadcast',
    event: 'webrtc_signal',
    payload: {
      roomId: testRoomId,
      fromClientId: 'pilot-client-1',
      fromRole: 'pilot',
      type: 'answer',
      sdp: { type: 'answer', sdp: 'v=0\r\no=Pilot 5678 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' },
    },
  });

  // Exchanging ICE candidates
  await atcWebrtcChan.send({
    type: 'broadcast',
    event: 'webrtc_signal',
    payload: {
      roomId: testRoomId,
      fromClientId: 'atc-client-1',
      fromRole: 'atc',
      type: 'ice-candidate',
      candidate: { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.50 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    },
  });

  await pilotWebrtcChan.send({
    type: 'broadcast',
    event: 'webrtc_signal',
    payload: {
      roomId: testRoomId,
      fromClientId: 'pilot-client-1',
      fromRole: 'pilot',
      type: 'ice-candidate',
      candidate: { candidate: 'candidate:2 1 UDP 2130706431 192.168.1.51 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    },
  });

  // Wait 1.5s for signal receipt
  await new Promise((r) => setTimeout(r, 1500));

  const atcGotReady = atcWebrtcSignals.some((s) => s.type === 'ready');
  const pilotGotOffer = pilotWebrtcSignals.some((s) => s.type === 'offer');
  const atcGotAnswer = atcWebrtcSignals.some((s) => s.type === 'answer');
  const pilotGotIce = pilotWebrtcSignals.some((s) => s.type === 'ice-candidate');
  const atcGotIce = atcWebrtcSignals.some((s) => s.type === 'ice-candidate');

  console.log(`ATC received Pilot 'ready': ${atcGotReady}`);
  console.log(`Pilot received ATC 'offer': ${pilotGotOffer}`);
  console.log(`ATC received Pilot 'answer': ${atcGotAnswer}`);
  console.log(`Pilot received ATC 'ice-candidate': ${pilotGotIce}`);
  console.log(`ATC received Pilot 'ice-candidate': ${atcGotIce}`);

  // Cleanup
  await atcTranscriptChan.unsubscribe();
  await pilotTranscriptChan.unsubscribe();
  await atcWebrtcChan.unsubscribe();
  await pilotWebrtcChan.unsubscribe();

  const allPassed =
    pilotReceivedTranscripts.some((t) => t.id === clearanceEntry.id) &&
    atcReceivedTranscripts.some((t) => t.id === readbackEntry.id) &&
    atcGotReady &&
    pilotGotOffer &&
    atcGotAnswer &&
    pilotGotIce &&
    atcGotIce;

  if (allPassed) {
    console.log('\n SUCCESS: All acceptance checks for rebuilt channels passed end-to-end!');
    process.exit(0);
  } else {
    console.error('\n FAILURE: Some acceptance checks failed.');
    process.exit(1);
  }
}

runAcceptanceSimulation().catch((err) => {
  console.error('Simulation exception:', err);
  process.exit(1);
});
