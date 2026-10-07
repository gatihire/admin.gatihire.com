import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { invalidateSessionCache } from "@/lib/utils"
import { logCandidateActivity } from "@/lib/activity-logger"
import { sendSessionMessage } from "@/lib/info-collector-v2"
import { getWhatsAppService } from "@/lib/whatsapp"
import { recordOutboundText } from "@/lib/whatsapp-thread"

export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const { decision, note } = body

    if (decision !== "proceed" && decision !== "filter_out") {
      return NextResponse.json({ error: "decision must be 'proceed' or 'filter_out'" }, { status: 400 })
    }

    const { data: participant, error: pErr } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, job_id, candidate_id, status, screening_context, candidates!inner(phone, name), jobs!inner(title, client_name)")
      .eq("id", id)
      .single()

    if (pErr || !participant) {
      return NextResponse.json({ error: "Participant not found" }, { status: 404 })
    }

    if (participant.status !== "pre_screen_review") {
      return NextResponse.json({ error: "Participant is not in pre-screen review status" }, { status: 400 })
    }

    const now = new Date().toISOString()
    const phoneNumber = (participant.candidates as any)?.phone
    const candidateName = (participant.candidates as any)?.name || 'Candidate'
    const jobTitle = (participant.jobs as any)?.title || ''
    const companyName = (participant.jobs as any)?.client_name || ''

    if (decision === "proceed") {
      // Approval offers the candidate a time. It never takes one for them.
      //
      // This branch used to stamp scheduled_call_at sixty seconds out, tell the
      // candidate a call was already coming, and dial. They never picked a time,
      // so the very first attempt produced:
      //
      //   19:23:11  ✅ Great news! Your profile has been reviewed and approved.
      //             Our AI recruiter will call you shortly ... Expect the call
      //             on <number>. Please keep your phone handy.
      //   19:24:48  We missed you for the Store Incharge screening at Sharepal.
      //             Please select a convenient time to reschedule ...
      //
      // "Select a convenient time" a minute after a call we chose ourselves. The
      // only thing a screening still needs from the candidate is when.
      const prevContext = (participant.screening_context || {}) as Record<string, any>
      const offerSent = phoneNumber
        ? await getWhatsAppService().sendScheduleOptions({
            phoneNumber,
            candidateName,
            jobTitle: jobTitle || "the role",
          })
        : null

      if (phoneNumber && !offerSent?.success) {
        // Nothing is recorded when the send fails: an approval with no offer on
        // file would look identical to one that succeeded, and nobody would
        // retry the message that never left.
        logger.error("Pre-screen approved but the slot picker could not be sent", {
          participantId: id,
          error: offerSent?.error,
        })
        return NextResponse.json(
          { error: offerSent?.error || "Approved, but the slot picker could not be sent — check the thread before retrying.", callPlaced: false },
          { status: 502 }
        )
      }

      // Approval and the offer move to a different status than before: we are
      // waiting on the candidate's answer, not on a call we scheduled.
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "info_received",
          // Deliberately not set: scheduled_call_at / next_retry_at. Both used
          // to be written sixty seconds out here, which is what made the trigger
          // dial regardless of whether anyone had chosen a time.
          screening_context: {
            ...prevContext,
            preScreenReview: {
              decision: "proceed",
              reviewed_by: ctx.authUser.id,
              reviewed_at: now,
              note: note || null,
            },
            approvalGranted: true,
            approvedBy: ctx.authUser?.email ?? ctx.authUser?.id ?? null,
            approvedAt: now,
            awaitingScheduleDecision: true,
            scheduleOfferAt: new Date().toISOString(),
            scheduleOfferSource: "pre_screen_review",
            interestNeedsApproval: false,
          },
          updated_at: now,
        })
        .eq("id", id)

      if (offerSent?.renderedBody) {
        await recordOutboundText(id, offerSent.renderedBody, {
          kind: "schedule_buttons",
          direction: "out",
          status: "sent",
          messageId: offerSent.messageId ?? null,
        })
      }


    } else if (decision === "filter_out") {
      // Move to pre_screen_filtered_out
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "pre_screen_filtered_out",
          screening_context: {
            ...participant.screening_context,
            preScreenReview: {
              decision: "filter_out",
              reviewed_by: ctx.authUser.id,
              reviewed_at: now,
              note: note || null,
            }
          },
          updated_at: now,
        })
        .eq("id", id)

      // Notify candidate
      if (phoneNumber) {
        await sendSessionMessage(phoneNumber, "Thank you for your interest! After reviewing your profile, we've determined this role may not be the best match at this time. We'll keep your details on file for future opportunities.")
      }
    }

    // Log activity
    logCandidateActivity({
      jobId: participant.job_id,
      candidateId: participant.candidate_id,
      participantId: participant.id,
      eventType: "screening_reviewed",
      eventData: {
        decision,
        note: note || null,
        previous_status: "pre_screen_review",
        pre_screen_result: participant.screening_context?.preScreenResult,
      },
      actor: ctx.authUser.id,
    })

    invalidateSessionCache("internal:phone-screening:", { prefix: true })

    return NextResponse.json({ success: true, decision })
  } catch (error: any) {
    logger.error("Pre-screen review failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}