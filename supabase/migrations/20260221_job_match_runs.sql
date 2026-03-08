create table if not exists public.job_match_runs (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  total_matches int not null default 0,
  cached_matches int not null default 0,
  per_page int not null default 20,
  max_pages int not null default 5,
  last_matched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.job_match_runs enable row level security;

create policy "Allow read access to authenticated users"
  on public.job_match_runs for select
  to authenticated
  using (true);

create policy "Allow insert access to authenticated users"
  on public.job_match_runs for insert
  to authenticated
  with check (true);

create policy "Allow update access to authenticated users"
  on public.job_match_runs for update
  to authenticated
  using (true);

create index if not exists idx_job_match_runs_job_id on public.job_match_runs(job_id);
