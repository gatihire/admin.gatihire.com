import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { 
  handleStepByStepReply,
  handleIncomingCallNow,
  handleIncomingSchedule,
  handleInteractiveButton,
  initializeInfoCollection,
  handleRejectionReason
} from "@/lib/info-collector-v2"
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
    whatsappSentAt: participant.whatsapp_sent_at,
    infoStep: participant.info_step,
    infoConfirmed: participant.info_confirmed
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
    
    const { handleInteractiveButton } = await import('@/lib/info-collector-v2')
    await handleInteractiveButton(participant.id, buttonId, buttonTitle)
  }
}

async function handleTextMessage(participant: any, text: any) {
  const messageBody = text.body?.toLowerCase() || ""
  
  logger.info("Received text message", { 
    participantId: participant.id, 
    message: messageBody,
    participantStatus: participant.status,
    screeningMode: participant.screening_mode,
    whatsappOutboundTemplate: participant.whatsapp_outbound_template,
    infoStep: participant.info_step,
    infoConfirmed: participant.info_confirmed
  })
  
  // Handle "Call Now" text
  if (messageBody.includes("call") && messageBody.includes("now")) {
    logger.info("Detected 'call now' keyword, scheduling immediate call", { participantId: participant.id })
    await scheduleCall(participant, 0)
    return
  }
  
  // Handle "Call Now" button text variants
  if (messageBody.includes("call now") || messageBody === "call now" || messageBody === "call") {
    logger.info("Detected 'call now' keyword, scheduling immediate call", { participantId: participant.id })
    await scheduleCall(participant, 0)
    return
  }
  
  // Handle time-based scheduling keywords
  if (messageBody.includes("10 min") || messageBody.includes("10 minutes")) {
    await scheduleCall(participant, 10 * 60 * 1000)
    return
  }
  if (messageBody.includes("30 min") || messageBody.includes("30 minutes")) {
    await scheduleCall(participant, 30 * 60 * 1000)
    return
  }
  if (messageBody.includes("1 hour") || messageBody.includes("one hour")) {
    await scheduleCall(participant, 60 * 60 * 1000)
    return
  }
  if (messageBody.includes("tomorrow")) {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setUTCHours(3, 30, 0, 0) // 09:00 IST
    const delay = tomorrow.getTime() - Date.now()
    await scheduleCall(participant, delay)
    return
  }
  if (messageBody.includes("evening")) {
    const now = new Date()
    const evening = new Date(now)
    evening.setUTCHours(12, 30, 0, 0) // 18:00 IST
    if (evening <= now) {
      evening.setDate(evening.getDate() + 1)
    }
    const delay = evening.getTime() - now.getTime()
    await scheduleCall(participant, delay)
    return
  }
  
  // Handle "interested/yes" 
  if (messageBody.includes("interested") || messageBody.includes("yes")) {
    logger.info("Detected 'interested/yes' keyword, updating status to interested", { participantId: participant.id })
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ 
        status: "interested",
        updated_at: new Date().toISOString()
      })
      .eq("id", participant.id)
    return
  }
  
  // Handle "not interested/no"
  if (messageBody.includes("not interested") || messageBody.includes("no")) {
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ 
        status: "not_interested",
        updated_at: new Date().toISOString()
      })
      .eq("id", participant.id)
    return
  }
  
  // Handle info collection replies using step-by-step handler
  if (participant.info_step && participant.status === 'info_requested') {
    const { handleStepByStepReply } = await import('@/lib/info-collector-v2')
    const result = await handleStepByStepReply(participant.id, text.body)
    logger.info("Step-by-step reply handled", { participantId: participant.id, result })
    return
  }
  
  // Handle "edit" command
  if (messageBody.includes("edit")) {
    const { handleStepByStepReply } = await import('@/lib/info-collector-v2')
    const result = await handleStepByStepReply(participant.id, "edit")
    return
  }
  
  // Handle "confirm" command
  if (messageBody.includes("confirm")) {
    const { handleStepByStepReply } = await import('@/lib/info-collector-v2')
    const result = await handleStepByStepReply(participant.id, "confirm")
    return
  }
  
  // Handle "call now" text variations
  if (messageBody.includes("call now") || messageBody === "call now" || messageBody === "call") {
    logger.info("Detected 'call now' keyword, scheduling immediate call", { participantId: participant.id })
    await scheduleCall(participant, 0)
    return
  }
  
  // Schedule options via text
  if (messageBody.includes("10 min") || messageBody.includes("10 minutes")) {
    await scheduleCall(participant, 10 * 60 * 1000)
    return
  }
  if (messageBody.includes("30 min") || messageBody.includes("30 minutes")) {
    await scheduleCall(participant, 30 * 60 * 1000)
    return
  }
  if (messageBody.includes("1 hour") || messageBody.includes("one hour")) {
    await scheduleCall(participant, 60 * 60 * 1000)
    return
  }
  if (messageBody.includes("tomorrow")) {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setUTCHours(3, 30, 0, 0) // 09:00 IST
    const delay = tomorrow.getTime() - Date.now()
    await scheduleCall(participant, delay)
    return
  }
  if (messageBody.includes("evening")) {
    const now = new Date()
    const evening = new Date(now)
    evening.setUTCHours(12, 30, 0, 0) // 18:00 IST
    if (evening <= now) {
      evening.setDate(evening.getDate() + 1)
    }
    const delay = evening.getTime() - now.getTime()
    await scheduleCall(participant, delay)
    return
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
