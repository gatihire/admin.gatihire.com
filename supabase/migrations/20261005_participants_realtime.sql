-- Live conversation updates.
--
-- The thread view used to poll the participant row every 5 seconds per open
-- modal, which cost a request per conversation per 5s whether or not anything
-- had changed. It now subscribes to this row instead, and refetches only when
-- the row actually changes.
--
-- This script is what makes that subscription deliver. Postgres only emits
-- postgres_changes for tables listed in the `supabase_realtime` publication, and
-- a table that is not in it produces NO error and NO event — the subscription
-- just connects and then silently never fires. That failure mode is why the
-- client keeps a slow conditional-GET poll as a fallback: on a project where
-- this has not been run, the thread degrades to slow rather than to dead.
--
-- Safe to run repeatedly. REPLICA IDENTITY FULL makes the UPDATE payload carry
-- the full row, so a client can react to a changed field without a refetch if it
-- ever wants to; the current client refetches, so this is headroom, not a
-- requirement. Default (primary key) identity would work too.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'phone_screening_participants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.phone_screening_participants;
  END IF;
END
$$;

ALTER TABLE public.phone_screening_participants REPLICA IDENTITY FULL;
