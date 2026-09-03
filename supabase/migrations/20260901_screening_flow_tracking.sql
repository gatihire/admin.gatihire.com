-- Migration: Enhanced tracking for AI screening flow
-- Adds: WhatsApp message content, candidate reply text, parsed callback, Bolna cost/voicemail/hangup, message history

-- 1. Store WhatsApp outbound message content for audit trail
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS whatsapp_outbound_template TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_outbound_params JSONB;

-- 2. Store candidate's raw reply text (not just classification)
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS whatsapp_reply_text TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_reply_at TIMESTAMPTZ;

-- 3. Parse custom time/date from free-text replies
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS parsed_callback_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parsed_callback_source TEXT;

-- 4. Bolna data we were throwing away
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS call_cost_cents INT,
  ADD COLUMN IF NOT EXISTS call_voicemail BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS call_hangup_reason TEXT;

-- 5. WhatsApp message history (append-only, don't overwrite whatsapp_message_id)
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS whatsapp_history JSONB DEFAULT '[]';

-- 6. Candidate timezone (from Bolna context or Aisensy)
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS candidate_timezone TEXT;

-- Index for retry scheduling
CREATE INDEX IF NOT EXISTS idx_participants_retry
  ON phone_screening_participants (next_retry_at)
  WHERE next_retry_at IS NOT NULL AND status IN ('call_scheduled', 'failed');
