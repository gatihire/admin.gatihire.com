INSERT INTO public.roles (name, description)
VALUES
  ('candidate_viewer', 'Can view candidates without PII')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  'candidates.view'
)
WHERE r.name = 'candidate_viewer'
ON CONFLICT DO NOTHING;

