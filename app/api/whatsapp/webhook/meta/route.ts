import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { 
  handleStepByStepReply,
  handleIncomingCallNow,
  handleIncomingSchedule,
  handleInteractiveButton,
  initializeInfoCollection,
  handleRejectionReason,
  extractAllFieldsFromReply,
  sendSessionMessage
} from "@/lib/info-collector-v2"
import { evaluatePreScreenWithAI } from "@/lib/pre-screen"
import { getWhatsAppService } from "@/lib/whatsapp"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import { classifyIntent } from "@/lib/ai-intent-classifier"
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
  const messageBody = text.body?.trim() || ""
  const lower = messageBody.toLowerCase()
  
  logger.info("Received text message", { 
    participantId: participant.id, 
    message: messageBody.substring(0, 100),
    participantStatus: participant.status,
    screeningMode: participant.screening_mode,
    infoStep: participant.info_step,
    infoConfirmed: participant.info_confirmed
  })
  
  // Auto-initialize info collection if participant is in info_requested but info_step is missing
  // This handles legacy participants or cases where orchestrator didn't set it
  if (participant.status === 'info_requested' && !participant.info_step) {
    logger.info("Auto-initializing info collection for participant", { 
      participantId: participant.id 
    })
    await initializeInfoCollection(participant)
    // Re-fetch participant to get updated info_step
    const { data: refreshed } = await supabaseAdmin
      .from('phone_screening_participants')
      .select('*')
      .eq('id', participant.id)
      .single()
    if (refreshed) {
      participant = { ...participant, ...refreshed }
    }
  }
  
  // 1. If participant is in collect_info_first mode with collect_all step (single-message parsing)
  if (participant.status === 'info_requested' && 
      participant.screening_mode === 'collect_info_first' &&
      participant.info_step === 'collect_all') {
    logger.info("Handling collect_all step for collect_info_first mode", { 
      participantId: participant.id 
    })
    await handleCollectAllReply(participant, messageBody)
    return
  }
  
  // 2. If participant is actively in info collection flow (legacy step-by-step), route to step-by-step handler
  const isInInfoFlow = participant.status === 'info_requested' && 
    participant.info_step && 
    participant.info_step !== 'confirmed' &&
    participant.info_step !== 'collect_all' &&
    !participant.info_confirmed
  
  if (isInInfoFlow) {
    logger.info("Routing to info collection step-by-step handler", { 
      participantId: participant.id, 
      infoStep: participant.info_step 
    })
    const result = await handleStepByStepReply(participant.id, messageBody)
    logger.info("Step-by-step reply handled", { participantId: participant.id, result })
    return
  }
  
  // 2. If participant has confirmed info and replies "confirm" or "edit", handle it
  if (participant.info_confirmed && participant.info_step === 'confirmed') {
    if (lower === 'confirm' || lower === 'edit') {
      await handleStepByStepReply(participant.id, messageBody)
      return
    }
  }
  
  // 3. AI intent classification for outreach/general messages
  const classification = await classifyIntent(messageBody, {
    candidate_name: participant.candidates?.name || 'Candidate',
    job_title: participant.jobs?.title || participant.job_title || 'the role',
    company_name: participant.jobs?.client_name || participant.company_name || 'the company',
    status: participant.status,
    screening_mode: participant.screening_mode,
    whatsapp_sent_at: participant.whatsapp_sent_at,
  })
  
  logger.info("AI intent classified", {
    participantId: participant.id,
    intent: classification.intent,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
    message: messageBody.substring(0, 100),
  })
  
  // 4. Dispatch based on intent + confidence threshold
  if (classification.confidence < 0.7) {
    logger.info("Low confidence classification, ignoring", {
      participantId: participant.id,
      intent: classification.intent,
      confidence: classification.confidence,
    })
    return
  }
  
  await dispatchIntent(participant, classification)
}

async function dispatchIntent(participant: any, classification: { intent: string; delay_minutes: number | null }) {
  const { intent, delay_minutes } = classification
  
  switch (intent) {
    case 'schedule_call_now': {
      logger.info("AI: scheduling immediate call", { participantId: participant.id })
      await scheduleCall(participant, 0)
      break
    }
    
    case 'schedule_call_later': {
      const delayMs = (delay_minutes || 10) * 60 * 1000
      logger.info("AI: scheduling delayed call", { participantId: participant.id, delayMinutes: delay_minutes })
      await scheduleCall(participant, delayMs)
      break
    }
    
    case 'interested': {
      logger.info("AI: marking interested", { participantId: participant.id })
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({ status: "interested", updated_at: new Date().toISOString() })
        .eq("id", participant.id)
      
      // Send schedule options if we have their phone
      if (participant.candidates?.phone) {
        try {
          const whatsapp = getWhatsAppService()
          await whatsapp.sendScheduleOptions({
            phoneNumber: participant.candidates.phone,
            candidateName: participant.candidates?.name || 'Candidate',
            jobTitle: participant.jobs?.title || 'the role',
          })
        } catch (err: any) {
          logger.error("Failed to send schedule options", { participantId: participant.id, error: err.message })
        }
      }
      break
    }
    
    case 'not_interested': {
      logger.info("AI: marking not interested", { participantId: participant.id })
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({ status: "not_interested", updated_at: new Date().toISOString() })
        .eq("id", participant.id)
      break
    }
    
    case 'provide_details': {
      logger.info("AI: starting info collection", { participantId: participant.id })
      await initializeInfoCollection(participant)
      
      const { sendFirstQuestion } = await import('@/lib/info-collector-v2')
      await sendFirstQuestion(
        {
          id: participant.id,
          candidate_id: participant.candidate_id,
          phone_number: participant.candidates?.phone || '',
          candidate_name: participant.candidates?.name || 'Candidate',
          job_title: participant.jobs?.title || '',
          company_name: participant.jobs?.client_name || '',
          status: participant.status,
          info_step: 'current_ctc',
          info_data: {},
          info_confirmed: false,
          origin: participant.origin,
          whatsapp_message_id: null,
          screening_context: participant.screening_context || {},
        },
        participant.jobs?.title || '',
        participant.jobs?.client_name || ''
      )
      break
    }
    
    case 'question':
    case 'unclear':
    default: {
      logger.info("AI: no action needed", { participantId: participant.id, intent })
      break
    }
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

async function handleCollectAllReply(participant: any, messageBody: string) {
  const candidateName = participant.candidates?.name || 'Candidate'
  const jobTitle = participant.jobs?.title || ''
  const companyName = participant.jobs?.client_name || ''
  const phoneNumber = participant.candidates?.phone

  try {
    // Parse all fields from the single message
    const allFields = await extractAllFieldsFromReply(messageBody, participant.info_data || {})
    
    logger.info("Extracted all fields from collect_all reply", { 
      participantId: participant.id, 
      allFields 
    })

    // Merge with existing info_data
    const mergedInfoData = { ...participant.info_data, ...allFields }

    // Get job requirements for pre-screen
    const jobRequirements = {
      salaryMinLpa: participant.jobs?.salary_min,
      salaryMaxLpa: participant.jobs?.salary_max,
      experienceMinYears: participant.jobs?.experience_min_years,
      experienceMaxYears: participant.jobs?.experience_max_years,
      city: participant.jobs?.city,
      location: participant.jobs?.location,
      title: participant.jobs?.title,
    }

    // Get pre-screen config from screening_context
    const preScreenConfig = participant.screening_context?.preScreenConfig || {
      salaryTolerancePercent: 40,
      experienceMinPercent: 50,
      experienceMaxPercent: 200,
      maxNoticePeriodDays: 120,
    }

    // Run AI pre-screen evaluation
    const preScreenResult = await evaluatePreScreenWithAI(mergedInfoData, jobRequirements, preScreenConfig)

    logger.info("Pre-screen evaluation result", { 
      participantId: participant.id, 
      decision: preScreenResult.decision,
      summary: preScreenResult.summary,
      reasons: preScreenResult.reasons
    })

    // Update participant with collected info and pre-screen result
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        info_data: mergedInfoData,
        info_step: 'confirm',
        info_confirmed: false,
        screening_context: {
          ...participant.screening_context,
          preScreenResult: {
            decision: preScreenResult.decision,
            reasons: preScreenResult.reasons,
            summary: preScreenResult.summary,
            evaluatedAt: new Date().toISOString(),
          }
        },
        updated_at: new Date().toISOString()
      })
      .eq("id", participant.id)

    // Branch based on pre-screen decision
    switch (preScreenResult.decision) {
      case 'proceed': {
        // Schedule AI call after 60 seconds
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ status: "call_scheduled", updated_at: new Date().toISOString() })
          .eq("id", participant.id)

        await sendSessionMessage(phoneNumber, "✅ Thanks for sharing your details! Your profile looks like a good fit. Our AI recruiter will call you in about a minute to conduct the screening.")

        // Schedule call via QStash (60 seconds delay)
        const { scheduleBolnaCall } = await import('@/lib/scheduled-call')
        await scheduleBolnaCall(participant.id, 60)
        break
      }

      case 'needs_review': {
        // Mark for HR review
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ status: "pre_screen_review", updated_at: new Date().toISOString() })
          .eq("id", participant.id)

        await sendSessionMessage(phoneNumber, "Thanks for sharing your details! Our team will review your profile and get back to you within 24 hours.")
        break
      }

      case 'filtered_out': {
        // Inform candidate they don't match
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ status: "pre_screen_filtered_out", updated_at: new Date().toISOString() })
          .eq("id", participant.id)

        await sendSessionMessage(phoneNumber, "Thank you for your interest! Based on the details you shared, this role may not be the best match for your profile at this time. We'll keep your details on file for future opportunities.")
        break
      }
    }

  } catch (error: any) {
    logger.error("Error handling collect_all reply", { 
      participantId: participant.id, 
      error: error.message 
    })

    // Fallback: ask for details step-by-step
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ info_step: 'current_ctc', updated_at: new Date().toISOString() })
      .eq("id", participant.id)

    const { sendFirstQuestion } = await import('@/lib/info-collector-v2')
    const refreshed = await supabaseAdmin
      .from('phone_screening_participants')
      .select('*')
      .eq('id', participant.id)
      .single()

    if (refreshed.data) {
      await sendFirstQuestion(
        refreshed.data,
        jobTitle,
        companyName
      )
    }
  }
}
