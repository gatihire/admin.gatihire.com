-- Backfill phone_e164 for existing candidates
UPDATE candidates
SET phone_e164 = 
  CASE
    WHEN phone IS NULL OR TRIM(phone) = '' THEN NULL
    WHEN phone ~ '^\+91' THEN '+' || regexp_replace(phone, '\D', '', 'g')
    WHEN phone ~ '^91[0-9]{10}$' THEN '+' || regexp_replace(phone, '\D', '', 'g')
    WHEN phone ~ '^[0-9]{10}$' THEN '+91' || regexp_replace(phone, '\D', '', 'g')
    WHEN length(regexp_replace(phone, '\D', '', 'g')) = 12 AND regexp_replace(phone, '\D', '', 'g') LIKE '91%' THEN '+' || regexp_replace(phone, '\D', '', 'g')
    WHEN length(regexp_replace(phone, '\D', '', 'g')) > 12 AND regexp_replace(phone, '\D', '', 'g') LIKE '91%' THEN '+' || substring(regexp_replace(phone, '\D', '', 'g') from length(regexp_replace(phone, '\D', '', 'g')) - 11)
    ELSE 
      CASE 
        WHEN length(regexp_replace(phone, '\D', '', 'g')) >= 10 THEN '+91' || right(regexp_replace(phone, '\D', '', 'g'), 10)
        ELSE NULL
      END
  END
WHERE phone_e164 IS NULL AND phone IS NOT NULL;

-- Update any remaining cases
UPDATE candidates
SET phone_e164 = '+91' || right(regexp_replace(phone, '\D', '', 'g'), 10)
WHERE phone_e164 IS NULL 
  AND phone IS NOT NULL 
  AND length(regexp_replace(phone, '\D', '', 'g')) >= 10;

-- Add index on phone for fallback lookups
CREATE INDEX IF NOT EXISTS idx_candidates_phone_gin_trgm ON candidates USING gin (phone gin_trgm_ops);
