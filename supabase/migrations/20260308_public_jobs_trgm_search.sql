CREATE OR REPLACE FUNCTION public.search_public_jobs_trgm(search_text text, max_results int DEFAULT 30)
RETURNS TABLE (
  id uuid,
  title text,
  created_at timestamptz,
  location text,
  city text,
  industry text,
  employment_type text,
  shift_type text,
  salary_type text,
  salary_min numeric,
  salary_max numeric,
  department_category text,
  role_category text,
  sub_category text,
  client_id uuid,
  client_name text,
  company_logo_url text,
  apply_type text,
  external_apply_url text,
  experience_min_years integer,
  experience_max_years integer,
  skills_must_have text[],
  skills_good_to_have text[],
  score real
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    j.id,
    j.title,
    j.created_at,
    j.location,
    j.city,
    j.industry,
    j.employment_type,
    j.shift_type,
    j.salary_type,
    j.salary_min,
    j.salary_max,
    j.department_category,
    j.role_category,
    j.sub_category,
    j.client_id,
    j.client_name,
    j.company_logo_url,
    j.apply_type,
    j.external_apply_url,
    j.experience_min_years,
    j.experience_max_years,
    j.skills_must_have,
    j.skills_good_to_have,
    GREATEST(
      similarity(lower(j.title), lower(search_text)),
      similarity(lower(COALESCE(j.client_name, '')), lower(search_text)),
      similarity(lower(COALESCE(j.industry, '')), lower(search_text)),
      similarity(lower(COALESCE(j.department_category, '')), lower(search_text)),
      similarity(lower(COALESCE(j.role_category, '')), lower(search_text)),
      similarity(lower(COALESCE(j.sub_category, '')), lower(search_text)),
      similarity(lower(COALESCE(j.city, '')), lower(search_text)),
      similarity(lower(COALESCE(j.location, '')), lower(search_text))
    ) AS score
  FROM jobs j
  WHERE j.status = 'open'
    AND search_text IS NOT NULL
    AND length(trim(search_text)) > 0
  ORDER BY score DESC, j.created_at DESC, j.id DESC
  LIMIT GREATEST(1, LEAST(max_results, 50));
END;
$$ LANGUAGE plpgsql STABLE;
