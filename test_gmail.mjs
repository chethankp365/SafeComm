import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();
const client = createClient(url, key);

async function testGmail() {
  const testEmail = `safecomm.officer.${Date.now()}@gmail.com`;
  console.log('Testing with real domain:', testEmail);
  const { data, error } = await client.auth.signUp({
    email: testEmail,
    password: 'Password123!',
  });
  console.log('Result:', {
    user: data?.user?.id,
    session: !!data?.session,
    error: error ? error.message : null,
  });
}

testGmail();
