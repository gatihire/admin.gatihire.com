import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"

import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { getBolnaExecution, BOLNA_TERMINAL_STATUSES } from "@/lib/bolna"
import {
  resolveSyncTarget,
  persistBolnaExecutionId,
  handleCompletedExecution,
  handleFailedExecution,
} from "@/lib/bolna-execution"
import { updateParticipantSafely } from "@/lib/participant-update"

// Auto-heal calls whose terminal webhook never arrived: find participants stuck
// in "calling"/"in_progress" past a threshold, re-fetch the execution from Bolna,
// and re-apply the SAME terminal handling as the webhook (transcript, verdict,
// recording, answers, status) so the UI shows complete results.
//
//  GET /api/bolna/reconcile?dry=1   -> dry-run: what would be healed
//  GET /api/bolna/reconcile         -> heal everything that needs it
//  GET /api/bolna/reconcile?executionId=<id>&sync=1 -> heal a single execution
//  GET /api/bolna/reconcile?phone=<dial>&sync=1     -> heal by phone
//  GET /api/bolna/reconcile?email=<addr>&sync=1     -> heal by email

// A call row counts as stuck when it is still non-terminal after this long.
const STUCK_AFTER_MINUTES = 3
// A provider call cannot legitimately stay "in progress" this long. If Bolna
// still says so after this, treat it as a stalled call instead of showing
// "on the call now" forever.
const MAX_CALL_MINUTES = 90
// If Bolna has no record of the execution at all after this long, stop waiting.
const UNKNOWN_EXECUTION_MINUTES = 60

const STUCK_STATUSES = [
  "calling",
  "in_progress",
  "in-progress",
  "initiated",
  "queued",
  "ringing",
  "call-disconnected",
  "call_disconnected",
]

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: NextRequest) {
  // Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. Accept that (and
  // an x-cron-secret header for external schedulers) so the healing job can run
  // without a human session. Everyone else still goes through internal auth.
  const cronSecret = process.env.CRON_SECRET || ""
  const authHeader = request.headers.get("authorization") || ""
  const cronHeader = request.headers.get("x-cron-secret") || ""
  const isCron =
    !!cronSecret &&
    (authHeader === `Bearer ${cronSecret}` || cronHeader === cronSecret)

  if (!isCron) {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "candidates.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const dry = request.nextUrl.searchParams.get("dry") === "1"
  const singleExecutionId = request.nextUrl.searchParams.get("executionId") || ""
  const singlePhone = request.nextUrl.searchParams.get("phone") || ""
  const singleEmail = request.nextUrl.searchParams.get("email") || ""

  const singleTarget = singleExecutionId || singlePhone || singleEmail

  try {
    const now = new Date().toISOString()

    // Resolve to a list of { participantId, bolnaExecutionId } to heal.
    let targets: { id: string; bolna_execution_id: string | null }[] = []

    if (singleTarget) {
      const { execution, participant } = await resolveSyncTarget({
        executionId: singleExecutionId,
        phone: singlePhone,
        email: singleEmail,
      })
      if (!participant) {
        return NextResponse.json({
          error: "No matching participant found",
          diagnostics: {
            executionFetched: !!execution,
            executionId: execution?.id || singleExecutionId || null,
            executionStatus: execution?.status || null,
            executionDialedNumber: execution?.telephony_data?.to_number || (execution as any)?.user_number || null,
            contextParticipantId: execution?.context_details?.participant_id || null,
          },
        }, { status: 404 })
      }
      targets.push({ id: participant.id, bolna_execution_id: execution?.id || null })
    } else {
      const threshold = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000).toISOString()
      // `updated_at` (not `last_attempt_at`) is the reliable staleness clock:
      // `last_attempt_at` can be null, which used to make rows invisible here.
      const { data: stuck } = await supabaseAdmin
        .from("phone_screening_participants")
        .select("id, bolna_execution_id, status, bolna_status, updated_at, last_attempt_at, call_started_at")
        .not("bolna_execution_id", "is", null)
        .in("status", STUCK_STATUSES)
        .lt("updated_at", threshold)
      targets = (stuck || []).map((s: any) => ({
        id: s.id,
        bolna_execution_id: s.bolna_execution_id || null,
      }))
    }

    if (targets.length === 0) {
      return NextResponse.json({ checked: 0, updated: 0, healed: [], result: "ok" })
    }

    const healed: any[] = []

    for (const target of targets) {
      const execution = target.bolna_execution_id
        ? await getBolnaExecution(target.bolna_execution_id)
        : null

      // Staleness clock: last_attempt_at can be null, so fall back to when the
      // call started (or when the row was last touched).
      const { data: timing } = await supabaseAdmin
        .from("phone_screening_participants")
        .select("updated_at, last_attempt_at, call_started_at")
        .eq("id", target.id)
        .maybeSingle()
      const startedRef = timing?.call_started_at || timing?.last_attempt_at || timing?.updated_at
      const startedMs = startedRef ? new Date(startedRef).getTime() : NaN
      const ageMinutes = Number.isFinite(startedMs) ? (Date.now() - startedMs) / 60000 : 0

      // Provider has no record of this execution. Waiting forever is what leaves
      // a card on "On the call now"; after a grace period, surface it for HR.
      if (!execution || !execution.status) {
        if (ageMinutes > UNKNOWN_EXECUTION_MINUTES) {
          const nowIso = new Date().toISOString()
          if (dry) {
            healed.push({ participantId: target.id, executionId: target.bolna_execution_id, result: "would_mark_unknown" })
          } else {
            await updateParticipantSafely(
              target.id,
              {
                status: "failed",
                bolna_status: "unknown",
                needs_manual_followup: true,
                call_ended_at: nowIso,
                ai_summary:
                  "Call status could not be confirmed with the calling provider. No recording or transcript was received. HR should send the call again.",
                verdict_json: {
                  summary: "Call status could not be confirmed with the calling provider.",
                  _classification_outcome: "not_screened",
                  _repair: "reconcile_unknown_execution",
                },
                updated_at: nowIso,
              },
              { source: "reconcile_unknown_execution", executionId: target.bolna_execution_id }
            )
            healed.push({ participantId: target.id, executionId: target.bolna_execution_id, result: "marked_unknown" })
          }
        }
        continue
      }

      if (!BOLNA_TERMINAL_STATUSES.has(execution.status)) {
        // A real call cannot run for 90+ minutes. If the provider still reports
        // in-progress after that, mark it stalled so HR gets an actionable card
        // instead of an endless "On the call now".
        if (ageMinutes > MAX_CALL_MINUTES) {
          const nowIso = new Date().toISOString()
          if (dry) {
            healed.push({ participantId: target.id, executionId: execution.id || null, result: "would_mark_stalled" })
          } else {
            await updateParticipantSafely(
              target.id,
              {
                status: "failed",
                bolna_status: execution.status,
                needs_manual_followup: true,
                call_ended_at: nowIso,
                ai_summary: `The call stayed "${execution.status}" at the provider for over ${MAX_CALL_MINUTES} minutes and never produced an outcome. HR should review and send the call again.`,
                verdict_json: {
                  summary: "Call stalled at the provider with no outcome.",
                  _classification_outcome: "not_screened",
                  _repair: "reconcile_stalled_call",
                },
                updated_at: nowIso,
              },
              { source: "reconcile_stalled_call", executionId: execution.id }
            )
            healed.push({ participantId: target.id, executionId: execution.id || null, result: "marked_stalled" })
          }
        } else if (!dry) {
          // Still genuinely in progress — keep bolna_status fresh, no healing.
          await supabaseAdmin
            .from("phone_screening_participants")
            .update({ bolna_status: execution.status, updated_at: now })
            .eq("id", target.id)
        }
        continue
      }

      const { data: current } = await supabaseAdmin
        .from("phone_screening_participants")
        .select("id, status, verdict_json, recording_url")
        .eq("id", target.id)
        .maybeSingle()

      // Idempotency: don't clobber a call that already has its verdict stored.
      const alreadySynced =
        current?.status === "completed" && (current.verdict_json || current.recording_url)

      if (dry) {
        healed.push({ participantId: target.id, executionId: execution.id || null, status: execution.status, wouldSync: !alreadySynced })
        continue
      }

      if (alreadySynced) {
        healed.push({ participantId: target.id, executionId: execution.id || null, status: execution.status, alreadySynced: true })
        continue
      }

      if (execution.id) await persistBolnaExecutionId(target.id, execution.id)

      logger.info("Reconcile healing execution", {
        participantId: target.id,
        executionId: execution.id,
        bolnaStatus: execution.status,
      })

      if (execution.status === "completed") {
        await handleCompletedExecution(target.id, execution)
      } else {
        // Resolve the full participant record for retry/failure bookkeeping (bulk + single).
        let participant: any = null
        if (singleTarget) {
          participant = (await resolveSyncTarget({ executionId: singleExecutionId, phone: singlePhone, email: singleEmail })).participant
        } else {
          const { data: p } = await supabaseAdmin
            .from("phone_screening_participants")
            .select(`id, status, call_attempts, retry_count, whatsapp_missed_nudge_sent, whatsapp_history,
              candidates: candidate_id (id, name, phone),
              jobs: job_id (id, title, client_name)`)
            .eq("id", target.id)
            .maybeSingle()
          participant = p
        }
        if (participant) {
          await handleFailedExecution(participant as any, execution)
        } else {
          logger.warn("Reconcile: participant not found for failed execution", { participantId: target.id, executionId: execution.id })
        }
      }
      healed.push({ participantId: target.id, executionId: execution.id || null, status: execution.status })
    }

    return NextResponse.json({ checked: targets.length, healed, result: dry ? "dry-run" : "ok" })
  } catch (error: any) {
    logger.error("Bolna reconcile failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}