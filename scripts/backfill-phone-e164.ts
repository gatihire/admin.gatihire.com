import { createClient } from '@supabase/supabase-js'
import { toE164 } from '../lib/phone'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing env vars')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function backfill() {
  let offset = 0
  const batchSize = 1000
  let totalUpdated = 0

  while (true) {
    const { data: candidates, error } = await supabase
      .from('candidates')
      .select('id, phone')
      .is('phone_e164', null)
      .range(offset, offset + batchSize - 1)

    if (error) {
      console.error('Error fetching:', error)
      break
    }

    if (!candidates || candidates.length === 0) {
      break
    }

    for (const candidate of candidates) {
      const e164 = toE164(candidate.phone)
      if (e164 && e164.replace(/\D/g, '').length >= 12) {
        const { error: updateError } = await supabase
          .from('candidates')
          .update({ phone_e164: e164 })
          .eq('id', candidate.id)
        
        if (updateError) {
          console.error(`Error updating ${candidate.id}:`, updateError.message)
        } else {
          totalUpdated++
        }
      }
    }

    console.log(`Processed batch, updated ${totalUpdated} so far`)
    offset += batchSize
    
    if (candidates.length < batchSize) {
      break
    }
  }

  console.log(`Done! Updated ${totalUpdated} candidates`)
}

backfill()
