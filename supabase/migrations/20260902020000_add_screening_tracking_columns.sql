-- Track all generated questions and screening context before candidate outreach.
-- Gives HR full visibility into what was asked and why.

ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS generated_questions text,
  ADD COLUMN IF NOT EXISTS screening_context jsonb,
  ADD COLUMN IF NOT EXISTS whatsapp_message_body text,
  ADD COLUMN IF NOT EXISTS gemini_prompt_used text;
