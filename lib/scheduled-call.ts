// Event-driven call scheduling with QStash (Upstash).
// Replaces the old 5-minute cron polling:
//  - WhatsApp outreach publishes nudge / human-escalation messages at +4h / +8h,
//  - an opted-in candidate schedules their own call (call_scheduled),
//  - a failed call schedules its own retry at the right time.
// All scheduling is "publish a JSON message to our own endpoint"; QStash delivers
// it (roughly) when due, so nothing has to poll the database.

import { Client } from "@upstash/qstash"
import { supabaseAdmin } from "@/lib/supabase"
import { placeBolnaCall, BOLNA_TERMINAL_STATUSES } from "@/lib/bolna"
import { buildAlreadyCollectedUserData } from "@/lib/prompt-user-data"
import { logger } from "@/lib/logger"

// WhatsApp outreach → human-escalation cadence. No blind AI calls: a silent
// outbound candidate gets one WhatsApp reminder, then goes to a human recruiter.
export function outreachNudgeHours(): number {
  return clampInt(process.env.OUTREACH_NUDGE_HOURS, 4, 1, 24)
}
export function outreachEscalateHours(): number {
  return clampInt(process.env.OUTREACH_ESCALATE_HOURS, 8, 1, 24)
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

// How many failed attempts before we stop auto-retrying a participant.
// Reads from campaign config if available, falls back to env var.
export async function getMaxCallAttempts(campaignId?: string | null): Promise<number> {
  if (campaignId) {
    const { data: campaign } = await supabaseAdmin
      .from("phone_screening_campaigns")
      .select("max_call_attempts")
      .eq("id", campaignId)
      .maybeSingle()
    if (campaign?.max_call_attempts) {
      return Math.max(1, Math.min(3, campaign.max_call_attempts))
    }
  }
  return clampInt(process.env.MAX_CALL_ATTEMPTS, 2, 1, 3)
}

// Synchronous fallback for callers without campaign context
export const MAX_CALL_ATTEMPTS = 2

/**
 * Hard ceiling on how many times we will ever dial one candidate.
 *
 * The automatic ladder and manual HR retries used to draw from separate budgets
 * — the ladder stopped at `MAX_CALL_ATTEMPTS` (2) but the retry button had no
 * ceiling at all, and it even accepted `completed`. Combined that allowed an
 * unbounded number of outbound AI calls to one phone number, which is both a
 * spend risk and a harassment/complaint risk.
 *
 * `call_attempts` is now the single shared budget for every placement path:
 * automatic ladder, WhatsApp "call now", pipeline "Call Now", and manual retry
 * all increment the same counter and all respect this ceiling. Campaign config
 * (`getMaxCallAttempts`) may lower it but never raise it above this.
 *
 * This is intentionally NOT bypassable by `force`. `force` exists to skip
 * accidental-double-dial protection when a human explicitly asks for a call
 * now; it is not a licence to exceed the attempt budget.
 */
export const MAX_TOTAL_CALL_ATTEMPTS = 3

// QStash accepts delays up to 24 hours.
const MAX_DELAY_SEC = 24 * 60 * 60

// A call that is due this soon is placed directly rather than queued — the
// candidate has usually just told us they are free right now.
const DIRECT_PLACE_WINDOW_SECONDS = 60

// When a direct placement fails, how long until the queued callback retries.
const CALLBACK_RETRY_DELAY_SECONDS = 5 * 60

/** Provider statuses after which a new execution is legitimate. */
function isTerminalProviderStatus(status?: string | null): boolean {
  return BOLNA_TERMINAL_STATUSES.has(String(status || "").toLowerCase())
}

/** Exported so callers can tell "still ringing" from "we never got an answer". */
export { isTerminalProviderStatus }

/** Provider statuses meaning a call is genuinely still open right now. */
function isLiveProviderStatus(status?: string | null): boolean {
  const s = String(status || "").trim().toLowerCase()
  return !s ? false : ["queued", "initiated", "ringing", "in-progress", "in_progress", "inprogress"].includes(s)
}

function getQStashToken(): string {
  return process.env.QSTASH_TOKEN || ""
}

function getTriggerUrl(): string {
  const base = process.env.PHONE_SCREENING_WEBHOOK_BASE
  return `${base || ""}/api/phone-screening/call/trigger`
}

function getOutreachUrl(): string {
  const base = process.env.PHONE_SCREENING_WEBHOOK_BASE
  return `${base || ""}/api/phone-screening/outreach-followup`
}

/**
 * Schedule a Bolna call for a participant to be fired `delaySeconds` from now.
 * Returns { scheduled: true } on success, { scheduled: false, error } if QStash
 * is not configured or the publish failed.
 */
export async function scheduleBolnaCall(
  participantId: string,
  delaySeconds: number
): Promise<{ scheduled: boolean; error?: string }> {
  const token = getQStashToken()
  const url = getTriggerUrl()

  if (!token || !url.startsWith("http")) {
    return { scheduled: false, error: "QStash not configured (QSTASH_TOKEN / PHONE_SCREENING_WEBHOOK_BASE)" }
  }

  const delay = Math.max(0, Math.min(MAX_DELAY_SEC, Math.round(delaySeconds)))

  try {
    const client = new Client({ token })
    await client.publishJSON({
      url,
      body: { participantId },
      delay,
    })
    logger.info(`Scheduled Bolna call via QStash`, { participantId, delaySec: delay })
    return { scheduled: true }
  } catch (err: any) {
    logger.error("QStash publish failed", { participantId, error: err?.message })
    return { scheduled: false, error: err?.message || "QStash publish failed" }
  }
}

/**
 * Schedule a WhatsApp outreach follow-up (nudge #1 or human-escalation) for a
 * participant, delivered `delaySeconds` from now by QStash.
 */
export async function scheduleOutreachFollowup(
  participantId: string,
  action: "nudge" | "escalate",
  delaySeconds: number
): Promise<{ scheduled: boolean; error?: string }> {
  const token = getQStashToken()
  const url = getOutreachUrl()

  if (!token || !url.startsWith("http")) {
    return { scheduled: false, error: "QStash not configured (QSTASH_TOKEN / PHONE_SCREENING_WEBHOOK_BASE)" }
  }

  const delay = Math.max(0, Math.min(MAX_DELAY_SEC, Math.round(delaySeconds)))

  try {
    const client = new Client({ token })
    await client.publishJSON({
      url,
      body: { participantId, action },
      delay,
    })
    logger.info(`Scheduled outreach follow-up via QStash`, { participantId, action, delaySec: delay })
    return { scheduled: true }
  } catch (err: any) {
    logger.error("QStash outreach publish failed", { participantId, action, error: err?.message })
    return { scheduled: false, error: err?.message || "QStash publish failed" }
  }
}

export interface PlaceCallResult {
  success: boolean
  skipped?: boolean
  error?: string
  /** Machine-readable cause when nothing was placed, so callers can tell an
   *  exhausted budget apart from a duplicate dial or a provider rejection. */
  reason?:
    | "attempt_cap"
    | "already_calling"
    | "already_booked"
    | "not_due"
    | "not_found"
    | "no_phone"
    | "provider_rejected"
    | "no_longer_waiting"
}

interface ParticipantRow {
  id: string
  status: string
  call_attempts: number
  call_payload_json?: Record<string, unknown> | null
  info_data?: Record<string, unknown> | null
  whatsapp_sent_at?: string | null
  next_retry_at?: string | null
  scheduled_call_at?: string | null
  campaign_id?: string | null
  candidates?: {
    id: string
    name?: string | null
    phone?: string | null
    total_experience?: string | number | null
    location?: string | null
  } | null
}

/**
 * Place the Bolna call for one participant and persist the placement.
 * When `guard` is true (QStash-triggered path) it first checks the participant is
 * still waiting on this exact step — call_scheduled past the agreed time, or failed
 * with an elapsed retry window — so an at-least-once delivery never double-calls
 * someone who already moved on. whatsapp_sent alone never fires a call.
 */
export async function placeCallForParticipant(
  participantId: string,
  opts?: { guard?: boolean }
): Promise<PlaceCallResult> {
  const guard = opts?.guard ?? false

  logger.info("placeCallForParticipant called", { participantId, guard })

  const { data: participant, error: partError } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      id, status, call_attempts, call_payload_json, info_data,
      whatsapp_sent_at, next_retry_at, scheduled_call_at, campaign_id,
      candidates: candidate_id (id, name, phone, total_experience, location)
    `)
    .eq("id", participantId)
    .maybeSingle()

  if (partError || !participant) {
    logger.warn("Participant not found", { participantId, error: partError?.message })
    return { success: false, reason: "not_found", error: "Participant not found" }
  }

  const row = participant as unknown as ParticipantRow
  const candidate = row.candidates

  logger.info("Participant state", { 
    participantId, 
    status: row.status, 
    callAttempts: row.call_attempts,
    scheduledCallAt: row.scheduled_call_at,
    nextRetryAt: row.next_retry_at,
    whatsappSentAt: row.whatsapp_sent_at,
    candidatePhone: candidate?.phone,
    candidateName: candidate?.name
  })

  // Hard attempt budget, checked before anything else so an exhausted budget is
  // never reported as "already calling" or "not due". Applies to every path —
  // automatic ladder, WhatsApp reply, pipeline "Call Now" and manual retry share
  // this one counter, which is what makes the ceiling real.
  const attemptsSoFar = Number(row.call_attempts || 0)
  if (attemptsSoFar >= MAX_TOTAL_CALL_ATTEMPTS) {
    // Flag for HR rather than failing silently. `needs_manual_followup` is the
    // existing hold flag; Phase 2 replaces this with dedicated attention columns
    // (needs_attention / attention_reason / attention_since) plus ownership.
    const now = new Date().toISOString()
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "needs_manual_followup",
        needs_manual_followup: true,
        bolna_status: "max_retries",
        next_retry_at: null,
        updated_at: now,
      })
      .eq("id", participantId)
    logger.warn("Call attempt budget exhausted — flagged for manual followup", {
      participantId,
      attempts: attemptsSoFar,
      cap: MAX_TOTAL_CALL_ATTEMPTS,
    })
    return {
      success: false,
      skipped: true,
      reason: "attempt_cap",
      error: `Attempt limit reached (${attemptsSoFar} of ${MAX_TOTAL_CALL_ATTEMPTS}) — flagged for manual followup`,
    }
  }

  if (guard) {
    // No blind calls: only fire when the participant opted in (call_scheduled
    // or scheduled with an elapsed time) or a retry window for an already-attempted
    // call has passed (failed). whatsapp_sent alone NEVER triggers a call.
    if (row.status === "call_scheduled" || row.status === "scheduled") {
      const scheduledTime = row.scheduled_call_at || row.next_retry_at
      if (!scheduledTime || new Date(scheduledTime).getTime() > Date.now()) {
        return { success: false, skipped: true, reason: "not_due", error: "Callback not due yet" }
      }
    } else if (row.status === "failed") {
      const maxAttempts = await getMaxCallAttempts(row.campaign_id)
      if (row.call_attempts >= maxAttempts) {
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ bolna_status: "max_retries", updated_at: new Date().toISOString() })
          .eq("id", participantId)
        return { success: false, skipped: true, reason: "attempt_cap", error: "Max attempts reached" }
      }
      if (!row.next_retry_at || new Date(row.next_retry_at).getTime() > Date.now()) {
        return { success: false, skipped: true, reason: "not_due", error: "Retry not due yet" }
      }
    } else {
      return {
        success: false,
        skipped: true,
        reason: "no_longer_waiting",
        error: `Participant no longer waiting (${row.status})`,
      }
    }
  }

  if (!candidate?.phone) {
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", participantId)
    return { success: false, reason: "no_phone", error: "Candidate has no phone number" }
  }

  const payload = row.call_payload_json
  const collected = buildAlreadyCollectedUserData(row.info_data, {
    total_experience: candidate.total_experience ?? undefined,
    location: candidate.location ?? undefined,
  })
  const userData =
    payload && Object.keys(payload).length > 0
      ? { ...payload, ...collected, participant_id: participantId }
      : { candidate_name: candidate.name || "", ...collected, participant_id: participantId }

  const result = await placeBolnaCall({
    to: candidate.phone,
    userData,
  })

  if (!result.success || !result.executionId) {
    // Leave the participant untouched so an at-least-once QStash retry can re-run
    // this step cleanly. Nothing was dialled, so the budget is untouched.
    return { success: false, reason: "provider_rejected", error: result.error || "Failed to place call" }
  }

  const now = new Date().toISOString()
  const attempts = row.call_attempts + 1
  await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      status: "calling",
      bolna_execution_id: result.executionId,
      bolna_status: "queued",
      call_attempts: attempts,
      last_attempt_at: now,
      next_retry_at: null,
      scheduled_call_at: null,
      updated_at: now,
    })
    .eq("id", participantId)

  return { success: true }
}

export async function scheduleCall(participant: any, delayMs: number): Promise<void> {
  const delaySeconds = Math.max(0, Math.round(delayMs / 1000));
  await scheduleBolnaCall(participant.id, delaySeconds);
}

/**
 * Place a call now, bypassing QStash entirely. Used by "Call Now" actions where
 * waiting on a queue message means the candidate hears nothing for seconds after
 * saying yes. `placeCallForParticipant` still owns the DB bookkeeping, so this
 * stays consistent with the scheduled path.
 *
 * Duplicate protection: HR buttons, WhatsApp "call me now" replies and bulk
 * actions can all fire for the same candidate. If a call is already with the
 * provider and no outcome has come back yet, we refuse a second execution rather
 * than double-dialling the candidate.
 *
 * `force` skips ONLY the already-*booked* check, for the explicit human "Call Now"
 * action: an HR overriding a future retry/callback slot. It does not skip the
 * in-flight check, because a live execution is not a booking to override — dialling
 * again would put two calls in front of the candidate at once — and it does not skip
 * the hard attempt budget in `placeCallForParticipant`.
 */
export async function placeCallImmediately(
  participantId: string,
  opts?: { force?: boolean }
): Promise<PlaceCallResult> {
  const { data: existing } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("bolna_execution_id, bolna_status, next_retry_at, scheduled_call_at")
    .eq("id", participantId)
    .maybeSingle()

  const prior = (existing as
    | { bolna_execution_id?: string | null; bolna_status?: string | null; next_retry_at?: string | null; scheduled_call_at?: string | null }
    | null) || {}

  // Checked before `force` is honoured, and before the attempt budget. If the last
  // permitted call is still ringing, the honest answer is "already calling" — not
  // "attempt limit reached", which would also flag the row for manual followup while
  // the recruiter is in the middle of a call that may still succeed.
  if (prior.bolna_execution_id && isLiveProviderStatus(prior.bolna_status)) {
    return {
      success: false,
      skipped: true,
      reason: "already_calling",
      error: `A call is already with the provider (${prior.bolna_status}) — waiting for its outcome`,
    }
  }

  const booked = [prior.next_retry_at, prior.scheduled_call_at].find((t) => {
    if (!t) return false
    const ms = new Date(t).getTime()
    return Number.isFinite(ms) && ms > Date.now()
  })
  if (booked && !opts?.force) {
    return {
      success: false,
      skipped: true,
      reason: "already_booked",
      error: `A call is already booked for ${new Date(booked).toISOString()}`,
    }
  }

  return placeCallForParticipant(participantId, { guard: false });
}

/**
 * Schedule a call, preferring a direct placement when it is already due.
 *
 * Every caller previously re-implemented this and each one had a different bug:
 * some recorded a due time but never enqueued the QStash message, so the call was
 * "scheduled" in the database and then silently never happened. This is the one
 * path: try now, and on failure persist the due time AND enqueue the callback.
 */
/**
 * May we place an AI screening call for this participant?
 *
 * Kept here rather than at the call sites so a fourth caller cannot invent its
 * own policy by accident.
 */
async function callEligibilityGate(
  participantId: string
): Promise<{ allowed: boolean; reason: string; status: string | null }> {
  const { data } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("status, screening_context")
    .eq("id", participantId)
    .maybeSingle()

  if (!data) return { allowed: false, reason: "participant not found", status: null }

  const ctx = (data.screening_context || {}) as Record<string, any>

  if (ctx.approvalGranted === true) {
    return { allowed: true, reason: "recruiter approved", status: data.status }
  }

  // A hold means a person is mid-decision. Booking over the top of that is how
  // a flagged-for-review candidate ends up being called anyway.
  if (["needs_review", "info_review_pending", "clarification_requested", "rejected"].includes(data.status)) {
    return { allowed: false, reason: `participant is on hold (${data.status})`, status: data.status }
  }

  const decision = ctx.preScreenResult?.decision
  if (decision !== "proceed") {
    return {
      allowed: false,
      reason: `pre-screen has not cleared this candidate (decision: ${decision ?? "none"})`,
      status: data.status,
    }
  }

  if (ctx.awaitingScheduleDecision !== true) {
    return {
      allowed: false,
      reason: "no slot was offered after pre-screen cleared",
      status: data.status,
    }
  }

  return { allowed: true, reason: "pre-screen cleared and slot offered", status: data.status }
}

export async function scheduleOrPlaceCall(
  participantId: string,
  delaySeconds: number
): Promise<PlaceCallResult & { scheduled?: boolean }> {
  const delay = Math.max(0, Math.round(delaySeconds))

  // Last line of defence before a real phone call happens.
  //
  // Three call sites existed and each had its own idea of when calling was
  // allowed: a pre-screen approval endpoint, the webhook's intent dispatcher,
  // and the form flow when a slot was picked. Whichever one a change reached
  // decided the policy by accident, and the slot flow placed calls with no
  // requirement check at all — the chain was pre-screen -> picker -> tap ->
  // call, so tapping a button was the only approval that ever happened.
  //
  // There are exactly two doors:
  //
  //   1. A recruiter approved them. Explicit and authoritative.
  //   2. Pre-screen cleared them against the job requirement, and we sent a slot
  //      picker afterwards. Evidence-based, so the candidate can self-serve.
  //
  // Anything else is refused, including a scheduling intent the AI inferred from
  // free text. Interest is not consent to be called, and an LLM's confidence
  // score is not a decision.
  const gate = await callEligibilityGate(participantId)
  if (!gate.allowed) {
    logger.warn("Refusing to place AI call — eligibility gate closed", {
      participantId,
      reason: gate.reason,
      status: gate.status,
    })
    return { success: false, skipped: false, scheduled: false, error: gate.reason }
  }

  if (delay <= DIRECT_PLACE_WINDOW_SECONDS) {
    const placed = await placeCallImmediately(participantId)
    if (placed.success || placed.skipped) return placed

    // Direct placement failed — book a real callback so this is never lost.
    const dueAt = new Date(Date.now() + CALLBACK_RETRY_DELAY_SECONDS * 1000).toISOString()
    const { error: bookErr } = await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "call_scheduled",
        scheduled_call_at: dueAt,
        next_retry_at: dueAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", participantId)

    const scheduled = await scheduleBolnaCall(participantId, CALLBACK_RETRY_DELAY_SECONDS)

    // If the enqueue itself failed there is nothing waiting to fire. Leaving the
    // row as "call_scheduled" would show HR a booked call that can never happen —
    // exactly the silent stranding this function exists to prevent. Fail the row
    // instead so it surfaces as "no call placed" and HR can retry.
    if (!scheduled.scheduled) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "failed",
          scheduled_call_at: null,
          next_retry_at: null,
          callback_preference: `Call callback could not be queued: ${scheduled.error || "QStash publish failed"}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", participantId)
      logger.error("Call callback could not be queued", { participantId, error: scheduled.error })
    }

    // A failed booking write means the QStash message will fire into a row whose
    // guard rejects it ("Callback not due yet"), so the candidate is never
    // dialled. Surface it rather than returning a normal result.
    if (bookErr) {
      logger.error("Failed to persist booked callback — call will not fire", {
        participantId,
        error: bookErr.message,
      })
      return { success: false, scheduled: false, error: `Could not book callback: ${bookErr.message}` }
    }

    return {
      success: false,
      scheduled: scheduled.scheduled,
      error: scheduled.error || placed.error,
    }
  }

  const dueAt = new Date(Date.now() + delay * 1000).toISOString()
  const { error: bookErr } = await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      status: "call_scheduled",
      scheduled_call_at: dueAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", participantId)

  const result = await scheduleBolnaCall(participantId, delay)

  // Same stranding risk on the delayed path: only keep the booked state if the
  // QStash message actually exists to deliver it.
  if (!result.scheduled) {
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "failed",
        scheduled_call_at: null,
        callback_preference: `Call could not be scheduled: ${result.error || "QStash publish failed"}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", participantId)
    logger.error("Call could not be scheduled", { participantId, delaySec: delay, error: result.error })
  }

  if (bookErr) {
    logger.error("Failed to persist scheduled call — callback will not fire", {
      participantId,
      delaySec: delay,
      error: bookErr.message,
    })
    return { success: false, scheduled: false, error: `Could not schedule call: ${bookErr.message}` }
  }

  return { success: false, scheduled: result.scheduled, error: result.error }
}
