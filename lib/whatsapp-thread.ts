import { supabaseAdmin } from "@/lib/supabase"
import {
  type ThreadEntry,
  describeTemplate,
  entryTime,
  TEMPLATE_LABELS,
} from "@/lib/whatsapp-thread-shared"

/**
 * Server-only writers for `phone_screening_participants.whatsapp_history`.
 *
 * Recording message text at the send site is what makes the conversation view
 * possible: the delivery receipts Meta sends afterwards carry a status and a
 * messageId but no body, so a message logged without its text is permanently
 * unreadable.
 *
 * Types and pure formatters live in `lib/whatsapp-thread-shared.ts` because this
 * module imports the service-role Supabase client, and a "use client" component
 * that imports from here crashes the page with `supabaseKey is required`.
 */

export { type ThreadEntry, describeTemplate, entryTime, TEMPLATE_LABELS }

/**
 * Append a thread entry.
 *
 * Read-modify-write on a JSONB array is not atomic, so two quick sends can
 * clobber each other. This re-reads immediately before writing (rather than
 * trusting a caller's stale copy) which keeps the common single-writer case
 * correct, and never throws — a lost log line must not fail the send.
 */
export async function appendThreadEntry(
  participantId: string,
  entry: ThreadEntry
): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("whatsapp_history")
      .eq("id", participantId)
      .maybeSingle()

    if (error || !data) return false

    const history = Array.isArray(data.whatsapp_history)
      ? [...data.whatsapp_history]
      : []

    // Bound the array. whatsapp_history is a JSONB column on a row we also store
    // the call payload in, and an untrimmed thread grows it without limit. The
    // cap matches lib/whatsapp-history so both writers behave the same.
    const MAX_ENTRIES = 60
    history.push(entry)
    const trimmed =
      history.length > MAX_ENTRIES ? history.slice(history.length - MAX_ENTRIES) : history

    const { error: writeError } = await supabaseAdmin
      .from("phone_screening_participants")
      .update({ whatsapp_history: trimmed, updated_at: new Date().toISOString() })
      .eq("id", participantId)

    if (writeError) return false
    return true
  } catch {
    // Logging must never break the conversation.
    return false
  }
}

/** Record an outbound free-text (session) message. */
export function recordOutboundText(
  participantId: string,
  text: string,
  extra: Partial<ThreadEntry> = {}
): Promise<boolean> {
  return appendThreadEntry(participantId, {
    direction: "out",
    text,
    status: "sent",
    at: new Date().toISOString(),
    ...extra,
  })
}

/** Record an inbound free-text message from the candidate. */
export function recordInboundText(
  participantId: string,
  text: string,
  extra: Partial<ThreadEntry> = {}
): Promise<boolean> {
  return appendThreadEntry(participantId, {
    direction: "in",
    text,
    at: new Date().toISOString(),
    ...extra,
  })
}

/** Record an outbound template send (body text optional — templates carry params). */
export function recordOutboundTemplate(
  participantId: string,
  template: string,
  text: string,
  messageId?: string,
  extra: Partial<ThreadEntry> = {}
): Promise<boolean> {
  return appendThreadEntry(participantId, {
    direction: "out",
    template,
    text,
    status: "sent",
    messageId: messageId ?? null,
    at: new Date().toISOString(),
    ...extra,
  })
}
