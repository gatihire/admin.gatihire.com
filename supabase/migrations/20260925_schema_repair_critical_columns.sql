-- Emergency schema repair: apply the missing migrations to the production DB.
-- Idempotent — safe to run multiple times. Covers:
--   20260901_add_transcript_raw_and_cost_breakdown.sql
--   20260901_add_enriched_summary.sql
--   20260903010000_call_flow_improvements.sql
-- These were applied to dev but never to this database, which silently broke
-- the entire call pipeline (findParticipant SELECT references retry_count ->
-- PostgREST 42703 -> no participant ever matches -> calls stuck at "calling").

-- 1. phone_screening_participants: raw transcript, cost breakdown, ring meta
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS transcript_raw TEXT;
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS cost_breakdown JSONB;
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS enriched_summary JSONB;
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS ring_duration INT;
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS carrier TEXT;
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS hangup_by TEXT;
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS call_disconnect_reason TEXT;

-- 2. phone_screening_participants: retry bookkeeping + call start
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS call_started_at TIMESTAMPTZ;
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- 3. call_transcripts: partial-call flag
ALTER TABLE call_transcripts
  ADD COLUMN IF NOT EXISTS is_partial BOOLEAN DEFAULT FALSE;

-- 4. Backfill retry_count from existing attempt history
UPDATE phone_screening_participants
SET retry_count = COALESCE(call_attempts, 0)
WHERE COALESCE(retry_count, 0) = 0 AND COALESCE(call_attempts, 0) > 0;

-- 5. Reconcile helper index
CREATE INDEX IF NOT EXISTS idx_participants_stuck_calls
  ON phone_screening_participants (status, last_attempt_at)
  WHERE status IN ('calling', 'in_progress');