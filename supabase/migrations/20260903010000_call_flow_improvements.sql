-- Call flow improvement: new statuses, retry tracking, partial transcripts
-- Run this migration in Supabase SQL Editor

-- 1. Add new columns to phone_screening_participants
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS call_disconnect_reason TEXT,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS call_started_at TIMESTAMPTZ;

-- 2. Add is_partial flag to call_transcripts
ALTER TABLE call_transcripts
  ADD COLUMN IF NOT EXISTS is_partial BOOLEAN DEFAULT FALSE;

-- 3. Update existing failed records with retry_count
UPDATE phone_screening_participants
SET retry_count = COALESCE(call_attempts, 0)
WHERE retry_count = 0 AND call_attempts > 0;

-- 4. Create index for faster reconcile queries
CREATE INDEX IF NOT EXISTS idx_participants_stuck_calls
  ON phone_screening_participants (status, last_attempt_at)
  WHERE status IN ('calling', 'in_progress');
