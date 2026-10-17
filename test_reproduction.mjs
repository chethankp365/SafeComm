import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

// Simulate Browser 1 (User 1 - ATC)
const client1 = createClient(url, key);

// Simulate Browser 2 (User 2 - Pilot)
const client2 = createClient(url, key);

async function testFlow() {
  console.log('--- STEP 1: Browser 1 creates room ---');
  const code = 'SFC-' + Math.floor(100 + Math.random() * 900);
  const { data: createData, error: createErr } = await client1.rpc('create_comm_room', {
    p_callsign: 'KSFO Tower',
    p_airport: 'KSFO',
    p_frequency: '120.500 MHz',
    p_custom_code: code,
  });

  if (createErr) {
    console.error('Create error:', createErr);
    return;
  }

  const room = createData.room;
  console.log('Room created successfully:', { id: room.id, code: room.join_code, status: room.status });

  console.log('\n--- STEP 2: Browser 2 enters code to join ---');
  const { data: joinData, error: joinErr } = await client2.rpc('join_comm_room', {
    p_join_code: room.join_code,
    p_callsign: 'Speedbird 214',
  });

  if (joinErr) {
    console.error('Join error:', joinErr);
    return;
  }
  console.log('Join result:', {
    success: joinData.success,
    roomStatus: joinData.room?.status,
    pilot: joinData.participant?.callsign,
    totalParticipants: joinData.participants?.length,
  });

  console.log('\n--- STEP 3: Browser 1 fetches room state (get_comm_room_state) ---');
  const { data: state1, error: state1Err } = await client1.rpc('get_comm_room_state', {
    p_room_id: room.id,
  });
  console.log('Browser 1 get_comm_room_state:', {
    roomStatus: state1?.room?.status,
    participants: state1?.participants?.map(p => ({ role: p.role, callsign: p.callsign, status: p.status })),
  });

  console.log('\n--- STEP 4: Browser 1 starts comm (start_comm_room) ---');
  const { data: startData, error: startErr } = await client1.rpc('start_comm_room', {
    p_room_id: room.id,
  });
  console.log('Start comm result:', { data: startData, error: startErr });

  console.log('\n--- STEP 5: Browser 2 checks room state after start ---');
  const { data: state2, error: state2Err } = await client2.rpc('get_comm_room_state', {
    p_room_id: room.id,
  });
  console.log('Browser 2 get_comm_room_state after start:', {
    roomStatus: state2?.room?.status,
  });
}

testFlow().catch(console.error);
