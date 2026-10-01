import { supabaseAdmin } from "@/lib/supabase"

/**
 * Canonical shape of one WhatsApp thread entry stored in
 * `phone_screening_participants.whatsapp_history`.
 *
 * History used to record only `{at, status, messageId}` delivery receipts and a
 * template name. There was no message body anywhere, so no UI could ever show
 * the candidate a readable conversation — the best possible view was a list of
 * "Message sent" lines with no idea what was said. `text` is what makes the
 * conversation renderable; `direction` is what decides which side of the bubble
 * it goes on.
 */
export interface ThreadEntry {
  /** ISO timestamp. Legacy rows used `sentAt`; both are read by the UI. */
  at?: string
  sentAt?: string
  kind?: string
  /** "out" for anything we sent, "in" for the candidate. */
  direction?: "in" | "out" | "system"
  /** The actual message body. Absent on legacy rows. */
  text?: string | null
  /** Template used, when the outbound message was a template send. */
  template?: string
  /** Delivery state: sent | delivered | read | failed. */
  status?: string
  messageId?: string | null
  buttonId?: string
  buttonTitle?: string
  scheduledFor?: string
  error?: string | null
  mode?: string | null
  [key: string]: unknown
}

/** Best-effort timestamp for an entry, tolerating both `at` and `sentAt`. */
export function entryTime(entry: ThreadEntry): Date | null {
  const raw = entry.at || entry.sentAt
  if (!raw) return null
  const d = new Date(String(raw))
  return isNaN(d.getTime()) ? null : d
}

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

/**
 * Human label for an outbound template send that has no stored body. Used to
 * render legacy rows so a recruiter still sees what was sent rather than a bare
 * "Message sent".
 */
export const TEMPLATE_LABELS: Record<string, string> = {
  talent_outreach: "Matched-role outreach with Interested / Not Interested",
  shortlist_call_schedule: "Shortlisted — call time options",
  collect_info_form: "Candidate details form",
  collect_info_form_v2: "Candidate details form",
  collect_info_form_v3: "Candidate details form",
  detailed_info_request: "Requested screening details",
  inbound_screening_invite: "Screening invite",
  inbound_info_request_v2: "Requested screening details",
  outbound_info_request: "Requested screening details",
  reminder_nudge: "Reminder nudge",
  second_reminder_nudge: "Second reminder nudge",
  call_nudge: "Call nudge",
  missed_call_reschedule: "Missed-call reschedule",
  ai_call_reassurance: "Call reassurance",
  info_received_confirm: "Confirmed details received",
  info_review_pending: "Held for recruiter review",
  not_interested_reason: "Asked why they declined",
  screening_filtered_out: "Screening outcome",
}

/** Short description of what a template was for, when its body text is unknown. */
export function describeTemplate(template?: string): string {
  if (!template) return "Message sent"
  return TEMPLATE_LABELS[template] || `Message sent (${template})`
}
