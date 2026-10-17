-- Today board: "Done" (a row an operator has handled) -------------------------
--
-- Adds done_at to work_item_states so the queue can take a row off the board
-- without touching the pipeline. Mirrors the WhatsApp inbox's
-- public.whatsapp_thread_states.done_at (20261017_whatsapp_thread_done.sql).
--
-- A row hides while done_at >= its derived "waiting since" (see
-- lib/dispatch/engine.ts). Any later activity moves waiting since forward, so
-- the row returns on its own — nothing is lost by marking it done.

alter table public.work_item_states
  add column if not exists done_at timestamptz;

create index if not exists idx_work_item_states_done
  on public.work_item_states (done_at)
  where done_at is not null;

-- Make PostgREST pick up the new column without a restart.
notify pgrst, 'reload schema';
