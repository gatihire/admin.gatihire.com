-- Create outreach tracking table for candidate messages
CREATE TABLE IF NOT EXISTS public.outreach_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    message_type TEXT NOT NULL CHECK (message_type IN ('email', 'whatsapp')),
    recipient_contact TEXT NOT NULL,
    message_content TEXT NOT NULL,
    unique_link TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'opened')),
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_outreach_job_id ON outreach_messages(job_id);
CREATE INDEX IF NOT EXISTS idx_outreach_candidate_id ON outreach_messages(candidate_id);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach_messages(status);
CREATE INDEX IF NOT EXISTS idx_outreach_unique_link ON outreach_messages(unique_link);

-- Enable RLS
ALTER TABLE public.outreach_messages ENABLE ROW LEVEL SECURITY;

-- Policies for authenticated users
CREATE POLICY "Authenticated users can view outreach messages" ON outreach_messages
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can manage outreach messages" ON outreach_messages
    FOR ALL USING (auth.role() = 'authenticated');