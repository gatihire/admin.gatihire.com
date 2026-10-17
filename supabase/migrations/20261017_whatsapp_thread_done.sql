-- WhatsApp inbox: "Done" (a thread the team has handled) ----------------------
--
-- The inbox needs a way to clear a conversation the team has dealt with, the
-- same way the Today board does (public.work_item_states.done_at). Marking a
-- thread done must not lose work: it hides the thread only until something new
-- happens on it. A later reply — anything that moves last_activity_at past the
-- mark — brings it straight back.
--
-- !! Mirrors the Today board's `done_at`. Keep the two in step. !!
-- The `done` test below is also mirrored in lib/dispatch/conversations.ts so the
-- Node fallback behaves the same once this is applied.

-- 1. Per-thread operator state ------------------------------------------------
-- One row per participant, only written when the team does something. Absence of
-- a row (or a null done_at) means "not done".
create table if not exists public.whatsapp_thread_states (
  participant_id uuid primary key
    references public.phone_screening_participants(id) on delete cascade,
  done_at timestamptz,
  done_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_thread_states enable row level security;
-- No policies on purpose: only the service role (the API) touches this table.

create index if not exists idx_wts_done
  on public.whatsapp_thread_states (participant_id)
  where done_at is not null;

-- 2. The view the inbox reads (redefined to hide done threads) -----------------
-- The column list is unchanged; only the WHERE gains the "not done" test, so
-- callers (and PostgREST) need no change. `done_at >= last_activity_at` means
-- "marked done since the last thing that happened"; new activity moves
-- last_activity_at forward and the thread reappears.
create or replace view public.whatsapp_threads
with (security_invoker = true)
as
select
  p.id as participant_id,
  p.job_id,
  p.candidate_id,
  p.status as participant_status,
  p.whatsapp_reply_text,
  p.whatsapp_reply_at,
  p.whatsapp_sent_at,
  public.whatsapp_candidate_reply_text(p.whatsapp_reply_text, p.whatsapp_response) as reply_text,
  coalesce(p.outreach_nudge_count, 0) as nudge_count,
  c.name as candidate_name,
  j.title as job_title,
  j.client_name,
  greatest(p.whatsapp_reply_at, p.whatsapp_sent_at, p.updated_at) as last_activity_at,
  public.whatsapp_thread_category(
    p.status, p.whatsapp_response, p.whatsapp_reply_text,
    p.whatsapp_reply_at, p.whatsapp_sent_at, p.updated_at,
    p.outreach_nudge_count, p.needs_manual_followup
  ) as category,
  public.whatsapp_thread_unread(
    p.whatsapp_response, p.whatsapp_reply_text, p.whatsapp_reply_at, p.whatsapp_sent_at
  ) as unread
from public.phone_screening_participants p
left join public.candidates c on c.id = p.candidate_id
left join public.jobs j on j.id = p.job_id
left join public.whatsapp_thread_states s on s.participant_id = p.id
where public.whatsapp_thread_has_activity(
        p.whatsapp_reply_text, p.whatsapp_response, p.whatsapp_reply_at, p.whatsapp_sent_at
      )
  and not (
    s.done_at is not null
    and s.done_at >= greatest(p.whatsapp_reply_at, p.whatsapp_sent_at, p.updated_at)
  );

-- 3. Counts function (redefined to hide done threads) --------------------------
create or replace function public.whatsapp_inbox_counts()
returns jsonb
language sql
stable
as $$
  with t as (
    select
      public.whatsapp_thread_category(
        p.status, p.whatsapp_response, p.whatsapp_reply_text,
        p.whatsapp_reply_at, p.whatsapp_sent_at, p.updated_at,
        p.outreach_nudge_count, p.needs_manual_followup
      ) as category,
      public.whatsapp_thread_unread(
        p.whatsapp_response, p.whatsapp_reply_text, p.whatsapp_reply_at, p.whatsapp_sent_at
      ) as unread
    from public.phone_screening_participants p
    where public.whatsapp_thread_has_activity(
            p.whatsapp_reply_text, p.whatsapp_response, p.whatsapp_reply_at, p.whatsapp_sent_at
          )
      and not exists (
        select 1
        from public.whatsapp_thread_states s
        where s.participant_id = p.id
          and s.done_at is not null
          and s.done_at >= greatest(p.whatsapp_reply_at, p.whatsapp_sent_at, p.updated_at)
      )
  )
  select jsonb_build_object(
    'total', count(*),
    'unread', count(*) filter (where unread),
    'needs_human', count(*) filter (where category = 'needs_human'),
    'needs_reply', count(*) filter (where category = 'needs_reply'),
    'declined', count(*) filter (where category = 'declined'),
    'no_reply', count(*) filter (where category = 'no_reply'),
    'other', count(*) filter (where category = 'other')
  )
  from t;
$$;

-- 4. Grants + schema reload ----------------------------------------------------
grant select, insert, update, delete on public.whatsapp_thread_states to service_role;
grant execute on function public.whatsapp_inbox_counts() to authenticated, service_role;

notify pgrst, 'reload schema';
