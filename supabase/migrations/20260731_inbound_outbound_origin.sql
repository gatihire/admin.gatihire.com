-- Inbound vs Outbound candidate classification
-- inbound  = candidate actively applied (portal, job boards, external apply links)
-- outbound = profile sourced/matched by admin (DB matches, sourced resume uploads)

-- 1. Add origin to applications, backfill from existing source, then constrain
ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS origin TEXT;

UPDATE public.applications
SET origin = 'outbound'
WHERE source IN ('database', 'enhanced_match', 'recruiter_upload');

UPDATE public.applications
SET origin = 'inbound'
WHERE origin IS NULL;

ALTER TABLE public.applications
    ALTER COLUMN origin SET NOT NULL,
    ALTER COLUMN origin SET DEFAULT 'inbound',
    ADD CONSTRAINT applications_origin_check CHECK (origin IN ('inbound', 'outbound'));

CREATE INDEX IF NOT EXISTS idx_applications_job_origin ON public.applications(job_id, origin);

-- 2. Denormalize origin on screening participants so webhooks/agents don't need a join
ALTER TABLE public.phone_screening_participants ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'inbound';
ALTER TABLE public.phone_screening_participants
    ADD CONSTRAINT phone_screening_participants_origin_check CHECK (origin IN ('inbound', 'outbound'));
