-- Outreach / fit / shortlist-email flow (founder's WhatsApp-context design).
-- 1. Participant statuses for the WhatsApp opt-in funnel (interested,
--    needs_manual_followup) + outreach tracking columns.
-- 2. candidate_job_fit — Gemini CV-vs-JD analysis (score + pros/misses/probes).
-- 3. jobs — email CC fields for the client shortlist email.
-- 4. sourcing_analytics — source × job category → stage counts.

-- 1. phone_screening_participants — widen status + outreach tracking
alter table phone_screening_participants
  drop constraint if exists phone_screening_participants_status_check;

alter table phone_screening_participants
  add constraint phone_screening_participants_status_check check (
    status in (
      'pending', 'whatsapp_sent', 'whatsapp_delivered', 'whatsapp_read',
      'interested', 'call_me_now', 'scheduled', 'call_scheduled',
      'calling', 'in_progress', 'completed', 'failed',
      'not_interested', 'unreachable', 'rescheduled', 'needs_manual_followup'
    )
  );

alter table phone_screening_participants
  add column if not exists outreach_nudge_count int not null default 0,
  add column if not exists needs_manual_followup boolean not null default false,
  add column if not exists interested_at timestamptz;

-- 2. Candidate × job AI fit analysis (Step 3)
create table if not exists public.candidate_job_fit (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  fit_score int,
  fit_json jsonb,
  summary text,
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(job_id, candidate_id)
);

-- 3. Shortlist email CC recipients (Tzy recruiter + account manager)
alter table jobs
  add column if not exists recruiter_email text,
  add column if not exists account_manager_email text;

-- 4. Sourcing analytics: source × job category → stage counts (last 90 days)
create or replace function public.sourcing_analytics(from_ts timestamptz default now() - interval '90 days')
returns table (
  source text,
  job_category text,
  applied bigint,
  shortlisted bigint,
  interviewed bigint,
  hired bigint
)
language sql stable
as $$
  select
    a.source,
    coalesce(j.role_category, 'unknown') as job_category,
    count(*) as applied,
    count(*) filter (where a.status = 'shortlist') as shortlisted,
    count(*) filter (where a.status in ('interview', 'offer')) as interviewed,
    count(*) filter (where a.status = 'hired') as hired
  from applications a
  left join jobs j on j.id = a.job_id
  where a.created_at >= from_ts
    and a.source is not null
    and a.source <> ''
  group by 1, 2
  order by 1, 2;
$$;
