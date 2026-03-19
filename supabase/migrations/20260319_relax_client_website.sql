-- Relax website requirement for clients
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_website_nonempty;
