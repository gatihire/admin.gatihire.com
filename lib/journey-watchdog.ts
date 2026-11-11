import { supabaseAdmin } from "@/lib/supabase"
import { redis } from "@/lib/redis"
import {
  placeCallForParticipant,
  placeCallImmediately,
  MAX_TOTAL_CALL_ATTEMPTS,
} from "@/lib/scheduled-call"
import { getBolnaExecution, BOLNA_TERMINAL_STATUSES } from "@/lib/bolna"
import { updateParticipantSafely } from "@/lib/participant-update"
import { logger } from "@/lib/logger"

/**
 * The journey watchdog.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The candidate journey is: WhatsApp → candidate replies → AI screens by
 * call → recruiter decides. Every step in that chain was driven by a ONE-SHOT
 * QStash message.
 *
 * A one-shot message is a single point of failure with no recovery:
 *  - if the publish failed (a bad token, a network blip), the step never
 *    happened and nothing recorded that it was supposed to;
 *  - if the message was delivered but the signature check rejected it (wrong
 *    signing key), the endpoint 401'd and the step never happened;
 *  - if the guard inside the endpoint refused the row (it had already moved
 *    on), the step never happened — and the row kept saying it was pending.
 *
 * In every one of those cases the row simply STOPPED. The candidate was never
 * called. The recruiter was never told. Nothing noticed, because nothing was
 * watching — the reconcile job only looked at rows that already had a provider
 * execution id, so a row that never got a call was invisible to it by
 * construction.
 *
 * This module is that watcher. It is stateless and idempotent: it looks for
 * journeys that have gone quiet and pushes them forward exactly one step.
 */

// ── Thresholds ──────────────────────────────────────────────────────────────

/**
 * A call booked for a time that has passed should have fired within minutes.
 * Ten minutes of grace covers QStash's own delivery jitter.
 */
const BOOKED_CALL_GRACE_MINUTES = 10

/**
 * After this long with no WhatsApp reply and no call placed, the candidate has
 * gone quiet. The WhatsApp message was the SOFT ask; the call is the real one.
 * If they ignored the message, we call them.
 */
const SILENCE_CALL_AFTER_HOURS = 12

/**
 * After this long they have moved on. Do NOT cold-call them — that is both
 * wasted spend and a harassment risk. Hand them to HR to close out instead.
 */
const GONE_COLD_AFTER_HOURS = 48

/**
 * A candidate who explicitly PICKED a call slot deserves that call for longer
 * than one who ignored a WhatsApp — they said yes, we just never dialled. So a
 * booked call is still worth placing for up to a week after the slot passed.
 * Beyond that it is a cold call, and cold calls are not worth making.
 */
const BOOKED_CALL_MAX_AGE_HOURS = 168

/**
 * A call cannot legitimately still be "in progress" after this long. If the
 * provider has not produced an outcome by then, the row is stuck and the
 * recruiter is staring at an endless "On the call now".
 */
const MAX_CALL_MINUTES = 90

/**
 * How many rows one sweep may act on per bucket. A sweep that dialled 300
 * people at once would be a spend spike and a complaint waiting to happen.
 * The next sweep picks up the rest.
 */
const MAX_PER_BUCKET = 5

export type JourneyBucket =
  | "booked_not_fired"     // a call was booked for a time that passed — never placed
  | "retry_overdue"        // a retry was booked for a time that passed — never placed
  | "silent_no_call"       // WhatsApp sent, no reply, no call ever — call them
  | "gone_cold"            // silent for too long — do not cold-call, hand to HR
  | "in_flight_stuck"      // a call stuck "in progress" — resolve it with the provider

export interface JourneySweepResult {
  scanned: number
  callsPlaced: number
  callsFailed: number
  flaggedForHr: number
  details: Array<{ participantId: string; bucket: JourneyBucket; outcome: string }>
}

type Row = {
  id: string
  status: string
  call_attempts: number
  scheduled_call_at?: string | null
  next_retry_at?: string | null
  whatsapp_sent_at?: string | null
  updated_at?: string | null
}

/**
 * Place a call for a row that should have been called already.
 *
 * `placeCallForParticipant` owns the attempt counter, the "already with the
 * provider" check and the hard attempt cap, so both paths go through it
 * rather than calling Bolna directly.
 */
async function placeNow(participantId: string, guarded: boolean): Promise<{ ok: boolean; reason?: string }> {
  try {
    const result = guarded
      ? await placeCallForParticipant(participantId, { guard: true })
      : await placeCallImmediately(participantId)

    if (result.success) return { ok: true }
    if (result.skipped) return { ok: false, reason: result.reason || result.error || "skipped" }
    return { ok: false, reason: result.error || result.reason || "failed" }
  } catch (err: any) {
    return { ok: false, reason: err?.message || "exception" }
  }
}

/**
 * One pass of the watchdog.
 *
 * `dry` reports what WOULD happen without touching anything — the same shape
 * the reconcile endpoint uses, so both can be checked from a browser.
 */
export async function sweepJourney(opts?: {
  dry?: boolean
  buckets?: JourneyBucket[]
}): Promise<JourneySweepResult> {
  const dry = opts?.dry === true
  const want = new Set(opts?.buckets || (["booked_not_fired", "retry_overdue", "silent_no_call", "gone_cold", "in_flight_stuck"] as JourneyBucket[]))

  const result: JourneySweepResult = {
    scanned: 0,
    callsPlaced: 0,
    callsFailed: 0,
    flaggedForHr: 0,
    details: [],
  }

  // ── 1. A call was booked for a time that has passed, but no call happened ──
  if (want.has("booked_not_fired")) {
    const { data } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, status, call_attempts, scheduled_call_at, next_retry_at, whatsapp_sent_at, updated_at")
      .in("status", ["call_scheduled", "scheduled"])
      .not("scheduled_call_at", "is", null)
      .lt("scheduled_call_at", new Date(Date.now() - BOOKED_CALL_GRACE_MINUTES * 60 * 1000).toISOString())
      // Older than this the candidate has moved on — that is a cold call, and
      // the gone_cold bucket below closes it out instead.
      .gt("scheduled_call_at", new Date(Date.now() - BOOKED_CALL_MAX_AGE_HOURS * 3600 * 1000).toISOString())
      .lt("call_attempts", MAX_TOTAL_CALL_ATTEMPTS)
      .order("scheduled_call_at", { ascending: true })
      .limit(MAX_PER_BUCKET)

    for (const row of (data || []) as Row[]) {
      result.scanned++
      if (dry) {
        result.details.push({ participantId: row.id, bucket: "booked_not_fired", outcome: "would_place_call" })
        continue
      }
      const r = await placeNow(row.id, true)
      if (r.ok) {
        result.callsPlaced++
        result.details.push({ participantId: row.id, bucket: "booked_not_fired", outcome: "call_placed" })
      } else {
        result.callsFailed++
        result.details.push({ participantId: row.id, bucket: "booked_not_fired", outcome: `not_placed:${r.reason}` })
      }
    }
  }

  // ── 2. A retry was booked for a time that has passed, but never fired ──
  if (want.has("retry_overdue")) {
    const { data } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, status, call_attempts, scheduled_call_at, next_retry_at, whatsapp_sent_at, updated_at")
      .eq("status", "failed")
      .not("next_retry_at", "is", null)
      .lt("next_retry_at", new Date(Date.now() - BOOKED_CALL_GRACE_MINUTES * 60 * 1000).toISOString())
      // PostgREST's negated `is` maps to SQL `IS DISTINCT FROM`, so a NULL
      // bolna_status (the attempt never got a provider verdict) is included.
      // A plain `<>` would skip every such row — which is exactly the set that
      // needed rescuing.
      .not("bolna_status", "is", "max_retries")
      .lt("call_attempts", MAX_TOTAL_CALL_ATTEMPTS)
      .order("next_retry_at", { ascending: true })
      .limit(MAX_PER_BUCKET)

    for (const row of (data || []) as Row[]) {
      result.scanned++
      if (dry) {
        result.details.push({ participantId: row.id, bucket: "retry_overdue", outcome: "would_place_call" })
        continue
      }
      const r = await placeNow(row.id, true)
      if (r.ok) {
        result.callsPlaced++
        result.details.push({ participantId: row.id, bucket: "retry_overdue", outcome: "call_placed" })
      } else {
        result.callsFailed++
        result.details.push({ participantId: row.id, bucket: "retry_overdue", outcome: `not_placed:${r.reason}` })
      }
    }
  }

  // ── 3. WhatsApp went out, no reply, and no call was ever made ──
  // This is the dead-end that swallowed 295 candidates: the escalation ladder
  // was supposed to hand them to a recruiter, and it did — but it never
  // actually CALLED anyone, so "escalate" just meant "sit here forever".
  if (want.has("silent_no_call")) {
    const since = new Date(Date.now() - SILENCE_CALL_AFTER_HOURS * 3600 * 1000).toISOString()
    const until = new Date(Date.now() - GONE_COLD_AFTER_HOURS * 3600 * 1000).toISOString()

    const { data } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, status, call_attempts, scheduled_call_at, next_retry_at, whatsapp_sent_at, updated_at")
      .in("status", [
        "whatsapp_sent",
        "whatsapp_delivered",
        "whatsapp_read",
        "info_requested",
        "info_received",
        "interested",
      ])
      .eq("call_attempts", 0)
      .is("whatsapp_reply_at", null)
      .is("whatsapp_reply_text", null)
      .lt("updated_at", since)
      .gt("updated_at", until)
      .order("updated_at", { ascending: true })
      .limit(MAX_PER_BUCKET)

    for (const row of (data || []) as Row[]) {
      result.scanned++
      if (dry) {
        result.details.push({ participantId: row.id, bucket: "silent_no_call", outcome: "would_place_call" })
        continue
      }
      // Unguarded: the candidate already agreed to talk by giving us a number
      // and not opting out. The eligibility gate exists to stop an LLM from
      // inventing consent for a call it inferred from free text — it does not
      // apply to a proactive outbound screen we already invited them to.
      const r = await placeNow(row.id, false)
      if (r.ok) {
        result.callsPlaced++
        result.details.push({ participantId: row.id, bucket: "silent_no_call", outcome: "call_placed" })
      } else {
        result.callsFailed++
        result.details.push({ participantId: row.id, bucket: "silent_no_call", outcome: `not_placed:${r.reason}` })
      }
    }
  }

  // ── 4. Silent for too long — hand to HR rather than cold-call ──
  if (want.has("gone_cold")) {
    const until = new Date(Date.now() - GONE_COLD_AFTER_HOURS * 3600 * 1000).toISOString()

    const { data } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, status, call_attempts, scheduled_call_at, next_retry_at, whatsapp_sent_at, updated_at, screening_context")
      .in("status", [
        "whatsapp_sent",
        "whatsapp_delivered",
        "whatsapp_read",
        "info_requested",
        "info_received",
        "needs_manual_followup",
        // A booked call that is now too old to place cold.
        "call_scheduled",
        "scheduled",
      ])
      .eq("call_attempts", 0)
      .is("whatsapp_reply_at", null)
      .lt("updated_at", until)
      .order("updated_at", { ascending: true })
      .limit(MAX_PER_BUCKET)

    for (const row of (data || []) as Row[]) {
      result.scanned++
      if (dry) {
        result.details.push({ participantId: row.id, bucket: "gone_cold", outcome: "would_flag_for_hr" })
        continue
      }
      const nowIso = new Date().toISOString()
      await updateParticipantSafely(
        row.id,
        {
          status: "needs_manual_followup",
          needs_manual_followup: true,
          // The reason is stored on the row so every surface that shows this
          // candidate explains WHY it is sitting there, instead of the generic
          // "flagged for a human" that hid 295 dead cases.
          screening_context: {
            ...((row as any).screening_context || {}),
            journeyStalledAt: nowIso,
            journeyStallReason: "gone_cold",
            journeyStallNote:
              "No WhatsApp reply and no screening call was ever placed. Too long to call cold — close this out.",
          },
          updated_at: nowIso,
        },
        { source: "journey_watchdog_gone_cold" }
      )
      result.flaggedForHr++
      result.details.push({ participantId: row.id, bucket: "gone_cold", outcome: "flagged_for_hr" })
    }
  }

  // ── 5. A call stuck "in progress" — resolve it with the provider ──
  //
  // This used to be the reconcile job's only job, and the reconcile job never
  // ran (no CRON_SECRET, and on the Hobby plan a cron runs once a day at
  // best). So a row could sit on "On the call now" indefinitely — which is
  // exactly the "stuck" recruiters kept reporting. The watchdog does it now,
  // and does not depend on the reconcile route being reachable.
  if (want.has("in_flight_stuck")) {
    const threshold = new Date(Date.now() - MAX_CALL_MINUTES * 60 * 1000).toISOString()
    const { data } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, status, call_attempts, bolna_execution_id, updated_at, last_attempt_at, call_started_at")
      .in("status", ["calling", "in_progress", "in-progress", "queued", "ringing", "initiated"])
      .not("bolna_execution_id", "is", null)
      .lt("updated_at", threshold)
      .order("updated_at", { ascending: true })
      .limit(MAX_PER_BUCKET)

    for (const row of (data || []) as any[]) {
      result.scanned++
      if (dry) {
        result.details.push({ participantId: row.id, bucket: "in_flight_stuck", outcome: "would_resolve" })
        continue
      }

      let execution: any = null
      try {
        execution = await getBolnaExecution(row.bolna_execution_id)
      } catch {
        execution = null
      }

      if (execution?.status && BOLNA_TERMINAL_STATUSES.has(String(execution.status).toLowerCase())) {
        // The provider finished and has the transcript + recording — our
        // webhook simply never landed. APPLY the terminal execution so the
        // candidate's screening result, score and summary are written. Marking
        // it "stalled" instead would throw away a 3-minute conversation that
        // already happened.
        try {
          const { handleCompletedExecution, handleFailedExecution } = await import("@/lib/bolna-execution")
          if (execution.status === "completed") {
            await handleCompletedExecution(row.id, execution, { suppressSideEffects: true })
          } else {
            await handleFailedExecution(
              {
                id: row.id,
                call_attempts: row.call_attempts ?? 0,
                retry_count: 0,
                whatsapp_missed_nudge_sent: false,
                whatsapp_history: null,
                candidates: null,
                jobs: null,
              } as any,
              execution
            )
          }
          result.callsPlaced++
          result.details.push({
            participantId: row.id,
            bucket: "in_flight_stuck",
            outcome: `recovered_terminal:${execution.status}`,
          })
        } catch (err: any) {
          result.callsFailed++
          result.details.push({
            participantId: row.id,
            bucket: "in_flight_stuck",
            outcome: `recover_failed:${err?.message || "error"}`,
          })
        }
        continue
      }

      const nowIso = new Date().toISOString()
      await updateParticipantSafely(
        row.id,
        {
          status: "failed",
          bolna_status: execution?.status || "unknown",
          needs_manual_followup: true,
          call_ended_at: nowIso,
          ai_summary: `The call never produced an outcome after ${MAX_CALL_MINUTES} minutes. HR should review and send the call again.`,
          verdict_json: {
            summary: "Call stalled at the provider with no outcome.",
            _classification_outcome: "not_screened",
            _repair: "journey_watchdog_stalled_call",
          },
          updated_at: nowIso,
        },
        { source: "journey_watchdog_stalled_call" }
      )
      result.flaggedForHr++
      result.details.push({ participantId: row.id, bucket: "in_flight_stuck", outcome: "marked_stalled" })
    }
  }

  if (!dry && (result.callsPlaced || result.callsFailed || result.flaggedForHr)) {
    logger.info("Journey watchdog sweep", {
      scanned: result.scanned,
      callsPlaced: result.callsPlaced,
      callsFailed: result.callsFailed,
      flaggedForHr: result.flaggedForHr,
    })
  }

  return result
}

// ── Self-triggering ──────────────────────────────────────────────────────────

/**
 * The watchdog has to run on its own. It cannot depend on a Vercel cron:
 *
 *  - the reconcile cron has never actually run, because `CRON_SECRET` was
 *    never set, so every cron request 401'd;
 *  - on the Vercel Hobby plan a cron runs at most once a DAY regardless of
 *    the five-minute schedule in vercel.json;
 *  - a call that is booked for "now" and never fired has to be rescued in
 *    minutes, not at midnight.
 *
 * So the sweep is triggered opportunistically from the surfaces a recruiter
 * already uses — the Today board loads constantly — behind a throttle that
 * guarantees one sweep per interval across every serverless instance.
 */

/** Minimum gap between two automatic sweeps. */
const SWEEP_INTERVAL_SECONDS = 60

const LOCK_KEY = "gh:journey:watchdog:lock"

/** Fallback throttle when Redis is not configured. */
let lastSweepAt = 0

/**
 * Acquire the sweep lock. Redis gives a cross-instance guarantee; without it
 * we fall back to a per-instance timestamp, which is weaker but still stops
 * one warm lambda from sweeping on every request.
 */
async function acquireSweepLock(): Promise<boolean> {
  if (redis) {
    try {
      const res = await redis.set(LOCK_KEY, "1", { nx: true, ex: SWEEP_INTERVAL_SECONDS })
      // With NX, a successful acquisition returns "OK"; a failed one returns null.
      return res === "OK"
    } catch {
      // Redis is down — fall through to the in-process throttle.
    }
  }
  const now = Date.now()
  if (now - lastSweepAt < SWEEP_INTERVAL_SECONDS * 1000) return false
  lastSweepAt = now
  return true
}

/**
 * Run the watchdog if the throttle allows it. Never throws and never blocks the
 * caller for long — a page load must not wait on a telephony provider.
 */
export async function maybeSweepJourney(opts?: {
  buckets?: JourneyBucket[]
}): Promise<JourneySweepResult | null> {
  try {
    const lock = await acquireSweepLock()
    if (!lock) return null
    return await sweepJourney(opts)
  } catch (err: any) {
    logger.warn("Journey watchdog skipped", { error: err?.message })
    return null
  }
}
