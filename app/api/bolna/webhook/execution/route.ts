import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { verifyBolnaWebhook, BOLNA_TERMINAL_STATUSES, type BolnaExecution } from "@/lib/bolna"
import {
  findParticipant,
  handleCompletedExecution,
  handleFailedExecution,
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
    const participant = await findParticipant(payload)

    if (!participant) {
      // Could be a pre-call in-progress webhook with no execution id yet, or a
      // scheduled/queued event before we persisted. Nothing to do.
      return NextResponse.json({ status: "ok" })
    }

    if (!BOLNA_TERMINAL_STATUSES.has(status)) {
      // Intermediate status — keep bolna_status fresh, do nothing else.
      const patch: Record<string, unknown> = {
        bolna_status: status,
        updated_at: new Date().toISOString(),
      }
      if (status === "in-progress") {
        patch.status = "in_progress"
        patch.call_started_at = new Date().toISOString()
        // Log call connected event
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
      await handleCompletedExecution(participant.id, payload)
    } else {
      await handleFailedExecution(participant, payload)
    }

    return NextResponse.json({ status: "ok" })
  } catch (error: any) {
    logger.error("Bolna execution webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}