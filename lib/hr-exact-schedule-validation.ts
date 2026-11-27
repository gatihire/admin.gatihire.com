/**
 * Pure validation for HR-authored exact-time slots.
 *
 * Kept separate from the booking/queueing code so tests can check the rules
 * without loading Supabase, QStash or the rest of the call stack.
 */

/** Distinct from `candidate_requested`, `auto_retry` and `recruiter`. */
export const HR_EXACT_TIME_SOURCE = "hr_exact_time"
export const HR_SCHEDULE_REASON_MIN = 10

const MIN_LEAD_MS = 5 * 60 * 1000
const MAX_HORIZON_MS = 7 * 24 * 60 * 60 * 1000

export type SlotErrorCode =
  | "feature_disabled"
  | "invalid_time"
  | "past_or_too_soon"
  | "too_far"
  | "reason_required"
  | "not_found"
  | "no_phone"
  | "already_calling"
  | "already_scheduled"
  | "attempt_cap"
  | "publish_failed"
  | "not_hr_slot"
  | "not_scheduled"
  | "already_due"

export type SlotValidation =
  | { ok: true; dueAt: Date }
  | { ok: false; code: SlotErrorCode; error: string }

/** Both flags default to off: the flow is inert until quality sign-off. */
export function hrSchedulingEnabled(): boolean {
  const raw = (process.env.ENABLE_HR_EXACT_TIME_SCHEDULING || "").trim().toLowerCase()
  return raw === "1" || raw === "true"
}

export function formatIst(at: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(at)
}

/** Unix seconds QStash expects for `notBefore` (the `Upstash-Not-Before` header). */
export function notBeforeSeconds(dueAt: Date): number {
  return Math.floor(dueAt.getTime() / 1000)
}

/**
 * HR booked the slot after speaking to the candidate, so there is deliberately
 * no calling-hours check here. The only limits are sanity limits: a real future
 * instant, enough lead time to enqueue it, and QStash's safe 7-day ceiling.
 */
export function validateHrSlot(
  rawScheduledAt: unknown,
  timezone: unknown,
  now: Date = new Date()
): SlotValidation {
  if (typeof rawScheduledAt !== "string" && !(rawScheduledAt instanceof Date)) {
    return { ok: false, code: "invalid_time", error: "Choose a valid date and time." }
  }
  const dueAt = new Date(rawScheduledAt as string)
  if (!Number.isFinite(dueAt.getTime())) {
    return { ok: false, code: "invalid_time", error: "Choose a valid date and time." }
  }
  if (!timezone || typeof timezone !== "string") {
    return { ok: false, code: "invalid_time", error: "A timezone is required." }
  }

  const delta = dueAt.getTime() - now.getTime()
  if (delta < MIN_LEAD_MS) {
    return {
      ok: false,
      code: "past_or_too_soon",
      error: "Pick a slot at least 5 minutes from now.",
    }
  }
  if (delta > MAX_HORIZON_MS) {
    return {
      ok: false,
      code: "too_far",
      error: "Slots can be booked up to 7 days ahead. Ask the candidate to confirm again closer to the date.",
    }
  }
  return { ok: true, dueAt }
}
