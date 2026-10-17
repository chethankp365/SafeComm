import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

const supabase = createClient(url, key);

async function testLeave() {
  console.log('Testing create, join, leave on remote...');
  const createRes = await supabase.rpc('create_comm_room', {
    p_callsign: 'KSFO Tower',
    p_airport: 'KSFO',
    p_frequency: '120.500 MHz',
    p_custom_code: null,
  });

  const roomId = createRes.data.room.id;
  const joinCode = createRes.data.room.join_code;
  console.log('Created room:', roomId, joinCode);

  const joinRes = await supabase.rpc('join_comm_room', {
    p_join_code: joinCode,
    p_callsign: 'United 555',
  });
  console.log('Pilot joined, room status:', joinRes.data?.room?.status);

  // Pilot leaves
  console.log('Calling leave_comm_room with p_room_id...');
  const leaveRes = await supabase.rpc('leave_comm_room', { p_room_id: roomId });
  console.log('leave_comm_room returned:', leaveRes);

  // Check state
  const stateRes = await supabase.rpc('get_comm_room_state', { p_room_id: roomId });
  console.log('State after leave:', stateRes.data);
}

testLeave().catch(console.error);
