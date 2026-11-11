-- The Performance Advisor flagged duplicate indexes on `public.jobs`
-- (status, employment_type, shift_type). Each pair has the same definition, so
-- Postgres maintains two b-trees for every INSERT/UPDATE/DELETE and autovacuum
-- twice. Keeping one of each reduces write IO with no change in query plans.
--
-- Safety rule used here: never drop an index unless a covering replacement is
-- confirmed to exist. Older projects may be missing either migration, and
-- dropping both halves of a pair would silently make job filters sequential.
--
-- Idempotent: safe to run more than once.

DO $$
DECLARE
  has_composite_status boolean := to_regclass('public.idx_jobs_status_created') IS NOT NULL;
  has_status           boolean := to_regclass('public.idx_jobs_status') IS NOT NULL;
  has_employment       boolean := to_regclass('public.idx_jobs_employment_type') IS NOT NULL;
  has_shift            boolean := to_regclass('public.idx_jobs_shift_type') IS NOT NULL;
BEGIN
  -- STATUS
  -- (status, created_at DESC) serves plain `status = ?` through its leftmost
  -- prefix, so both single-column status indexes are redundant when it exists.
  IF has_composite_status THEN
    DROP INDEX IF EXISTS public.jobs_status_idx;
    DROP INDEX IF EXISTS public.idx_jobs_status;
  ELSIF has_status THEN
    -- No composite: keep exactly one single-column status index.
    DROP INDEX IF EXISTS public.jobs_status_idx;
  END IF;

  -- EMPLOYMENT TYPE
  IF has_employment THEN
    DROP INDEX IF EXISTS public.jobs_employment_type_idx;
  END IF;

  -- SHIFT TYPE
  IF has_shift THEN
    DROP INDEX IF EXISTS public.jobs_shift_type_idx;
  END IF;
END $$;

-- Refresh planner statistics after dropping indexes so plans stop costing them.
-- `ANALYZE` is transaction-safe (unlike VACUUM).
ANALYZE public.jobs;
