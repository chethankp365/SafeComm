import { createClient } from '@supabase/supabase-js';

const env = (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: Record<string, string> }).env) || {};
const supabaseUrl = env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(
  supabaseUrl && 
  supabaseAnonKey && 
  !supabaseUrl.includes('your-project-id') && 
  !supabaseAnonKey.includes('your-anon-public-key')
);

if (!isSupabaseConfigured) {
  console.warn(
    '[SafeComm] Supabase credentials missing or set to placeholder. Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.'
  );
}

// Fallback configuration allows client instantiation without crashing if unconfigured
const validUrl = isSupabaseConfigured ? supabaseUrl : 'https://placeholder.supabase.co';
const validKey = isSupabaseConfigured ? supabaseAnonKey : 'placeholder-anon-key';

export const supabase = createClient(validUrl, validKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

export interface DatabaseSession {
  id: string;
  user_id: string;
  created_at: string;
  scenario_name?: string;
  status?: string;
}

export interface DatabaseTransmission {
  id: string;
  session_id: string;
  role: 'controller' | 'pilot';
  text: string;
  timestamp: string;
  confidence: number;
}

export interface DatabaseInstruction {
  id: string;
  transmission_id: string;
  type: string;
  value: string;
  direction?: string | null;
  callsign: string;
  confidence: number;
}

export interface DatabaseVerdict {
  id: string;
  instruction_id: string;
  outcome: 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED';
  severity: 'OK' | 'WARNING' | 'CRITICAL';
  explanation: string;
  created_at: string;
}

export interface DatabaseAlert {
  id: string;
  verdict_id: string;
  acknowledged: boolean;
  created_at: string;
}
