import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { getWhatsAppService } from "@/lib/whatsapp"
import { appendWhatsappHistory } from "@/lib/whatsapp-history"
import { logCandidateActivity } from "@/lib/activity-logger"

export const runtime = "nodejs"

/**
 * Remind a candidate to respond, without recording any screening decision.
 *
 * The review queue offered exactly three actions and all of them moved the row:
 * approve booked a call, reject ended the process, and clarify committed the
 * recruiter to waiting on an answer. So a recruiter who simply wanted to prompt
 * someone again — a very common instinct, because candidates go quiet — had no
 * button for it and had to close the modal and find another screen.
 *
 * This is intentionally non-committal. It sends the call nudge, records the
 * message in the thread, and leaves status, review_status and the pre-screen
 * flags exactly as they were, so the candidate stays in the queue.
 */
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
        id, candidate_id, job_id, status, scheduled_call_at,
        candidates: candidate_id (id, name, phone),
        jobs: job_id (id, title, client_name, city)
      `)
      .eq("id", id)
      .single()

    if (pError || !participant) {
      return NextResponse.json({ error: "Participant not found", reason: "not_found" }, { status: 404 })
    }

    const candidate = Array.isArray(participant.candidates)
      ? participant.candidates[0]
      : (participant.candidates as any)
    const job = Array.isArray(participant.jobs) ? participant.jobs[0] : (participant.jobs as any)

    if (!candidate?.phone) {
      return NextResponse.json({ error: "Candidate has no phone number", reason: "no_phone" }, { status: 400 })
    }

    // A call must actually exist before we tell one is coming.
    //
    // This endpoint sent unconditionally, so "Send call nudge" from the review
    // modal promised the candidate a call that nothing had scheduled:
    //
    //   15:04:12  "our Senior AI Agent will call you shortly... Please answer when
    //              we call. Expect our AI recruiter's call on +918031805503"
    //
    // No call had been approved or booked. The candidate was then asked, three
    // times over the next minute, whether they wanted a call. A recruiter reading
    // a decline message at 15:01:53 and a call promise at 15:04:12 on the same
    // thread is being shown two systems that do not know about each other.
    const CALL_STATES = ["call_scheduled", "calling", "call_in_progress", "awaiting_call"]
    const callIsReal =
      CALL_STATES.includes(participant.status) ||
      (typeof participant.scheduled_call_at === "string" && participant.scheduled_call_at.length > 0)

    if (!callIsReal) {
      logger.info("call nudge refused — no call scheduled", {
        participantId: id,
        status: participant.status,
      })
      return NextResponse.json(
        {
          error: "No screening call is scheduled for this candidate, so a call reminder would promise something that isn't happening. Approve them for a call first.",
          reason: "no_call_scheduled",
        },
        { status: 409 }
      )
    }

    const sent = await getWhatsAppService().sendCallNudge({
      phoneNumber: candidate.phone,
      candidateName: candidate.name || "",
      jobTitle: job?.title || "",
      companyName: job?.client_name || "",
    })

    // Recorded either way. A nudge a recruiter believes they sent but which never
    // left the building is worse than no nudge at all, because it stops them
    // looking for a reply.
    await appendWhatsappHistory(participant.id, {
      at: new Date().toISOString(),
      kind: "hr_call_nudge",
      direction: "out",
      template: process.env.WHATSAPP_TEMPLATE_CALL_NUDGE || "call_nudge",
      text: `Reminder sent to ${candidate.name || "the candidate"} to continue.`,
      status: sent.success ? "sent" : "failed",
      messageId: sent.messageId ?? null,
      error: sent.success ? null : sent.error ?? null,
      sentBy: ctx.authUser.id,
    })

    if (!sent.success) {
      logger.error("HR call nudge failed", {
        participantId: participant.id,
        candidateId: participant.candidate_id,
        error: sent.error,
      })
      return NextResponse.json(
        { error: sent.error || "Failed to send nudge", reason: "send_failed" },
        { status: 502 }
      )
    }

    // Deliberately NOT updating status or review_status here.
    logCandidateActivity({
      jobId: participant.job_id || "",
      candidateId: participant.candidate_id,
      participantId: participant.id,
      eventType: "whatsapp_sent",
      eventData: {
        channel: "call_nudge_manual",
        messageId: sent.messageId ?? null,
        previousStatus: participant.status,
      },
      actor: ctx.authUser.id,
    })

    return NextResponse.json({ success: true, messageId: sent.messageId ?? null })
  } catch (error: any) {
    logger.error("HR call nudge error", { error: error?.message })
    return NextResponse.json({ error: "Internal Server Error", details: error?.message }, { status: 500 })
  }
}
