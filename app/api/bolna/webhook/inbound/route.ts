import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { verifyBolnaWebhook } from "@/lib/bolna"
import { placeBolnaCall } from "@/lib/bolna"

export const runtime = "nodejs"

interface InboundCallPayload {
  call_id?: string
  from_number?: string
  to_number?: string
  status?: string
  timestamp?: string
}

async function findParticipantByPhone(phone: string): Promise<{
  id: string
  call_payload_json: Record<string, unknown> | null
  candidate_id: string
  status: string
  call_attempts: number
  candidates: { id: string; name: string; phone: string } | null
  jobs: { id: string; title: string; client_name: string } | null
} | null> {
  const e164Phone = phone.startsWith("+") ? phone : `+${phone.replace(/\D/g, "")}`

  const { data, error } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      id,
      call_payload_json,
      candidate_id,
      status,
      call_attempts,
      candidates:candidate_id (id, name, phone),
      jobs:job_id (id, title, client_name)
    `)
    .eq("candidates.phone", e164Phone)
    .in("status", ["failed", "call_scheduled", "not_interested", "unreachable", "completed"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return data as unknown as {
    id: string
    call_payload_json: Record<string, unknown> | null
    candidate_id: string
    status: string
    call_attempts: number
    candidates: { id: string; name: string; phone: string } | null
    jobs: { id: string; title: string; client_name: string } | null
  }
}

export async function POST(request: NextRequest) {
  try {
    const headers = request.headers
    const bodyText = await request.text().catch(() => "")
    if (!verifyBolnaWebhook(request, headers, bodyText)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    let payload: InboundCallPayload
    try {
      payload = JSON.parse(bodyText || "{}")
    } catch {
      return NextResponse.json({ status: "ok" })
    }

    const fromNumber = payload.from_number || payload.to_number
    if (!fromNumber) {
      logger.warn("Bolna inbound webhook: no from_number")
      return NextResponse.json({ status: "ok" })
    }

    const participant = await findParticipantByPhone(fromNumber)
    if (!participant) {
      logger.info("Bolna inbound: no participant found for number", { fromNumber })
      return NextResponse.json({ status: "ok" })
    }

    const candidate = participant.candidates
    if (!candidate?.phone) {
      logger.warn("Bolna inbound: candidate has no phone", { participantId: participant.id })
      return NextResponse.json({ status: "ok" })
    }

    const now = new Date().toISOString()

    // Reset participant status for new call attempt
    const { error: updateError } = await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "calling",
        bolna_execution_id: null,
        bolna_status: "inbound_triggered",
        call_attempts: (participant.call_attempts || 0) + 1,
        last_attempt_at: now,
        next_retry_at: null,
        scheduled_call_at: null,
        updated_at: now,
      })
      .eq("id", participant.id)

    if (updateError) {
      logger.error("Bolna inbound: failed to update participant", { error: updateError.message })
      return NextResponse.json({ status: "ok" })
    }

    const userData = participant.call_payload_json && Object.keys(participant.call_payload_json).length > 0
      ? { ...participant.call_payload_json, participant_id: participant.id, inbound_resume: true }
      : { candidate_name: candidate.name || "", participant_id: participant.id, inbound_resume: true }

    const result = await placeBolnaCall({
      to: candidate.phone,
      userData,
    })

    if (!result.success || !result.executionId) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "failed",
          updated_at: now,
        })
        .eq("id", participant.id)

      logger.error("Bolna inbound: failed to place call", { participantId: participant.id, error: result.error })
      return NextResponse.json({ status: "ok" })
    }

    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        bolna_execution_id: result.executionId,
        bolna_status: "inbound_started",
        updated_at: now,
      })
      .eq("id", participant.id)

    logger.info("Bolna inbound call triggered", { participantId: participant.id, executionId: result.executionId })

    return NextResponse.json({ status: "ok", executionId: result.executionId })
  } catch (error: any) {
    logger.error("Bolna inbound webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}