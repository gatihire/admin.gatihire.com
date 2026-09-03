-- Fix interview status constraint to match API/UI reality.
-- Old DB constraint: pending|scheduled|completed|passed|failed|no_show
-- New constraint includes ALL statuses used by API + UI + new scheduling flow.

ALTER TABLE job_interviews
  DROP CONSTRAINT IF EXISTS job_interviews_status_check;

ALTER TABLE job_interviews
  ADD CONSTRAINT job_interviews_status_check
  CHECK (status IN (
    -- Original DB statuses
    'pending', 'scheduled', 'completed', 'passed', 'failed', 'no_show',
    -- API/UI statuses
    'waitlist', 'on_hold', 'move_next', 'rejected',
    -- New interview scheduling flow
    'invite_sent',       -- WhatsApp interview invite sent to candidate
    'confirmed',         -- Candidate confirmed the interview time
    'rescheduled',       -- Candidate suggested a new time
    'cancelled'          -- Interview cancelled
  ));

-- Add columns for the interview scheduling flow
ALTER TABLE job_interviews ADD COLUMN IF NOT EXISTS candidate_response text;
ALTER TABLE job_interviews ADD COLUMN IF NOT EXISTS suggested_times jsonb;
ALTER TABLE job_interviews ADD COLUMN IF NOT EXISTS invite_sent_at timestamptz;
ALTER TABLE job_interviews ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE job_interviews ADD COLUMN IF NOT EXISTS whatsapp_message_id text;

-- Add scheduling fields to job_interview_rounds for round-level defaults
ALTER TABLE job_interview_rounds ADD COLUMN IF NOT EXISTS duration_minutes integer DEFAULT 30;
ALTER TABLE job_interview_rounds ADD COLUMN IF NOT EXISTS interview_type text DEFAULT 'online';
