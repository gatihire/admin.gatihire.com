-- Pipeline stage restructure (Phase 3 flow).
--   Applied → AI Screen → Pending HR Review → Shortlist (share-ready)
--   → Client Review (via share link) → Interview → Offer → Hired / Rejected
--
-- Legacy stages collapse into the new set:
--   phone_call    → ai_screen   (calls are now run by the AI screener)
--   screening     → hr_review   (call done → HR reviews the AI verdict/transcript)
--   human_review  → hr_review
-- `applications.status` has no DB CHECK constraint, so these are plain UPDATEs.

UPDATE public.applications SET status = 'ai_screen' WHERE status = 'phone_call';
UPDATE public.applications SET status = 'hr_review' WHERE status IN ('screening', 'human_review');