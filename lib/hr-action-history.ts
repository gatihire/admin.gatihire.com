import { appendWhatsappHistory } from "@/lib/whatsapp-history"

/**
 * Persistent, human-readable record of an HR action on a candidate.
 *
 * A toast disappears. When HR says "I clicked nudge three times and nothing
 * happened", the only trustworthy answer is a timestamped note on the
 * candidate's own thread — written whether the action succeeded or failed, and
 * never invented from an outcome the provider did not report.
 *
 * These entries are internal: they are for the recruiter's conversation view,
 * never sent to the candidate.
 */

export type HrActionName =
  | "nudge"
  | "call"
  | "retry_call"
  | "manual_message"
  | "schedule"
  | "cancel_schedule"
export type HrActionStatus = "sent" | "started" | "deferred" | "failed" | "cancelled"

export type HrActionEntry = {
  at: string
  kind: "hr_action"
  direction: "internal"
  action: HrActionName
  status: HrActionStatus
  actor: string | null
  /** Short line with IST date/time and the honest result. Safe to show as-is. */
  text: string
  /** Longer cause, when the action failed or was deferred. */
  detail?: string
  error?: string | null
  executionId?: string | null
}

function istStamp(at: string): string {
  const d = new Date(at)
  if (isNaN(d.getTime())) return at
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d)
}

function verb(action: HrActionName): string {
  switch (action) {
    case "nudge":
      return "nudge"
    case "call":
      return "call"
    case "retry_call":
      return "call retry"
    case "manual_message":
      return "message"
    case "schedule":
      return "exact slot booking"
    case "cancel_schedule":
      return "exact slot cancellation"
  }
}

function outcome(status: HrActionStatus, detail?: string, executionId?: string | null): string {
  switch (status) {
    case "sent":
      return "sent"
    case "started":
      return executionId
        ? `provider accepted · ${String(executionId).slice(0, 8)}`
        : "provider accepted"
    case "deferred":
      return detail ? `deferred · ${detail}` : "deferred"
    case "failed":
      return detail ? `failed · ${detail}` : "failed"
    case "cancelled":
      return detail ? `cancelled · ${detail}` : "cancelled"
  }
}

/** Append an HR action note. Non-fatal by design: it must never break a dial. */
export async function recordHrAction(
  participantId: string | null | undefined,
  opts: {
    action: HrActionName
    status: HrActionStatus
    at?: string
    actor?: string | null
    detail?: string | null
    error?: string | null
    executionId?: string | null
  }
): Promise<HrActionEntry | null> {
  if (!participantId) return null
  const at = opts.at || new Date().toISOString()
  const detail = opts.detail?.toString().trim().slice(0, 240) || undefined
  const entry: HrActionEntry = {
    at,
    kind: "hr_action",
    direction: "internal",
    action: opts.action,
    status: opts.status,
    actor: opts.actor ?? null,
    text: `HR ${verb(opts.action)} at ${istStamp(at)} IST — ${outcome(opts.status, detail, opts.executionId)}`,
    ...(detail ? { detail } : {}),
    ...(opts.error ? { error: opts.error.slice(0, 500) } : {}),
    ...(opts.executionId ? { executionId: opts.executionId } : {}),
  }
  await appendWhatsappHistory(participantId, entry)
  return entry
}
