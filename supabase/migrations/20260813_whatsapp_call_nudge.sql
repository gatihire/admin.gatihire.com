-- WhatsApp call nudge for the AI phone-screening funnel.
-- Adds fields on phone_screening_participants to track the one-way
-- Aisensy "we'll call you" nudge sent before (or after a missed attempt of)
-- the Bolna voice call.

alter table phone_screening_participants
  add column if not exists whatsapp_message_id text,
  add column if not exists whatsapp_sent_at timestamptz,
  add column if not exists whatsapp_delivery_status text check (
    whatsapp_delivery_status is null
    or whatsapp_delivery_status in ('sent', 'delivered', 'read', 'failed')
  ),
  add column if not exists whatsapp_missed_nudge_sent boolean not null default false;