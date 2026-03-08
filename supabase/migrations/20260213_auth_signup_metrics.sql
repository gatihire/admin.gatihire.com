-- Helpers for Super Admin sign-up analytics (Supabase Auth users)
 
CREATE OR REPLACE FUNCTION public.count_auth_users_between(start_ts TIMESTAMPTZ, end_ts TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = auth, public
AS $$
  SELECT COUNT(*)
  FROM auth.users
  WHERE created_at >= start_ts
    AND created_at < end_ts;
$$;
