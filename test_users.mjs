import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();
const client = createClient(url, key);

async function testKnownUsers() {
  const testAccounts = [
    { email: 'atc.officer.test@safecomm.aero', pass: 'Password123!' },
    { email: 'officer@safecomm.aero', pass: 'Password123!' },
    { email: 'officer@tower.faa.gov', pass: 'Password123!' },
    { email: 'chethan@gmail.com', pass: 'Password123!' },
  ];

  for (const acc of testAccounts) {
    const { data, error } = await client.auth.signInWithPassword({
      email: acc.email,
      password: acc.pass,
    });
    console.log(`SignIn ${acc.email}:`, {
      userId: data?.user?.id,
      error: error ? error.message : null,
    });
  }
}

testKnownUsers();
