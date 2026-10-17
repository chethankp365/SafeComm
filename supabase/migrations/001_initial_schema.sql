-- SafeComm Supabase Initial Schema & Row-Level Security
-- Run this in your Supabase Dashboard: SQL Editor -> New Query -> Run

-- 1. Create sessions table
CREATE TABLE IF NOT EXISTS public.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL DEFAULT auth.uid(),
    scenario_name TEXT DEFAULT 'Standard Approach',
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Create transmissions table
CREATE TABLE IF NOT EXISTS public.transmissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES public.sessions(id) ON DELETE CASCADE NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('controller', 'pilot')),
    text TEXT NOT NULL,
    timestamp TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    confidence NUMERIC DEFAULT 1.0
);

-- 3. Create instructions table
CREATE TABLE IF NOT EXISTS public.instructions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transmission_id UUID REFERENCES public.transmissions(id) ON DELETE CASCADE NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    direction TEXT,
    callsign TEXT NOT NULL,
    confidence NUMERIC DEFAULT 1.0
);

-- 4. Create verdicts table
CREATE TABLE IF NOT EXISTS public.verdicts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id UUID REFERENCES public.instructions(id) ON DELETE CASCADE NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('MATCH', 'MISMATCH', 'PARTIAL', 'UNVERIFIED')),
    severity TEXT NOT NULL CHECK (severity IN ('OK', 'WARNING', 'CRITICAL')),
    explanation TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Create alerts table
CREATE TABLE IF NOT EXISTS public.alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    verdict_id UUID REFERENCES public.verdicts(id) ON DELETE CASCADE NOT NULL,
    acknowledged BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transmissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

-- Clean existing policies if re-running
DROP POLICY IF EXISTS "Users can manage own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can manage transmissions in own sessions" ON public.transmissions;
DROP POLICY IF EXISTS "Users can manage instructions in own sessions" ON public.instructions;
DROP POLICY IF EXISTS "Users can manage verdicts in own sessions" ON public.verdicts;
DROP POLICY IF EXISTS "Users can manage alerts in own sessions" ON public.alerts;

-- RLS Policies scoped to auth.uid()
CREATE POLICY "Users can manage own sessions"
    ON public.sessions
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage transmissions in own sessions"
    ON public.transmissions
    FOR ALL
    USING (
        session_id IN (
            SELECT id FROM public.sessions WHERE user_id = auth.uid()
        )
    )
    WITH CHECK (
        session_id IN (
            SELECT id FROM public.sessions WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can manage instructions in own sessions"
    ON public.instructions
    FOR ALL
    USING (
        transmission_id IN (
            SELECT t.id FROM public.transmissions t
            JOIN public.sessions s ON t.session_id = s.id
            WHERE s.user_id = auth.uid()
        )
    )
    WITH CHECK (
        transmission_id IN (
            SELECT t.id FROM public.transmissions t
            JOIN public.sessions s ON t.session_id = s.id
            WHERE s.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can manage verdicts in own sessions"
    ON public.verdicts
    FOR ALL
    USING (
        instruction_id IN (
            SELECT i.id FROM public.instructions i
            JOIN public.transmissions t ON i.transmission_id = t.id
            JOIN public.sessions s ON t.session_id = s.id
            WHERE s.user_id = auth.uid()
        )
    )
    WITH CHECK (
        instruction_id IN (
            SELECT i.id FROM public.instructions i
            JOIN public.transmissions t ON i.transmission_id = t.id
            JOIN public.sessions s ON t.session_id = s.id
            WHERE s.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can manage alerts in own sessions"
    ON public.alerts
    FOR ALL
    USING (
        verdict_id IN (
            SELECT v.id FROM public.verdicts v
            JOIN public.instructions i ON v.instruction_id = i.id
            JOIN public.transmissions t ON i.transmission_id = t.id
            JOIN public.sessions s ON t.session_id = s.id
            WHERE s.user_id = auth.uid()
        )
    )
    WITH CHECK (
        verdict_id IN (
            SELECT v.id FROM public.verdicts v
            JOIN public.instructions i ON v.instruction_id = i.id
            JOIN public.transmissions t ON i.transmission_id = t.id
            JOIN public.sessions s ON t.session_id = s.id
            WHERE s.user_id = auth.uid()
        )
    );
