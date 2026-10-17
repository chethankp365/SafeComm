import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envContent = fs.readFileSync('.env', 'utf-8');
const url = envContent.match(/VITE_SUPABASE_URL=(.+)/)[1].trim();
const key = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)[1].trim();
const client = createClient(url, key);

async function verifySync() {
  console.log('=== VERIFYING SUPABASE SCHEMA & TABLES STATUS ===');
  console.log('Target Supabase URL:', url);

  const tables = ['sessions', 'transmissions', 'instructions', 'verdicts', 'alerts'];
  const status = {};

  for (const table of tables) {
    const { data, error, count } = await client
      .from(table)
      .select('*', { count: 'exact' })
      .limit(5);

    status[table] = {
      rowCount: count ?? (data ? data.length : 0),
      sample: data,
      error: error ? { code: error.code, message: error.message, hint: error.hint } : null,
    };
  }

  console.log('\nTable Inspection Results:');
  console.log(JSON.stringify(status, null, 2));

  // Check if permissions denied
  const hasPermissionDenied = Object.values(status).some(
    (s) => s.error && s.error.code === '42501'
  );

  if (hasPermissionDenied) {
    console.log('\n[CRITICAL ROOT CAUSE CONFIRMED]');
    console.log('Postgres returned 42501 (permission denied) on tables.');
    console.log('The table-level privileges (GRANT) have not been applied to the anon/authenticated role yet.');
    console.log('Action: Run supabase/migrations/002_fix_rls_and_permissions.sql in the Supabase SQL editor.');
  } else {
    console.log('\n[PERMISSIONS NOMINAL] All tables accessible without 42501 error.');
  }
}

verifySync();
