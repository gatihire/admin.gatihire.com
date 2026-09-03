-- AI Continuous Learning System
-- Loop: per-call quality evaluation -> weekly playbook synthesis -> agent context
-- Plus: fine-tuning dataset extraction so a proprietary LLM can be trained from transcripts.

-- 1. Per-call quality/learning events (issues, lessons, positive patterns)
CREATE TABLE IF NOT EXISTS public.ai_learning_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID REFERENCES phone_screening_participants(id) ON DELETE CASCADE,
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    call_uuid TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN ('quality_issue', 'lesson', 'positive_pattern')),
    issue_category TEXT,
    severity TEXT CHECK (severity IN ('low', 'medium', 'high')),
    evidence_text TEXT,
    lesson TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Aggregated quality metrics per completed call
CREATE TABLE IF NOT EXISTS public.call_quality_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID NOT NULL REFERENCES phone_screening_participants(id) ON DELETE CASCADE,
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    duration_seconds INT,
    agent_turns INT NOT NULL DEFAULT 0,
    candidate_turns INT NOT NULL DEFAULT 0,
    missing_answers TEXT[] NOT NULL DEFAULT '{}',
    avg_candidate_answer_words NUMERIC(5,1),
    negative_sentiment_count INT NOT NULL DEFAULT 0,
    aborted BOOLEAN NOT NULL DEFAULT FALSE,
    issues_count INT NOT NULL DEFAULT 0,
    quality_score NUMERIC(4,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(participant_id)
);

-- 3. Weekly-synthesized playbook versions (the growing "generalist HR" knowledge)
CREATE TABLE IF NOT EXISTS public.ai_playbook_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version INT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'superseded')),
    title TEXT NOT NULL DEFAULT 'Weekly Playbook',
    summary TEXT,
    prompt_override TEXT,
    rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    qa_examples JSONB NOT NULL DEFAULT '[]'::jsonb,
    stats JSONB NOT NULL DEFAULT '{}'::jsonb,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Fine-tuning training rows extracted from real conversations
CREATE TABLE IF NOT EXISTS public.ai_fine_tune_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID REFERENCES phone_screening_participants(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ale_participant ON public.ai_learning_events(participant_id);
CREATE INDEX IF NOT EXISTS idx_ale_category ON public.ai_learning_events(issue_category);
CREATE INDEX IF NOT EXISTS idx_ale_created ON public.ai_learning_events(created_at);
CREATE INDEX IF NOT EXISTS idx_cqm_participant ON public.call_quality_metrics(participant_id);
CREATE INDEX IF NOT EXISTS idx_cqm_created ON public.call_quality_metrics(created_at);
CREATE INDEX IF NOT EXISTS idx_apbv_status ON public.ai_playbook_versions(status);
CREATE INDEX IF NOT EXISTS idx_ftr_participant ON public.ai_fine_tune_rows(participant_id);

-- RLS
ALTER TABLE public.ai_learning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_quality_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_playbook_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_fine_tune_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view learning events" ON public.ai_learning_events
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage learning events" ON public.ai_learning_events
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view quality metrics" ON public.call_quality_metrics
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage quality metrics" ON public.call_quality_metrics
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view playbook versions" ON public.ai_playbook_versions
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage playbook versions" ON public.ai_playbook_versions
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view fine-tune rows" ON public.ai_fine_tune_rows
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage fine-tune rows" ON public.ai_fine_tune_rows
    FOR ALL USING (auth.role() = 'authenticated');
