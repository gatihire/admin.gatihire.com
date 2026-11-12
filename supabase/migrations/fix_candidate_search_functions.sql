-- Fix the broken candidate search functions.
--
-- WHY THESE WERE BROKEN
--
-- 1. `current_role` is a PostgreSQL KEYWORD (like `current_user`). An
--    unquoted reference resolves to the session role — which returns the
--    string "postgres" — NOT to the candidates.current_role column. So
--    every filter on current_role silently matched nothing.
--
-- 2. `technical_skills` was migrated from text[] to jsonb. The functions
--    still called unnest()/array_to_string() on it, which raises
--    "function unnest(jsonb) does not exist".
--
-- 3. `candidates` has no `created_at` column (it has uploaded_at). The
--    ORDER BY referenced a column that does not exist.
--
-- 4. `search_candidates` declared RETURNS TABLE(... technical_skills text[])
--    but the underlying column is jsonb, so the result type did not match.
--
-- All four are now rebuilt correctly. `search_candidates_hybrid` (the one
-- used by job matching) was already healthy and is left alone.

-- ---------------------------------------------------------------------------
-- search_candidates — plain full-text search over the candidate table.
-- ---------------------------------------------------------------------------
-- The return type changes (text[] -> jsonb), so the old function must be
-- dropped first — PostgreSQL refuses CREATE OR REPLACE with a changed
-- return type.
DROP FUNCTION IF EXISTS public.search_candidates(text);

CREATE FUNCTION public.search_candidates(search_query text)
RETURNS TABLE(
  result_id uuid,
  result_name text,
  result_current_role text,
  result_location text,
  result_technical_skills jsonb,
  result_rank real
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c."current_role",
    c.location,
    c.technical_skills,
    ts_rank(c.search_vector, plainto_tsquery('english', search_query))
  FROM candidates c
  WHERE c.search_vector @@ plainto_tsquery('english', search_query)
  ORDER BY result_rank DESC, c.uploaded_at DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- search_candidates_by_skills — skill match with a match count.
-- technical_skills is jsonb, so it is unnested with jsonb_array_elements_text.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.search_candidates_by_skills(text[]);

CREATE FUNCTION public.search_candidates_by_skills(skills text[])
RETURNS TABLE(
  result_id uuid,
  result_name text,
  result_current_role text,
  result_location text,
  result_technical_skills jsonb,
  result_skill_matches integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c."current_role",
    c.location,
    c.technical_skills,
    (
      SELECT COUNT(DISTINCT skill)::int
      FROM unnest(skills) AS skill
      WHERE
        LOWER(skill) = ANY(
          SELECT LOWER(x) FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(c.technical_skills) = 'array'
                 THEN c.technical_skills ELSE '[]'::jsonb END
          ) AS x
        )
        OR LOWER(c."current_role") LIKE '%' || LOWER(skill) || '%'
        OR LOWER(c.summary) LIKE '%' || LOWER(skill) || '%'
        OR LOWER(c.resume_text) LIKE '%' || LOWER(skill) || '%'
    )
  FROM candidates c
  WHERE (
    SELECT COUNT(DISTINCT skill)
    FROM unnest(skills) AS skill
    WHERE
      LOWER(skill) = ANY(
        SELECT LOWER(x) FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(c.technical_skills) = 'array'
               THEN c.technical_skills ELSE '[]'::jsonb END
        ) AS x
      )
      OR LOWER(c."current_role") LIKE '%' || LOWER(skill) || '%'
      OR LOWER(c.summary) LIKE '%' || LOWER(skill) || '%'
      OR LOWER(c.resume_text) LIKE '%' || LOWER(skill) || '%'
  ) > 0
  ORDER BY result_skill_matches DESC, c.uploaded_at DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- search_candidates_v2 — the older hybrid search. Unused by the app today
-- but kept working because it is part of the public RPC surface.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_candidates_v2(
  p_query_text text,
  p_query_embedding vector,
  p_match_threshold double precision,
  p_filters jsonb,
  p_limit integer,
  p_offset integer
)
RETURNS TABLE(candidate_data jsonb, total_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_where text := '1=1';
BEGIN
  IF p_filters ? 'location' AND (p_filters->>'location') <> '' THEN
    v_where := v_where || format(' AND location ILIKE %L', '%' || (p_filters->>'location') || '%');
  END IF;

  IF p_filters ? 'exp_min' AND (p_filters->>'exp_min') <> '' THEN
    v_where := v_where || format(' AND CAST(NULLIF(total_experience, '''') AS numeric) >= %L', (p_filters->>'exp_min')::numeric);
  END IF;

  IF p_filters ? 'exp_max' AND (p_filters->>'exp_max') <> '' THEN
    v_where := v_where || format(' AND CAST(NULLIF(total_experience, '''') AS numeric) <= %L', (p_filters->>'exp_max')::numeric);
  END IF;

  IF p_filters ? 'must_kw' AND jsonb_array_length(p_filters->'must_kw') > 0 THEN
    v_where := v_where || format(
      ' AND (lower("current_role") || '' '' || COALESCE(location,'''') || '' '' || COALESCE(degree,'''') || '' '' || COALESCE(highest_qualification,'''') || '' '' || COALESCE(technical_skills::text,'''')) ILIKE ANY (ARRAY[%s])',
      (SELECT string_agg(quote_literal('%' || x || '%'), ',') FROM jsonb_array_elements_text(p_filters->'must_kw') x)
    );
  END IF;

  IF p_filters ? 'exclude_kw' AND jsonb_array_length(p_filters->'exclude_kw') > 0 THEN
    v_where := v_where || format(
      ' AND (lower("current_role") || '' '' || COALESCE(location,'''') || '' '' || COALESCE(degree,'''') || '' '' || COALESCE(highest_qualification,'''') || '' '' || COALESCE(technical_skills::text,'''')) NOT ILIKE ALL (ARRAY[%s])',
      (SELECT string_agg(quote_literal('%' || x || '%'), ',') FROM jsonb_array_elements_text(p_filters->'exclude_kw') x)
    );
  END IF;

  IF p_filters ? 'currentCity' AND jsonb_array_length(p_filters->'currentCity') > 0 THEN
    v_where := v_where || format(' AND location ILIKE ANY (ARRAY[%s])',
      (SELECT string_agg(quote_literal('%' || x || '%'), ',') FROM jsonb_array_elements_text(p_filters->'currentCity') x)
    );
  END IF;

  IF p_filters ? 'industries' AND jsonb_array_length(p_filters->'industries') > 0 THEN
    v_where := v_where || format(' AND lower("current_role") ILIKE ANY (ARRAY[%s])',
      (SELECT string_agg(quote_literal('%' || x || '%'), ',') FROM jsonb_array_elements_text(p_filters->'industries') x)
    );
  END IF;

  IF p_filters ? 'companies' AND jsonb_array_length(p_filters->'companies') > 0 THEN
    v_where := v_where || format(' AND lower(current_company) ILIKE ANY (ARRAY[%s])',
      (SELECT string_agg(quote_literal('%' || x || '%'), ',') FROM jsonb_array_elements_text(p_filters->'companies') x)
    );
  END IF;

  IF p_filters ? 'education' AND jsonb_array_length(p_filters->'education') > 0 THEN
    v_where := v_where || format(' AND (lower(degree) || '' '' || lower(highest_qualification)) ILIKE ANY (ARRAY[%s])',
      (SELECT string_agg(quote_literal('%' || x || '%'), ',') FROM jsonb_array_elements_text(p_filters->'education') x)
    );
  END IF;

  IF p_query_embedding IS NOT NULL AND p_query_text <> '' THEN
    -- HYBRID SEARCH (Vector + Text)
    RETURN QUERY EXECUTE format(
      'WITH filtered AS (
         SELECT *, 
           ts_rank(search_vector, websearch_to_tsquery(''english'', %L)) as text_rank,
           1 - (embedding <=> %L::vector) as vec_sim
         FROM candidates
         WHERE %s
       ), scored AS (
         SELECT *,
           (text_rank * 100) + (vec_sim * 100) as match_score
         FROM filtered
         WHERE (text_rank > 0 OR vec_sim > %L)
       )
       SELECT row_to_json(scored.*)::jsonb, count(*) OVER() as total_count
       FROM scored
       ORDER BY match_score DESC
       LIMIT %L OFFSET %L
    ', p_query_text, p_query_embedding, v_where, p_match_threshold, p_limit, p_offset);

  ELSIF p_query_embedding IS NOT NULL THEN
    RETURN QUERY EXECUTE format(
      'WITH filtered AS (
         SELECT *,
           1 - (embedding <=> %L::vector) as vec_sim
         FROM candidates
         WHERE %s
       ), scored AS (
         SELECT *,
           (vec_sim * 100) as match_score
         FROM filtered
         WHERE vec_sim > %L
       )
       SELECT row_to_json(scored.*)::jsonb, count(*) OVER() as total_count
       FROM scored
       ORDER BY match_score DESC
       LIMIT %L OFFSET %L
    ', p_query_embedding, v_where, p_match_threshold, p_limit, p_offset);

  ELSIF p_query_text <> '' THEN
    RETURN QUERY EXECUTE format(
      'WITH filtered AS (
         SELECT *,
           ts_rank(search_vector, websearch_to_tsquery(''english'', %L)) as text_rank
         FROM candidates
         WHERE %s
       ), scored AS (
         SELECT *,
           (text_rank * 100) as match_score
         FROM filtered
         WHERE text_rank > 0
       )
       SELECT row_to_json(scored.*)::jsonb, count(*) OVER() as total_count
       FROM scored
       ORDER BY match_score DESC
       LIMIT %L OFFSET %L
    ', p_query_text, v_where, p_limit, p_offset);

  ELSE
    RETURN QUERY EXECUTE format(
      'WITH filtered AS (
         SELECT *, 0::float as match_score
         FROM candidates
         WHERE %s
       )
       SELECT row_to_json(filtered.*)::jsonb, count(*) OVER() as total_count
       FROM filtered
       ORDER BY uploaded_at DESC
       LIMIT %L OFFSET %L
    ', v_where, p_limit, p_offset);
  END IF;
END;
$$;

-- The keyword-comparison trigger must also quote the column, otherwise it
-- concatenates the session role ("postgres") into every search vector.
CREATE OR REPLACE FUNCTION public.update_candidates_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.name, '') || ' ' ||
    COALESCE(NEW."current_role", '') || ' ' ||
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
$$;
