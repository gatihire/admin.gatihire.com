-- Add missing matchingCriteria column to job_matches table
ALTER TABLE public.job_matches 
ADD COLUMN IF NOT EXISTS matchingCriteria jsonb;

-- Add match_score column for easier querying
ALTER TABLE public.job_matches 
ADD COLUMN IF NOT EXISTS match_score float;

-- Add index for score-based queries
CREATE INDEX IF NOT EXISTS idx_job_matches_match_score 
ON public.job_matches(match_score desc);

-- Add index for candidate lookups
CREATE INDEX IF NOT EXISTS idx_job_matches_candidate_id 
ON public.job_matches(candidate_id);