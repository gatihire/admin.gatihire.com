-- Pipeline / call-screening read-path indexes.
--
-- Why: the 11 Nov incident had the database pinned at ~95% CPU and ~95% memory.
-- The pipeline and participant-list endpoints filter and sort on these columns
-- for every job open. Without indexes Postgres falls back to sequential scans
-- over tables that include large JSONB/text payloads, so a handful of concurrent
-- HR users could saturate the instance.
--
-- Safe to re-run: every statement is IF NOT EXISTS.

-- Job pipeline: applications for a job, newest first.
CREATE INDEX IF NOT EXISTS idx_applications_job_applied_at
  ON applications (job_id, applied_at DESC);

-- Screening participants: per job, newest first (pipeline card list).
CREATE INDEX IF NOT EXISTS idx_psp_job_created_at
  ON phone_screening_participants (job_id, created_at DESC);

-- Reconcile cron: find non-terminal rows that have gone stale.
CREATE INDEX IF NOT EXISTS idx_psp_status_updated_at
  ON phone_screening_participants (status, updated_at);

-- Reconcile / webhook lookup by provider execution id.
CREATE INDEX IF NOT EXISTS idx_psp_bolna_execution_id
  ON phone_screening_participants (bolna_execution_id)
  WHERE bolna_execution_id IS NOT NULL;

-- Fit scores are read per job when rendering the pipeline.
CREATE INDEX IF NOT EXISTS idx_candidate_job_fit_job_id
  ON candidate_job_fit (job_id);

-- Latest shortlist share per job.
CREATE INDEX IF NOT EXISTS idx_shortlist_shares_job_created_at
  ON shortlist_shares (job_id, created_at DESC);
