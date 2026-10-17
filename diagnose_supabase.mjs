import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

const client = createClient(url, key);

async function testAuthRole() {
  // Let's test with signInAnonymously if enabled, or check what users exist
  console.log('Testing signInAnonymously...');
  const { data: anonData, error: anonError } = await client.auth.signInAnonymously();
  console.log('Anon signIn result:', { user: anonData?.user?.id, anonError });

  if (anonData?.user) {
    const { data, error } = await client.from('sessions').select('*');
    console.log('Authenticated user select sessions:', { data, error });
  }
}

testAuthRole();
