import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { aisensyService } from "@/lib/aisensy"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import { logger } from "@/lib/logger"
import { logCandidateActivity } from "@/lib/activity-logger"

export const runtime = "nodejs"

// Aisensy webhook:
//  1. Delivery-status updates → reconcile onto phone_screening_participants.
//  2. Inbound button replies / free text → drive the WhatsApp opt-in funnel:
//       interested  → send schedule-options message (no HR interference)
//       not interested → stop
//       call me now → schedule the call in ~1 min
//       in 10 minutes → schedule in ~10 min
//       today evening → schedule at the next 18:00 (IST) slot
const VALID = ["sent", "delivered", "read", "failed"]

function pickFirst(raw: any, keys: string[]): string {
  for (const k of keys) {
    const v = k.includes(".")
      ? k.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), raw)
      : raw?.[k]
    if (v != null && String(v).trim() !== "") return String(v)
  }
  return ""
}

function normalizePhone(phone: string): string {
  let cleaned = String(phone).replace(/\D/g, "")
  if (cleaned.startsWith("0")) cleaned = cleaned.slice(1)
  if (cleaned.length === 10) cleaned = `91${cleaned}`
  return cleaned
}

type ReplyAction = "not_interested" | "interested" | "call_me_now" | "in_10_min" | "in_30_min" | "today_evening" | "custom_time" | null

interface ClassifiedReply {
  action: ReplyAction
  parsedTime?: { iso: string; delaySec: number }
}

function classifyReply(text: string): ClassifiedReply {
  const t = text.toLowerCase().replace(/\s+/g, " ")
  if (/(not.*interest|interest.*not|not.*needed|no thanks|no thank)/.test(t)) return { action: "not_interested" }
  if (/(interest|interested|yes|ok|okay|call me|callme|sure)/.test(t)) {
    if (/call.*(now|immediately|right now|abhi)/.test(t)) return { action: "call_me_now" }
    if (/(30|thirty|after 30|in 30|30 min|half hour)/.test(t)) return { action: "in_30_min" }
    if (/(10|ten|after 10|in 10|10 min|few min)/.test(t)) return { action: "in_10_min" }
    if (/(evening|today evening|tonight|6 pm|6pm|5 pm|6:00)/.test(t)) return { action: "today_evening" }
    if (/call/.test(t)) return { action: "call_me_now" }
    return { action: "interested" }
  }
  if (/call/.test(t)) return { action: "call_me_now" }
  if (/(30|thirty|after 30|in 30|30 min|half hour)/.test(t)) return { action: "in_30_min" }
  if (/(no|nhi|nahi|not now|busy)/.test(t) && !/call/.test(t)) return { action: "not_interested" }

  // NLP: try to parse custom time/date from free-text
  const parsed = parseScheduleFromText(t)
  if (parsed) return { action: "custom_time", parsedTime: parsed }

  return { action: null }
}

/**
 * Parse schedule intent from free-text WhatsApp replies.
 * Handles: "3pm", "3:00 PM", "tomorrow 10am", "next Monday", "evening",
 * "10 minutes", "1 hour", "kal subah", "aaj raat", etc.
 */
function parseScheduleFromText(text: string): { iso: string; delaySec: number } | null {
  const now = new Date()

  // Relative: "10 minutes", "10 min", "10 mins"
  const minMatch = text.match(/(\d+)\s*(min|mins|minutes)/)
  if (minMatch) {
    const mins = parseInt(minMatch[1])
    if (mins > 0 && mins <= 120) {
      const target = new Date(now.getTime() + mins * 60 * 1000)
      return { iso: target.toISOString(), delaySec: mins * 60 }
    }
  }

  // Relative: "1 hour", "2 hours", "ek ghanta"
  const hrMatch = text.match(/(\d+)\s*(hour|hours|hr|hrs|ghant)/)
  if (hrMatch) {
    const hrs = parseInt(hrMatch[1])
    if (hrs > 0 && hrs <= 12) {
      const target = new Date(now.getTime() + hrs * 60 * 60 * 1000)
      return { iso: target.toISOString(), delaySec: hrs * 3600 }
    }
  }

  // "evening" / "raat" → next 18:00 IST
  if (/(evening|raat|tonight)/.test(text)) {
    const slot = nextEveningSlot()
    return slot
  }

  // "tomorrow" / "kal"
  const isTomorrow = /(tomorrow|kal)/.test(text)

  // Absolute time: "3pm", "3:00 PM", "15:00"
  const timeMatch = text.match(/(\d{1,2})[:\s]?(\d{2})?\s*(am|pm)?/i)
  if (timeMatch) {
    let hours = parseInt(timeMatch[1])
    const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0
    const meridian = timeMatch[3]?.toLowerCase()

    if (meridian === "pm" && hours < 12) hours += 12
    if (meridian === "am" && hours === 12) hours = 0
    if (!meridian && hours >= 1 && hours <= 7) hours += 12 // assume PM for 1-7 without AM/PM

    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      // IST offset: +5:30
      const istOffsetMs = 5.5 * 60 * 60 * 1000
      const istNow = new Date(now.getTime() + istOffsetMs)
      const target = new Date(istNow)
      target.setDate(target.getDate() + (isTomorrow ? 1 : 0))
      target.setHours(hours, minutes, 0, 0)
      const targetUtcMs = target.getTime() - istOffsetMs

      // If the time has already passed today (and not tomorrow), schedule for tomorrow
      if (!isTomorrow && targetUtcMs <= now.getTime()) {
        target.setDate(target.getDate() + 1)
      }

      const targetUtc = new Date(target.getTime() - istOffsetMs)
      const delaySec = Math.max(60, Math.round((targetUtc.getTime() - now.getTime()) / 1000))
      return { iso: targetUtc.toISOString(), delaySec }
    }
  }

  return null
}

// Next 18:00 IST slot (today if not yet past, else tomorrow).
function nextEveningSlot(): { iso: string; delaySec: number } {
  const now = new Date()
  const istNowMs = now.getTime() + 5.5 * 60 * 60 * 1000
  const istNow = new Date(istNowMs)
  const target = new Date(istNow)
  target.setHours(18, 0, 0, 0)
  if (target.getTime() <= istNowMs) target.setDate(target.getDate() + 1)
  const targetUtcMs = target.getTime() - 5.5 * 60 * 60 * 1000
  const targetUtc = new Date(targetUtcMs)
  return { iso: targetUtc.toISOString(), delaySec: Math.max(60, Math.round((targetUtcMs - now.getTime()) / 1000)) }
}

async function findLatestParticipant(phone: string) {
  const { data } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      id, status, job_id,
      candidates: candidate_id (id, name, phone)
    `)
    .order("created_at", { ascending: false })
    .limit(200)

  if (!data) return null
  return (
    (data as any[]).find(
      (p) => p.candidates?.phone && normalizePhone(String(p.candidates.phone)) === phone
    ) || null
  )
}

async function handleInbound(raw: any) {
  const phoneRaw = pickFirst(raw, ["from", "phoneNumber", "phone_number", "source", "msisdn", "data.from", "data.source"])
  const messageText = pickFirst(raw, ["message", "text", "body", "data.message", "data.text", "data.body"])
  const buttonText = pickFirst(raw, [
    "data.buttons.0.title",
    "data.button.title",
    "buttons.0.title",
    "data.interactive.button_reply.title",
    "data.payload.text",
  ])

  if (!phoneRaw) return NextResponse.json({ ok: false, reason: "no phone" })

  const phone = normalizePhone(phoneRaw)
  const classified = classifyReply(buttonText || messageText)
  const reply = classified.action
  const rawReplyText = buttonText || messageText || ""

  if (!reply) {
    logger.info("Aisensy inbound message ignored (no actionable reply)", { phone, text: messageText.slice(0, 80) })
    // Still store the raw reply text for audit trail
    const participant = await findLatestParticipant(phone)
    if (participant) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          whatsapp_reply_text: rawReplyText.slice(0, 500),
          whatsapp_reply_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)
    }
    return NextResponse.json({ ok: true, action: null })
  }

  const participant = await findLatestParticipant(phone)
  if (!participant) {
    logger.info("Aisensy inbound reply from unknown participant", { phone, reply })
    return NextResponse.json({ ok: true, matched: false })
  }

  const participantId = participant.id
  const candidateName = participant.candidates?.name || "there"
  const nowIso = new Date().toISOString()
  const baseUpdate: Record<string, unknown> = {
    updated_at: nowIso,
    whatsapp_reply_text: rawReplyText.slice(0, 500),
    whatsapp_reply_at: nowIso,
  }

  if (reply === "not_interested") {
    baseUpdate.status = "not_interested"
    await supabaseAdmin.from("phone_screening_participants").update(baseUpdate).eq("id", participantId)
    logCandidateActivity({
      jobId: participant.job_id || "",
      candidateId: participant.candidates?.id || "",
      participantId,
      eventType: "whatsapp_replied",
      eventData: { reply_text: rawReplyText.slice(0, 500), action: "not_interested" },
    })
    return NextResponse.json({ ok: true, action: "not_interested" })
  }

  if (reply === "interested") {
    baseUpdate.status = "interested"
    baseUpdate.interested_at = nowIso
    await supabaseAdmin.from("phone_screening_participants").update(baseUpdate).eq("id", participantId)
    await aisensyService.sendScheduleOptions(participant.candidates?.phone as string, candidateName)
    logCandidateActivity({
      jobId: participant.job_id || "",
      candidateId: participant.candidates?.id || "",
      participantId,
      eventType: "whatsapp_replied",
      eventData: { reply_text: rawReplyText.slice(0, 500), action: "interested" },
    })
    return NextResponse.json({ ok: true, action: "interested" })
  }

  // Scheduling replies (call_me_now / in_10_min / in_30_min / today_evening / custom_time).
  let scheduledAt: string
  let delaySec: number

  if (reply === "custom_time" && classified.parsedTime) {
    scheduledAt = classified.parsedTime.iso
    delaySec = classified.parsedTime.delaySec
  } else if (reply === "call_me_now") {
    scheduledAt = new Date(Date.now() + 60 * 1000).toISOString()
    delaySec = 60
  } else if (reply === "in_10_min") {
    scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    delaySec = 10 * 60
  } else if (reply === "in_30_min") {
    scheduledAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    delaySec = 30 * 60
  } else {
    const slot = nextEveningSlot()
    scheduledAt = slot.iso
    delaySec = slot.delaySec
  }

  await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      ...baseUpdate,
      status: "call_scheduled",
      scheduled_call_at: scheduledAt,
      parsed_callback_at: scheduledAt,
      parsed_callback_source: "whatsapp_text",
    })
    .eq("id", participantId)

  const scheduled = await scheduleBolnaCall(participantId, delaySec)
  if (!scheduled.scheduled) {
    logger.error("Failed to schedule call from WhatsApp reply", { participantId, reply, error: scheduled.error })
  }

  // Log WhatsApp reply with scheduling action
  logCandidateActivity({
    jobId: participant.job_id || "",
    candidateId: participant.candidates?.id || "",
    participantId,
    eventType: "whatsapp_replied",
    eventData: {
      reply_text: rawReplyText.slice(0, 500),
      action: reply,
      scheduled_at: scheduledAt,
      call_scheduled: scheduled.scheduled,
    },
  })

  return NextResponse.json({ ok: true, action: reply, callScheduled: scheduled.scheduled })
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.json().catch(() => ({}))
    const messageId = String(
      raw?.messageId || raw?.message_id || raw?.id || raw?.data?.messageId || ""
    )
    const status = String(
      raw?.status || raw?.deliveryStatus || raw?.delivery_status || raw?.data?.status || ""
    ).toLowerCase()

    // Delivery-status update?
    if (messageId && status && VALID.includes(status)) {
      const { data } = await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          whatsapp_delivery_status: status,
          whatsapp_sent_at: status === "sent" ? new Date().toISOString() : undefined,
          updated_at: new Date().toISOString(),
        })
        .eq("whatsapp_message_id", messageId)
        .select("id, candidate_id, job_id")
        .maybeSingle()

      if (!data) return NextResponse.json({ ok: true, matched: false })
      logger.info("Aisensy delivery update applied", { messageId, status })

      // Log delivery status event
      const eventType = status === "delivered" ? "whatsapp_delivered" as const
        : status === "read" ? "whatsapp_read" as const
        : null
      if (eventType) {
        logCandidateActivity({
          jobId: data.job_id || "",
          candidateId: data.candidate_id || "",
          participantId: data.id,
          eventType,
          eventData: { delivery_status: status },
        })
      }

      return NextResponse.json({ ok: true, matched: true })
    }

    // Otherwise treat it as an inbound message / button reply.
    return await handleInbound(raw)
  } catch (error: any) {
    logger.error("Aisensy webhook error", { error: error.message })
    return NextResponse.json({ ok: false })
  }
}
