import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const anonKey = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

const supabase = createClient(url, anonKey);

async function verifyEdgeFunction() {
  console.log('--- Verifying agora-token Edge Function ---');
  console.log(`Endpoint: ${url}/functions/v1/agora-token\n`);

  // 1. Test Unauthenticated Request (Expect 401 Unauthorized)
  console.log('Test 1: Unauthenticated request...');
  const unauthClient = createClient(url, anonKey);
  const unauthRes = await unauthClient.functions.invoke('agora-token', {
    body: { roomId: '00000000-0000-0000-0000-000000000000' },
  });

  const is401 = unauthRes.error?.context?.status === 401 || unauthRes.error?.message?.includes('401');
  console.log(`Unauthenticated rejected with 401: ${is401 ? 'PASS' : 'FAIL'} (${unauthRes.error?.message || 'unexpected success'})\n`);

  // 2. Test Authenticated but Unauthorized User / Non-existent Room (Expect 403 or 404)
  console.log('Test 2: Authenticated request for unauthorized/non-existent room...');
  // Attempt to sign in or use current session
  const testEmail = `test-verify-${Date.now()}@safecomm.org`;
  const testPassword = 'Password123!SafeComm';
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email: testEmail,
    password: testPassword,
  });

  if (signUpData?.session) {
    const authRes = await supabase.functions.invoke('agora-token', {
      body: { roomId: '00000000-0000-0000-0000-000000000000' },
    });
    const isRejected = authRes.error?.context?.status === 404 || authRes.error?.context?.status === 403;
    console.log(`Unauthorized room request rejected (403/404): ${isRejected ? 'PASS' : 'FAIL'} (status: ${authRes.error?.context?.status || 200})\n`);
  } else {
    console.log('Skipping step 2 (requires active auth user session on remote project)\n');
  }

  console.log('Edge Function security verification complete.');
}

verifyEdgeFunction().catch((err) => {
  console.error('Verification error:', err);
});
