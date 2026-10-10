/**
 * Client-safe WhatsApp thread types and formatting helpers.
 *
 * This file must never import anything server-only. `lib/whatsapp-thread.ts`
 * imports `supabaseAdmin`, which builds a Supabase client at module scope — so
 * importing that module from a "use client" component pulled the service-role
 * client into the browser bundle and threw `supabaseKey is required` during
 * module evaluation, blanking the whole page. Pure formatting lives here; the
 * database-writing recorders stay in `lib/whatsapp-thread.ts`.
 */

export interface ThreadEntry {
  /** ISO timestamp. Legacy rows used `sentAt`; both are read by the UI. */
  at?: string
  sentAt?: string
  kind?: string
  /** "out" for anything we sent, "in" for the candidate. */
  /**
   * `internal` is our own note — never sent to the candidate.
   *
   * It was missing from this union while the webhook already wrote it, so the
   * compiler said nothing and internal notes rendered as ordinary outbound
   * bubbles: a recruiter read our own policy note as a message we had texted.
   */
  direction?: "in" | "out" | "system" | "internal"
  /** The actual message body. Absent on legacy rows. */
  text?: string | null
  /** Template used, when the outbound message was a template send. */
  template?: string
  /** Delivery state: sent | delivered | read | failed. */
  status?: string
  messageId?: string | null
  buttonId?: string
  buttonTitle?: string
  scheduledFor?: string | null
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
 * Human label for an outbound template send that has no stored body. Used to
 * render legacy rows so a recruiter still sees what was sent rather than a bare
 * "Message sent".
 */
export const TEMPLATE_LABELS: Record<string, string> = {
  talent_outreach: "Matched-role outreach with Interested / Not Interested",
  talent_outreach_v2: "Matched-role outreach with Interested / Not Interested",
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

/**
 * Translate a stored, technical call-failure reason into plain language a
 * recruiter can act on. Returns null when the reason isn't one we recognise, so
 * the caller can fall back to the raw text.
 */
export function friendlyCallFailure(raw?: string | null): string | null {
  if (!raw) return null
  const r = raw.toLowerCase()
  if (
    r.includes("pre-screen has not cleared") ||
    r.includes("pre-screen not cleared") ||
    r.includes("decision: none")
  )
    return "Couldn't book the call — the profile wasn't approved for a call yet. Approve it in Review, then send the time options again."
  if (r.includes("no slot was offered"))
    return "A time was never offered, so there was nothing to book — send the time options again."
  if (r.includes("attempt limit") || r.includes("max attempts") || r.includes("max_attempts"))
    return "Too many failed attempts — the profile is flagged for a human to handle."
  if (r.includes("no longer waiting"))
    return "The candidate already moved on from this step — nothing was booked."
  if (r.includes("callback not due") || r.includes("retry not due") || r.includes("not due yet"))
    return "The booked time hasn't arrived yet — the call is still on schedule."
  if (r.includes("already calling") || r.includes("already in flight"))
    return "A call is already dialling for this candidate — not dialling twice."
  if (r.includes("already booked"))
    return "A call is already booked for this candidate — not double-booking."
  if (r.includes("with the provider"))
    return "The call is already being dialled — waiting for its outcome."
  if (r.includes("no phone number"))
    return "No phone number on file — add one before booking a call."
  if (r.includes("qstash") || r.includes("could not be scheduled") || r.includes("schedule failed"))
    return "The time was marked, but the dial was never scheduled — retry placing the call."
  if (r.includes("not configured"))
    return "Call booking isn't set up (the dial service isn't configured) — tell the developer."
  if (r.includes("provider_rejected") || r.includes("failed to place call"))
    return "The phone line rejected the call — check the number and retry."
  return null
}
