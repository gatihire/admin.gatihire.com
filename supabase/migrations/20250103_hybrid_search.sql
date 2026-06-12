-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Create missing indexes for fast foreign key lookups (crucial for drawer loading)
CREATE INDEX IF NOT EXISTS idx_work_experience_candidate_id ON work_experience(candidate_id);
CREATE INDEX IF NOT EXISTS idx_education_candidate_id ON education(candidate_id);

-- 2. Create indexes for common filter columns to speed up the RPC
CREATE INDEX IF NOT EXISTS idx_candidates_location ON candidates(location);

-- 3. Drop existing function if it exists to replace it
DROP FUNCTION IF EXISTS search_candidates_hybrid;

-- 4. Create the new highly optimized hybrid search function
CREATE OR REPLACE FUNCTION search_candidates_hybrid(
  p_query_text text,
  p_query_embedding vector(1536),
  p_match_threshold float,
  p_filters jsonb,
  p_limit int,
  p_offset int
)
RETURNS TABLE (
  candidate_data jsonb,
  match_score float,
  total_count bigint
) 
LANGUAGE plpgsql
AS $$
DECLARE
  v_tsquery tsquery;
  v_has_text_query boolean;
BEGIN
  -- Prepare the text search query if provided
  v_has_text_query := p_query_text IS NOT NULL AND trim(p_query_text) <> '';
  IF v_has_text_query THEN
    v_tsquery := websearch_to_tsquery('english', p_query_text);
  END IF;

  RETURN QUERY
  WITH filtered_candidates AS (
    SELECT 
      c.*,
      -- Calculate Text Rank (if query exists)
      CASE 
        WHEN v_has_text_query THEN ts_rank_cd(c.search_vector, v_tsquery)
        ELSE 1.0 
      END as text_rank,
      
      -- Calculate Vector Similarity (if embedding exists)
      CASE 
        WHEN p_query_embedding IS NOT NULL THEN 1 - (c.embedding <=> p_query_embedding)
        ELSE 1.0 
      END as vector_similarity

    FROM candidates c
    WHERE 
      -- Filter: Status (exclude rejected, hired, etc. if needed, assuming active for now)
      (c.status IS NULL OR c.status NOT IN ('rejected', 'hired'))
      
      -- Filter: Current City
      AND (
        p_filters->>'currentCity' IS NULL 
        OR jsonb_array_length(p_filters->'currentCity') = 0
        OR c.location ILIKE ANY (
             SELECT '%' || x || '%' 
             FROM jsonb_array_elements_text(p_filters->'currentCity') x
           )
      )
      
      -- Filter: Minimum Experience (Safely cast string to numeric)
      AND (
        p_filters->>'exp_min' IS NULL 
        OR NULLIF(regexp_replace(c.total_experience::text, '[^0-9.]', '', 'g'), '')::numeric >= (p_filters->>'exp_min')::numeric
      )
      
      -- Filter: Maximum Experience (Safely cast string to numeric)
      AND (
        p_filters->>'exp_max' IS NULL 
        OR NULLIF(regexp_replace(c.total_experience::text, '[^0-9.]', '', 'g'), '')::numeric <= (p_filters->>'exp_max')::numeric
      )
      
      -- Filter: Keywords (Must Have)
      AND (
        p_filters->>'must_kw' IS NULL 
        OR jsonb_array_length(p_filters->'must_kw') = 0
        OR (
          SELECT bool_and(
            c.search_vector @@ plainto_tsquery('english', kw)
          )
          FROM jsonb_array_elements_text(p_filters->'must_kw') kw
        )
      )
      
      -- Filter: Keywords (Exclude)
      AND (
        p_filters->>'exclude_kw' IS NULL 
        OR jsonb_array_length(p_filters->'exclude_kw') = 0
        OR NOT (
          SELECT bool_or(
            c.search_vector @@ plainto_tsquery('english', kw)
          )
          FROM jsonb_array_elements_text(p_filters->'exclude_kw') kw
        )
      )

      -- Text Search Constraint (if text query exists, must match at least something)
      AND (
        NOT v_has_text_query 
        OR c.search_vector @@ v_tsquery
      )
      
      -- Vector Similarity Constraint (if embedding exists)
      AND (
        p_query_embedding IS NULL 
        OR 1 - (c.embedding <=> p_query_embedding) >= COALESCE(p_match_threshold, 0)
      )
  ),
  scored_candidates AS (
    SELECT 
      fc.*,
      -- Hybrid Score Calculation
      CASE 
        WHEN v_has_text_query AND p_query_embedding IS NOT NULL THEN
          (fc.text_rank * 0.7) + (fc.vector_similarity * 0.3)
        WHEN v_has_text_query THEN fc.text_rank
        WHEN p_query_embedding IS NOT NULL THEN fc.vector_similarity
        ELSE 1.0
      END as final_score
    FROM filtered_candidates fc
  ),
  total_results AS (
    SELECT count(*) as cnt FROM scored_candidates
  )
  SELECT 
    row_to_json(sc.*)::jsonb as candidate_data,
    sc.final_score as match_score,
    (SELECT cnt FROM total_results) as total_count
  FROM scored_candidates sc
  ORDER BY sc.final_score DESC, sc.uploaded_at DESC
  LIMIT COALESCE(p_limit, 500)
  OFFSET COALESCE(p_offset, 0);

END;
$$;