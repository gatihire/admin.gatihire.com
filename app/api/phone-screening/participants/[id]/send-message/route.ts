import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { sendSessionMessage } from "@/lib/info-collector-v2/sender"
import { getWhatsAppService } from "@/lib/whatsapp"
import { appendWhatsappHistory } from "@/lib/whatsapp-history"
import { recordHrAction } from "@/lib/hr-action-history"
import { logCandidateActivity } from "@/lib/activity-logger"
import { toDial } from "@/lib/phone"

export const runtime = "nodejs"

/**
 * Recruiter nudge to a candidate, from the screening thread / Today view.
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
 *
 * One hard constraint: Meta only permits free text for 24 hours after the
 * candidate's LAST inbound message. The people HR nudges are precisely the
 * ones who have gone quiet, so free text failed with #131047 and the UI showed
 * the raw error ("Not able to nudge the call"). Outside the window we send an
 * approved template instead and tell HR what actually went out.
 */

/** Meta's text body limit. */
const MAX_CHARS = 4096
const MIN_CHARS = 1
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000

type SendOutcome = {
  success: boolean
  messageId?: string | null
  error?: string | null
  errorCode?: string | number
  renderedBody?: string | null
  templateName?: string
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** The clock Meta uses is the candidate's last message, never our own sends. */
function lastInboundAt(participant: any): number | null {
  const times: number[] = []
  const explicit = parsedTime(participant?.whatsapp_reply_at)
  if (explicit !== null) times.push(explicit)

  const history = Array.isArray(participant?.whatsapp_history) ? participant.whatsapp_history : []
  for (const entry of history) {
    if (!entry || entry.direction !== "in") continue
    const at = parsedTime(entry.at ?? entry.sentAt ?? entry.timestamp)
    if (at !== null) times.push(at)
  }
  return times.length > 0 ? Math.max(...times) : null
}

function insideServiceWindow(participant: any, nowMs: number): boolean {
  const last = lastInboundAt(participant)
  return last !== null && nowMs - last < SESSION_WINDOW_MS
}

/** #131047 is Meta's "re-engagement message" refusal after the 24h window. */
function windowExpired(outcome: SendOutcome): boolean {
  const code = Number(outcome.errorCode)
  const text = String(outcome.error || "")
  return code === 131047 || /131047|24 hours|re-engagement/i.test(text)
}

/**
 * An approved template carries our follow-up outside the session window.
 *
 * Only claim a call is coming when one is actually booked or in flight —
 * promising a call to a candidate we have no booking for is how a nudge becomes
 * a broken promise. Every other case uses the neutral follow-up template.
 */
async function sendTemplateNudge(args: {
  participant: any
  candidate: any
  job: any
}): Promise<{ outcome: SendOutcome; template: string; body: string }> {
  const { participant, candidate, job } = args
  const whatsapp = getWhatsAppService()
  const candidateName = String(candidate?.name || "").trim() || "there"
  const jobTitle = String(job?.title || "").trim() || "an open role"
  const companyName = String(job?.client_name || "").trim() || "our client"
  const status = String(participant?.status || "")
  const bookedAt = parsedTime(participant?.scheduled_call_at)
  const callUpcoming =
    ["call_scheduled", "scheduled", "calling", "in_progress", "queued", "ringing"].includes(status) ||
    (bookedAt !== null && bookedAt > Date.now())

  if (callUpcoming) {
    const outcome = await whatsapp.sendCallNudge({
      phoneNumber: candidate.phone,
      candidateName,
      jobTitle,
      companyName,
    })
    return {
      outcome,
      template: outcome.templateName || process.env.WHATSAPP_TEMPLATE_CALL_NUDGE || "call_nudge",
      body: outcome.renderedBody || `Hi ${candidateName}, a reminder that our AI recruiter will call you about ${jobTitle} at ${companyName}.`,
    }
  }

  const outcome = await whatsapp.sendReminderNudge({
    phoneNumber: candidate.phone,
    candidateName,
    jobTitle,
    companyName,
  })
  return {
    outcome,
    template: outcome.templateName || process.env.WHATSAPP_TEMPLATE_REMINDER_NUDGE || "reminder_nudge",
    body: outcome.renderedBody || `Hi ${candidateName}, following up regarding the ${jobTitle} position at ${companyName}. If you are interested, please reply here.`,
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) {
      return NextResponse.json({ error: "Session expired — please log in again", code: "SESSION_EXPIRED" }, { status: 401 })
    }
    if (!hasPermission(ctx, "applications.manage") && !hasPermission(ctx, "outreach.send")) {
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
        id, candidate_id, job_id, status, whatsapp_reply_at, whatsapp_history, scheduled_call_at,
        candidates: candidate_id (id, name, phone),
        jobs: job_id (id, title, client_name)
      `)
      .eq("id", id)
      .single()

    if (pError || !participant) {
      return NextResponse.json(
        { error: "Participant not found", reason: "not_found" },
        { status: 404 }
      )
    }

    // Joined relations arrive as arrays under PostgREST.
    const candidate = Array.isArray(participant.candidates)
      ? participant.candidates[0]
      : (participant.candidates as any)
    const job = Array.isArray(participant.jobs)
      ? participant.jobs[0]
      : (participant.jobs as any)

    if (!candidate?.phone) {
      return NextResponse.json({ error: "Candidate has no phone number", reason: "no_phone" }, { status: 400 })
    }

    let outcome: SendOutcome
    let via: "session" | "template" = "session"
    let template: string | null = null
    let deliveredText = text

    if (insideServiceWindow(participant, Date.now())) {
      outcome = await sendSessionMessage(candidate.phone, text)
      // Meta's clock can disagree with ours (delivery receipts, timezone, a
      // reply that landed in a different thread). A #131047 refusal must not
      // end the nudge — retry once through an approved template.
      if (!outcome.success && windowExpired(outcome)) {
        const fallback = await sendTemplateNudge({ participant, candidate, job })
        outcome = fallback.outcome
        via = "template"
        template = fallback.template
        deliveredText = fallback.body
      }
    } else {
      const fallback = await sendTemplateNudge({ participant, candidate, job })
      outcome = fallback.outcome
      via = "template"
      template = fallback.template
      deliveredText = fallback.body
    }

    // Record the attempt whether or not it landed. A failed HR message that
    // silently vanished from the thread is exactly how a recruiter ends up
    // believing they told a candidate something they never did. The body is
    // what actually went out (the rendered template outside the window), not
    // the text HR typed.
    const messageAt = new Date().toISOString()
    const hrAction = await recordHrAction(participant.id, {
      action: "manual_message",
      status: outcome.success ? "sent" : "failed",
      actor: ctx.authUser?.email || ctx.authUser?.id || null,
      at: messageAt,
      detail: outcome.success ? undefined : outcome.error || "WhatsApp delivery failed",
    })
    await appendWhatsappHistory(participant.id, {
      at: messageAt,
      kind: "hr_manual_message",
      direction: "out",
      text: deliveredText,
      requestedText: via === "template" ? text : undefined,
      via,
      template: template ?? undefined,
      status: outcome.success ? "sent" : "failed",
      messageId: outcome.messageId ?? null,
      error: outcome.success ? null : outcome.error ?? null,
      sentBy: ctx.authUser.id,
    })

    if (!outcome.success) {
      logger.error("HR manual message failed", {
        participantId: participant.id,
        candidateId: participant.candidate_id,
        via,
        template,
        error: outcome.error,
      })
      return NextResponse.json(
        {
          error: outcome.error || "Failed to send message",
          reason: "send_failed",
          via,
          template,
          suggestion: via === "session"
            ? "The candidate has not replied in 24 hours; a template is required."
            : "The approved WhatsApp template could not be delivered.",
          action: hrAction,
        },
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
        length: deliveredText.length,
        via,
        template: template ?? null,
        messageId: outcome.messageId ?? null,
        previousStatus: participant.status,
      },
      actor: ctx.authUser.id,
      actorAuthUserId: ctx.authUser.id,
    })

    return NextResponse.json({
      success: true,
      messageId: outcome.messageId ?? null,
      via,
      template,
      action: hrAction,
    })
  } catch (error: any) {
    logger.error("HR manual message error", { error: error?.message })
    return NextResponse.json({ error: "Internal Server Error", details: error?.message }, { status: 500 })
  }
}
