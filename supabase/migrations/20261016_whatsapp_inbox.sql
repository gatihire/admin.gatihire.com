-- WhatsApp inbox: server-side thread classification.
--
-- Why this exists:
--   * The inbox (app/(internal)/whatsapp) lists one row per WhatsApp thread and
--     is read on every visit *and* on every page load for the sidebar badge.
--     Classifying in Node meant reading every phone_screening_participants row
--     and computing a category per row in memory, then shipping all of them.
--     That cost grows with the whole table, on every request. It does not scale.
--   * PostgREST cannot express the rules itself: the "answered?" test compares
--     two columns (`whatsapp_reply_at > whatsapp_sent_at`), and the category is a
--     CASE over several fields — neither is expressible as a PostgREST filter,
--     and there is no "GROUP BY a computed column" to get counts. So the rules
--     live in SQL functions, the inbox reads a view, and the badge reads a
--     counts function. Counts become one indexed aggregate instead of a full
--     table read plus JSON serialisation.
--
-- !! The rules below MUST mirror lib/dispatch/conversations.ts. !!
-- They are the same decisions (needs_human -> needs_reply -> declined ->
-- no_reply -> other) written twice, because they are needed on both sides of
-- the TS/SQL boundary. If you change one, change the other.

-- 1. Flow-form detection -------------------------------------------------------
-- `whatsapp_reply_text`/`whatsapp_response` sometimes hold the AI flow's raw JSON
-- form body rather than something the candidate typed; that is never a "reply".
create or replace function public.whatsapp_is_flow_json(raw text)
returns boolean
language plpgsql
immutable
as $$
begin
  if raw is null or left(btrim(raw), 1) <> '{' then
    return false;
  end if;
  -- Raise on invalid JSON, then treat the exception as "not flow JSON".
  perform btrim(raw)::jsonb;
  return true;
exception when others then
  return false;
end;
$$;

-- 2. The candidate's own words ------------------------------------------------
-- Mirrors candidateReplyText(): the free-text reply if there is one, else a
-- non-intent whatsapp_response. Human-intent taps and "not_interested" are not
-- "text" — they are handled as their own signals.
create or replace function public.whatsapp_candidate_reply_text(p_reply_text text, p_response text)
returns text
language sql
immutable
as $$
  select coalesce(
    case
      when nullif(btrim(coalesce(p_reply_text, '')), '') is not null
        and not public.whatsapp_is_flow_json(p_reply_text)
      then btrim(p_reply_text)
    end,
    case
      when nullif(btrim(coalesce(p_response, '')), '') is not null
        and lower(btrim(p_response)) not in ('call_me_now', 'schedule', 'call', 'callback', 'not_interested')
        and not public.whatsapp_is_flow_json(p_response)
      then btrim(p_response)
    end
  );
$$;

-- 3. Did anything happen on this thread at all? -------------------------------
create or replace function public.whatsapp_thread_has_activity(
  p_reply_text text,
  p_response text,
  p_reply_at timestamptz,
  p_sent_at timestamptz
) returns boolean
language sql
immutable
as $$
  select p_sent_at is not null
      or p_reply_at is not null
      or public.whatsapp_candidate_reply_text(p_reply_text, p_response) is not null
      or nullif(btrim(coalesce(p_response, '')), '') is not null;
$$;

-- 4. Unread = still waiting on us ---------------------------------------------
-- Mirrors isUnread(): an unanswered reply, or an explicit request for a person.
create or replace function public.whatsapp_thread_unread(
  p_response text,
  p_reply_text text,
  p_reply_at timestamptz,
  p_sent_at timestamptz
) returns boolean
language sql
immutable
as $$
  select
    lower(coalesce(p_response, '')) in ('call_me_now', 'schedule', 'call', 'callback')
    or (
      public.whatsapp_candidate_reply_text(p_reply_text, p_response) is not null
      and (p_reply_at is null or p_sent_at is null or p_reply_at > p_sent_at)
    );
$$;

-- 5. The category ---------------------------------------------------------------
-- Mirrors classifyConversation(). First matching rule wins.
create or replace function public.whatsapp_thread_category(
  p_status text,
  p_response text,
  p_reply_text text,
  p_reply_at timestamptz,
  p_sent_at timestamptz,
  p_updated_at timestamptz,
  p_nudge_count int,
  p_needs_followup boolean
) returns text
language sql
stable
as $$
  select case
    -- A person specifically: an explicit button intent, or the screen held it.
    when coalesce(p_needs_followup, false)
      or lower(coalesce(p_response, '')) in ('call_me_now', 'schedule', 'call', 'callback')
      or lower(coalesce(p_status, '')) in ('needs_review', 'needs_manual_followup')
      then 'needs_human'

    -- Something they typed that we have not answered: inbound newer than our
    -- last outbound. Missing timestamps are treated as unanswered, matching
    -- hasUnansweredReply().
    when public.whatsapp_candidate_reply_text(p_reply_text, p_response) is not null
      and (p_reply_at is null or p_sent_at is null or p_reply_at > p_sent_at)
      then 'needs_reply'

    when lower(coalesce(p_status, '')) = 'not_interested'
      or lower(coalesce(p_response, '')) = 'not_interested'
      then 'declined'

    -- We sent, nothing came back, and it has gone cold. Repeated nudges count
    -- even inside the freshness window, matching isGhostedThread().
    when public.whatsapp_candidate_reply_text(p_reply_text, p_response) is null
      and p_sent_at is not null
      and lower(coalesce(p_status, '')) in ('whatsapp_sent', 'whatsapp_delivered', 'whatsapp_read', 'info_requested')
      and (
        coalesce(p_nudge_count, 0) >= 2
        or now() - coalesce(p_sent_at, p_updated_at) >= interval '12 hours'
      )
      then 'no_reply'

    else 'other'
  end;
$$;

-- 6. Indexes the filters/order lean on -----------------------------------------
create index if not exists idx_psp_whatsapp_reply_at
  on public.phone_screening_participants (whatsapp_reply_at desc nulls last);
create index if not exists idx_psp_whatsapp_sent_at
  on public.phone_screening_participants (whatsapp_sent_at desc nulls last);
create index if not exists idx_psp_updated_at
  on public.phone_screening_participants (updated_at desc);
create index if not exists idx_psp_status
  on public.phone_screening_participants (status);
create index if not exists idx_psp_needs_followup
  on public.phone_screening_participants (needs_manual_followup)
  where needs_manual_followup is true;

-- 7. The view the inbox reads ---------------------------------------------------
-- Display fields are joined in so the list can filter (by category) *and* search
-- (by candidate/job/client) server-side in one query. `security_invoker` means
-- the querying role's RLS on the underlying tables still applies.
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
where public.whatsapp_thread_has_activity(
        p.whatsapp_reply_text, p.whatsapp_response, p.whatsapp_reply_at, p.whatsapp_sent_at
      );

-- 8. Counts for the chips + the sidebar badge ------------------------------------
-- Reads only the base table (no display joins) — one aggregate, no row transfer.
create or replace function public.whatsapp_inbox_counts()
returns jsonb
language sql
stable
security invoker
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

-- 9. Grants + schema reload -------------------------------------------------------
grant select on public.whatsapp_threads to authenticated, service_role;
grant execute on function public.whatsapp_inbox_counts() to authenticated, service_role;
grant execute on function public.whatsapp_thread_category(text, text, text, timestamptz, timestamptz, timestamptz, int, boolean) to authenticated, service_role;
grant execute on function public.whatsapp_thread_unread(text, text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.whatsapp_candidate_reply_text(text, text) to authenticated, service_role;
grant execute on function public.whatsapp_thread_has_activity(text, text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.whatsapp_is_flow_json(text) to authenticated, service_role;

-- Make PostgREST pick up the new view/function without a restart.
notify pgrst, 'reload schema';
