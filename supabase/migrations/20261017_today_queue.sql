-- 1. time difference hours
create or replace function public.hours_between(from_t timestamptz, to_t timestamptz)
returns numeric
language sql
immutable
as $$
  select greatest(0, extract(epoch from (to_t - from_t)) / 3600.0);
$$;

-- 2. compute waitingSince
create or replace function public.today_waiting_since(
  app_status text,
  app_updated_at timestamptz,
  app_applied_at timestamptz,
  p_status text,
  p_updated_at timestamptz,
  p_whatsapp_sent_at timestamptz,
  sl_created_at timestamptz,
  iv_scheduled_at timestamptz
) returns timestamptz
language sql
stable
as $$
  select coalesce(
    case when lower(app_status)='ai_screen' then coalesce(p_whatsapp_sent_at,p_updated_at,app_updated_at,app_applied_at) end,
    case when lower(app_status) in ('ai_screen','hr_review','reply','declined','call','hold') then coalesce(p_updated_at,app_updated_at,app_applied_at) end,
    case when lower(app_status) in ('shortlist','client_review','overdue') then coalesce(sl_created_at,app_updated_at,app_applied_at) end,
    case when lower(app_status) in ('resched','interview') then coalesce(iv_scheduled_at,app_updated_at,app_applied_at) end,
    case when lower(app_status)='offer' then coalesce(app_updated_at,app_applied_at) end,
    app_updated_at,app_applied_at
  );
$$;


-- 3. kind determination
create or replace function public.today_work_item_kind(
  app_status text,
  app_updated_at timestamptz,
  app_applied_at timestamptz,
  p_status text,
  p_review_status text,
  p_whatsapp_response text,
  p_whatsapp_reply_text text,
  p_whatsapp_reply_at timestamptz,
  p_whatsapp_sent_at timestamptz,
  p_updated_at timestamptz,
  p_outreach_nudge_count int,
  p_needs_manual_followup boolean,
  p_ai_suggests_rejection boolean,
  sl_created_at timestamptz,
  sl_status text,
  iv_status text,
  iv_scheduled_at timestamptz,
  now_t timestamptz default now()
) returns text
language sql
stable
as $$
with base as (
  select
    lower(coalesce(app_status,'')) as s,
    public.whatsapp_candidate_reply_text(p_whatsapp_reply_text, p_whatsapp_response) as reply_text,
    public.whatsapp_thread_unread(p_whatsapp_response, p_whatsapp_reply_text, p_whatsapp_reply_at, p_whatsapp_sent_at) as has_unanswered,
    public.whatsapp_thread_has_activity(p_whatsapp_reply_text, p_whatsapp_response, p_whatsapp_reply_at, p_whatsapp_sent_at) as has_act,
    lower(coalesce(p_status,'')) as ps,
    lower(coalesce(p_whatsapp_response,'')) as presp,
    (lower(coalesce(p_whatsapp_response,'')) in ('call_me_now','schedule','call','callback')) as wants_human,
    (lower(coalesce(p_status,''))='not_interested' or lower(coalesce(p_whatsapp_response,''))='not_interested') as declined,
    (lower(coalesce(p_status,'')) in ('calling','call_in_progress','dialing')) as live_call,
    (lower(coalesce(p_status,'')) in ('completed','done','call_completed')) as completed_screen
  from (values(1)) as x
)
select case
  when (select not live_call and declined from base) then 'declined'
  when (select not live_call and has_unanswered from base) then 'reply'
  when (select s from base) = 'ai_screen' then
    case
      when (select not live_call and not declined and wants_human from base) then 'human'
      when ((select ps from base) in ('needs_review','needs_manual_followup','unreachable','failed') or coalesce(p_needs_manual_followup,false) or coalesce(p_ai_suggests_rejection,false)) and not (select live_call from base) then 'human'
      when (select not declined and reply_text is null from base) and (select ps from base) in ('whatsapp_sent','whatsapp_delivered','whatsapp_read','info_requested') and p_whatsapp_sent_at is not null then
        case
          when coalesce(p_outreach_nudge_count,0) >= 2 then 'ghosted'
          when public.hours_between(coalesce(p_whatsapp_sent_at, p_updated_at, app_updated_at, app_applied_at), now_t) >= 12 then 'ghosted'
          else null
        end
      when ((select completed_screen from base) or (select ps from base)='completed') then 'call'
      else null
    end
  when (select s from base) = 'hr_review' then
    case
      when (select completed_screen from base) and not coalesce(p_ai_suggests_rejection,false) then 'call'
      else 'hold'
    end
  when (select s from base) = 'shortlist' then
    case when sl_created_at is null and sl_status is null then 'shortlist' else null end
  when (select s from base) = 'client_review' then
    case
      when sl_created_at is null or lower(coalesce(sl_status,'')) = 'pending' then
        case when public.hours_between(coalesce(sl_created_at, app_updated_at, app_applied_at), now_t) >= 48 then 'overdue' else 'client' end
      else null
    end
  when (select s from base) in ('interview','resched') then
    case
      when iv_status is null or lower(coalesce(iv_status,'')) = '' then 'client'
      when lower(coalesce(iv_status,'')) in ('rescheduled','cancelled') then 'resched'
      when iv_scheduled_at is not null and iv_scheduled_at < now_t and lower(coalesce(iv_status,'')) <> 'completed' then 'resched'
      else null
    end
  when (select s from base) = 'offer' then
    case when public.hours_between(coalesce(app_updated_at, app_applied_at), now_t) >= 48 then 'offer' else null end
  else null
end;
$$;


-- 4. view with computed waitingSince, done, snoozed
create or replace view public.today_work_items
with (security_invoker = true)
as
select
  a.id as application_id,
  a.job_id,
  a.candidate_id,
  a.status as app_status,
  a.updated_at as app_updated_at,
  a.applied_at,
  a.match_score,
  j.title as job_title,
  j.client_name,
  j.owner_auth_user_id,
  c.name as candidate_name,
  c.current_role,
  c.current_company,
  c.location as candidate_location,
  c.total_experience,
  c.expected_salary,
  c.notice_period,
  p.id as participant_id,
  p.status as p_status,
  p.whatsapp_response,
  p.whatsapp_reply_text,
  p.whatsapp_reply_at,
  p.whatsapp_sent_at,
  p.outreach_nudge_count,
  p.needs_manual_followup,
  p.ai_suggests_rejection,
  p.ai_score,
  p.ai_summary,
  p.ai_recommendation,
  p.verdict_json,
  p.call_attempts,
  sl.id as share_id,
  sl.status as sl_status,
  sl.created_at as sl_created_at,
  sl.decided_at,
  iv.id as interview_id,
  iv.status as iv_status,
  iv.scheduled_at as iv_scheduled_at,
  st.snoozed_until,
  st.snooze_reason,
  st.assigned_auth_user_id,
  st.done_at,
  coalesce(st.snoozed_until, 'epoch')::timestamptz > now() as is_snoozed,
  st.done_at is not null as is_done
from public.applications a
left join public.jobs j on j.id = a.job_id
left join public.candidates c on c.id = a.candidate_id
left join public.phone_screening_participants p on p.job_id = a.job_id and p.candidate_id = a.candidate_id
left join public.shortlist_share_candidates sl on sl.application_id = a.id
left join public.job_interviews iv on iv.application_id = a.id
left join public.work_item_states st on st.application_id = a.id
where lower(coalesce(a.status,'')) in ('ai_screen','hr_review','shortlist','client_review','interview','offer');

-- 5. counts RPC (server-side)
create or replace function public.today_inbox_counts(
  include_snoozed boolean default false,
  include_done boolean default false,
  now_t timestamptz default now()
)
returns jsonb
language sql
stable
security invoker
as $$
  with t as (
    select
      public.today_work_item_kind(
        a.status, a.updated_at, a.applied_at,
        p.status, p.review_status, p.whatsapp_response, p.whatsapp_reply_text,
        p.whatsapp_reply_at, p.whatsapp_sent_at, p.updated_at, p.outreach_nudge_count,
        p.needs_manual_followup, p.ai_suggests_rejection,
        sl.created_at, sl.status, iv.status, iv.scheduled_at, now_t
      ) as kind,
      coalesce(st.snoozed_until, 'epoch')::timestamptz > now_t as is_snoozed,
      coalesce(st.done_at, 'epoch')::timestamptz as done_at,
      (public.today_waiting_since(
        a.status, a.updated_at, a.applied_at,
        p.status, p.updated_at, p.whatsapp_sent_at,
        sl.created_at, iv.scheduled_at
      )) as ws
    from public.applications a
    left join public.phone_screening_participants p on p.job_id = a.job_id and p.candidate_id = a.candidate_id
    left join public.shortlist_share_candidates sl on sl.application_id = a.id
    left join public.job_interviews iv on iv.application_id = a.id
    left join public.work_item_states st on st.application_id = a.id
    where lower(coalesce(a.status,'')) in ('ai_screen','hr_review','shortlist','client_review','interview','offer')
  )
  select jsonb_build_object(
    'total', count(*) filter (where kind is not null and (include_snoozed or not is_snoozed) and (include_done or done_at < ws))
  )
  from t;
$$;

-- 6. grants/reload
grant select on public.today_work_items to authenticated, service_role;
grant execute on function public.today_inbox_counts(boolean, boolean, timestamptz) to authenticated, service_role;
grant execute on function public.today_work_item_kind(text,text,timestamptz,timestamptz,text,text,text,text,timestamptz,timestamptz,timestamptz,int,boolean,boolean,timestamptz,text,text,timestamptz,timestamptz) to authenticated, service_role;
grant execute on function public.today_waiting_since(text,timestamptz,timestamptz,text,timestamptz,timestamptz,timestamptz,timestamptz) to authenticated, service_role;
grant execute on function public.hours_between(timestamptz,timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
