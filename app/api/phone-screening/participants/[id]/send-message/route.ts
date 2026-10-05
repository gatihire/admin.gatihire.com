import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { sendSessionMessage } from "@/lib/info-collector-v2/sender"
import { appendWhatsappHistory } from "@/lib/whatsapp-history"
import { logCandidateActivity } from "@/lib/activity-logger"
import { toDial } from "@/lib/phone"

export const runtime = "nodejs"

/**
 * Recruiter free-text message to a candidate, from the screening thread.
 *
 * The whole AI screen was built around templates and scripted branches, so when
 * the model or the pre-screen got something wrong there was no way for a human
 * to just talk to the candidate — the only recruiter-authored message was
 * `clarify`, which could ask exactly one pre-written-shaped question and then
 * parked the row in an invalid `info_step: "clarify"`, where the candidate's
 * answer was parsed into info_data as a literal `clarify` field.
 *
 * This is the escape hatch that was missing: HR types what they mean, it goes
 * out on the same session window the rest of the flow uses, and the message is
 * recorded in the same thread so the conversation stays auditable.
 */

/** Meta's text body limit. */
const MAX_CHARS = 4096
const MIN_CHARS = 1

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params

    const body = await request.json().catch(() => ({}))
    const text = String(body?.text ?? "").trim()

    if (text.length < MIN_CHARS) {
      return NextResponse.json({ error: "Message cannot be empty" }, { status: 400 })
    }
    if (text.length > MAX_CHARS) {
      return NextResponse.json(
        { error: `Message is too long (${text.length} characters, maximum ${MAX_CHARS})` },
        { status: 400 }
      )
    }

    const { data: participant, error: pError } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, candidate_id, job_id, status,
        candidates: candidate_id (id, name, phone),
        jobs: job_id (id, title)
      `)
      .eq("id", id)
      .single()

    if (pError || !participant) {
      return NextResponse.json({ error: "Participant not found", reason: "not_found" }, { status: 404 })
    }

    // Joined relations arrive as arrays under PostgREST.
    const candidate = Array.isArray(participant.candidates)
      ? participant.candidates[0]
      : (participant.candidates as any)

    if (!candidate?.phone) {
      return NextResponse.json({ error: "Candidate has no phone number", reason: "no_phone" }, { status: 400 })
    }

    const sent = await sendSessionMessage(candidate.phone, text)

    // Record the attempt whether or not it landed. A failed HR message that
    // silently vanished from the thread is exactly how a recruiter ends up
    // believing they told a candidate something they never did.
    await appendWhatsappHistory(participant.id, {
      at: new Date().toISOString(),
      kind: "hr_manual_message",
      direction: "out",
      text,
      status: sent.success ? "sent" : "failed",
      messageId: sent.messageId ?? null,
      error: sent.success ? null : sent.error ?? null,
      sentBy: ctx.authUser.id,
    })

    if (!sent.success) {
      logger.error("HR manual message failed", {
        participantId: participant.id,
        candidateId: participant.candidate_id,
        error: sent.error,
      })
      return NextResponse.json(
        { error: sent.error || "Failed to send message", reason: "send_failed" },
        { status: 502 }
      )
    }

    // Clear the "waiting on a recruiter" flag. The recruiter has now spoken, so
    // the row is no longer blocked on a review decision that nobody has made.
    const now = new Date().toISOString()
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ updated_at: now })
      .eq("id", participant.id)

    logCandidateActivity({
      jobId: participant.job_id || "",
      candidateId: participant.candidate_id,
      participantId: participant.id,
      eventType: "whatsapp_sent",
      eventData: {
        channel: "manual_hr",
        to: toDial(candidate.phone),
        length: text.length,
        messageId: sent.messageId ?? null,
        previousStatus: participant.status,
      },
      actor: ctx.authUser.id,
    })

    return NextResponse.json({ success: true, messageId: sent.messageId ?? null })
  } catch (error: any) {
    logger.error("HR manual message error", { error: error?.message })
    return NextResponse.json({ error: "Internal Server Error", details: error?.message }, { status: 500 })
  }
}
