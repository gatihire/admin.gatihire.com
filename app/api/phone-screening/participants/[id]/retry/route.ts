import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { placeBolnaCall } from "@/lib/bolna"
import { logger } from "@/lib/logger"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import { logCandidateActivity } from "@/lib/activity-logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params

    const { data: participant, error: pError } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, candidate_id, job_id, status, call_payload_json, bolna_execution_id,
        call_attempts, retry_count,
        candidates: candidate_id (id, name, phone),
        jobs: job_id (id, title, client_name)
      `)
      .eq("id", id)
      .single()

    if (pError || !participant) {
      return NextResponse.json({ error: "Participant not found" }, { status: 404 })
    }

    // Handle the joined relations which come as arrays
    const candidate = Array.isArray(participant.candidates) ? participant.candidates[0] : participant.candidates
    const job = Array.isArray(participant.jobs) ? participant.jobs[0] : participant.jobs

    // Only allow retry for terminal/failed states
    const retryableStatuses = ["failed", "unreachable", "failed_partial", "completed", "call_scheduled"]
    if (!retryableStatuses.includes(participant.status)) {
      return NextResponse.json({ error: `Cannot retry participant in status: ${participant.status}` }, { status: 400 })
    }

    if (!participant.call_payload_json || Object.keys(participant.call_payload_json).length === 0) {
      return NextResponse.json({ error: "No stored call payload for retry" }, { status: 400 })
    }

    if (!candidate?.phone) {
      return NextResponse.json({ error: "Candidate has no phone number" }, { status: 400 })
    }

    const userData = { ...participant.call_payload_json, participant_id: participant.id, retry: true }
    const result = await placeBolnaCall({ to: candidate.phone, userData })

    if (!result.success || !result.executionId) {
      return NextResponse.json({ error: result.error || "Failed to place retry call" }, { status: 500 })
    }

    const now = new Date().toISOString()
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "calling",
        bolna_execution_id: result.executionId,
        bolna_status: "queued",
        call_attempts: (participant.call_attempts || 0) + 1,
        retry_count: 0,
        last_attempt_at: now,
        next_retry_at: null,
        scheduled_call_at: null,
        review_status: "pending",
        updated_at: now,
      })
      .eq("id", participant.id)

    // Schedule follow-up nudge/escalate
    await scheduleBolnaCall(participant.id, 4 * 60 * 60) // nudge at 4 hours
    await scheduleBolnaCall(participant.id, 24 * 60 * 60) // escalate at 24 hours

logCandidateActivity({
    jobId: job?.id || "",
    candidateId: participant.candidate_id,
    participantId: participant.id,
    eventType: "call_attempted",
    eventData: { bolna_execution_id: result.executionId, manual: true, actor: ctx.authUser.id },
    actor: ctx.authUser.id,
  })

    return NextResponse.json({ success: true, executionId: result.executionId })
  } catch (error: any) {
    logger.error("Retry call failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error", details: error.message }, { status: 500 })
  }
}