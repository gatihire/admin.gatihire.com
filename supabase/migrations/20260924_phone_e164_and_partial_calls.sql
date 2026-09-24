-- Migration: canonical phone numbers + partial-call tracking
-- 1. candidates.phone_e164 — single authoritative E.164 number used by both
--    send (WhatsApp/Bolna) and lookup (Meta webhook) so format mismatches
--    like "+91-99323 38847" vs "919932338847" can never break matching again.
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS phone_e164 TEXT;

CREATE INDEX IF NOT EXISTS idx_candidates_phone_e164
  ON candidates (phone_e164)
  WHERE phone_e164 IS NOT NULL;

COMMENT ON COLUMN candidates.phone_e164 IS 'Canonical E.164 phone (e.g. +919932338847) used for WhatsApp send and Meta webhook candidate lookup';

-- 2. Track when a Bolna call ended mid-conversation (partial transcript, no verdict)
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS call_is_partial BOOLEAN DEFAULT false;

COMMENT ON COLUMN phone_screening_participants.call_is_partial IS 'True when the call disconnected mid-conversation with a partial transcript and no completed verdict';