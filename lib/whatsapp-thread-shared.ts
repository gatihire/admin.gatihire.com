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
