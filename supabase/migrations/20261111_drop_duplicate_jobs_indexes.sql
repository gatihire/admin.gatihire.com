-- The Performance Advisor flagged three duplicate index pairs on `public.jobs`
-- (status, employment_type, shift_type). Each pair is byte-for-byte the same
-- definition, so Postgres maintains two b-trees for every INSERT/UPDATE/DELETE
-- and autovacuum twice. Dropping one of each keeps write cost down with no
-- change in query behaviour.
--
-- Kept:
--   idx_jobs_status_created (status, created_at DESC) — also serves plain
--   `status = ?` lookups via the leftmost prefix, so both single-column status
--   indexes are redundant.
--   idx_jobs_employment_type, idx_jobs_shift_type — the newer, consistently
--   named pair.
--
-- Idempotent: safe to run more than once.

DROP INDEX IF EXISTS public.jobs_status_idx;
DROP INDEX IF EXISTS public.idx_jobs_status;
DROP INDEX IF EXISTS public.jobs_employment_type_idx;
DROP INDEX IF EXISTS public.jobs_shift_type_idx;

-- Rebuild planner statistics after dropping indexes so the planner stops
-- costing plans against them. `ANALYZE` is transaction-safe.
ANALYZE public.jobs;
