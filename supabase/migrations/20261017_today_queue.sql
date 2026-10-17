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
