import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
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

  // Find participant by phone number
  const { data: participant, error: findError } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("*")
    .eq("phone_number", phoneNumber)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  if (findError || !participant) {
    logger.warn("No participant found for phone number", { phoneNumber })
    return
  }

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
        // TODO: Send schedule_options template
        break

      case "not_interested":
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ 
            status: "not_interested",
            updated_at: new Date().toISOString()
          })
          .eq("id", participant.id)
        break

      case "call_now":
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

      default:
        logger.info("Unknown button reply", { buttonId })
    }
  }
}

async function handleTextMessage(participant: any, text: any) {
  const messageBody = text.body?.toLowerCase() || ""

  logger.info("Received text message", { 
    participantId: participant.id, 
    message: messageBody 
  })

  // Simple NLP for time parsing
  if (messageBody.includes("interested") || messageBody.includes("yes")) {
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

  await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      status: "call_scheduled",
      scheduled_at: scheduledTime.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", participant.id)

  logger.info("Call scheduled", { 
    participantId: participant.id, 
    scheduledTime 
  })

  // TODO: Schedule via QStash
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
