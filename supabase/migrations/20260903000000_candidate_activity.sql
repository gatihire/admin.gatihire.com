-- Activity timeline for candidates: logs every important event in the hiring pipeline
-- so HR can see a full history of interactions per candidate.

CREATE TABLE IF NOT EXISTS candidate_activity (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
  application_id UUID REFERENCES applications(id) ON DELETE SET NULL,
  participant_id UUID REFERENCES phone_screening_participants(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  event_data JSONB DEFAULT '{}'::jsonb,
  actor TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_activity_job ON candidate_activity(job_id);
CREATE INDEX IF NOT EXISTS idx_candidate_activity_candidate ON candidate_activity(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_activity_app ON candidate_activity(application_id);
CREATE INDEX IF NOT EXISTS idx_candidate_activity_created ON candidate_activity(created_at DESC);
