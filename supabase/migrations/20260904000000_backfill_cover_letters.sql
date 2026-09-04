-- Backfill candidate_notes from notes for all applications
-- This ensures cover letters submitted before the candidate_notes column was added are visible

-- 1. Copy cover letters from notes to candidate_notes (remove "Cover Letter: " prefix)
UPDATE applications
SET candidate_notes = regexp_replace(notes, '^Cover Letter: ', '')
WHERE candidate_notes IS NULL
  AND notes IS NOT NULL
  AND notes LIKE 'Cover Letter:%';

-- 2. Also backfill any notes that look like cover letters (from board-app source)
UPDATE applications
SET candidate_notes = notes
WHERE candidate_notes IS NULL
  AND notes IS NOT NULL
  AND source = 'board-app'
  AND notes NOT LIKE 'Cover Letter:%'
  AND length(notes) > 50;  -- Likely a cover letter if longer than 50 chars

-- 3. Clear the notes field for applications where we moved cover letters to candidate_notes
-- This prevents cover letters from showing in the Recruiter Notes section
UPDATE applications
SET notes = NULL
WHERE candidate_notes IS NOT NULL
  AND candidate_notes != ''
  AND (notes LIKE 'Cover Letter:%' OR (source = 'board-app' AND length(notes) > 50));
