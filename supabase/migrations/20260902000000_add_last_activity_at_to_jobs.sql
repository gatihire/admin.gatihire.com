-- Add last_activity_at to jobs for stale-job detection on the /jobs listing page.
-- Updated by triggers on applications, phone_screening_participants, and shortlist_share_candidates.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_activity_at timestamptz DEFAULT now();

-- Back-fill from the most recent application per job
UPDATE jobs j
SET last_activity_at = COALESCE(
  (SELECT MAX(a.created_at) FROM applications a WHERE a.job_id = j.id),
  j.created_at
);

-- Trigger: when a new application arrives, touch the job
CREATE OR REPLACE FUNCTION touch_job_on_application() RETURNS trigger AS $$
BEGIN
  UPDATE jobs SET last_activity_at = now() WHERE id = NEW.job_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_job_on_application ON applications;
CREATE TRIGGER trg_touch_job_on_application
  AFTER INSERT ON applications
  FOR EACH ROW EXECUTE FUNCTION touch_job_on_application();

-- Trigger: when a screening participant status changes, touch the job
CREATE OR REPLACE FUNCTION touch_job_on_participant() RETURNS trigger AS $$
DECLARE
  v_job_id uuid;
BEGIN
  SELECT job_id INTO v_job_id FROM phone_screening_campaigns WHERE id = NEW.campaign_id;
  IF v_job_id IS NOT NULL THEN
    UPDATE jobs SET last_activity_at = now() WHERE id = v_job_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_job_on_participant ON phone_screening_participants;
CREATE TRIGGER trg_touch_job_on_participant
  AFTER INSERT OR UPDATE ON phone_screening_participants
  FOR EACH ROW EXECUTE FUNCTION touch_job_on_participant();
