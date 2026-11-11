-- Hot-path indexes for the admin dashboard's biggest read patterns.
--
-- Context: the project exhausted its Disk IO budget on 11 Nov. The instance had
-- ~95% memory, so the Postgres page cache could not hold the working set and
-- every range COUNT(*) / list query fell through to disk. These indexes make the
-- common range scans cheap; the memory upgrade (compute) is what keeps them in
-- cache. All statements are idempotent.

-- Dashboard "created in the last day/week/month/year" counters.
CREATE INDEX IF NOT EXISTS idx_candidates_uploaded_at
  ON candidates (uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_applied_at
  ON applications (applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at
  ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_users_created_at
  ON internal_users (created_at DESC);

-- Outreach counters (total + per status) per range.
CREATE INDEX IF NOT EXISTS idx_outreach_messages_created_at
  ON outreach_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_status_created_at
  ON outreach_messages (status, created_at DESC);

-- Analytics explorer: recent events, optionally filtered by name.
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
  ON analytics_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_name_created_at
  ON analytics_events (event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_actor_created_at
  ON analytics_events (actor_auth_user_id, created_at DESC);

-- Candidate list: status filter + recency sort.
CREATE INDEX IF NOT EXISTS idx_candidates_status_uploaded_at
  ON candidates (status, uploaded_at DESC);

-- NOTE: after applying, refresh planner statistics. `ANALYZE` is safe inside a
-- migration; run `VACUUM (ANALYZE)` separately (outside a transaction) if the
-- tables have heavy dead-tuple bloat from repeated JSONB updates.
ANALYZE;
