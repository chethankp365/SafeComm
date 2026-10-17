import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://sduigyfousbbhrgkjjjg.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkdWlneWZvdXNiYmhyZ2tqampnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNjAxMjgsImV4cCI6MjEwNzYzNjEyOH0.h8d7J1Uq7wLynSl3e2P4KuPgTDvg2waizXUgAKnYUh8';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function check() {
  console.log('--- Checking Supabase state ---');

  // 1. Check if anon can select from comm_rooms
  const { data: rooms, error: roomsError } = await supabase.from('comm_rooms').select('id, join_code, status').limit(5);
  console.log('comm_rooms query:', { count: rooms?.length, error: roomsError?.message });

  // 2. Check if is_comm_room_participant RPC exists
  const { data: partData, error: partError } = await supabase.rpc('is_comm_room_participant', {
    p_room_id: '00000000-0000-0000-0000-000000000000'
  });
  console.log('is_comm_room_participant RPC:', { data: partData, error: partError?.message });

  // 3. Check if is_comm_room_creator RPC exists
  const { data: creatorData, error: creatorError } = await supabase.rpc('is_comm_room_creator', {
    p_room_id: '00000000-0000-0000-0000-000000000000'
  });
  console.log('is_comm_room_creator RPC:', { data: creatorData, error: creatorError?.message });

  // 4. Check leave_comm_room overloads
  const { data: leave1, error: leaveError1 } = await supabase.rpc('leave_comm_room', {
    p_room_id: '00000000-0000-0000-0000-000000000000'
  });
  console.log('leave_comm_room(1-arg):', { data: leave1, error: leaveError1?.message });

  const { data: leave2, error: leaveError2 } = await supabase.rpc('leave_comm_room', {
    p_room_id: '00000000-0000-0000-0000-000000000000',
    p_role: 'atc'
  });
  console.log('leave_comm_room(2-arg):', { data: leave2, error: leaveError2?.message });
}

check().catch(console.error);
