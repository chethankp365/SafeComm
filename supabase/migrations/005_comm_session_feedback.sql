-- SafeComm Migration 005: Comm Session Feedback & Ratings
-- Narrowly scoped feedback table with strict Row Level Security (RLS)
-- Each participant can only insert and read their own feedback.

CREATE TABLE IF NOT EXISTS public.comm_session_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES public.comm_rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
    role TEXT NOT NULL CHECK (role IN ('atc', 'pilot')),
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    feedback_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT comm_session_feedback_room_user_unique UNIQUE (room_id, user_id)
);

-- Enable RLS
ALTER TABLE public.comm_session_feedback ENABLE ROW LEVEL SECURITY;

-- Clean existing policies if re-running
DROP POLICY IF EXISTS "Users can insert own comm feedback" ON public.comm_session_feedback;
DROP POLICY IF EXISTS "Users can view own comm feedback" ON public.comm_session_feedback;
DROP POLICY IF EXISTS "Users can update own comm feedback" ON public.comm_session_feedback;

-- Policy 1: Users can insert feedback only for their own authenticated user ID
CREATE POLICY "Users can insert own comm feedback"
    ON public.comm_session_feedback
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- Policy 2: Users can view ONLY their own feedback (privacy guarantee - never exposed to peer)
CREATE POLICY "Users can view own comm feedback"
    ON public.comm_session_feedback
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Policy 3: Users can update their own feedback
CREATE POLICY "Users can update own comm feedback"
    ON public.comm_session_feedback
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Revoke all access from anon and PUBLIC
REVOKE ALL ON TABLE public.comm_session_feedback FROM anon, PUBLIC;

-- Table permissions for authenticated users
GRANT SELECT, INSERT, UPDATE ON TABLE public.comm_session_feedback TO authenticated;

-- Secure helper function to submit feedback atomically
CREATE OR REPLACE FUNCTION public.submit_comm_feedback(
    p_room_id UUID,
    p_rating INT,
    p_feedback TEXT DEFAULT NULL,
    p_role TEXT DEFAULT 'pilot'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id UUID;
    v_feedback_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Authentication required to submit feedback');
    END IF;

    IF p_rating < 1 OR p_rating > 5 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Rating must be between 1 and 5 stars');
    END IF;

    IF p_role NOT IN ('atc', 'pilot') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid role');
    END IF;

    -- Upsert feedback (allow rating revision while strictly preventing duplicate rows)
    INSERT INTO public.comm_session_feedback (room_id, user_id, role, rating, feedback_text)
    VALUES (p_room_id, v_user_id, p_role, p_rating, p_feedback)
    ON CONFLICT (room_id, user_id)
    DO UPDATE SET
        rating = EXCLUDED.rating,
        feedback_text = EXCLUDED.feedback_text,
        role = EXCLUDED.role,
        created_at = timezone('utc'::text, now())
    RETURNING id INTO v_feedback_id;

    RETURN jsonb_build_object('success', true, 'feedback_id', v_feedback_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_comm_feedback(UUID, INT, TEXT, TEXT) TO authenticated;
