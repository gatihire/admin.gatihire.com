alter table public.job_match_runs
  add column if not exists candidate_ids jsonb not null default '[]'::jsonb,
  add column if not exists requirements jsonb;

create index if not exists idx_job_match_runs_last_matched_at on public.job_match_runs(last_matched_at desc);
