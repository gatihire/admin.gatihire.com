-- RBAC + analytics foundations for Super Admin / internal staff
-- Notes:
-- - Uses Supabase Auth (auth.users) as the source of truth for credentials.
-- - Field-level access is enforced at the API layer using permission_field_rules.
-- - RLS protects RBAC tables; server routes can use service role for admin operations.
 
CREATE EXTENSION IF NOT EXISTS pgcrypto;
 
-- INTERNAL USERS (profile on top of auth.users)
CREATE TABLE IF NOT EXISTS public.internal_users (
  auth_user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ
);
 
ALTER TABLE public.internal_users ENABLE ROW LEVEL SECURITY;
 
CREATE POLICY "Internal users can read their profile" ON public.internal_users
  FOR SELECT USING (auth.uid() = auth_user_id);
 
CREATE POLICY "Internal users can insert their profile" ON public.internal_users
  FOR INSERT WITH CHECK (auth.uid() = auth_user_id);
 
CREATE POLICY "Internal users can update their profile" ON public.internal_users
  FOR UPDATE USING (auth.uid() = auth_user_id)
  WITH CHECK (auth.uid() = auth_user_id);
 
-- RBAC TABLES
CREATE TABLE IF NOT EXISTS public.roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
 
CREATE TABLE IF NOT EXISTS public.permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  description TEXT
);
 
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
 
CREATE TABLE IF NOT EXISTS public.user_roles (
  auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  PRIMARY KEY (auth_user_id, role_id)
);
 
-- Field-level rules tied to a permission (used by API layer to filter response fields/UI)
CREATE TABLE IF NOT EXISTS public.permission_field_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  allowed_fields TEXT[],
  denied_fields TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (permission_id, resource)
);
 
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_field_rules ENABLE ROW LEVEL SECURITY;
 
-- RBAC helper functions
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.auth_user_id = auth.uid()
      AND r.name = 'super_admin'
  );
$$;
 
CREATE POLICY "Super admin can manage internal users" ON public.internal_users
  FOR ALL USING (public.is_super_admin());
 
CREATE OR REPLACE FUNCTION public.has_permission(permission_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.auth_user_id = auth.uid()
      AND p.key = permission_key
  );
$$;
 
CREATE OR REPLACE FUNCTION public.current_user_permission_keys()
RETURNS TABLE (permission_key TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT p.key
  FROM public.user_roles ur
  JOIN public.role_permissions rp ON rp.role_id = ur.role_id
  JOIN public.permissions p ON p.id = rp.permission_id
  WHERE ur.auth_user_id = auth.uid();
$$;
 
CREATE OR REPLACE FUNCTION public.current_user_field_rules()
RETURNS TABLE (
  permission_key TEXT,
  resource TEXT,
  allowed_fields TEXT[],
  denied_fields TEXT[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.key,
    r.resource,
    r.allowed_fields,
    r.denied_fields
  FROM public.user_roles ur
  JOIN public.role_permissions rp ON rp.role_id = ur.role_id
  JOIN public.permissions p ON p.id = rp.permission_id
  LEFT JOIN public.permission_field_rules r ON r.permission_id = p.id
  WHERE ur.auth_user_id = auth.uid();
$$;
 
-- Only Super Admin can manage RBAC objects
CREATE POLICY "Super admin can manage roles" ON public.roles
  FOR ALL USING (public.is_super_admin());
 
CREATE POLICY "Super admin can manage permissions" ON public.permissions
  FOR ALL USING (public.is_super_admin());
 
CREATE POLICY "Super admin can manage role permissions" ON public.role_permissions
  FOR ALL USING (public.is_super_admin());
 
CREATE POLICY "Super admin can manage user roles" ON public.user_roles
  FOR ALL USING (public.is_super_admin());
 
CREATE POLICY "Super admin can manage field rules" ON public.permission_field_rules
  FOR ALL USING (public.is_super_admin());
 
-- Helper function to grant roles (Super Admin or service_role only)
CREATE OR REPLACE FUNCTION public.grant_role_to_user(target_auth_user_id UUID, role_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_role_id UUID;
BEGIN
  IF NOT (public.is_super_admin() OR auth.role() = 'service_role') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
 
  SELECT id INTO target_role_id FROM public.roles WHERE name = role_name;
  IF target_role_id IS NULL THEN
    RAISE EXCEPTION 'role_not_found';
  END IF;
 
  INSERT INTO public.user_roles (auth_user_id, role_id)
  VALUES (target_auth_user_id, target_role_id)
  ON CONFLICT DO NOTHING;
END;
$$;
 
-- ANALYTICS EVENTS
CREATE TABLE IF NOT EXISTS public.analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
 
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON public.analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_actor ON public.analytics_events(actor_auth_user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_name ON public.analytics_events(event_name);
 
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
 
CREATE POLICY "Super admin can read analytics events" ON public.analytics_events
  FOR SELECT USING (public.is_super_admin());
 
CREATE POLICY "Internal users can insert analytics events for themselves" ON public.analytics_events
  FOR INSERT WITH CHECK (actor_auth_user_id = auth.uid());
 
-- Optional daily aggregation table (kept simple; can be backfilled later)
CREATE TABLE IF NOT EXISTS public.analytics_daily (
  day DATE NOT NULL,
  event_name TEXT NOT NULL,
  actor_auth_user_id UUID,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event_name, actor_auth_user_id)
);
 
ALTER TABLE public.analytics_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Super admin can read daily analytics" ON public.analytics_daily
  FOR SELECT USING (public.is_super_admin());
 
-- Tie outreach to internal users for per-user performance
ALTER TABLE public.outreach_messages
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);
 
CREATE INDEX IF NOT EXISTS idx_outreach_created_by ON public.outreach_messages(created_by);
 
-- Seed base roles and permissions
INSERT INTO public.roles (name, description)
VALUES
  ('super_admin', 'Full access to internal analytics and access control'),
  ('admin', 'Admin access to core operations'),
  ('recruiter', 'Recruiting operations (jobs, candidates, outreach)'),
  ('viewer', 'Read-only access')
ON CONFLICT (name) DO NOTHING;
 
INSERT INTO public.permissions (key, description)
VALUES
  ('analytics.view', 'View analytics dashboards'),
  ('users.manage', 'Manage internal users'),
  ('roles.manage', 'Manage roles and permissions'),
  ('candidates.view', 'View candidates'),
  ('candidates.edit', 'Edit candidates'),
  ('jobs.view', 'View jobs'),
  ('jobs.post', 'Create jobs'),
  ('jobs.edit', 'Edit jobs'),
  ('applications.view', 'View applications'),
  ('applications.manage', 'Manage applications'),
  ('outreach.view', 'View outreach'),
  ('outreach.send', 'Send outreach'),
  ('export.data', 'Export data')
ON CONFLICT (key) DO NOTHING;
 
-- Assign permissions to default roles
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  'analytics.view','users.manage','roles.manage','candidates.view','candidates.edit',
  'jobs.view','jobs.post','jobs.edit','applications.view','applications.manage',
  'outreach.view','outreach.send','export.data'
)
WHERE r.name = 'super_admin'
ON CONFLICT DO NOTHING;
 
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  'analytics.view','candidates.view','candidates.edit','jobs.view','jobs.post','jobs.edit',
  'applications.view','applications.manage','outreach.view','outreach.send','export.data'
)
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;
 
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  'candidates.view','jobs.view','jobs.post','applications.view','outreach.view','outreach.send'
)
WHERE r.name = 'recruiter'
ON CONFLICT DO NOTHING;
 
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  'candidates.view','jobs.view','applications.view','outreach.view'
)
WHERE r.name = 'viewer'
ON CONFLICT DO NOTHING;
