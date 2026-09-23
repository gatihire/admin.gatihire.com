import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { invalidateSessionCache } from "@/lib/utils"
import { logCandidateActivity } from "@/lib/activity-logger"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import { sendSessionMessage } from "@/lib/info-collector-v2"

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
      // Move to call_scheduled and trigger AI call
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "call_scheduled",
          screening_context: {
            ...participant.screening_context,
            preScreenReview: {
              decision: "proceed",
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
        await sendSessionMessage(phoneNumber, `✅ Great news! Your profile has been reviewed and approved. Our AI recruiter will call you shortly to conduct the screening for ${jobTitle} at ${companyName}.`)
      }

      // Schedule call via QStash (60 seconds delay)
      await scheduleBolnaCall(id, 60)

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