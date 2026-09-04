import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { triggerOutboundCall } from "@/lib/plivo"
import { logger } from "@/lib/logger"
import { logCandidateActivity } from "@/lib/activity-logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const messageUuid = body.message_uuid || body.MessageUUID

    if (!messageUuid) {
      return NextResponse.json({ status: "ok" })
    }

    const { data: participants, error: findError } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, candidate_id, job_id, status, origin,
        candidates: candidate_id (id, name, phone, current_role, current_company, total_experience, location, technical_skills),
        jobs: job_id (id, title, client_name, skills_must_have, experience_min_years, experience_max_years)
      `)
      .eq("whatsapp_message_id", messageUuid)

    if (findError || !participants || participants.length === 0) {
      logger.info("WhatsApp webhook: no matching participant", { messageUuid })
      return NextResponse.json({ status: "ok" })
    }

    const participant = participants[0] as any

    const messageStatus = body.status || body.MessageStatus
    if (messageStatus === "delivered") {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({ status: "whatsapp_delivered", updated_at: new Date().toISOString() })
        .eq("id", participant.id)
      logCandidateActivity({
        jobId: participant.job_id,
        candidateId: participant.candidate_id,
        participantId: participant.id,
        eventType: "whatsapp_delivered",
      })
      return NextResponse.json({ status: "ok" })
    }

    if (messageStatus === "read") {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({ status: "whatsapp_read", updated_at: new Date().toISOString() })
        .eq("id", participant.id)
      logCandidateActivity({
        jobId: participant.job_id,
        candidateId: participant.candidate_id,
        participantId: participant.id,
        eventType: "whatsapp_read",
      })
      return NextResponse.json({ status: "ok" })
    }

    const buttonId = body.interactive?.button_reply?.id || body.ButtonReply?.id

    if (!buttonId) {
      return NextResponse.json({ status: "ok" })
    }

    const candidate = participant.candidates
    const job = participant.jobs

    if (buttonId === "call_me_now") {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "call_me_now",
          whatsapp_response: "call_me_now",
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)

      logCandidateActivity({
        jobId: participant.job_id,
        candidateId: participant.candidate_id,
        participantId: participant.id,
        eventType: "whatsapp_replied",
        eventData: { button: "call_me_now" },
      })

      const callResult = await triggerOutboundCall({
        to: candidate.phone,
        candidateName: candidate.name,
        candidateProfile: {
          id: candidate.id,
          name: candidate.name,
          current_role: candidate.current_role,
          current_company: candidate.current_company,
          total_experience: candidate.total_experience,
          location: candidate.location,
          skills: candidate.technical_skills,
        },
        jobDetails: {
          id: job.id,
          title: job.title,
          client_name: job.client_name,
          must_have_skills: job.skills_must_have,
          experience_min: job.experience_min_years,
          experience_max: job.experience_max_years,
        },
        origin: participant.origin === "outbound" ? "outbound" : "inbound",
      })

      if (callResult.success) {
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: "calling",
            plivo_call_uuid: callResult.requestUuid,
            call_attempts: 1,
            last_attempt_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", participant.id)
      } else {
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: "failed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", participant.id)
      }
    } else if (buttonId === "schedule_call") {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "scheduled",
          whatsapp_response: "schedule",
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)
      logCandidateActivity({
        jobId: participant.job_id,
        candidateId: participant.candidate_id,
        participantId: participant.id,
        eventType: "whatsapp_replied",
        eventData: { button: "schedule_call" },
      })
    } else if (buttonId === "not_interested") {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "not_interested",
          whatsapp_response: "not_interested",
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)
      logCandidateActivity({
        jobId: participant.job_id,
        candidateId: participant.candidate_id,
        participantId: participant.id,
        eventType: "whatsapp_replied",
        eventData: { button: "not_interested" },
      })
    }

    return NextResponse.json({ status: "ok" })
  } catch (error: any) {
    logger.error("WhatsApp webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}
