-- Migration: Add raw transcript, cost breakdown, and ring duration
-- Stores data from Bolna that was previously discarded

-- 1. Store the raw Bolna transcript verbatim (before parsing)
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS transcript_raw TEXT;

-- 2. Store itemized cost breakdown from Bolna
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS cost_breakdown JSONB;

-- 3. Store ring duration (how long phone rang before answer)
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS ring_duration INT;

-- 4. Store carrier info (Jio, Airtel, Vi, etc.)
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS carrier TEXT;

-- 5. Store hangup source (who hung up: Candidate, AI, System)
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS hangup_by TEXT;
