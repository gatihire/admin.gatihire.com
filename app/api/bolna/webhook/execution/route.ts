import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { verifyBolnaWebhook, BOLNA_TERMINAL_STATUSES, type BolnaExecution } from "@/lib/bolna"
import {
  findParticipant,
  handleCompletedExecution,
  handleFailedExecution,
  resolveSyncTarget,
  persistBolnaExecutionId,
} from "@/lib/bolna-execution"
import { logCandidateActivity } from "@/lib/activity-logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const headers = request.headers
    const bodyText = await request.text().catch(() => "")
    if (!verifyBolnaWebhook(request, headers, bodyText)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    let payload: BolnaExecution
    try {
      payload = JSON.parse(bodyText || "{}")
    } catch {
      return NextResponse.json({ status: "ok" })
    }
    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ status: "ok" })
    }

    const status = payload.status || ""

    // Use robust participant resolution (execution ID + phone + context fallback)
    const { participant, execution: resolvedExecution } = await resolveSyncTarget({
      executionId: payload.id,
      phone: payload.telephony_data?.to_number || (payload as any).user_number || null,
    })

    if (!participant) {
      logger.warn("Bolna webhook: no participant found", { executionId: payload.id })
      return NextResponse.json({ status: "ok" })
    }

    const execution = resolvedExecution || payload

    // Persist execution ID if missing
    if (execution.id && participant.id) {
      await persistBolnaExecutionId(participant.id, execution.id)
    }

    if (!BOLNA_TERMINAL_STATUSES.has(status)) {
      // Some "non-terminal" webhook statuses (e.g. call-disconnected) can arrive
      // with completion data, or the true terminal webhook may be missed. If we
      // have enough data to finalize, do it now to avoid stuck in_progress records.
      const hasCompletionData = Boolean(
        execution.transcript ||
        execution.extracted_data ||
        execution.telephony_data?.recording_url ||
        (execution as any).recording_url
      )
      const looksDisconnected = /disconnect|ended|hangup/i.test(status || "")
      if (hasCompletionData || looksDisconnected) {
        // Prefer treating as completed when we have data; otherwise let the
        // completed/failed handlers decide based on execution details.
        if (hasCompletionData) {
          await handleCompletedExecution(participant.id, execution)
        } else {
          // Disconnected without data in payload - check if Bolna has more info
          // by reusing the resolved execution; if still ambiguous, mark failed.
          if (execution.transcript || execution.extracted_data || execution.telephony_data?.recording_url) {
            await handleCompletedExecution(participant.id, execution)
          } else {
            await handleFailedExecution(participant as any, execution)
          }
        }
        return NextResponse.json({ status: "ok" })
      }

      // Intermediate status — keep bolna_status fresh.
      const patch: Record<string, unknown> = {
        bolna_status: status,
        updated_at: new Date().toISOString(),
      }
      if (status === "in-progress") {
        patch.status = "in_progress"
        patch.call_started_at = new Date().toISOString()
        logCandidateActivity({
          jobId: participant.jobs?.id || "",
          candidateId: participant.candidates?.id || "",
          participantId: participant.id,
          eventType: "call_in_progress",
          eventData: { bolna_status: status },
        })
      } else if (status === "initiated" || status === "ringing") {
        patch.status = "calling"
        logCandidateActivity({
          jobId: participant.jobs?.id || "",
          candidateId: participant.candidates?.id || "",
          participantId: participant.id,
          eventType: "call_attempted",
          eventData: { bolna_status: status },
        })
      }
      await supabaseAdmin
        .from("phone_screening_participants")
        .update(patch)
        .eq("id", participant.id)
      return NextResponse.json({ status: "ok" })
    }

    if (status === "completed") {
      await handleCompletedExecution(participant.id, execution)
    } else {
      // For completed calls that come as different statuses, still try to handle as completed if they have transcript/extracted data
      if (execution.transcript || execution.extracted_data) {
        await handleCompletedExecution(participant.id, execution)
      } else {
        await handleFailedExecution(participant as any, execution)
      }
    }

    return NextResponse.json({ status: "ok" })
  } catch (error: any) {
    logger.error("Bolna execution webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}