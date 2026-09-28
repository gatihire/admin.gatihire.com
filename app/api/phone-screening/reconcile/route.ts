import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import {
  handleCompletedExecution,
  handleFailedExecution,
  resolveSyncTarget,
  persistBolnaExecutionId,
} from "@/lib/bolna-execution"
import { getBolnaExecution, findLatestExecutionByPhone, BOLNA_TERMINAL_STATUSES } from "@/lib/bolna"
import { logCandidateActivity } from "@/lib/activity-logger"

export const runtime = "nodejs"

const STUCK_STATUSES = ["calling", "in_progress", "scheduled", "call_scheduled"]
const MAX_STUCK_MINUTES = 30

export async function POST(request: NextRequest) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { participantId, executionId, phone, email, dryRun } = body

    // If specific target provided, reconcile just that one
    if (participantId || executionId || phone || email) {
      return await reconcileSingle({ executionId, phone, email, dryRun, actor: ctx.authUser.id })
    }

    // Otherwise, bulk reconcile all stuck participants
    return await reconcileStuck(dryRun)
  } catch (error: any) {
    logger.error("Reconcile failed", { error: error.message, stack: error.stack })
    return NextResponse.json({ error: "Internal Server Error", details: error.message }, { status: 500 })
  }
}

async function reconcileSingle(params: {
  executionId?: string
  phone?: string
  email?: string
  dryRun?: boolean
  actor: string
}) {
  const { executionId, phone, email, dryRun, actor } = params
  const result = await resolveSyncTarget({ executionId, phone, email })

  if (!result.participant) {
    return NextResponse.json({ error: "No participant found", tried: { executionId, phone, email } }, { status: 404 })
  }

  if (!result.execution) {
    return NextResponse.json(
      { error: "Participant found but no Bolna execution", participantId: result.participant.id },
      { status: 404 }
    )
  }

  // Persist execution ID if missing
  if (result.execution.id && result.participant.id) {
    await persistBolnaExecutionId(result.participant.id, result.execution.id)
  }

  const status = result.execution.status || ""
  const isTerminal = BOLNA_TERMINAL_STATUSES.has(status)

  if (!isTerminal) {
    return NextResponse.json({
      message: "Execution not in terminal status",
      status,
      participantId: result.participant.id,
    })
  }

  if (dryRun) {
    return NextResponse.json({
      message: "Dry run - would process terminal execution",
      status,
      participantId: result.participant.id,
      executionId: result.execution.id,
    })
  }

  if (status === "completed") {
    await handleCompletedExecution(result.participant.id, result.execution)
  } else {
    await handleFailedExecution(result.participant as any, result.execution)
  }

  logCandidateActivity({
    jobId: result.participant.jobs?.id || "",
    candidateId: result.participant.candidates?.id || "",
    participantId: result.participant.id,
    eventType: "screening_reviewed",
    eventData: { status, executionId: result.execution.id, actor },
    actor,
  })

  return NextResponse.json({
    success: true,
    participantId: result.participant.id,
    status,
    executionId: result.execution.id,
  })
}

async function reconcileStuck(dryRun?: boolean) {
  const cutoff = new Date(Date.now() - MAX_STUCK_MINUTES * 60 * 1000).toISOString()

  // Find participants stuck in calling/in_progress for too long
  const { data: stuckParticipants, error } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      id, status, bolna_execution_id, call_attempts, retry_count, last_attempt_at,
      candidates: candidate_id (id, name, phone),
      jobs: job_id (id, title, client_name)
    `)
    .in("status", STUCK_STATUSES)
    .lt("updated_at", cutoff)

  if (error) {
    logger.error("Reconcile: failed to fetch stuck participants", { error: error.message })
    return NextResponse.json({ error: "Query failed" }, { status: 500 })
  }

  if (!stuckParticipants || stuckParticipants.length === 0) {
    return NextResponse.json({ message: "No stuck participants found", checked: 0 })
  }

  const results: Array<{
    participantId: string
    candidateName: string
    status: string
    action: string
    error?: string
  }> = []

  for (const p of stuckParticipants) {
    try {
      // Handle joined relations which come as arrays
      const candidate = Array.isArray(p.candidates) ? p.candidates[0] : p.candidates
      let execution = null

      // 1. Try stored execution ID
      if (p.bolna_execution_id) {
        execution = await getBolnaExecution(p.bolna_execution_id)
      }

      // 2. Try latest execution by phone
      if (!execution && candidate?.phone) {
        execution = await findLatestExecutionByPhone(candidate.phone)
      }

      if (!execution) {
        // No execution found - mark as failed to allow retry
        if (!dryRun) {
          await supabaseAdmin
            .from("phone_screening_participants")
            .update({
              status: "failed",
              next_retry_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", p.id)
        }
        results.push({
          participantId: p.id,
          candidateName: candidate?.name || "Unknown",
          status: p.status,
          action: "no_execution_found -> marked failed for retry",
        })
        continue
      }

      // Persist execution ID if missing
      if (execution.id && p.id) {
        await persistBolnaExecutionId(p.id, execution.id)
      }

      const execStatus = execution.status || ""
      const isTerminal = BOLNA_TERMINAL_STATUSES.has(execStatus)

      if (!isTerminal) {
        // Still in progress on Bolna side - just update local status
        const patch: Record<string, unknown> = {
          bolna_status: execStatus,
          updated_at: new Date().toISOString(),
        }
        if (execStatus === "in-progress") {
          patch.status = "in_progress"
          patch.call_started_at = new Date().toISOString()
        } else if (execStatus === "initiated" || execStatus === "ringing") {
          patch.status = "calling"
        }
        if (!dryRun) {
          await supabaseAdmin.from("phone_screening_participants").update(patch).eq("id", p.id)
        }
        results.push({
          participantId: p.id,
          candidateName: candidate?.name || "Unknown",
          status: p.status,
          action: `synced to ${execStatus}`,
        })
        continue
      }

      // Terminal execution - process it
      if (!dryRun) {
        if (execStatus === "completed") {
          await handleCompletedExecution(p.id, execution)
        } else {
          await handleFailedExecution(p as any, execution)
        }
      }

      results.push({
        participantId: p.id,
        candidateName: candidate?.name || "Unknown",
        status: p.status,
        action: `processed terminal execution (${execStatus})`,
      })
    } catch (err: any) {
      const candidate = Array.isArray(p.candidates) ? p.candidates[0] : p.candidates
      results.push({
        participantId: p.id,
        candidateName: candidate?.name || "Unknown",
        status: p.status,
        action: "error",
        error: err.message,
      })
    }
  }

  return NextResponse.json({
    message: dryRun ? "Dry run complete" : "Reconciliation complete",
    checked: stuckParticipants.length,
    results,
  })
}