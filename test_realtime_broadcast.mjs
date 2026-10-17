import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

const clientA = createClient(url, key);
const clientB = createClient(url, key);

async function testRealtime() {
  console.log('Testing Supabase Realtime Broadcast...');
  const channelName = `test_broadcast_${Date.now()}`;

  let receivedB = false;

  const chanB = clientB.channel(channelName, { config: { broadcast: { self: false } } });
  chanB.on('broadcast', { event: 'test_event' }, (payload) => {
    console.log('Client B received payload:', payload);
    receivedB = true;
  });

  await new Promise((resolve) => {
    chanB.subscribe((status) => {
      console.log('Client B subscription status:', status);
      if (status === 'SUBSCRIBED') resolve();
    });
  });

  const chanA = clientA.channel(channelName, { config: { broadcast: { self: false } } });
  await new Promise((resolve) => {
    chanA.subscribe((status) => {
      console.log('Client A subscription status:', status);
      if (status === 'SUBSCRIBED') resolve();
    });
  });

  console.log('Both subscribed! Sending broadcast from Client A...');
  const res = await chanA.send({
    type: 'broadcast',
    event: 'test_event',
    payload: { message: 'Hello from client A' },
  });
  console.log('Send result:', res);

  // Wait 3 seconds
  await new Promise((r) => setTimeout(r, 3000));
  console.log('Did client B receive message?', receivedB);

  await chanA.unsubscribe();
  await chanB.unsubscribe();
  process.exit(receivedB ? 0 : 1);
}

testRealtime().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
