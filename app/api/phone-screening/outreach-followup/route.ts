import { NextRequest, NextResponse } from "next/server"
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs"
import { supabaseAdmin } from "@/lib/supabase"
import { getWhatsAppService } from "@/lib/whatsapp"
import { placeCallImmediately, MAX_TOTAL_CALL_ATTEMPTS } from "@/lib/scheduled-call"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

// Fired by QStash after WhatsApp outreach:
//   action "nudge"    at OUTREACH_NUDGE_HOURS    → send one WhatsApp reminder.
//   action "escalate" at OUTREACH_ESCALATE_HOURS → hand over to a human recruiter.
// Request signature is verified by QStash.
async function handler(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const participantId = String(body?.participantId || "")
    const action = body?.action === "escalate" ? "escalate" : "nudge"

    if (!participantId) {
      return NextResponse.json({ error: "participantId required" }, { status: 400 })
    }

    const { data: participant, error: partError } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, status, outreach_nudge_count, campaign_id, call_attempts,
        candidates: candidate_id (id, name, phone),
        jobs: job_id (id, title, city)
      `)
      .eq("id", participantId)
      .maybeSingle()

    if (partError || !participant) {
      return NextResponse.json({ error: "Participant not found" }, { status: 404 })
    }

    const row = participant as unknown as {
      id: string
      status: string
      outreach_nudge_count: number
      campaign_id: string
      call_attempts: number
      candidates?: { id: string; name?: string | null; phone?: string | null } | null
      jobs?: { id: string; title?: string | null; city?: string | null } | null
    }

    // Candidate already engaged (replied / scheduled / called) → no-op.
    if (row.status !== "whatsapp_sent" && row.status !== "whatsapp_delivered" && row.status !== "whatsapp_read") {
      return NextResponse.json({ success: false, skipped: true, reason: `Participant advanced (${row.status})` })
    }

    // Check campaign max call attempts to cap nudge count
    let maxNudgeCount = 1 // default: 1 nudge before escalate
    if (row.campaign_id) {
      const { data: campaign } = await supabaseAdmin
        .from("phone_screening_campaigns")
        .select("max_call_attempts, nudge_hours, escalate_hours")
        .eq("id", row.campaign_id)
        .maybeSingle()
      if (campaign) {
        maxNudgeCount = Math.max(1, (campaign.max_call_attempts || 2) - 1)
      }
    }

    const candidate = row.candidates
    const job = row.jobs

    if (action === "nudge") {
      // Respect per-job max nudge count
      if ((row.outreach_nudge_count || 0) >= maxNudgeCount) {
        // Already sent max nudges — escalate instead.
        //
        // Escalation must not be a dead end: if we can still call, call.
        // Otherwise this branch just parks the candidate for a human, which is
        // what left 295 of them sitting untouched for 19 days.
        const canCall = Boolean(candidate?.phone) && (row.call_attempts || 0) < MAX_TOTAL_CALL_ATTEMPTS
        if (canCall) {
          const placed = await placeCallImmediately(participantId)
          if (placed.success) {
            logger.info("Max nudges reached — escalated to an AI screening call", { participantId })
            return NextResponse.json({ success: true, escalated: true, callPlaced: true })
          }
        }
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: "needs_manual_followup",
            needs_manual_followup: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", participantId)
        logger.info("Max nudges reached, auto-escalating", { participantId, nudgeCount: row.outreach_nudge_count })
        return NextResponse.json({ success: true, escalated: true, callPlaced: false, reason: "max_nudges_reached" })
      }

      if (!candidate?.phone) {
        return NextResponse.json({ success: false, skipped: true, reason: "No phone" })
      }

      const whatsapp = getWhatsAppService()
      const nudgeResult = await whatsapp.sendReminderNudge({
        phoneNumber: candidate.phone,
        candidateName: candidate.name || "",
        jobTitle: job?.title || "",
        companyName: "",
        location: job?.city || "",
      })

      if (!nudgeResult.success) {
        return NextResponse.json({ error: nudgeResult.error || "Reminder send failed" }, { status: 502 })
      }

      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          outreach_nudge_count: (row.outreach_nudge_count || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", participantId)

      return NextResponse.json({ success: true, nudgeSent: true })
    }

    // escalate → the candidate never answered our WhatsApp.
    //
    // This used to only set `needs_manual_followup`, which meant "escalate"
    // actually meant "sit here forever". The data showed it: 295 candidates
    // flagged for manual follow-up with ZERO call attempts, averaging 19 days
    // old. The WhatsApp message was the soft ask; the screening call is the
    // real one. If they ignored the message, we call them — that is what the
    // AI screener is for, and it is why they gave us a number.
    //
    // Only when there is no number (or the call is refused) does this become a
    // genuine hand-off to a recruiter.
    const canCall = Boolean(candidate?.phone) && (row as any).call_attempts < MAX_TOTAL_CALL_ATTEMPTS

    if (canCall) {
      const placed = await placeCallImmediately(participantId)
      if (placed.success) {
        logger.info("Outreach escalated to an AI screening call", { participantId })
        return NextResponse.json({ success: true, escalated: true, callPlaced: true })
      }
      logger.warn("Escalation could not place a call — falling back to a human", {
        participantId,
        reason: placed.error || placed.reason,
      })
    }

    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "needs_manual_followup",
        needs_manual_followup: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", participantId)

    logger.info("Outreach escalated to human recruiter", { participantId })

    return NextResponse.json({ success: true, escalated: true, callPlaced: false })
  } catch (error: any) {
    logger.error("Outreach follow-up failed", { error: error?.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export const POST = verifySignatureAppRouter(handler)
