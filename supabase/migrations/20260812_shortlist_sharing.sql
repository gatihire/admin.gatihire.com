-- Shortlist sharing with clients.
-- HR snapshots a job's shortlist into a tokenized, no-login client view.
-- Clients can Approve / Reject each screened candidate; decisions flow back to the pipeline.

CREATE TABLE IF NOT EXISTS public.shortlist_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
    token TEXT NOT NULL UNIQUE,
    title TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.shortlist_share_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_id UUID NOT NULL REFERENCES public.shortlist_shares(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.applications(id) ON DELETE CASCADE,
    candidate_id UUID NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
    name TEXT,
    "current_role" TEXT,
    "current_company" TEXT,
    location TEXT,
    match_score REAL,
    screening_score DECIMAL(3,1),
    screening_verdict TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_at TIMESTAMPTZ,
    decision_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(share_id, application_id)
);

CREATE INDEX IF NOT EXISTS idx_ss_job ON public.shortlist_shares(job_id);
CREATE INDEX IF NOT EXISTS idx_ss_token ON public.shortlist_shares(token);
CREATE INDEX IF NOT EXISTS idx_ssc_share ON public.shortlist_share_candidates(share_id);

-- RLS (mirrors the existing authenticated-user pattern; the public client view
-- uses the service-role client server-side, which bypasses RLS).
ALTER TABLE public.shortlist_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shortlist_share_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view shortlist shares" ON public.shortlist_shares
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage shortlist shares" ON public.shortlist_shares
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view share candidates" ON public.shortlist_share_candidates
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage share candidates" ON public.shortlist_share_candidates
    FOR ALL USING (auth.role() = 'authenticated');
