-- Add candidate_notes column to separate cover letters from recruiter notes
ALTER TABLE applications ADD COLUMN IF NOT EXISTS candidate_notes TEXT;

-- Migrate existing cover letter data from notes (content before first "---" delimiter or all if no delimiter)
UPDATE applications
SET candidate_notes = notes
WHERE candidate_notes IS NULL
  AND notes IS NOT NULL
  AND source = 'board-app';

-- Index for quick lookup of applications with candidate notes
CREATE INDEX IF NOT EXISTS idx_applications_candidate_notes
ON applications (job_id, candidate_id)
WHERE candidate_notes IS NOT NULL;
