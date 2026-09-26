-- Scalable search: rebuild search_vector to cover past employers + job titles,
-- add trigram (fuzzy/typo-tolerant) matching on company/institution fields, and
-- expose a company-first fuzzy lookup used by the admin smart-search pool.
-- Idempotent and safe to run multiple times.

-- 1. Trigram similarity extension (already installed in prod; idempotent guard).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Company-name normalizer: strips legal suffixes / filler words so fuzz and
--    ILIKE compare the meaningful part ("Delhivery Pvt Ltd" vs "delhivery").
CREATE OR REPLACE FUNCTION public.normalize_company_name(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT COALESCE(
    string_agg(w, ' '),
    ''
  )
  FROM (
    SELECT btrim(w) AS w
    FROM unnest(string_to_array(replace(coalesce(p_name, ''), '.', ' '), ' ')) AS w
    WHERE btrim(w) <> ''
      AND lower(btrim(w)) NOT IN (
        'pvt','private','ltd','limited','llp','llc','inc','incorporated',
        'corp','corporation','co','tech','technologies','technology',
        'services','service','solutions','solution','and','the','of','group',
        'systems','international','intl','india','ind','en'
      )
  ) t;
$fn$;

-- 3. search_vector: include previous companies + past job titles so text/tsquery
--    legs (admin search AND the shared search_candidates_hybrid used by job
--    matches + client portal) can surface candidates who used to work at a company.
CREATE OR REPLACE FUNCTION public.update_candidates_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.name, '') || ' ' ||
    COALESCE(NEW.current_role, '') || ' ' ||
    COALESCE(NEW.current_company, '') || ' ' ||
    COALESCE(NEW.location, '') || ' ' ||
    COALESCE(NEW.summary, '') || ' ' ||
    COALESCE(NEW.resume_text, '') || ' ' ||
    COALESCE(NEW.technical_skills::text, '') || ' ' ||
    COALESCE(NEW.soft_skills::text, '') || ' ' ||
    COALESCE(NEW.certifications::text, '') || ' ' ||
    COALESCE(NEW.languages_known::text, '') || ' ' ||
    COALESCE(NEW.previous_companies::text, '') || ' ' ||
    COALESCE(NEW.job_titles::text, '')
  );
  RETURN NEW;
END;
$function$;

-- 4. Backfill existing candidates so the expanded vector takes effect immediately.
UPDATE public.candidates
SET search_vector = to_tsvector('english',
  COALESCE(name,'') || ' ' || COALESCE(current_role,'') || ' ' ||
  COALESCE(current_company,'') || ' ' || COALESCE(location,'') || ' ' ||
  COALESCE(summary,'') || ' ' || COALESCE(resume_text,'') || ' ' ||
  COALESCE(technical_skills::text,'') || ' ' || COALESCE(soft_skills::text,'') || ' ' ||
  COALESCE(certifications::text,'') || ' ' || COALESCE(languages_known::text,'') || ' ' ||
  COALESCE(previous_companies::text,'') || ' ' || COALESCE(job_titles::text,''));

-- 5. Trigram GIN indexes: make ILIKE '%...%' and fuzzy matching fast (scales to
--    50k+ candidates without seq scans).
CREATE INDEX IF NOT EXISTS idx_candidates_current_company_trgm ON public.candidates USING gin (current_company gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_candidates_name_trgm ON public.candidates USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_work_experience_company_trgm ON public.work_experience USING gin (company gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_education_institution_trgm ON public.education USING gin (institution gin_trgm_ops);

-- 6. Fuzzy company search: matches current company, past work_experience,
--    education institution and previous_companies with ILIKE + trigram similarity.
--    Used by the admin search pool (searchCandidatesByText) for typo tolerance.
DROP FUNCTION IF EXISTS public.search_candidates_by_company(text, integer, double precision);
CREATE OR REPLACE FUNCTION public.search_candidates_by_company(
  p_query text,
  p_limit int DEFAULT 250,
  p_similarity float DEFAULT 0.4
)
RETURNS TABLE (
  candidate_id uuid,
  matched_company text,
  matched_source text,
  similarity_score float8
)
LANGUAGE plpgsql STABLE
AS $fn$
DECLARE
  v_norm text;
  v_pat text;
BEGIN
  IF p_query IS NULL OR length(btrim(p_query)) < 3 THEN RETURN; END IF;
  v_norm := public.normalize_company_name(p_query);
  v_pat := '%' || lower(btrim(p_query)) || '%';

  RETURN QUERY
  WITH raw AS (
    -- current company
    SELECT c.id AS cid, c.current_company AS mc, 'current_company'::text AS msrc,
           similarity(public.normalize_company_name(c.current_company), v_norm)::float8 AS sim
    FROM candidates c
    WHERE c.current_company IS NOT NULL
      AND (lower(c.current_company) LIKE v_pat
           OR similarity(public.normalize_company_name(c.current_company), v_norm) >= p_similarity)
    UNION ALL
    -- past employers
    SELECT we.candidate_id, we.company, 'work_experience'::text,
           similarity(public.normalize_company_name(we.company), v_norm)::float8
    FROM work_experience we
    WHERE we.company IS NOT NULL
      AND (lower(we.company) LIKE v_pat
           OR similarity(public.normalize_company_name(we.company), v_norm) >= p_similarity)
    UNION ALL
    -- education institutions
    SELECT ed.candidate_id, ed.institution, 'education'::text,
           similarity(public.normalize_company_name(ed.institution), v_norm)::float8
    FROM education ed
    WHERE ed.institution IS NOT NULL
      AND (lower(ed.institution) LIKE v_pat
           OR similarity(public.normalize_company_name(ed.institution), v_norm) >= p_similarity)
    UNION ALL
    -- previous_companies array (jsonb)
    SELECT c.id, pc, 'previous_company'::text,
           similarity(public.normalize_company_name(pc), v_norm)::float8
    FROM candidates c, jsonb_array_elements_text(COALESCE(c.previous_companies, '[]'::jsonb)) AS pc
    WHERE lower(pc) LIKE v_pat
       OR similarity(public.normalize_company_name(pc), v_norm) >= p_similarity
  ),
  deduped AS (
    SELECT DISTINCT ON (cid) cid, mc, msrc, sim
    FROM raw
    ORDER BY cid, sim DESC
  )
  SELECT r.cid, r.mc, r.msrc, r.sim
  FROM deduped r
  ORDER BY r.sim DESC
  LIMIT GREATEST(1, p_limit);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.search_candidates_by_company(text, integer, double precision)
  TO anon, authenticated, service_role;