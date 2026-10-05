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
import { evaluatePreScreenWithAI, buildCandidateInfoFromCollected } from "@/lib/pre-screen"
import { mergeSources, stampSources, isMeaningfulValue } from "@/lib/info-provenance"
import { updateParticipant } from "@/lib/participant-update"
import { buildResumeInfo } from "@/lib/prompt-user-data"
import { getWhatsAppService } from "@/lib/whatsapp"
import { scheduleOrPlaceCall } from "@/lib/scheduled-call"
import { classifyIntent } from "@/lib/ai-intent-classifier"
import { toE164 } from "@/lib/phone"
import { appendThreadEntry, recordInboundText, recordOutboundText } from "@/lib/whatsapp-thread"
import { logCandidateActivity } from "@/lib/activity-logger"
import crypto from "crypto"

/**
 * Send a free-text message and record the body it sent.
 *
 * The send and the log have to be one call. Recording text at the send site is
 * the only way the UI can ever show what was actually said — the delivery
 * receipts that arrive later carry no body, so a message logged without its text
 * is permanently unreadable.
 */
async function sendAndRecord(
  participantId: string,
  phoneNumber: string,
  text: string,
  extra: Record<string, any> = {}
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const result = await sendSessionMessage(phoneNumber, text)
  await recordOutboundText(participantId, text, {
    messageId: result.messageId ?? null,
    status: result.success ? "sent" : "failed",
    error: result.error,
    ...extra,
  })
  return result
}

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
  
  // Find participant by phone number - need to join with candidates table.
  // IMPORTANT: we must NOT filter phone_screening_participants by an embedded
  // candidates.phone=  structured filter. PostgREST left-joins and returns the
  // row with candidates: null (silently never matching), so every inbound
  // message used to "match" the newest participant with no phone available.
  // Instead: resolve candidate id(s) by matching any stored phone format in JS,
  // then fetch the participant joined on candidate_id with real candidate data.
  const normalizedFrom = (phoneNumber || "").replace(/\D/g, "").replace(/^0+/, "")
  const normalizedTo = (p: string | null | undefined) => {
    if (!p) return ""
    let c = p.replace(/\D/g, "")
    if (c.startsWith("0")) c = c.substring(1)
    if (c.length === 10) return `91${c}`
    if (c.length === 12 && c.startsWith("91")) return c
    if (c.length > 12 && c.startsWith("91")) return c.substring(c.length - 12)
    return c
  }
  // Canonical E.164 comparison — the fast indexed path once phone_e164 is
  // backfilled (send and lookup then share the exact same canonical form).
  const senderE164 = toE164(phoneNumber)

  let participant = null
  let findError = null
  let matchedCandidateIds: string[] = []

  // Step 1: find candidate rows whose stored phone normalizes to the sender.
  const matchedSet = new Set<string>()

  // Fast path: exact match on the canonical phone_e164 column (indexed).
  if (senderE164) {
    const { data: e164Matches, error } = await supabaseAdmin
      .from("candidates")
      .select("id")
      .eq("phone_e164", senderE164)
      .limit(10)
    if (error) {
      logger.warn("Candidate phone_e164 lookup failed", { phoneNumber, error: error.message })
      findError = error
    } else {
      for (const c of e164Matches || []) matchedSet.add(c.id)
    }
  }

  // Fallback: normalized full-table scan for rows not yet backfilled.
  if (matchedSet.size === 0) {
    // Supabase caps a single select at 1000 rows, so paginate the scan.
    for (let offset = 0; offset < 20000; offset += 1000) {
      const { data: phoneMatches, error } = await supabaseAdmin
        .from("candidates")
        .select("id, phone")
        .range(offset, offset + 999)

      if (error) {
        logger.warn("Candidate phone scan failed", { phoneNumber, error: error.message })
        findError = error
        break
      }
      for (const c of phoneMatches || []) {
        if (normalizedTo(c.phone) === normalizedFrom) matchedSet.add(c.id)
      }
      if ((phoneMatches || []).length < 1000) break
    }
  }
  matchedCandidateIds = Array.from(matchedSet)

  if (findError) {
    // fall through to no-participant handling below
  } else {
    // Step 2: fetch the newest active participant for any matched candidate.
    if (matchedCandidateIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("phone_screening_participants")
        .select(`
          *,
          candidates:candidate_id (id, name, phone, email, total_experience, location),
          jobs:job_id (id, title, client_name, city, location, salary_min, salary_max, experience_min_years, experience_max_years)
        `)
        .in("candidate_id", matchedCandidateIds)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!error && data) {
        participant = data
      } else {
        findError = error
      }
    } else {
      // The sender's number matches no candidate row at all — a common case when
      // a recruiter tests the flow from their own SIM, or when the candidate
      // replies from a different number than the one on file.
      //
      // This used to `return` with only a warn. That made a candidate tap
      // "Interested" and receive complete silence, with nothing in the thread to
      // explain it: no reply, no error surfaced, and the participant row still
      // showing "waiting for reply" because we never touched it.
      //
      // Fall back to the most recent awaiting-interest participant so the reply
      // is still handled, and say so loudly — picking the wrong row is far better
      // than dropping a real candidate reply, and the log names the row we chose.
      const { data: recent, error: recentErr } = await supabaseAdmin
        .from("phone_screening_participants")
        .select(`
          *,
          candidates:candidate_id (id, name, phone, email, total_experience, location),
          jobs:job_id (id, title, client_name, city, location, salary_min, salary_max, experience_min_years, experience_max_years)
        `)
        .eq("info_step", "awaiting_interest")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!recentErr && recent) {
        participant = recent
        logger.error(
          "Sender number matches no candidate — matched most recent awaiting_interest participant instead. VERIFY THIS IS CORRECT.",
          {
            senderPhone: phoneNumber,
            normalized: normalizedFrom,
            matchedParticipantId: recent.id,
            matchedCandidateId: recent.candidate_id,
            matchedCandidatePhone: recent.candidates?.phone,
            matchedCandidateName: recent.candidates?.name,
            jobId: recent.job_id,
          }
        )
      } else {
        logger.error("No candidate matched sender phone and no awaiting_interest participant to fall back on", {
          phoneNumber,
          normalized: normalizedFrom,
          recentError: recentErr?.message,
        })
        return
      }
    }
  }
  
  if (!participant) {
    logger.warn("No participant found for phone number", { phoneNumber, normalized: normalizedFrom, triedCandidates: matchedCandidateIds.length })
    return
  }
  
  // Which number do we answer?
  //
  // When the sender matched a candidate row, that row's phone IS the number that
  // wrote, so either value is correct. When we had to fall back to "most recent
  // awaiting_interest participant" the sender's number belongs to *nobody* on the
  // row — it is a different SIM (recruiter testing from their own phone, candidate
  // replying from a new number, forwarded SIM). Answering participant.candidates.phone
  // in that case replies to a stranger and leaves the person who actually wrote
  // staring at silence, which is indistinguishable from the message being dropped.
  // Prefer the number the message really came from whenever we can send to it.
  const matchedByCandidatePhone = matchedCandidateIds.length > 0
  const replyPhone = matchedByCandidatePhone
    ? participant.candidates?.phone
    : senderE164 || participant.candidates?.phone

  if (!matchedByCandidatePhone && replyPhone) {
    logger.warn("Replying to sender number, not participant phone — participant was matched by fallback", {
      participantId: participant.id,
      senderPhone: phoneNumber,
      participantPhone: participant.candidates?.phone,
      replyingTo: replyPhone,
    })
  }

  logger.info("Found participant for incoming message", { 
    participantId: participant.id, 
    candidateId: participant.candidate_id,
    candidateName: participant.candidates?.name,
    candidatePhone: participant.candidates?.phone,
    replyPhone,
    status: participant.status,
    whatsappOutboundTemplate: participant.whatsapp_outbound_template,
    screeningMode: participant.screening_mode,
    scheduledCallAt: participant.scheduled_call_at,
    whatsappSentAt: participant.whatsapp_sent_at,
    infoStep: participant.info_step,
    infoConfirmed: participant.info_confirmed
  })
  
  // Idempotency: Meta redelivers webhook events on retries/timeouts. Skip any
  // message id we already processed so a candidate is never acked, parsed, or
  // re-asked more than once per inbound message.
  const msgKey = String(message.id || "")
  const seen = (participant.screening_context?.processedMessages || {}) as Record<string, string>
  if (msgKey && seen[msgKey]) {
    logger.info("Duplicate WhatsApp message, skipping", { participantId: participant.id, messageId: message.id })
    return
  }
  // Handle different message types
  //
  // The message is recorded as processed only AFTER the handler succeeds. It
  // used to be stamped first, which meant any handler failure marked the
  // message done and then returned 5xx: Meta retried, the retry hit the
  // duplicate guard above and returned 200 without acting on it. A candidate
  // tapped "Call Now", the write failed once, and the tap was then permanently
  // discarded — which is exactly the silent no-call this guard was meant to
  // prevent.
  if (messageType === "interactive") {
    await handleInteractiveMessage(participant, message.interactive, replyPhone)
  } else if (messageType === "button") {
    // Quick-reply buttons on legacy templates arrive as their own top-level type,
    // NOT wrapped in `interactive`:
    //
    //   { "type": "button", "button": { "payload": "interested", "text": "Interested" } }
    //
    // The dispatch only ever tested for "interactive" and "text", so every tap on
    // such a template fell through to no handler at all: acked with 200, no reply,
    // no state change, no record. Confirmed in production on 2026-10-05 — a
    // candidate tapped Interested on talent_outreach_v2 at 05:48:14Z and the
    // participant was still sitting on `whatsapp_sent` / `awaiting_interest`.
    //
    // Normalised into the interactive shape so it runs through the identical
    // handler, error isolation and idempotency as a modern interactive reply.
    const button = message.button || {}
    logger.warn("Legacy quick-reply button received — normalising to interactive", {
      participantId: participant.id,
      payload: button.payload,
      title: button.text,
    })
    await handleInteractiveMessage(
      participant,
      { type: "button_reply", button_reply: { id: button.payload, title: button.text } },
      replyPhone
    )
  } else if (messageType === "text") {
    await handleTextMessage(participant, message.text, replyPhone)
  } else {
    // Anything that is neither text nor interactive used to fall through this
    // `if/else if` with no handler at all — then get stamped as processed and
    // acked with 200. That is the worst possible outcome: Meta considers the
    // message delivered, we have no record of it, the candidate's recruiter card
    // shows them as still "waiting for reply", and nothing anywhere says a
    // message was dropped. Confirmed happening in production: a message arrived
    // at 05:48:14, got stamped, and left zero trace.
    //
    // Types that legitimately reach here: image/audio/video/document/sticker
    // (a candidate attaching their CTC screenshot, which is a normal reply to
    // "share your details"), contacts/location, and `unsupported` which Meta
    // uses for messages it could not decode. None of them can be auto-answered,
    // but they must never be invisible.
    logger.warn("Unhandled WhatsApp message type — recorded, not answered", {
      participantId: participant.id,
      messageType,
      messageId: message.id,
    })

    await appendToHistory(participant.id, {
      at: new Date().toISOString(),
      kind: "unhandled_message",
      direction: "in",
      messageType,
      text: describeUnhandledMessage(message),
      messageId: message.id ?? null,
    })

    // An attachment is nearly always an attempt to answer the screening
    // questions ("here is my CTC"), so treat it as needing a human rather than
    // letting it sit unanswered. `unsupported` is left alone: it is usually a
    // malformed or duplicate delivery, not a candidate waiting on us.
    if (messageType !== "unsupported") {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          needs_manual_followup: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)
    }
  }

  if (msgKey) {
    const latest = await supabaseAdmin
      .from("phone_screening_participants")
      .select("screening_context")
      .eq("id", participant.id)
      .maybeSingle()
    const currentCtx = (latest.data?.screening_context || {}) as Record<string, any>
    const currentSeen = (currentCtx.processedMessages || {}) as Record<string, string>
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        screening_context: {
          ...currentCtx,
          processedMessages: { ...currentSeen, [msgKey]: new Date().toISOString() },
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", participant.id)
  }
}

/**
 * One-line, human-readable label for a message we deliberately do not answer,
 * so the recruiter card shows *something* instead of a gap. Prefer the candidate's
 * own caption where they sent one — an image captioned "my CTC" tells the
 * recruiter far more than "Sent an image".
 */
function describeUnhandledMessage(message: any): string {
  const caption = typeof message.caption === "string" ? message.caption.trim() : ""
  const suffix = caption ? `: ${caption}` : ""

  switch (message?.type) {
    case "image":
      return `Sent a photo${suffix}`
    case "audio":
      return "Sent a voice note"
    case "video":
      return `Sent a video${suffix}`
    case "document":
      return caption
        ? `Sent a document — ${caption}`
        : "Sent a document"
    case "sticker":
      return "Sent a sticker"
    case "location":
      return "Sent their location"
    case "contacts":
      return "Sent a contact card"
    case "reaction":
      return "Reacted to a message"
    case "unsupported":
      return "Message could not be read by WhatsApp"
    default:
      return `Sent a ${message?.type || "message"}`
  }
}

async function handleInteractiveMessage(participant: any, interactive: any, replyPhone?: string) {
  if (interactive.type === "button_reply") {
    const buttonId = interactive.button_reply.id
    const buttonTitle = interactive.button_reply.title
    
    logger.info("Received button reply", { 
      participantId: participant.id, 
      buttonId, 
      buttonTitle 
    })
    
    // Isolate the handler so a failure returns a 5xx that Meta will RETRY,
    // instead of throwing out of this function and letting the whole webhook
    // 200 with the reply unprocessed.
    //
    // A candidate tapped "Call Now", the message was delivered and read, and
    // nothing happened: no call_attempts, no bolna_execution_id, no history
    // entry. Any throw here used to bubble up and the delivery was silently
    // swallowed, so the tap vanished with no trace and no way to replay it.
    try {
      const { handleInteractiveButton } = await import('@/lib/info-collector-v2')
      await handleInteractiveButton(participant.id, buttonId, buttonTitle, replyPhone)
    } catch (err: any) {
      logger.error("Failed to handle button reply — returning 500 so Meta retries", {
        participantId: participant.id,
        buttonId,
        error: err?.message || String(err),
      })
      throw err
    }
  } else if (interactive.type === "nfm_reply") {
    // Structured answers from the collect_info_form WhatsApp Flow. Only act
    // while the participant is actually being asked for info — ignore stale
    // submissions that arrive after they've already scheduled/been reviewed.
    if (participant.status === "info_requested" && participant.info_step === "collect_form") {
      await handleFlowFormReply(participant, interactive.nfm_reply)
    } else {
      logger.info("Ignoring nfm_reply for non-collect participant", {
        participantId: participant.id,
        status: participant.status,
        infoStep: participant.info_step,
      })
    }
  }
}

async function handleTextMessage(participant: any, text: any, replyPhone?: string) {
  // The number to answer. Defaults to the participant's own phone, but the caller
  // overrides it when the sender was matched by fallback rather than by phone —
  // see handleIncomingMessage. Sending to the participant row instead would reply
  // to someone who never wrote.
  const respondTo = replyPhone || participant.candidates?.phone
  const messageBody = text.body?.trim() || ""
  const lower = messageBody.toLowerCase()

  // Record the candidate's own words before doing anything else with them. This
  // is the only place inbound text exists — after this the value lives in local
  // variables and in no persisted field, so a recruiter reviewing the thread
  // later would see our replies with none of their answers.
  await recordInboundText(participant.id, messageBody)

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
  
  // 2b. A reply to a recruiter's clarification question.
  //
  // This has to be caught here, before intent classification. `clarify` leaves
  // the participant in `info_requested` with the screening step untouched, so an
  // answer to the question falls through to classifyIntent, which routes it as a
  // fresh screening utterance ("interested", "unclear", ...) and discards what
  // the candidate actually typed. The recruiter asked a specific question and the
  // answer has to land on that question.
  if (
    participant.status === 'info_requested' &&
    participant.clarification_question &&
    !participant.clarification_answered_at
  ) {
    logger.info('Candidate answered a clarification question', {
      participantId: participant.id,
      question: participant.clarification_question,
      reply: messageBody.substring(0, 160),
    })

    const answeredAt = new Date().toISOString()

    await supabaseAdmin
      .from('phone_screening_participants')
      .update({
        clarification_answered_at: answeredAt,
        // Stay in `info_requested`: the answer is in hand but the recruiter has
        // not reviewed it, and no call is approved yet. Moving to
        // `needs_review` would drop the thread out of the pre-screen queue the
        // recruiter is already looking at.
        //
        // The answer body goes in screening_context rather than a
        // `clarification_answer` column: only question/asked_at/answered_at exist
        // as real columns, and writing an unknown column makes PostgREST reject
        // the whole update — which would silently drop answered_at too and leave
        // the recruiter waiting on a reply that was received.
        screening_context: {
          ...(participant.screening_context || {}),
          clarification_answer: messageBody,
        },
      })
      .eq('id', participant.id)

    // Surfaced in the review modal as "Replied" and used to order the queue, so
    // a recruiter opening the list sees who is waiting on them rather than
    // having to read every thread to find out.
    await logCandidateActivity({
      jobId: participant.job_id || '',
      candidateId: participant.candidate_id,
      participantId: participant.id,
      eventType: 'screening_clarification_answered',
      eventData: {
        question: participant.clarification_question,
        answer: messageBody,
      },
    })

    const answerPhone = replyPhone || participant.candidates?.phone
    if (answerPhone) {
      // Free text is safe here: we just asked the question, so the 24h service
      // window is open by definition.
      await sendAndRecord(
        participant.id,
        answerPhone,
        "Thanks for the details — our team is reviewing this now and will get back to you shortly.",
        { template: null, event: 'clarification_ack' }
      )
    }
    return
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
    logger.info("Low confidence classification, sending fallback prompt", {
      participantId: participant.id,
      intent: classification.intent,
      confidence: classification.confidence,
    })
    await sendReplyFallbackPrompt(participant)
    return
  }
  
  await dispatchIntent(participant, classification, respondTo)
}

async function sendReplyFallbackPrompt(participant: any) {
  const { sendSessionMessage } = await import('@/lib/info-collector-v2')
  const phoneNumber = participant.candidates?.phone
  if (!phoneNumber) return

  await sendAndRecord(
    participant.id,
    phoneNumber,
    "Thanks for replying! To help us move forward faster, please pick one:\n\n" +
    "• Interested — we'll schedule your screening call\n" +
    "• Call now — we'll call you right away\n" +
    "• Not interested\n" +
    "• Or share your details: Current CTC, Expected CTC, Total experience, Notice period, City, Willing to relocate, Reason for switching (in one message)"
  )
}

async function dispatchIntent(
  participant: any,
  classification: { intent: string; delay_minutes: number | null },
  replyPhone?: string
) {
  // Number to answer. See handleIncomingMessage: when the sender was matched by
  // fallback rather than by phone, the participant row holds a different number
  // than the one that actually wrote, and replying to the row leaves the real
  // sender with silence.
  const respondTo = replyPhone || participant.candidates?.phone
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

      // Outbound candidates are gated on interest BEFORE we ask for anything.
      // Jumping straight to schedule buttons skipped the details we actually
      // need (CTC, notice, relocation), so the call had nothing to screen
      // against. Now "Interested" opens the form; the call is offered after the
      // pre-screen, which is where the schedule buttons are sent from.
      const awaitingInterest = !!participant.screening_context?.awaitingInterest
      if (awaitingInterest) {
        // info_data is deliberately preserved. It is NOT reset here: a candidate
        // can reply "interested" after already typing some details (or after a
        // pre-screen was started), and blanking it threw away real CTC/notice
        // data and forced them to re-type everything. Resetting on a fresh
        // interest is the caller's decision, not something a reply should do.
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: "info_requested",
            screening_mode: "collect_info_first",
            info_step: "collect_form",
            info_confirmed: false,
            screening_context: {
              ...(participant.screening_context || {}),
              awaitingInterest: false,
              interestedAt: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", participant.id)

        if (respondTo) {
          try {
            // sendCollectInfoForm is a method on the service, not a standalone
            // export.
            const formResult = await getWhatsAppService().sendCollectInfoForm({
              phoneNumber: respondTo,
              candidateName: participant.candidates?.name || "Candidate",
              jobTitle: participant.jobs?.title || "the role",
              companyName: participant.jobs?.client_name || "",
              flowToken: participant.id,
            })
            if (!formResult.success) {
              logger.error("Failed to send details form after interest", {
                participantId: participant.id,
                error: formResult.error,
              })
              await supabaseAdmin
                .from("phone_screening_participants")
                .update({
                  status: "needs_manual_followup",
                  needs_manual_followup: true,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", participant.id)
              await sendAndRecord(
                participant.id,
                respondTo,
                "Sorry, we couldn't open the details form just now. 🙏 Reply here and our team will help you directly."
              )
            }
          } catch (err: any) {
            logger.error("Failed to send details form after interest", {
              participantId: participant.id,
              error: err.message,
            })
          }
        } else {
          // Interested but we have nowhere to reply. Previously this just fell
          // through the `if` and hit `break`, leaving the row sitting in
          // info_requested with no form, no reply and no flag — it looked like
          // the candidate was mid-flow when in fact nobody had been contacted.
          logger.error("Interested with no reachable phone — flagging for manual followup", {
            participantId: participant.id,
            candidateId: participant.candidate_id,
          })
          await supabaseAdmin
            .from("phone_screening_participants")
            .update({
              status: "needs_manual_followup",
              needs_manual_followup: true,
              updated_at: new Date().toISOString(),
            })
            .eq("id", participant.id)
        }
        break
      }

      await supabaseAdmin
        .from("phone_screening_participants")
        .update({ status: "interested", updated_at: new Date().toISOString() })
        .eq("id", participant.id)

      // Send schedule options if we have their phone
      if (respondTo) {
        try {
          const whatsapp = getWhatsAppService()
          await whatsapp.sendScheduleOptions({
            phoneNumber: respondTo,
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

      // Never end on a dead end. Thank them, leave the door open, and point them
      // at the portal so a decline today can become an application later.
      if (participant.candidates?.phone) {
        try {
          const { getPortalJobsUrl } = await import("@/lib/call-orchestrator")
          await sendAndRecord(
            participant.id,
            participant.candidates.phone,
            "Thanks for your time, and for reading our message. 🙏\n\n" +
              "We'll reach out if something matching your profile comes up. " +
              `In the meantime, you can browse other open roles here: ${getPortalJobsUrl()}`,
            { kind: "not_interested_closing" }
          )
        } catch (err: any) {
          logger.error("Failed to send not-interested follow-up", {
            participantId: participant.id,
            error: err.message,
          })
        }
      }
      break
    }
    
    case 'provide_details': {
      // Portal applicants already typed their CTC/notice into the apply form.
      // Re-asking is the "why are you asking me again" bug — when we hold a
      // screenable set of fields, "provide details" is just consent, so honour
      // it by moving to scheduling rather than opening a form.
      const { hasEnoughToScreen, knownScreeningFields } = await import('@/lib/info-collector-v2')
      if (hasEnoughToScreen(participant)) {
        logger.info("AI: provide_details but details already on file — scheduling", {
          participantId: participant.id,
          known: knownScreeningFields(participant),
        })
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ status: "interested", info_step: "confirmed", updated_at: new Date().toISOString() })
          .eq("id", participant.id)

        if (participant.candidates?.phone) {
          const sent = await getWhatsAppService().sendScheduleOptions({
            phoneNumber: participant.candidates.phone,
            candidateName: participant.candidates?.name || 'Candidate',
            jobTitle: participant.jobs?.title || 'the role',
          })
          if (sent.success) {
            await appendToHistory(participant.id, {
              at: new Date().toISOString(),
              kind: "schedule_buttons",
              direction: "out",
              text: `Thanks ${participant.candidates?.name || ''} — we already have your details from your application, so let's set up your screening call.`.trim(),
              status: "sent",
              messageId: sent.messageId ?? null,
            })
          }
        }
        break
      }

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
    
    case 'question': {
      logger.info("AI: answering candidate question", { participantId: participant.id })
      const { sendSessionMessage } = await import('@/lib/info-collector-v2')
      const { formatSalaryRange, jobLocation } = await import('@/lib/call-orchestrator')
      const { hasEnoughToScreen } = await import('@/lib/info-collector-v2')
      const phoneNumber = participant.candidates?.phone
      const role = participant.jobs?.title || "the role"
      const company = participant.jobs?.client_name || "our client"
      const city = jobLocation(participant.jobs || {})
      // Shared formatter: the inline `Rs ${min} - ${max}` this replaced printed
      // raw rupees (a monthly 30000-40000 band read as a paise salary) and "?"
      // for half-filled jobs.
      const salary = formatSalaryRange(participant.jobs || {}) || "competitive"

      // Do not invite a portal applicant to re-send details they already typed
      // into the apply form — that invitation is what turned a question into an
      // info-collection exchange.
      const nextStep = hasEnoughToScreen(participant)
        ? `Would you like to schedule it? Reply "call now" or pick a slot.`
        : `Would you like to schedule it? Reply "call now", or share your CTC / notice period / experience and we'll proceed.`

      if (phoneNumber) {
        await sendAndRecord(
          participant.id,
          phoneNumber,
          `Thanks for asking! Quick details on the ${role} role at ${company}:${city ? `\n• Location: ${city}` : ""}\n• Salary: ${salary}\n• Screening: a quick 5-10 minute call with our AI recruiter.\n\n${nextStep}`,
          { kind: "role_info_reply" }
        )
      }
      break
    }
    
    case 'unclear':
    default: {
      logger.info("AI: unclear intent, sending fallback prompt", { participantId: participant.id, intent })
      await sendReplyFallbackPrompt(participant)
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

  // scheduleOrPlaceCall owns the DB write (both due-time columns) and the
  // delivery decision: due now → direct placement, otherwise QStash. It also
  // books a callback if a direct placement fails, so "call now" can never end
  // up as a database row with no actual call behind it.
  const result = await scheduleOrPlaceCall(participant.id, Math.max(0, Math.round(delayMs / 1000)))

  if (result.success) {
    logger.info("Call placed immediately", { participantId: participant.id })
  } else if (result.skipped) {
    logger.info("Call already in flight — not duplicating", {
      participantId: participant.id,
      reason: result.error,
    })
  } else if (result.scheduled) {
    logger.info("Successfully scheduled via QStash", { participantId: participant.id })
  } else {
    logger.error("Failed to schedule or place call", { participantId: participant.id, error: result.error })
  }
}

async function handleStatusUpdate(status: any) {
  const messageId = status.id
  const statusType = status.status // sent, delivered, read, failed

  logger.info("WhatsApp status update", { messageId, status: statusType })

  if (!status.id) return

  // Try to find participant by message ID (outbound template + interactive sends)
  const { data: participant, error: findError } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, whatsapp_history")
    .eq("whatsapp_message_id", messageId)
    .maybeSingle()

  if (findError) {
    logger.warn("Status update: participant lookup failed", { messageId, error: findError.message })
    return
  }

  if (!participant) {
    logger.info("Status update: no participant mapped to message id", { messageId, status: statusType })
    return
  }

  // Note: whatsapp_delivery_status is the only delivery-state column that exists on
  // phone_screening_participants (whatsapp_delivered_at/read_at/error do NOT exist and
  // previously caused silent update failures). Delivery timestamps are appended to
  // whatsapp_history so the UI can still show them.
  const updates: any = {
    whatsapp_delivery_status: statusType,
    updated_at: new Date().toISOString(),
  }

  const history = Array.isArray(participant.whatsapp_history) ? [...participant.whatsapp_history] : []
  const historyEntry: Record<string, any> = { messageId, status: statusType, at: new Date().toISOString() }

  if (statusType === "failed") {
    const errMsg = status.errors?.[0]?.message || "Delivery failed"
    logger.warn("WhatsApp message delivery failed", { participantId: participant.id, messageId, error: errMsg })
    historyEntry.error = errMsg
    updates.whatsapp_response = errMsg
  }

  history.push(historyEntry)
  updates.whatsapp_history = history

  const { error: updateError } = await supabaseAdmin
    .from("phone_screening_participants")
    .update(updates)
    .eq("id", participant.id)

  if (updateError) {
    logger.warn("Failed to persist status update", { participantId: participant.id, status: statusType, error: updateError.message })
  } else {
    logger.info("Status update persisted", { participantId: participant.id, status: statusType })
  }
}

// Kept as a thin named wrapper so existing call sites read unchanged; the actual
// read-modify-write now lives in lib/whatsapp-thread so the UI and the recorder
// agree on one entry shape.
async function appendToHistory(participantId: string, entry: Record<string, any>) {
  const ok = await appendThreadEntry(participantId, entry)
  if (!ok) {
    logger.warn("appendToHistory: persist failed", { participantId, entry: entry.kind || entry.status })
  }
}

async function assertSet(participantId: string, fields: Record<string, any>) {
  const { error } = await supabaseAdmin
    .from("phone_screening_participants")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", participantId)
  if (error) {
    logger.warn("assertSet failed", { participantId, error: error.message })
  }
}

// Shared post-collect path: persist collected info + pre-screen result, then
// branch (proceed / needs_review / filtered_out). Used by BOTH the free-text
// collect_all reply and the WhatsApp Flows form (nfm_reply) submission.
async function finalizeCollectedInfo(
  participant: any,
  mergedInfoData: Record<string, any>,
  infoSource: "collect_all" | "collect_form",
  sourceText: string,
  answeredFields?: Record<string, any>,
) {
  const phoneNumber = participant.candidates?.phone

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

  // Run AI pre-screen evaluation on the normalized numeric CandidateInfo
  // (extracted strings like "8 LPA"/"5 years" never satisfied the numeric
  // checks, so every candidate used to sail through as "proceed").
  //
  // Total experience and current location are trusted from the resume and are no
  // longer seeded into info_data, so overlay them here for the evaluation only.
  // Without this the experience-band check would run against a blank value.
  const resumeInfo = buildResumeInfo(participant.candidates || {})
  const preScreenResult = await evaluatePreScreenWithAI(
    buildCandidateInfoFromCollected({ ...resumeInfo, ...mergedInfoData }),
    jobRequirements,
    preScreenConfig
  )

  logger.info("Pre-screen evaluation result", {
    participantId: participant.id,
    decision: preScreenResult.decision,
    summary: preScreenResult.summary,
    reasons: preScreenResult.reasons,
  })

  // Update participant with collected info and pre-screen result.
  //
  // info_sources is written in the SAME update as info_data: every key the
  // candidate just supplied is "whatsapp", while anything still sitting from the
  // apply form keeps its original "application" provenance via mergeSources.
  // Without this the UI labels apply-form values as WhatsApp-confirmed.
  const now = new Date().toISOString()
  const { data: currentRow } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("info_sources")
    .eq("id", participant.id)
    .maybeSingle()

  // Only the fields the candidate supplied in THIS message/reply are WhatsApp.
  //
  // mergedInfoData still holds values seeded from the apply form, so stamping
  // all of its keys marked apply-form answers as "confirmed on WhatsApp" and
  // relabelled them in the UI. answeredFields is what was just parsed.
  const answeredNow = Object.keys(answeredFields ?? {}).filter((k) => {
    const v = (answeredFields ?? {})[k]
    return isMeaningfulValue(v)
  })

  logger.info("Provenance for this collection", {
    participantId: participant.id,
    infoSource,
    stampedAsWhatsapp: answeredNow,
    keptFromApplication: Object.keys(mergedInfoData).filter((k) => !answeredNow.includes(k)),
  })

  // This single update carries info_data, info_sources, the pre-screen result and
  // the reply text. If ANY of it fails the candidate's answers plus the pre-screen
  // verdict are lost while the webhook would still return 200 — silent data loss
  // with no trace. updateParticipant retries without info_sources if that column
  // has not been migrated yet, and throws for every other failure so Meta retries.
  await updateParticipant(participant.id, {
    info_data: mergedInfoData,
    info_sources: mergeSources(currentRow?.info_sources, stampSources(answeredNow, "whatsapp")),
    // 'confirmed' is a sentinel that isInInfoFlow explicitly excludes (it
    // excludes 'confirmed' and 'collect_all', NOT 'confirm'). The old
    // 'confirm' value left participants stuck in the step-by-step re-ask.
    info_step: 'confirmed',
    info_confirmed: false,
    whatsapp_reply_text: sourceText.slice(0, 500),
    whatsapp_reply_at: now,
    info_received_at: now,
    screening_context: {
      ...participant.screening_context,
      infoReceivedVia: infoSource,
      preScreenResult: {
        decision: preScreenResult.decision,
        reasons: preScreenResult.reasons,
        summary: preScreenResult.summary,
        skippedChecks: preScreenResult.skippedChecks,
        evaluatedAt: new Date().toISOString(),
      }
    },
    updated_at: now,
  })

  // Branch based on pre-screen decision
  switch (preScreenResult.decision) {
    case 'proceed': {
      // Mark as passed pre-screen; let candidate pick a call slot via session buttons
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({ status: "info_received", updated_at: new Date().toISOString() })
        .eq("id", participant.id)

      const { getWhatsAppService, AI_CALLER_NUMBER } = await import('@/lib/whatsapp')
      // Body text is recorded alongside the send so the conversation view shows
      // what was actually offered, not just that a send happened.
      //
      // The caller number is named here because this is the exact moment the
      // candidate commits to a call: carrier unknown-number screening makes
      // candidates decline an unrecognised one, and an unrecognised screening
      // call is indistinguishable from a scam call. This is a session message
      // inside the 24-hour customer service window, so it needs no approved
      // template and therefore no Meta re-approval.
      const proceedBody =
        "✅ Thanks for sharing your details! Your profile looks like a good fit.\n\n" +
        `When should our AI recruiter call you for the quick screening?\n\n` +
        `Expect the call on ${AI_CALLER_NUMBER}. Please keep your phone handy.`
      const sendResult = await getWhatsAppService().sendInteractiveButtons({
        phoneNumber,
        body: proceedBody,
        footer: "Reply 'call now' or pick a slot",
        buttons: [
          { id: "call_now", title: "Call Now" },
          { id: "in_10_min", title: "In 10 min" },
          { id: "in_30_min", title: "In 30 min" },
        ],
      })

      if (!sendResult.success) {
        logger.warn("Failed to send schedule buttons after proceed", {
          participantId: participant.id,
          error: sendResult.error,
        })
        await appendToHistory(participant.id, {
          at: new Date().toISOString(),
          kind: "schedule_buttons",
          direction: "out",
          text: proceedBody,
          status: "failed",
          error: sendResult.error,
        })
      } else {
        logger.info("Schedule buttons sent after proceed", {
          participantId: participant.id,
          messageId: sendResult.messageId,
        })
        await appendToHistory(participant.id, {
          at: new Date().toISOString(),
          kind: "schedule_buttons",
          direction: "out",
          text: proceedBody,
          status: "sent",
          messageId: sendResult.messageId,
        })
        await assertSet(participant.id, {
          whatsapp_delivery_status: "sent",
          whatsapp_message_id: sendResult.messageId,
        })
      }
      break
    }

    case 'needs_review': {
      // Tell the candidate we have their details and a person is looking at them.
      //
      // This branch used to be COMPLETELY silent. That was right about one thing
      // and wrong about another. Right: before approval we must not send a verdict
      // or offer call slots. Wrong: silence leaves the candidate with no idea
      // whether they were heard at all. A live run showed the cost — the
      // candidate's details landed, nothing came back, and then a scheduled
      // reminder fired saying "one quick thing before we call you", contradicting
      // the silence and promising a call nobody approved. The only thing the
      // candidate could do meanwhile was reply, and those replies got parsed as
      // answers to a screening field ("clarify: yes").
      //
      // So: acknowledge receipt, say a human is reviewing, commit to nothing, and
      // invite replies — which is also what gives HR something to answer. The
      // review gate itself is untouched.
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "needs_review",
          needs_manual_followup: true,
          screening_context: {
            ...(participant.screening_context || {}),
            // Guards the late-reply path below from messaging them either.
            awaitingReviewApproval: true,
            awaitingReviewSince: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)

      // Recorded as an internal event, not an outbound bubble: the thread shows
      // the candidate's details arriving and then nothing, which is accurate.
      await appendToHistory(participant.id, {
        at: new Date().toISOString(),
        kind: "pre_screen_review_queued",
        direction: "internal",
        text: "Pre-screen flagged this profile for HR review. Candidate told a recruiter is reviewing — no verdict, no call slot and no booking until a human approves.",
        status: "sent",
        preScreenDecision: preScreenResult.decision,
        preScreenReasons: preScreenResult.reasons,
      })

      // The only candidate-facing message on this path, and it uses the
      // pre-approved `info_review_pending` template rather than free text.
      //
      // A template matters here for a concrete reason: free-text session messages
      // only reach a candidate inside WhatsApp's 24-hour service window, and this
      // send can easily happen outside it. sendAndRecord would report success
      // while Meta silently refused, re-creating the silence in a harder-to-spot
      // form. The template also carries no verdict and promises nothing beyond
      // "we will get back to you shortly", which is what makes it safe pre-approval.
      const reviewPhone = participant.candidates?.phone
      if (!reviewPhone) {
        logger.warn("needs_review — no candidate phone; cannot acknowledge", {
          participantId: participant.id,
        })
      } else {
        const ack = await getWhatsAppService().sendInfoReviewPending({
          phoneNumber: reviewPhone,
          candidateName: participant.candidates?.name || "",
          jobTitle: participant.jobs?.title || "this role",
          companyName: participant.jobs?.client_name || "",
        })

        await appendToHistory(participant.id, {
          at: new Date().toISOString(),
          kind: "info_review_pending",
          direction: "out",
          template: "info_review_pending",
          text: `Thanks ${participant.candidates?.name || ""} — we've received your details and our team is reviewing your profile. We'll be in touch shortly.`,
          status: ack.success ? "sent" : "failed",
          messageId: ack.messageId ?? null,
          error: ack.success ? null : ack.error ?? null,
        })

        if (!ack.success) {
          logger.error("Could not acknowledge needs_review to the candidate", {
            participantId: participant.id,
            error: ack.error,
          })
        }
      }

      logger.info("Pre-screen needs_review — held for HR approval; candidate told we're reviewing", {
        participantId: participant.id,
        reasons: preScreenResult.reasons,
      })
      break
    }

    case 'filtered_out': {
      // ── NEVER tell the candidate they were rejected. ──────────────────────
      // This branch used to set status "filtered_out" and immediately send
      // "this role may not be the best match for your profile". Nothing human
      // ever saw it.
      //
      // That is indefensible when the verdict is computed from parsed free text:
      // a real candidate was rejected because his ₹11,40,000/yr expectation was
      // compared against a job band stored as 40,000-70,000 PER MONTH — a 1000x
      // units error — and he received a rejection message that no recruiter
      // approved, for a role he may well have been a strong match for.
      //
      // So the AI's opinion is recorded and surfaced to HR, and the candidate
      // hears NOTHING until a human decides. The row goes to the "AI suggests
      // not suitable" queue, where one click either sends the schedule buttons
      // (proceed to call) or sends the rejection with a reason (reject).
      //
      // Note the candidate is deliberately NOT blocked from the call here. They
      // have already engaged with us, so silence is the least harmful option —
      // but "no decision" is a decision HR has to notice, which is why this is
      // recorded as an explicit pending review rather than a terminal status.
      const reviewedAt = new Date().toISOString()
      const { data: latest } = await supabaseAdmin
        .from("phone_screening_participants")
        .select("screening_context")
        .eq("id", participant.id)
        .maybeSingle()

      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "needs_review",
          screening_context: {
            ...(latest?.screening_context || participant.screening_context || {}),
            // The AI recommendation is kept verbatim under preScreenResult
            // (already written above). These flags mark that a human decision is
            // outstanding, so the AI Screen can show an explicit queue.
            aiSuggestsRejection: true,
            aiSuggestsRejectionAt: reviewedAt,
            pendingDecision: "ai_recommends_reject",
          },
          updated_at: reviewedAt,
        })
        .eq("id", participant.id)

      await appendToHistory(participant.id, {
        at: reviewedAt,
        kind: "pre_screen_review",
        status: "pending",
        detail:
          "AI suggests this candidate may not be a fit. The candidate was told a recruiter " +
          "is reviewing — no verdict has been sent, and a recruiter must confirm before they " +
          "hear anything about the outcome.",
      })

      // Same template, and deliberately so. "AI suggests reject" must not read
      // differently from "needs review": if the two branches sent different copy,
      // the wording itself would leak the verdict we are refusing to state. The
      // AI's opinion stays internal until a recruiter decides.
      const rejectPhone = participant.candidates?.phone
      if (rejectPhone) {
        const ack = await getWhatsAppService().sendInfoReviewPending({
          phoneNumber: rejectPhone,
          candidateName: participant.candidates?.name || "",
          jobTitle: participant.jobs?.title || "this role",
          companyName: participant.jobs?.client_name || "",
        })

        await appendToHistory(participant.id, {
          at: new Date().toISOString(),
          kind: "info_review_pending",
          direction: "out",
          template: "info_review_pending",
          text: `Thanks ${participant.candidates?.name || ""} — we've received your details and our team is reviewing your profile. We'll be in touch shortly.`,
          status: ack.success ? "sent" : "failed",
          messageId: ack.messageId ?? null,
          error: ack.success ? null : ack.error ?? null,
        })

        if (!ack.success) {
          logger.error("Could not acknowledge AI-suggested-rejection to the candidate", {
            participantId: participant.id,
            error: ack.error,
          })
        }
      }

      logger.info("AI suggested rejection — escalated to HR; candidate told we're reviewing, verdict withheld", {
        participantId: participant.id,
        reasons: preScreenResult.reasons,
      })
      break
    }
  }
}

// Structured fields submitted through the collect_info_form WhatsApp Flow.
// The flow form is only sent to collect_info_first participants (info_step
// "collect_form"), so the data is trusted as-is — no Gemini extraction, the
// form fields already match the CandidateInfo keys the pre-screen reads.
async function handleFlowFormReply(participant: any, nfmReply: any) {
  const phoneNumber = participant.candidates?.phone

  try {
    // Instant ack so the candidate isn't staring at silence while the
    // pre-screen runs. Fire-and-forget; the decision messages supersede it.
    sendAndRecord(
      participant.id,
      phoneNumber,
      "Thanks — got it. Reviewing your profile now."
    ).catch(() => {})

    let fields: Record<string, any> = {}
    let parseFailed = false
    try {
      const parsed = JSON.parse(nfmReply?.response_json || "{}")
      fields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
    } catch (err: any) {
      parseFailed = true
      logger.warn("flow form response_json was not valid JSON", {
        participantId: participant.id,
        error: err?.message,
        raw: String(nfmReply?.response_json || "").slice(0, 200),
      })
    }

    // A `complete` action returns ONLY the values its footer payload maps. The
    // old v2 flow had `"payload": {}`, so every submission arrived as `{}` — the
    // candidate filled all five fields and we silently discarded them, then ran
    // the pre-screen on a blank profile and reported "Salary / Notice missing" as
    // though they had withheld it. Never judge a candidate on an empty payload:
    // tell them it didn't come through and route to a human instead.
    const meaningful = Object.entries(fields).filter(([, v]) =>
      v !== undefined && v !== null && String(v).trim() !== ""
    )
    if (meaningful.length === 0) {
      logger.error("flow form submission contained no fields — not evaluating", {
        participantId: participant.id,
        parseFailed,
        hasResponseJson: !!nfmReply?.response_json,
        template: participant.whatsapp_outbound_template,
      })
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "needs_manual_followup",
          needs_manual_followup: true,
          info_step: "collect_form",
          screening_context: {
            ...(participant.screening_context || {}),
            collect_fail_count: Number(participant.screening_context?.collect_fail_count || 0) + 1,
            collect_error: "empty_form_submission",
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)

      await appendToHistory(participant.id, {
        at: new Date().toISOString(),
        kind: "form_submit_failed",
        status: "failed",
        error: "empty form submission",
      })

      await sendAndRecord(
        participant.id,
        phoneNumber,
        "Sorry — we didn't receive your details properly. 🙏\n\n" +
          "Please tap 'Share details' in the previous message and submit the form again. " +
          "If it still fails, just reply here and our team will help you directly.",
      )
      return
    }

    // Form returns "Yes"/"No" but the pre-screen checks for "yes"/true.
    if (typeof fields.willing_to_relocate === "string") {
      fields.willing_to_relocate = fields.willing_to_relocate.toLowerCase()
    }

    logger.info("Received flow form reply", {
      participantId: participant.id,
      flowToken: nfmReply?.flow_token,
      fieldCount: meaningful.length,
      fields,
    })

    const mergedInfoData = { ...participant.info_data, ...fields }
    const sourceText = JSON.stringify({ ...mergedInfoData, flow_token: nfmReply?.flow_token || null })
    await finalizeCollectedInfo(participant, mergedInfoData, "collect_form", sourceText, fields)
  } catch (error: any) {
    logger.error("Error handling flow form reply", {
      participantId: participant.id,
      error: error.message,
    })
    if (phoneNumber) {
      await sendAndRecord(participant.id, phoneNumber, "Thanks for sharing your details! Our team will review them and reach out shortly.")
    }
  }
}

async function handleCollectAllReply(participant: any, messageBody: string) {
  const phoneNumber = participant.candidates?.phone

  try {
    // Instant ack so the candidate isn't staring at silence while Gemini
    // extracts fields and runs the pre-screen. Fire-and-forget; the decision
    // messages below supersede it.
    sendAndRecord(
      participant.id,
      phoneNumber,
      "Thanks — got it. Reviewing your profile now."
    ).catch(() => {})

    // Parse all fields from the single message
    const allFields = await extractAllFieldsFromReply(messageBody, participant.info_data || {})
    
    logger.info("Extracted all fields from collect_all reply", { 
      participantId: participant.id, 
      allFields 
    })

    // Merge with existing info_data
    const mergedInfoData = { ...participant.info_data, ...allFields }

    await finalizeCollectedInfo(participant, mergedInfoData, "collect_all", messageBody, allFields)

  } catch (error: any) {
    logger.error("Error handling collect_all reply", { 
      participantId: participant.id, 
      error: error.message 
    })

    // Never reset to step-by-step + re-send the info-request template here
    // (that was the "asks again and again" loop when the status write failed
    // or extraction threw). Keep collect_all, ask once for a re-formatted
    // reply, and escalate to HR follow-up after repeated failures.
    const ctx = participant.screening_context || {}
    const failCount = Number(ctx.collect_fail_count || 0) + 1

    if (failCount >= 2) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          info_step: 'confirmed',
          status: "needs_manual_followup",
          screening_context: {
            ...ctx,
            collect_fail_count: failCount,
            collect_error: String(error.message || error),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)

      if (phoneNumber) {
        await sendAndRecord(participant.id, phoneNumber, "Thanks for sharing your details! Our team will review them and reach out shortly.")
      }
    } else {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          info_step: 'collect_all',
          screening_context: {
            ...ctx,
            collect_fail_count: failCount,
            collect_error: String(error.message || error),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)

      if (phoneNumber) {
        await sendAndRecord(
          participant.id,
          phoneNumber,
          "🙏 Couldn't read all the details. Please share them in ONE reply like:\n\n" +
            "Current CTC, Expected CTC, Total experience, Notice period, City, Willing to relocate (yes/no), Reason for switching\n\n" +
            'Example: "8 LPA, 12 LPA, 5 years, 30 days, Mumbai, yes, better growth"'
        )
      }
    }
  }
}
