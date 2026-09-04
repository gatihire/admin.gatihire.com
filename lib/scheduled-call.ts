// Event-driven call scheduling with QStash (Upstash).
// Replaces the old 5-minute cron polling:
//  - WhatsApp outreach publishes nudge / human-escalation messages at +4h / +8h,
//  - an opted-in candidate schedules their own call (call_scheduled),
//  - a failed call schedules its own retry at the right time.
// All scheduling is "publish a JSON message to our own endpoint"; QStash delivers
// it (roughly) when due, so nothing has to poll the database.

import { Client } from "@upstash/qstash"
import { supabaseAdmin } from "@/lib/supabase"
import { placeBolnaCall } from "@/lib/bolna"
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
// Max 2 attempts to avoid candidate frustration.
export const MAX_CALL_ATTEMPTS = 2

// QStash accepts delays up to 24 hours.
const MAX_DELAY_SEC = 24 * 60 * 60

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
}

interface ParticipantRow {
  id: string
  status: string
  call_attempts: number
  call_payload_json?: Record<string, unknown> | null
  whatsapp_sent_at?: string | null
  next_retry_at?: string | null
  scheduled_call_at?: string | null
  candidates?: { id: string; name?: string | null; phone?: string | null } | null
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

  const { data: participant, error: partError } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      id, status, call_attempts, call_payload_json,
      whatsapp_sent_at, next_retry_at, scheduled_call_at,
      candidates: candidate_id (id, name, phone)
    `)
    .eq("id", participantId)
    .maybeSingle()

  if (partError || !participant) {
    return { success: false, error: "Participant not found" }
  }

  const row = participant as unknown as ParticipantRow
  const candidate = row.candidates

  if (guard) {
    // No blind calls: only fire when the participant opted in (call_scheduled
    // or scheduled with an elapsed time) or a retry window for an already-attempted
    // call has passed (failed). whatsapp_sent alone NEVER triggers a call.
    if (row.status === "call_scheduled" || row.status === "scheduled") {
      const scheduledTime = row.scheduled_call_at || row.next_retry_at
      if (!scheduledTime || new Date(scheduledTime).getTime() > Date.now()) {
        return { success: false, skipped: true, error: "Callback not due yet" }
      }
    } else if (row.status === "failed") {
      if (row.call_attempts >= MAX_CALL_ATTEMPTS) {
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ bolna_status: "max_retries", updated_at: new Date().toISOString() })
          .eq("id", participantId)
        return { success: false, skipped: true, error: "Max attempts reached" }
      }
      if (!row.next_retry_at || new Date(row.next_retry_at).getTime() > Date.now()) {
        return { success: false, skipped: true, error: "Retry not due yet" }
      }
    } else {
      return { success: false, skipped: true, error: `Participant no longer waiting (${row.status})` }
    }
  }

  if (!candidate?.phone) {
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", participantId)
    return { success: false, error: "Candidate has no phone number" }
  }

  const payload = row.call_payload_json
  const userData =
    payload && Object.keys(payload).length > 0
      ? { ...payload, participant_id: participantId }
      : { candidate_name: candidate.name || "", participant_id: participantId }

  const result = await placeBolnaCall({
    to: candidate.phone,
    userData,
  })

  if (!result.success || !result.executionId) {
    // Leave the participant untouched so an at-least-once QStash retry can re-run
    // this step cleanly.
    return { success: false, error: result.error || "Failed to place call" }
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
