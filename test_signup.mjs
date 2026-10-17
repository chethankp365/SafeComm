import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();
const client = createClient(url, key);

async function testSignup() {
  const testEmail = `atc.officer.${Date.now()}@safecomm.io`;
  console.log('Testing signup with:', testEmail);
  const { data, error } = await client.auth.signUp({
    email: testEmail,
    password: 'Password123!',
  });
  console.log('Signup result:', {
    user: data?.user?.id,
    session: !!data?.session,
    error: error ? error.message : null,
  });

  if (data?.session) {
    console.log('Auto-logged in! Testing session table insert...');
    const { data: sData, error: sError } = await client.from('sessions').insert({
      user_id: data.user.id,
      scenario_name: 'Test Scenario',
      status: 'active'
    }).select();
    console.log('Insert result:', { sData, sError });
  }
}

testSignup();
