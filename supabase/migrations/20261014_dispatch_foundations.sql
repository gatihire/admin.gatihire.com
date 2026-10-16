-- Dispatch foundations: job ownership/assignment, work-item operator state, and
-- attributable candidate activity.
--
-- Why this exists:
--   * `jobs` had `created_by` but no owner, so "assign this opening to the
--     concerned person" and a per-person Today queue were impossible. The
--     prototype's `j.rec` / `j.am` (recruiter / account manager) had no
--     counterpart in the schema.
--   * The Today "Candidates waiting on you" queue is *derived* from live
--     pipeline state by `lib/dispatch/engine.ts`. The only thing the engine
--     cannot infer is an operator's own choice to snooze an item or to log a
--     call they placed by hand — that lives in `work_item_states`.
--   * `candidate_activity.actor` was free text, so "who did what, today or over
--     any date range" could not be attributed to an internal user. Adding
--     `actor_auth_user_id` makes the activity log the attribution source.

-- 1. Job ownership + collaborators ------------------------------------------------
alter table public.jobs
  add column if not exists owner_auth_user_id uuid references auth.users(id) on delete set null;

create index if not exists idx_jobs_owner on public.jobs(owner_auth_user_id);

-- Many-to-many collaborators. `jobs.owner_auth_user_id` is the primary assignee
-- ("the concerned person"); this table lets others work the same opening.
create table if not exists public.job_assignees (
  job_id uuid not null references public.jobs(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'collaborator' check (role in ('owner', 'collaborator', 'viewer')),
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (job_id, auth_user_id)
);

create index if not exists idx_job_assignees_user on public.job_assignees(auth_user_id);

-- Backfill: whoever created a job owns it until a Super Admin reassigns it, so
-- existing openings are not orphaned on day one. Guarded on auth.users because
-- `jobs.created_by` has no FK and may hold stale ids, which would make the new
-- FK on `owner_auth_user_id` reject the whole update.
update public.jobs j
set owner_auth_user_id = j.created_by
from auth.users u
where j.owner_auth_user_id is null
  and j.created_by is not null
  and u.id = j.created_by;

-- 2. Operator state on derived queue rows ------------------------------------------
-- One row per application, only written when a human snoozes or logs a manual
-- call. Absence of a row means "no operator overrides".
create table if not exists public.work_item_states (
  application_id uuid primary key references public.applications(id) on delete cascade,
  snoozed_until timestamptz,
  snooze_reason text,
  last_manual_call_at timestamptz,
  last_manual_call_outcome text,
  last_manual_call_note text,
  assigned_auth_user_id uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_work_item_states_snoozed
  on public.work_item_states(snoozed_until)
  where snoozed_until is not null;

-- 3. Attributable activity ----------------------------------------------------------
-- `actor` (text) stays for back-compat/display; `actor_auth_user_id` is the join
-- key the metrics use.
alter table public.candidate_activity
  add column if not exists actor_auth_user_id uuid references auth.users(id) on delete set null;

create index if not exists idx_candidate_activity_actor
  on public.candidate_activity(actor_auth_user_id, created_at desc);

-- 4. New permission keys ------------------------------------------------------------
insert into public.permissions (key, description)
values
  ('dispatch.view', 'View the Today dispatch queue for assigned work'),
  ('dispatch.view.team', 'View the whole team''s dispatch queue'),
  ('jobs.assign', 'Assign or reassign a job opening to an internal user'),
  ('jobs.claim', 'Claim an unassigned job opening')
on conflict (key) do nothing;

-- Everyone who works the pipeline sees their own queue and can claim work.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in ('dispatch.view', 'jobs.claim')
where r.name in ('super_admin', 'admin', 'recruiter', 'hr_executive')
on conflict do nothing;

-- Only admins manage assignment and see the team-wide queue.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in ('dispatch.view.team', 'jobs.assign')
where r.name in ('super_admin', 'admin')
on conflict do nothing;

-- 5. Row level security -------------------------------------------------------------
-- Mirrors the existing pattern: service-role routes do the scoping; these
-- policies keep the anon/authenticated roles from reading raw rows directly.
alter table public.job_assignees enable row level security;
alter table public.work_item_states enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'job_assignees' and policyname = 'Internal staff can read job assignees'
  ) then
    create policy "Internal staff can read job assignees" on public.job_assignees
      for select using (public.has_permission('applications.view') or public.has_permission('jobs.view'));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'job_assignees' and policyname = 'Admins can manage job assignees'
  ) then
    create policy "Admins can manage job assignees" on public.job_assignees
      for all using (public.is_super_admin() or public.has_permission('jobs.assign'));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'work_item_states' and policyname = 'Internal staff can read work item states'
  ) then
    create policy "Internal staff can read work item states" on public.work_item_states
      for select using (public.has_permission('applications.view') or public.has_permission('dispatch.view'));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'work_item_states' and policyname = 'Internal staff can manage work item states'
  ) then
    create policy "Internal staff can manage work item states" on public.work_item_states
      for all using (public.has_permission('applications.manage') or public.has_permission('dispatch.view'));
  end if;
end $$;
