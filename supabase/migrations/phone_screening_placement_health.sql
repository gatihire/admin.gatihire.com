-- Placement health: make "we never got a call" observable and recoverable.
--
-- Before this, a provider rejection (no balance, invalid number, 5xx) left no
-- trace on the participant row: placeBolnaCall returned { success: false },
-- the caller pushed the message into an API response that nobody reads after
-- the request ends, and the row simply said `failed`. A 40-hour outage in
-- which no call was created anywhere was indistinguishable from candidates
-- not picking up.
--
-- Columns:
--   placement_attempts        how many times we tried to CREATE the call
--                             (separate from call_attempts, which counts
--                             calls the provider actually accepted)
--   last_placement_error      the provider's own message, verbatim
--   last_placement_error_at   when that rejection happened
--   next_placement_retry_at   when we are allowed to try creating it again
--   provider_error            terminal provider-side explanation for a call
--                             that was created and then failed
--   booking_source            who booked the next call:
--                             candidate_requested | auto_retry | recruiter

alter table public.phone_screening_participants
  add column if not exists placement_attempts integer not null default 0,
  add column if not exists last_placement_error text,
  add column if not exists last_placement_error_at timestamptz,
  add column if not exists next_placement_retry_at timestamptz,
  add column if not exists provider_error text,
  add column if not exists booking_source text;

-- The watchdog drains this queue oldest-first. Without an index the scan is
-- fine at today's volume but would not be at 100k participants.
create index if not exists idx_psp_placement_retry
  on public.phone_screening_participants (next_placement_retry_at)
  where status in ('failed', 'call_scheduled', 'scheduled');

create index if not exists idx_psp_booked_call
  on public.phone_screening_participants (scheduled_call_at)
  where status in ('call_scheduled', 'scheduled');

-- Global switches that must be visible to every surface (e.g. "the voice
-- provider has no balance — calls are paused"). A single row keeps the whole
-- team looking at the same answer instead of each campaign guessing.
create table if not exists public.system_flags (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.system_flags enable row level security;
-- Service role only: no policies are defined on purpose.
