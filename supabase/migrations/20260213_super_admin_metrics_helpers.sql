-- Helpers for Super Admin analytics queries
 
CREATE OR REPLACE FUNCTION public.count_distinct_event_actors_between(start_ts TIMESTAMPTZ, end_ts TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(DISTINCT actor_auth_user_id)
  FROM public.analytics_events
  WHERE actor_auth_user_id IS NOT NULL
    AND created_at >= start_ts
    AND created_at < end_ts;
$$;
