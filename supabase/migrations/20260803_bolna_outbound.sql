-- Bolna outbound AI screening — direct-call pipeline
-- Replaces the Plivo WhatsApp-first path with direct Bolna voice calls.

ALTER TABLE public.phone_screening_participants ADD COLUMN IF NOT EXISTS bolna_execution_id TEXT;
ALTER TABLE public.phone_screening_participants ADD COLUMN IF NOT EXISTS bolna_status TEXT;
ALTER TABLE public.phone_screening_participants ADD COLUMN IF NOT EXISTS verdict_json JSONB;
ALTER TABLE public.phone_screening_participants ADD COLUMN IF NOT EXISTS call_payload_json JSONB;

CREATE INDEX IF NOT EXISTS idx_psp_bolna_execution ON public.phone_screening_participants(bolna_execution_id)
    WHERE bolna_execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_psp_bolna_status ON public.phone_screening_participants(bolna_status)
    WHERE bolna_status IS NOT NULL;
