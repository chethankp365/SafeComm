import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

const supabase = createClient(url, key);

async function inspectSchema() {
  console.log('Querying RPC details...');
  // Check if we can query pg_proc via rpc or if an edge function exists
  // We can test calling create_comm_room and inspect full returned object
  const res = await supabase.rpc('create_comm_room', {
    p_callsign: 'KSFO Test',
    p_airport: 'KSFO',
    p_frequency: '120.500 MHz',
    p_custom_code: null,
  });
  console.log('create_comm_room returned:', JSON.stringify(res, null, 2));

  if (res.data?.room?.id) {
    const roomId = res.data.room.id;
    const roomCode = res.data.room.join_code;

    // Now test join_comm_room
    const joinRes = await supabase.rpc('join_comm_room', {
      p_join_code: roomCode,
      p_callsign: 'United 101',
    });
    console.log('join_comm_room returned:', JSON.stringify(joinRes, null, 2));

    // Now test get_comm_room_state
    const stateRes = await supabase.rpc('get_comm_room_state', {
      p_room_id: roomId,
    });
    console.log('get_comm_room_state returned:', JSON.stringify(stateRes, null, 2));
  }
}

inspectSchema().catch(console.error);
