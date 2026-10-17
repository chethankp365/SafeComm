-- SafeComm Migration 002: Fix Table Permissions, RLS Policies, and Demo Officer Account
-- Run this in your Supabase Dashboard: SQL Editor -> New Query -> Run

-- 1. Grant table and sequence permissions to authenticated and anon roles
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;

-- 2. Allow user_id to be nullable so demo/evaluation sessions succeed without foreign-key crashes
ALTER TABLE public.sessions ALTER COLUMN user_id DROP NOT NULL;

-- 3. Re-apply minimum secure Row-Level Security (RLS) policies
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transmissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can manage transmissions in own sessions" ON public.transmissions;
DROP POLICY IF EXISTS "Users can manage instructions in own sessions" ON public.instructions;
DROP POLICY IF EXISTS "Users can manage verdicts in own sessions" ON public.verdicts;
DROP POLICY IF EXISTS "Users can manage alerts in own sessions" ON public.alerts;

-- Sessions Policy: Authenticated users manage own sessions; unauthenticated can manage demo sessions
CREATE POLICY "Users can manage own sessions"
    ON public.sessions
    FOR ALL
    USING (
        (auth.uid() IS NOT NULL AND auth.uid() = user_id)
        OR (auth.uid() IS NULL AND user_id IS NULL)
    )
    WITH CHECK (
        (auth.uid() IS NOT NULL AND auth.uid() = user_id)
        OR (auth.uid() IS NULL AND user_id IS NULL)
    );

-- Transmissions Policy
CREATE POLICY "Users can manage transmissions in own sessions"
    ON public.transmissions
    FOR ALL
    USING (
        session_id IN (
            SELECT id FROM public.sessions
            WHERE (auth.uid() IS NOT NULL AND auth.uid() = user_id)
               OR (auth.uid() IS NULL AND user_id IS NULL)
        )
    )
    WITH CHECK (
        session_id IN (
            SELECT id FROM public.sessions
            WHERE (auth.uid() IS NOT NULL AND auth.uid() = user_id)
               OR (auth.uid() IS NULL AND user_id IS NULL)
        )
    );

-- Instructions Policy
CREATE POLICY "Users can manage instructions in own sessions"
    ON public.instructions
    FOR ALL
    USING (
        transmission_id IN (
            SELECT t.id FROM public.transmissions t
            JOIN public.sessions s ON t.session_id = s.id
            WHERE (auth.uid() IS NOT NULL AND auth.uid() = s.user_id)
               OR (auth.uid() IS NULL AND s.user_id IS NULL)
        )
    )
    WITH CHECK (
        transmission_id IN (
            SELECT t.id FROM public.transmissions t
            JOIN public.sessions s ON t.session_id = s.id
            WHERE (auth.uid() IS NOT NULL AND auth.uid() = s.user_id)
               OR (auth.uid() IS NULL AND s.user_id IS NULL)
        )
    );

-- Verdicts Policy
CREATE POLICY "Users can manage verdicts in own sessions"
    ON public.verdicts
    FOR ALL
    USING (
        instruction_id IN (
            SELECT i.id FROM public.instructions i
            JOIN public.transmissions t ON i.transmission_id = t.id
            JOIN public.sessions s ON t.session_id = s.id
            WHERE (auth.uid() IS NOT NULL AND auth.uid() = s.user_id)
               OR (auth.uid() IS NULL AND s.user_id IS NULL)
        )
    )
    WITH CHECK (
        instruction_id IN (
            SELECT i.id FROM public.instructions i
            JOIN public.transmissions t ON i.transmission_id = t.id
            JOIN public.sessions s ON t.session_id = s.id
            WHERE (auth.uid() IS NOT NULL AND auth.uid() = s.user_id)
               OR (auth.uid() IS NULL AND s.user_id IS NULL)
        )
    );

-- Alerts Policy
CREATE POLICY "Users can manage alerts in own sessions"
    ON public.alerts
    FOR ALL
    USING (
        verdict_id IN (
            SELECT v.id FROM public.verdicts v
            JOIN public.instructions i ON v.instruction_id = i.id
            JOIN public.transmissions t ON i.transmission_id = t.id
            JOIN public.sessions s ON t.session_id = s.id
            WHERE (auth.uid() IS NOT NULL AND auth.uid() = s.user_id)
               OR (auth.uid() IS NULL AND s.user_id IS NULL)
        )
    )
    WITH CHECK (
        verdict_id IN (
            SELECT v.id FROM public.verdicts v
            JOIN public.instructions i ON v.instruction_id = i.id
            JOIN public.transmissions t ON i.transmission_id = t.id
            JOIN public.sessions s ON t.session_id = s.id
            WHERE (auth.uid() IS NOT NULL AND auth.uid() = s.user_id)
               OR (auth.uid() IS NULL AND s.user_id IS NULL)
        )
    );

-- 4. Pre-seed confirmed demo officer in auth.users
INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
) VALUES (
    '00000000-0000-0000-0000-000000000000',
    'd3b07384-d113-494a-89a7-96a93bf81152',
    'authenticated',
    'authenticated',
    'officer@safecomm.aero',
    crypt('Password123!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"ATC Safety Officer KSFO-01"}',
    now(),
    now()
) ON CONFLICT (id) DO UPDATE SET
    encrypted_password = crypt('Password123!', gen_salt('bf')),
    email_confirmed_at = now();
