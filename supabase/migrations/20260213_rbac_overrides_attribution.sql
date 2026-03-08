CREATE TABLE IF NOT EXISTS public.user_permissions (
  auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (auth_user_id, permission_id)
);

ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admin can manage user permissions" ON public.user_permissions
  FOR ALL USING (public.is_super_admin());

CREATE TABLE IF NOT EXISTS public.user_permission_field_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  allowed_fields TEXT[],
  denied_fields TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auth_user_id, permission_id, resource)
);

ALTER TABLE public.user_permission_field_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admin can manage user field rules" ON public.user_permission_field_rules
  FOR ALL USING (public.is_super_admin());

ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS uploaded_by_auth_user_id UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_candidates_uploaded_by_auth_user_id ON public.candidates(uploaded_by_auth_user_id);

ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_applications_created_by ON public.applications(created_by);

INSERT INTO public.permissions (key, description)
VALUES
  ('candidates.pii.view', 'View candidate email and phone'),
  ('candidates.salary.view', 'View candidate salary fields'),
  ('candidates.search', 'Use candidate smart search'),
  ('candidates.search-only', 'Search candidates without default listing')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.roles (name, description)
VALUES
  ('hr_executive', 'HR Executive operations'),
  ('intern', 'Limited access intern')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  'candidates.view','candidates.edit','jobs.view','jobs.post','jobs.edit',
  'applications.view','applications.manage','outreach.view','outreach.send','analytics.view','export.data',
  'candidates.pii.view','candidates.salary.view'
)
WHERE r.name = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  'candidates.view','candidates.edit','jobs.view','jobs.post','jobs.edit',
  'applications.view','applications.manage','outreach.view','outreach.send','analytics.view',
  'candidates.pii.view','candidates.salary.view'
)
WHERE r.name = 'hr_executive'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  'candidates.view','candidates.edit','jobs.view','jobs.post',
  'applications.view','outreach.view','outreach.send',
  'candidates.pii.view'
)
WHERE r.name = 'recruiter'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  'candidates.view','jobs.view','applications.view','outreach.view'
)
WHERE r.name = 'intern'
ON CONFLICT DO NOTHING;

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
  )
  OR EXISTS (
    SELECT 1
    FROM public.user_permissions up
    JOIN public.permissions p ON p.id = up.permission_id
    WHERE up.auth_user_id = auth.uid()
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
  FROM (
    SELECT rp.permission_id
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.auth_user_id = auth.uid()
    UNION
    SELECT up.permission_id
    FROM public.user_permissions up
    WHERE up.auth_user_id = auth.uid()
  ) x
  JOIN public.permissions p ON p.id = x.permission_id;
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
  WITH granted AS (
    SELECT rp.permission_id
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.auth_user_id = auth.uid()
    UNION
    SELECT up.permission_id
    FROM public.user_permissions up
    WHERE up.auth_user_id = auth.uid()
  )
  SELECT
    p.key,
    COALESCE(ufr.resource, pfr.resource) AS resource,
    COALESCE(ufr.allowed_fields, pfr.allowed_fields) AS allowed_fields,
    COALESCE(ufr.denied_fields, pfr.denied_fields) AS denied_fields
  FROM granted g
  JOIN public.permissions p ON p.id = g.permission_id
  LEFT JOIN public.permission_field_rules pfr ON pfr.permission_id = p.id
  LEFT JOIN public.user_permission_field_rules ufr
    ON ufr.permission_id = p.id
   AND ufr.auth_user_id = auth.uid()
   AND (pfr.resource IS NULL OR ufr.resource = pfr.resource)
  WHERE COALESCE(ufr.resource, pfr.resource) IS NOT NULL;
$$;
