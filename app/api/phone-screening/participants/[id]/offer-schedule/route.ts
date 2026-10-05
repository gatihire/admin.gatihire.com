import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getWhatsAppService } from "@/lib/whatsapp"
import { recordOutboundText } from "@/lib/whatsapp-thread"
import { logger } from "@/lib/logger"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { invalidateSessionCache } from "@/lib/utils"

/**
 * Recruiter-initiated slot offer.
 *
 * The AI no longer offers a call on its own: interest during a chat is recorded
 * and flagged (`interestNeedsApproval`), and the slot picker is otherwise sent
 * only after pre-screen clears the candidate. This endpoint is the manual third
 * door — the recruiter has looked at the candidate, agreed a call is right, and
 * is asking for the picker to be sent.
 *
 * It records the agreement where the eligibility gate can see it
 * (`approvalGranted`), rather than trusting that the request came from here. That
 * is deliberate: the gate exists so no caller can invent its own policy, so a
 * fourth path that placed calls without leaving that evidence would defeat it.
 *
 * Approval overrides a hold status. A candidate parked for salary mismatch can
 * still be offered a slot by someone who has decided the mismatch is fine —
 * otherwise "flag it" would become "never call them", which is not what flagging
 * is for.
 */
export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params

  const { data: participant, error } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, status, candidates: candidate_id (id, name, phone), jobs: job_id (title, client_name)")
    .eq("id", id)
    .maybeSingle()

  if (error) {
    logger.error("offer-schedule: failed to load participant", { participantId: id, error: error.message })
    return NextResponse.json({ error: "Failed to load candidate" }, { status: 500 })
  }
  if (!participant) {
    return NextResponse.json({ error: "Participant not found" }, { status: 404 })
  }

  const candidate: any = Array.isArray(participant.candidates) ? participant.candidates[0] : participant.candidates
  const job: any = Array.isArray(participant.jobs) ? participant.jobs[0] : participant.jobs

  const phone = candidate?.phone
  if (!phone) {
    return NextResponse.json(
      { error: "This candidate has no phone number on file, so a slot cannot be offered." },
      { status: 400 }
    )
  }

  // Re-offering on top of a live offer means the candidate receives a second
  // picker and cannot tell which one is real.
  const existingCtx = (participant as any).screening_context || {}
  if (existingCtx.awaitingScheduleDecision === true) {
    return NextResponse.json(
      {
        error: "A slot picker is already outstanding for this candidate.",
        alreadyOffered: true,
      },
      { status: 409 }
    )
  }

  const whatsapp = getWhatsAppService()
  const sent = await whatsapp.sendScheduleOptions({
    phoneNumber: phone,
    candidateName: candidate?.name || "Candidate",
    jobTitle: job?.title || "the role",
  })

  if (!sent.success) {
    logger.error("offer-schedule: picker send failed", { participantId: id, error: sent.error })
    return NextResponse.json(
      { error: sent.error || "Failed to send the slot picker" },
      { status: 502 }
    )
  }

  // Record the agreement AND the offer in one write, so the eligibility gate can
  // never see the offer without the approval behind it.
  const { error: updateError } = await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      screening_context: {
        ...existingCtx,
        awaitingScheduleDecision: true,
        scheduleOfferAt: new Date().toISOString(),
        scheduleOfferSource: "recruiter_manual",
        approvalGranted: true,
        approvalSource: "recruiter_manual_offer",
        approvedBy: ctx.authUser?.email ?? ctx.authUser?.id ?? null,
        approvedAt: new Date().toISOString(),
        interestNeedsApproval: false,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)

  if (updateError) {
    logger.error("offer-schedule: failed to record offer", { participantId: id, error: updateError.message })
    return NextResponse.json(
      { error: "Slot picker sent, but the offer could not be recorded. Do not re-send — check the thread." },
      { status: 500 }
    )
  }

  // renderedBody is what Meta accepted, so the recruiter sees the same words the
  // candidate did rather than our paraphrase of them.
  if (sent.renderedBody) {
    await recordOutboundText(id, sent.renderedBody, {
      kind: "schedule_buttons",
      messageId: sent.messageId ?? null,
      direction: "out",
      status: "sent",
    })
  }

  logger.info("offer-schedule: recruiter offered a slot", {
    participantId: id,
    approvedBy: ctx.authUser?.email ?? ctx.authUser?.id ?? null,
    previousStatus: participant.status,
  })

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    logger.error("offer-schedule: unhandled error", { error: err?.message })
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }
}
