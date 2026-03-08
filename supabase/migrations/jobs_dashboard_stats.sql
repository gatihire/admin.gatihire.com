CREATE OR REPLACE FUNCTION public.jobs_dashboard_stats(job_ids UUID[])
RETURNS TABLE (
  job_id UUID,
  applications_total BIGINT,
  applications_pending BIGINT,
  matches_total BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ids.id AS job_id,
    COALESCE(apps.applications_total, 0) AS applications_total,
    COALESCE(apps.applications_pending, 0) AS applications_pending,
    COALESCE(matches.matches_total, 0) AS matches_total
  FROM UNNEST(job_ids) AS ids(id)
  LEFT JOIN (
    SELECT
      a.job_id,
      COUNT(*)::BIGINT AS applications_total,
      COUNT(*) FILTER (WHERE a.status = 'applied')::BIGINT AS applications_pending
    FROM public.applications a
    WHERE a.job_id = ANY(job_ids)
    GROUP BY a.job_id
  ) apps ON apps.job_id = ids.id
  LEFT JOIN (
    SELECT
      jm.job_id,
      COUNT(*)::BIGINT AS matches_total
    FROM public.job_matches jm
    WHERE jm.job_id = ANY(job_ids)
    GROUP BY jm.job_id
  ) matches ON matches.job_id = ids.id;
$$;

GRANT EXECUTE ON FUNCTION public.jobs_dashboard_stats(UUID[]) TO authenticated;
