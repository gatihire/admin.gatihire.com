-- Add job source and external link fields to jobs table
ALTER TABLE public.jobs 
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'truckinzy' CHECK (source IN ('truckinzy', 'employee')),
ADD COLUMN IF NOT EXISTS is_external_link BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS external_link TEXT,
ADD COLUMN IF NOT EXISTS auto_matchmaking_enabled BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS messaging_preferences TEXT DEFAULT 'both' CHECK (messaging_preferences IN ('email', 'whatsapp', 'both')),
ADD COLUMN IF NOT EXISTS outreach_sent_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS outreach_responded_count INTEGER DEFAULT 0;