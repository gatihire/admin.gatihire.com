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

const STUCK_AFTER_MINUTES = 3

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

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
      const { data: stuck } = await supabaseAdmin
        .from("phone_screening_participants")
        .select("id, bolna_execution_id, status, bolna_status")
        .not("bolna_execution_id", "is", null)
        .in("status", ["calling", "in_progress"])
        .lt("last_attempt_at", threshold)
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
      if (!execution || !execution.status) continue

      if (!BOLNA_TERMINAL_STATUSES.has(execution.status)) {
        // Still in progress on Bolna's side — keep bolna_status fresh, no healing.
        if (!dry) {
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
        // Resolve the full participant record for retry bookkeeping.
        const participant = singleTarget
          ? (await resolveSyncTarget({ executionId: singleExecutionId, phone: singlePhone, email: singleEmail })).participant
          : null
        if (participant) {
          await handleFailedExecution(participant as any, execution)
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