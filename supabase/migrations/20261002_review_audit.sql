-- Human review audit trail for AI-screened candidates.
--
-- Why: the AI prescreen may flag a candidate as "not a fit", but that is advice,
-- not a decision. Someone has to decide, and later someone has to be able to
-- answer "who passed on this candidate, when, and why".
--
-- review_status / reviewed_by / reviewed_at / review_note were already added by
-- 20260802_call_pipeline.sql, but the endpoint that actually handles AI-flagged
-- candidates (app/api/phone-screening/review) never wrote them — it only set
-- status and prescreen_decision. So the columns existed and stayed empty, and
-- reviewed_at was read by no UI.
--
-- Added here:
--   ai_suggests_rejection    the AI's recommendation, lifted out of screening_context
--                            so it is queryable ("show me everything the AI
--                            wanted to reject that a human overrode")
--   clarification_*          the "ask the candidate a question" outcome. There was
--                            no way to express it before: the only options were
--                            approve (books a call) or reject (tells the candidate
--                            it's not a fit).
--
-- prescreen_decision / prescreen_reason already exist (20260905000001).

ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS ai_suggests_rejection BOOLEAN,
  ADD COLUMN IF NOT EXISTS ai_suggests_rejection_at TIMESTAMPTZ;

-- What HR asked, and whether the candidate came back with an answer. A stale
-- clarification (asked_at set, answered_at null) is what the UI uses to warn
-- that a question is still outstanding.
ALTER TABLE phone_screening_participants
  ADD COLUMN IF NOT EXISTS clarification_question TEXT,
  ADD COLUMN IF NOT EXISTS clarification_asked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clarification_answered_at TIMESTAMPTZ;

COMMENT ON COLUMN phone_screening_participants.ai_suggests_rejection IS
  'AI pre-screen advisory only. A human decision is still required; never treat this as a rejection.';
COMMENT ON COLUMN phone_screening_participants.clarification_question IS
  'Question HR asked the candidate before deciding. Null when no question is outstanding.';

-- Backfill the advisory flag from screening_context for rows the webhook already
-- flagged, so the new column agrees with the data the UI has been reading.
-- Scoped to participants that have no human decision recorded yet.
UPDATE phone_screening_participants
SET ai_suggests_rejection = (screening_context->>'aiSuggestsRejection')::boolean,
    ai_suggests_rejection_at = COALESCE(
      NULLIF(screening_context->>'aiSuggestsRejectionAt', '')::timestamptz,
      updated_at
    )
WHERE screening_context ? 'aiSuggestsRejection'
  AND ai_suggests_rejection IS NULL;

-- The HR queue: pending decisions, newest first.
CREATE INDEX IF NOT EXISTS idx_psp_awaiting_hr_review
  ON phone_screening_participants (updated_at DESC)
  WHERE review_status = 'pending' AND status = 'needs_review';
