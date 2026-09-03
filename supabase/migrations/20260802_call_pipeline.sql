-- AI Call Pipeline: team review + callback scheduling for phone screening

-- 1. Team review on screening participants (approve / reject call results)
ALTER TABLE public.phone_screening_participants
  ADD COLUMN IF NOT EXISTS review_status TEXT CHECK (review_status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending';
ALTER TABLE public.phone_screening_participants
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES internal_users(auth_user_id);
ALTER TABLE public.phone_screening_participants
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE public.phone_screening_participants
  ADD COLUMN IF NOT EXISTS review_note TEXT;

-- 2. Callback preference captured by the agent when candidate is busy / not a good time
ALTER TABLE public.phone_screening_participants
  ADD COLUMN IF NOT EXISTS callback_preference TEXT;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_psp_review ON phone_screening_participants(job_id, review_status);
CREATE INDEX IF NOT EXISTS idx_psp_callback ON phone_screening_participants(callback_preference) WHERE callback_preference IS NOT NULL;
