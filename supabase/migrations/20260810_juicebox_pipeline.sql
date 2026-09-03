-- Juicebox / LinkedIn outbound candidate pipeline
-- Dedicated schema for Juicebox premium-search profile imports. Never mixed
-- with resume-derived candidate data. Enriched contact info cached forever.

-- 1. Juicebox profiles (one per imported search result, job-scoped, file-ordered)
CREATE TABLE IF NOT EXISTS public.juicebox_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    import_batch_id UUID NOT NULL,
    import_order INT NOT NULL,

    contact_id TEXT,
    linkedin_id TEXT,
    linkedin_url TEXT,

    first_name TEXT,
    last_name TEXT,
    full_name TEXT,

    job_title TEXT,
    job_company_name TEXT,
    job_company_website TEXT,

    location_name TEXT,
    location_locality TEXT,
    location_country TEXT,

    summary TEXT,
    total_experience_months INT,
    average_tenure TEXT,

    ai_skills JSONB DEFAULT '[]'::jsonb,
    languages JSONB DEFAULT '[]'::jsonb,
    tags JSONB DEFAULT '[]'::jsonb,

    enrichment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (enrichment_status IN ('pending', 'enriching', 'enriched', 'failed')),

    raw_json JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jp_job ON public.juicebox_profiles(job_id, import_order);
CREATE INDEX IF NOT EXISTS idx_jp_contact ON public.juicebox_profiles(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jp_linkedin ON public.juicebox_profiles(linkedin_id) WHERE linkedin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jp_status ON public.juicebox_profiles(job_id, enrichment_status);

-- 2. Experience rows
CREATE TABLE IF NOT EXISTS public.juicebox_experience (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES public.juicebox_profiles(id) ON DELETE CASCADE,
    title TEXT,
    company TEXT,
    company_industry TEXT,
    company_linkedin_url TEXT,
    location TEXT,
    start_date TEXT,
    end_date TEXT,
    duration_months INT,
    sort_order INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jx_profile ON public.juicebox_experience(profile_id);

-- 3. Education rows
CREATE TABLE IF NOT EXISTS public.juicebox_education (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES public.juicebox_profiles(id) ON DELETE CASCADE,
    school TEXT,
    degree TEXT,
    field TEXT,
    start_year TEXT,
    end_year TEXT,
    sort_order INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jed_profile ON public.juicebox_education(profile_id);

-- 4. Enriched contacts (fetched ONCE, persisted FOREVER; never re-fetched)
CREATE TABLE IF NOT EXISTS public.juicebox_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES public.juicebox_profiles(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'thepeakai',
    phone TEXT,
    phone_verified BOOLEAN NOT NULL DEFAULT false,
    work_email TEXT,
    personal_email TEXT,
    credits_charged INT,
    from_cache BOOLEAN,
    raw_json JSONB,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(profile_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_jc_provider ON public.juicebox_contacts(provider, phone);

-- 5. candidates flags for materialized Juicebox rows (source keeps them
--    separable from resume-derived data; source_profile_id traces the origin)
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS source_profile_id UUID REFERENCES public.juicebox_profiles(id);
CREATE INDEX IF NOT EXISTS idx_candidates_source ON public.candidates(source) WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidates_source_profile ON public.candidates(source_profile_id) WHERE source_profile_id IS NOT NULL;

-- RLS (mirror the existing screening-table policy pattern)
ALTER TABLE public.juicebox_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.juicebox_experience ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.juicebox_education ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.juicebox_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view juicebox profiles" ON public.juicebox_profiles
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage juicebox profiles" ON public.juicebox_profiles
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view juicebox experience" ON public.juicebox_experience
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage juicebox experience" ON public.juicebox_experience
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view juicebox education" ON public.juicebox_education
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage juicebox education" ON public.juicebox_education
    FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can view juicebox contacts" ON public.juicebox_contacts
    FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can manage juicebox contacts" ON public.juicebox_contacts
    FOR ALL USING (auth.role() = 'authenticated');
