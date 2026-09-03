-- Phone Screening System for first-round automated calls via Plivo + WhatsApp

-- 1. Screening campaigns (one per trigger action by a recruiter)
CREATE TABLE IF NOT EXISTS public.phone_screening_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES internal_users(auth_user_id),
    total_candidates INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'whatsapp_sent', 'in_progress', 'completed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Screening participants (individual candidates within a campaign)
CREATE TABLE IF NOT EXISTS public.phone_screening_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES phone_screening_campaigns(id) ON DELETE CASCADE,
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'whatsapp_sent', 'whatsapp_delivered', 'whatsapp_read',
        'call_me_now', 'scheduled', 'call_scheduled',
        'calling', 'in_progress', 'completed', 'failed',
        'not_interested', 'unreachable', 'rescheduled'
    )),

    whatsapp_message_id TEXT,
    whatsapp_sent_at TIMESTAMPTZ,
    whatsapp_response TEXT CHECK (whatsapp_response IN ('call_me_now', 'schedule', 'not_interested')),

    scheduled_call_at TIMESTAMPTZ,
    timezone TEXT,

    plivo_call_uuid TEXT,
    call_started_at TIMESTAMPTZ,
    call_ended_at TIMESTAMPTZ,
    call_duration_seconds INT,
    call_attempts INT NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,

    ai_score DECIMAL(3,1),
    ai_summary TEXT,
    ai_recommendation TEXT CHECK (ai_recommendation IN ('advance', 'further_review', 'not_a_fit')),
    transcript_json JSONB,
    recording_url TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(campaign_id, candidate_id)
);

-- 3. Call transcript segments
CREATE TABLE IF NOT EXISTS public.call_transcripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID NOT NULL REFERENCES phone_screening_participants(id) ON DELETE CASCADE,
    speaker TEXT NOT NULL CHECK (speaker IN ('ai', 'candidate')),
    text TEXT NOT NULL,
    start_time_sec DECIMAL(6,2),
    end_time_sec DECIMAL(6,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Structured screening answers (key data points extracted)
CREATE TABLE IF NOT EXISTS public.screening_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID NOT NULL REFERENCES phone_screening_participants(id) ON DELETE CASCADE,
    question_key TEXT NOT NULL,
    question_text TEXT NOT NULL,
    answer_text TEXT,
    sentiment TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_psp_candidate ON phone_screening_participants(candidate_id);
CREATE INDEX IF NOT EXISTS idx_psp_job ON phone_screening_participants(job_id);
CREATE INDEX IF NOT EXISTS idx_psp_status ON phone_screening_participants(status);
CREATE INDEX IF NOT EXISTS idx_psp_campaign ON phone_screening_participants(campaign_id);
CREATE INDEX IF NOT EXISTS idx_psp_next_retry ON phone_screening_participants(next_retry_at) WHERE next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_psp_scheduled_call ON phone_screening_participants(scheduled_call_at) WHERE scheduled_call_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_participant ON call_transcripts(participant_id);
CREATE INDEX IF NOT EXISTS idx_sa_participant ON screening_answers(participant_id);
CREATE INDEX IF NOT EXISTS idx_psc_job ON phone_screening_campaigns(job_id);

-- RLS
ALTER TABLE public.phone_screening_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phone_screening_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.screening_answers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view screening campaigns" ON phone_screening_campaigns
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage screening campaigns" ON phone_screening_campaigns
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view screening participants" ON phone_screening_participants
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage screening participants" ON phone_screening_participants
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view transcripts" ON call_transcripts
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage transcripts" ON call_transcripts
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view screening answers" ON screening_answers
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage screening answers" ON screening_answers
    FOR ALL USING (auth.role() = 'authenticated');
