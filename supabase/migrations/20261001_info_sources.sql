-- Per-field provenance for phone-screening candidate info.
--
-- Why: phone_screening_participants.info_data is a flat JSONB blob that mixes
-- values the candidate typed into the talent-portal apply form with values they
-- later typed on WhatsApp. The UI rendered every non-empty key as "Confirmed by
-- the candidate on WhatsApp", which was false for portal applicants — the value
-- came from their own application, hours earlier.
--
-- info_sources maps field key -> provenance, written by the same code that
-- writes info_data:
--   "application"  seeded from candidates.* when the campaign was created
--                  (talent-portal apply form / candidate profile)
--   "whatsapp"     supplied by the candidate in a WhatsApp Flow or free text
--   "resume"       trusted from the parsed resume; never asked on WhatsApp
--
-- Shape: { "current_ctc": "whatsapp", "willing_to_relocate": "application" }
--
-- Default '{}' keeps existing rows valid; surfaces fall back to inferring a
-- source when a key is missing here, so this migration is safe to deploy
-- before the code that writes it.

ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS info_sources jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN phone_screening_participants.info_sources IS
  'Per-field provenance for info_data: application | whatsapp | resume.';

-- Backs the HR queue "AI suggests not suitable" — the newest needs_review rows
-- first. Partial so it stays small: the AI gate means rejected-suggestions are a
-- small minority of a table that also holds every waiting/completed row.
CREATE INDEX IF NOT EXISTS idx_psp_needs_review_recent
  ON phone_screening_participants (updated_at DESC)
  WHERE status = 'needs_review';
