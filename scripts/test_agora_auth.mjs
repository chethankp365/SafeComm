import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const anonKey = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

const supabase = createClient(url, anonKey);

async function testAgoraAuth() {
  console.log('Testing Agora Token Function with Supabase Auth...');
  
  // 1. Try to sign up or sign in a test user to get a real JWT
  const testEmail = `pilot-${Date.now()}@safecomm.aero`;
  const testPassword = 'Password123!Safe';
  
  console.log('Signing up user:', testEmail);
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: testEmail,
    password: testPassword,
  });

  if (authError) {
    console.log('Sign up error:', authError.message);
  }

  const session = authData?.session;
  console.log('Has session:', Boolean(session));
  console.log('User ID:', authData?.user?.id || 'none');

  if (session) {
    console.log('Invoking agora-token with authenticated session...');
    const res = await supabase.functions.invoke('agora-token', {
      body: { roomId: '00000000-0000-0000-0000-000000000000' },
    });
    console.log('Response status:', res.error?.context?.status || 200);
    console.log('Response error:', res.error?.message || 'none');
    console.log('Response data:', res.data);
  } else {
    console.log('No direct session returned on signup (email confirmation may be required).');
  }
}

testAgoraAuth().catch(console.error);
