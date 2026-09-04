-- Backfill candidate_notes from notes for all applications
-- This ensures cover letters submitted before the candidate_notes column was added are visible

UPDATE applications
SET candidate_notes = regexp_replace(notes, '^Cover Letter: ', '')
WHERE candidate_notes IS NULL
  AND notes IS NOT NULL
  AND notes LIKE 'Cover Letter:%';

-- Also backfill any notes that look like cover letters (from board-app source)
UPDATE applications
SET candidate_notes = notes
WHERE candidate_notes IS NULL
  AND notes IS NOT NULL
  AND source = 'board-app'
  AND notes NOT LIKE 'Cover Letter:%'
  AND length(notes) > 50;  -- Likely a cover letter if longer than 50 chars
