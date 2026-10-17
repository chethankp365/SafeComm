import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();

const supabase = createClient(url, key);

async function checkAuthIssue() {
  console.log('Testing signInWithPassword on officer@safecomm.aero...');
  const res = await supabase.auth.signInWithPassword({
    email: 'officer@safecomm.aero',
    password: 'Password123!',
  });
  console.log('Result:', res);
}

checkAuthIssue().catch(console.error);
