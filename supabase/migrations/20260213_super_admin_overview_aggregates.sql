-- Fast aggregations for Super Admin overview

CREATE OR REPLACE FUNCTION public.count_rows_by_day(table_name text, ts_column text, start_ts timestamptz, end_ts timestamptz)
RETURNS TABLE(day date, count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY EXECUTE format(
    'SELECT date_trunc(''day'', %1$I)::date AS day, COUNT(*)::int AS count
     FROM %2$I
     WHERE %1$I >= $1 AND %1$I < $2
     GROUP BY 1
     ORDER BY 1',
    ts_column, table_name
  ) USING start_ts, end_ts;
END;
$$;

CREATE OR REPLACE FUNCTION public.count_events_by_day(event_name text, start_ts timestamptz, end_ts timestamptz)
RETURNS TABLE(day date, count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
  FROM public.analytics_events
  WHERE event_name = $1
    AND created_at >= $2
    AND created_at < $3
  GROUP BY 1
  ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION public.count_auth_users_by_day(start_ts timestamptz, end_ts timestamptz)
RETURNS TABLE(day date, count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = auth, public
AS $$
  SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
  FROM auth.users
  WHERE created_at >= $1
    AND created_at < $2
  GROUP BY 1
  ORDER BY 1;
$$;
