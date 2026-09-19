import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { handleInfoReply, handleDetailedInfoReply, handleRejectionReason, sendInfoRequest } from "@/lib/info-collector"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import crypto from "crypto"

// Verify Meta webhook signature
function verifyMetaSignature(body: string, signature: string | null, appSecret: string): boolean {
  if (!signature) return false
  
  try {
    const expectedSignature = crypto
      .createHmac("sha256", appSecret)
      .update(body)
      .digest("hex")
    
    return signature === `sha256=${expectedSignature}`
  } catch {
    return false
  }
}

// Handle GET request (webhook verification)
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info("WhatsApp webhook verified successfully")
    return new NextResponse(challenge, { status: 200 })
  }

  logger.error("WhatsApp webhook verification failed", { mode, token })
  return NextResponse.json({ error: "Verification failed" }, { status: 403 })
}

// Handle POST request (webhook events)
export async function POST(request: NextRequest) {
  try {
    const body = await request.text()
    const signature = request.headers.get("x-hub-signature-256")
    
    // Verify signature if app secret is configured
    const appSecret = process.env.WHATSAPP_APP_SECRET
    if (appSecret && !verifyMetaSignature(body, signature, appSecret)) {
      logger.error("WhatsApp webhook signature verification failed")
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
    }

    const payload = JSON.parse(body)
    
    // Verify it's a WhatsApp Business Account event
    if (payload.object !== "whatsapp_business_account") {
      return NextResponse.json({ status: "ok" })
    }

    // Process each entry
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === "messages") {
          await processMessageEvent(change.value)
        }
      }
    }

    return NextResponse.json({ status: "ok" })
  } catch (error: any) {
    logger.error("Error processing WhatsApp webhook", { error: error.message })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

async function processMessageEvent(value: any) {
  // Handle incoming messages
  if (value.messages) {
    for (const message of value.messages) {
      await handleIncomingMessage(message, value.contacts?.[0])
    }
  }

  // Handle status updates
  if (value.statuses) {
    for (const status of value.statuses) {
      await handleStatusUpdate(status)
    }
  }
}

async function handleIncomingMessage(message: any, contact: any) {
  const phoneNumber = message.from
  const messageType = message.type
  
  logger.info("Received WhatsApp message", { phoneNumber, messageType, messageId: message.id })
  
  // Find participant by phone number - need to join with candidates table
  const normalizedPhone = phoneNumber.replace(/\D/g, "").replace(/^0+/, "")
  // Handle Indian numbers: 10 digits -> add 91 prefix
  const searchPhones = [
    phoneNumber,
    normalizedPhone,
    normalizedPhone.startsWith("91") ? normalizedPhone : `91${normalizedPhone}`,
    `+${normalizedPhone}`,
    `+91${normalizedPhone.replace(/^91/, "")}`
  ].filter(Boolean)
  
  let participant = null
  let findError = null
  
  // Try to find participant by joining with candidates table
  for (const searchPhone of searchPhones) {
    const { data, error } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        *,
        candidates:candidate_id (id, name, phone, email)
      `)
      .eq("candidates.phone", searchPhone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    
    if (!error && data) {
      participant = data
      break
    }
    findError = error
  }
  
  if (!participant) {
    logger.warn("No participant found for phone number", { phoneNumber, tried: searchPhones })
    return
  }
  
  logger.info("Found participant for incoming message", { 
    participantId: participant.id, 
    candidateId: participant.candidate_id,
    candidateName: participant.candidates?.name,
    candidatePhone: participant.candidates?.phone,
    status: participant.status,
    whatsappOutboundTemplate: participant.whatsapp_outbound_template,
    screeningMode: participant.screening_mode,
    scheduledCallAt: participant.scheduled_call_at,
    whatsappSentAt: participant.whatsapp_sent_at
  })

  // Handle different message types
  if (messageType === "interactive") {
    await handleInteractiveMessage(participant, message.interactive)
  } else if (messageType === "text") {
    await handleTextMessage(participant, message.text)
  }
}

async function handleInteractiveMessage(participant: any, interactive: any) {
  if (interactive.type === "button_reply") {
    const buttonId = interactive.button_reply.id
    const buttonTitle = interactive.button_reply.title

    logger.info("Received button reply", { 
      participantId: participant.id, 
      buttonId, 
      buttonTitle 
    })

    // Update participant status based on button
    switch (buttonId) {
      case "interested":
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ 
            status: "interested",
            updated_at: new Date().toISOString()
          })
          .eq("id", participant.id)
        
        // Send schedule options
        {
          const { getWhatsAppService } = await import("@/lib/whatsapp")
          const whatsapp = getWhatsAppService()
          const candidate = participant.candidates
          if (candidate?.phone) {
            await whatsapp.sendScheduleOptions({
              phoneNumber: candidate.phone,
              candidateName: candidate.name || "",
              jobTitle: participant.jobs?.title || "",
            })
          }
        }
        break

      case "not_interested":
        // Send rejection reason template (6 buttons) to capture why
        const { getWhatsAppService } = await import("@/lib/whatsapp")
        const whatsapp = getWhatsAppService()
        const candidate = participant.candidates
        if (candidate?.phone) {
          await whatsapp.sendNotInterestedReason({
            phoneNumber: candidate.phone,
            candidateName: candidate.name || "",
          })
        }
        // Keep status as interested temporarily while waiting for reason
        // The reason buttons will set it to not_interested with rejection_reason
        break

      case "call_now":
        logger.info("Received 'call_now' button, scheduling immediate call", { participantId: participant.id })
        // Schedule immediate call
        await scheduleCall(participant, 0)
        break

      case "in_10_min":
        await scheduleCall(participant, 10 * 60 * 1000)
        break

      case "in_30_min":
        await scheduleCall(participant, 30 * 60 * 1000)
        break

      case "today_evening":
        // Schedule at 18:00 IST
        const now = new Date()
        const evening = new Date(now)
        evening.setUTCHours(12, 30, 0, 0) // 18:00 IST = 12:30 UTC
        if (evening <= now) {
          evening.setDate(evening.getDate() + 1)
        }
        const delay = evening.getTime() - now.getTime()
        await scheduleCall(participant, delay)
        break

      case "tomorrow_morning":
        // Schedule at 09:00 IST
        const tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setUTCHours(3, 30, 0, 0) // 09:00 IST = 03:30 UTC
        const tomorrowDelay = tomorrow.getTime() - Date.now()
        await scheduleCall(participant, tomorrowDelay)
        break

      case "provide_details":
        // Candidate clicked "Provide Details" - they will reply with text
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ 
            status: "info_requested",
            updated_at: new Date().toISOString()
          })
          .eq("id", participant.id)
        break

      case "skip_schedule_call":
        // Candidate skipped info collection - schedule call directly
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ 
            status: "whatsapp_sent",
            updated_at: new Date().toISOString()
          })
          .eq("id", participant.id)
        // Send schedule options
        {
          const { getWhatsAppService } = await import("@/lib/whatsapp")
          const whatsapp = getWhatsAppService()
          const candidate = participant.candidates
          if (candidate?.phone) {
            await whatsapp.sendScheduleOptions({
              phoneNumber: candidate.phone,
              candidateName: candidate.name || "",
              jobTitle: participant.jobs?.title || "",
            })
          }
        }
        break

      // Rejection reason buttons (from not_interested_reason template)
      case "reject_not_looking":
        await handleRejectionReason(participant.id, "not_looking_to_switch")
        break

      case "reject_comp_mismatch":
        await handleRejectionReason(participant.id, "comp_mismatch")
        break

      case "reject_location":
        await handleRejectionReason(participant.id, "location_mismatch")
        break

      case "reject_placed":
        await handleRejectionReason(participant.id, "already_placed")
        break

      case "reject_role_not_relevant":
        await handleRejectionReason(participant.id, "role_not_relevant")
        break

      case "reject_other":
        await handleRejectionReason(participant.id, "other")
        break

      default:
        logger.info("Unknown button reply", { buttonId })
    }
  }
}

async function handleTextMessage(participant: any, text: any) {
  const messageBody = text.body?.toLowerCase() || ""

  logger.info("Received text message", { 
    participantId: participant.id, 
    message: messageBody,
    participantStatus: participant.status,
    screeningMode: participant.screening_mode,
    whatsappOutboundTemplate: participant.whatsapp_outbound_template
  })

  // Check if this is an info collection reply (contains numbers and possibly LPA, days, etc.)
  if (participant.status === "info_requested") {
    // Route based on screening_mode, not template name
    const screeningMode = participant.screening_mode

    if (screeningMode === "extended_screening" || screeningMode === "info_first") {
      // Both modes use detailed info reply handler (with 7-field parsing + pre-screen for extended)
      const infoResult = await handleDetailedInfoReply(participant.id, text.body)
      if (infoResult.success) {
        logger.info("Detailed info reply parsed and saved", { 
          participantId: participant.id,
          decision: infoResult.prescreen?.decision,
          screeningMode
        })
        return
      }
    } else {
      // Legacy: check template name for backward compatibility
      const screeningContext = participant.screening_context
      const isExtended = screeningContext && participant.whatsapp_outbound_template === "detailed_info_request"
      
      if (isExtended) {
        const infoResult = await handleDetailedInfoReply(participant.id, text.body)
        if (infoResult.success) {
          logger.info("Detailed info reply parsed and saved", { 
            participantId: participant.id,
            decision: infoResult.prescreen?.decision 
          })
          return
        }
      } else {
        // Simple info reply (backward compatible)
        const infoResult = await handleInfoReply(participant.id, text.body)
        if (infoResult.success) {
          logger.info("Info reply parsed and saved", { participantId: participant.id })
          return
        }
      }
    }
    // If parsing failed, continue with normal text handling
  }

  // Simple NLP for time parsing
  if (messageBody.includes("interested") || messageBody.includes("yes")) {
    logger.info("Detected 'interested/yes' keyword, updating status to interested", { participantId: participant.id })
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ 
        status: "interested",
        updated_at: new Date().toISOString()
      })
      .eq("id", participant.id)
  } else if (messageBody.includes("not interested") || messageBody.includes("no")) {
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ 
        status: "not_interested",
        updated_at: new Date().toISOString()
      })
      .eq("id", participant.id)
  } else if (messageBody.includes("call") && messageBody.includes("now")) {
    logger.info("Detected 'call now' keyword, scheduling immediate call", { participantId: participant.id })
    await scheduleCall(participant, 0)
  } else if (messageBody.includes("10 min") || messageBody.includes("10 minutes")) {
    await scheduleCall(participant, 10 * 60 * 1000)
  } else if (messageBody.includes("30 min") || messageBody.includes("30 minutes")) {
    await scheduleCall(participant, 30 * 60 * 1000)
  } else if (messageBody.includes("1 hour") || messageBody.includes("one hour")) {
    await scheduleCall(participant, 60 * 60 * 1000)
  } else if (messageBody.includes("tomorrow")) {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setUTCHours(3, 30, 0, 0) // 09:00 IST
    const delay = tomorrow.getTime() - Date.now()
    await scheduleCall(participant, delay)
  } else if (messageBody.includes("evening")) {
    const now = new Date()
    const evening = new Date(now)
    evening.setUTCHours(12, 30, 0, 0) // 18:00 IST
    if (evening <= now) {
      evening.setDate(evening.getDate() + 1)
    }
    const delay = evening.getTime() - now.getTime()
    await scheduleCall(participant, delay)
  }
}

async function scheduleCall(participant: any, delayMs: number) {
  const scheduledTime = new Date(Date.now() + delayMs)

  logger.info("Scheduling call", { 
    participantId: participant.id, 
    delayMs, 
    scheduledTime: scheduledTime.toISOString(),
    currentStatus: participant.status 
  })

  await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      status: "call_scheduled",
      scheduled_at: scheduledTime.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", participant.id)

  logger.info("Call scheduled in DB", { 
    participantId: participant.id, 
    scheduledTime: scheduledTime.toISOString() 
  })

  // Schedule via QStash
  const delaySeconds = Math.max(0, Math.round(delayMs / 1000))
  logger.info("Scheduling via QStash", { participantId: participant.id, delaySeconds })
  const result = await scheduleBolnaCall(participant.id, delaySeconds)
  if (!result.scheduled) {
    logger.error("Failed to schedule call via QStash", { participantId: participant.id, error: result.error })
  } else {
    logger.info("Successfully scheduled via QStash", { participantId: participant.id })
  }
}

async function handleStatusUpdate(status: any) {
  const messageId = status.id
  const statusType = status.status // sent, delivered, read, failed

  logger.info("WhatsApp status update", { messageId, status: statusType })

  // Update participant if we have a mapping
  if (status.id) {
    // Try to find participant by message ID
    const { data: participant } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id")
      .eq("whatsapp_message_id", messageId)
      .single()

    if (participant) {
      const updates: any = { updated_at: new Date().toISOString() }
      
      if (statusType === "delivered") {
        updates.whatsapp_delivered_at = new Date().toISOString()
      } else if (statusType === "read") {
        updates.whatsapp_read_at = new Date().toISOString()
      } else if (statusType === "failed") {
        updates.whatsapp_error = status.errors?.[0]?.message || "Delivery failed"
      }

      await supabaseAdmin
        .from("phone_screening_participants")
        .update(updates)
        .eq("id", participant.id)
    }
  }
}
