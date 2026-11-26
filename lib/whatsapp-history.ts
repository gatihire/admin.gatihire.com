import { supabaseAdmin } from '@/lib/supabase'
import { logger } from '@/lib/logger'

/**
 * Append-only timeline of everything that happens to a candidate's WhatsApp
 * thread.
 *
 * This exists because the thread used to be write-only: the webhook recorded
 * outbound sends and delivery receipts, but an inbound button tap was never
 * stored anywhere. A candidate could tap "Call Now", the tap could be dropped,
 * and the recruiter card would show only "read" with no way to tell a tap had
 * happened. Every inbound tap is now recorded here so the UI can show the
 * sequence: sent -> delivered -> read -> tapped -> booked.
 */

export type WhatsappHistoryEntry = {
  at: string
  kind: string
  [key: string]: unknown
}

/** How many entries to keep. Older ones are dropped to bound row size. */
const MAX_ENTRIES = 60

/**
 * Append one entry to a participant's WhatsApp history.
 *
 * Read-modify-write on a JSON array, so concurrent writes can lose an entry.
 * That is acceptable for a diagnostic timeline — losing one line of history is
 * far better than failing the caller's actual work — and every call site treats
 * a failure here as non-fatal.
 */
export async function appendWhatsappHistory(
  participantId: string,
  entry: WhatsappHistoryEntry
): Promise<boolean> {
  const { data: participant, error: findError } = await supabaseAdmin
    .from('phone_screening_participants')
    .select('whatsapp_history')
    .eq('id', participantId)
    .maybeSingle()

  if (findError || !participant) {
    logger.warn('appendWhatsappHistory: participant lookup failed', {
      participantId,
      error: findError?.message,
    })
    return false
  }

  const history = Array.isArray(participant.whatsapp_history)
    ? [...participant.whatsapp_history]
    : []

  // A terminal Bolna execution is processed by the webhook, then again by
  // reconcile / on-view healing / manual sync. Those extra passes used to
  // append another "Call completed" note each time, so one 30-second call
  // showed five completion lines in the thread. Dedupe every outcome note that
  // carries an execution id before appending.
  const kind = String(entry.kind || "")
  const executionId = entry.executionId ? String(entry.executionId) : null
  if (executionId && ["call_completed", "call_ended", "post_call_message"].includes(kind)) {
    const alreadyRecorded = history.some(
      (h: any) => h?.executionId === executionId && String(h?.kind || "") === kind
    )
    if (alreadyRecorded) return true
  }

  history.push(entry)

  // An outbound entry means we just spoke to the candidate. Stamping
  // `whatsapp_sent_at` here — in one place — is what lets the queue tell an
  // *answered* reply from an unanswered one; without it a manual message or a
  // call nudge left no trace that we had replied, so "Replied" never cleared.
  const isOutbound = entry.direction === 'out'

  const { error: updateError } = await supabaseAdmin
    .from('phone_screening_participants')
    .update({
      whatsapp_history: history.slice(-MAX_ENTRIES),
      updated_at: new Date().toISOString(),
      ...(isOutbound ? { whatsapp_sent_at: entry.at || new Date().toISOString() } : {}),
    })
    .eq('id', participantId)

  if (updateError) {
    logger.warn('appendWhatsappHistory: persist failed', {
      participantId,
      kind: entry.kind,
      error: updateError.message,
    })
    return false
  }

  return true
}

/** Human label for a recorded button id, for display in the UI. */
export function buttonLabel(buttonId: string): string {
  switch (buttonId) {
    case 'call_now':
      return 'Call Now'
    case 'in_10_min':
      return 'In 10 min'
    case 'in_20_min':
      return 'In 20 min'
    case 'in_30_min':
      return 'In 30 min'
    case 'today_evening':
      return 'Today evening'
    case 'tomorrow_morning':
      return 'Tomorrow morning'
    case 'interested':
      return 'Interested'
    case 'not_interested':
      return 'Not interested'
    case 'provide_details':
      return 'Share details'
    default:
      return buttonId
  }
}
