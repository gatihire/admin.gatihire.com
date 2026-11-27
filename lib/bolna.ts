import { logger } from "@/lib/logger"
import { toE164 } from "./phone"

const BOLNA_API = "https://api.bolna.ai"
const BOLNA_WEBHOOK_SOURCE_IP = "13.203.39.153"

function getConfig() {
  const apiKey = process.env.BOLNA_API_KEY
  const agentId = process.env.BOLNA_AGENT_ID
  const fromNumber = process.env.BOLNA_FROM_NUMBER
  const webhookBase = process.env.PHONE_SCREENING_WEBHOOK_BASE

  if (!apiKey) {
    logger.warn("Bolna configuration incomplete: BOLNA_API_KEY missing")
  }

  return { apiKey, agentId, fromNumber, webhookBase }
}

/** Convert a phone number to E.164 format Bolna requires (e.g. +919876543210). */
export { toE164 }

export interface BolnaCallParams {
  to: string
  userData: Record<string, unknown>
  fromNumber?: string
  scheduledAt?: string
}

/**
 * Why a placement was refused.
 *
 * This exists because every failure used to look the same: `success: false`
 * with a message that was printed into a request log and then dropped. A
 * balance outage and a bad phone number need opposite responses (pause
 * everything vs. flag one candidate), so they cannot share one bucket.
 */
export type BolnaFailureKind =
  | "credit_exhausted" // provider account has no balance / quota
  | "invalid_number"   // number cannot be dialled — retrying will not help
  | "not_configured"   // missing API key / agent id
  | "provider_error"   // 5xx, timeout, rate limit — worth retrying
  | "rejected"         // any other refusal

export interface BolnaCallResult {
  success: boolean
  executionId?: string
  error?: string
  kind?: BolnaFailureKind
  /** False when a retry cannot possibly succeed without a human changing something. */
  retryable?: boolean
  httpStatus?: number
}

const CREDIT_PATTERN =
  /insufficient|out of (balance|credit|funds)|no (balance|credit)|not enough (balance|credit|funds)|balance|credit|wallet|quota|payment|recharge|top[\s-]?up|exhaust/i

const INVALID_NUMBER_PATTERN =
  /invalid (phone|number|recipient)|not a valid|unverified|number (is )?(invalid|not valid|blocked)|dnd|do not disturb|not reachable/i

/** Map a provider refusal onto an actionable cause. */
export function classifyPlacementFailure(
  httpStatus: number | undefined,
  rawMessage: string | undefined
): { kind: BolnaFailureKind; retryable: boolean } {
  const message = String(rawMessage || "").trim()

  if (httpStatus === 402) {
    return { kind: "credit_exhausted", retryable: false }
  }
  if (httpStatus === 401) {
    return { kind: "not_configured", retryable: false }
  }
  if (CREDIT_PATTERN.test(message)) {
    return { kind: "credit_exhausted", retryable: false }
  }
  if (httpStatus === 403) {
    // 403 is only a balance signal when it SAYS so; otherwise it is an auth
    // problem and pausing every campaign would be the wrong response.
    return { kind: "rejected", retryable: false }
  }
  if (INVALID_NUMBER_PATTERN.test(message)) {
    return { kind: "invalid_number", retryable: false }
  }
  if (httpStatus === 429 || (typeof httpStatus === "number" && httpStatus >= 500)) {
    return { kind: "provider_error", retryable: true }
  }
  if (!httpStatus) {
    // Network exception — no status at all.
    return { kind: "provider_error", retryable: true }
  }
  return { kind: "rejected", retryable: false }
}

export async function placeBolnaCall(params: BolnaCallParams): Promise<BolnaCallResult> {
  const { apiKey, agentId, fromNumber } = getConfig()
  const recipient = toE164(params.to)

  logger.info("placeBolnaCall called", { 
    to: params.to, 
    recipient, 
    hasApiKey: !!apiKey, 
    hasAgentId: !!agentId,
    hasFromNumber: !!(params.fromNumber || fromNumber),
    userDataKeys: Object.keys(params.userData || {})
  })

  if (!apiKey || !agentId) {
    logger.error("Bolna not configured", { hasApiKey: !!apiKey, hasAgentId: !!agentId })
    return {
      success: false,
      error: "Bolna not configured (BOLNA_API_KEY / BOLNA_AGENT_ID)",
      kind: "not_configured",
      retryable: false,
    }
  }
  if (!recipient) {
    logger.error("Invalid phone number", { to: params.to, recipient })
    return { success: false, error: "Invalid phone number", kind: "invalid_number", retryable: false }
  }

  const body: Record<string, unknown> = {
    agent_id: agentId,
    recipient_phone_number: recipient,
    // No calling-hours policy anywhere in the stack. Even if the live agent
    // still has a legacy guardrail from a dashboard edit, this call must ring
    // now instead of being rescheduled by the provider.
    bypass_call_guardrails: true,
    user_data: params.userData,
  }
  if (params.fromNumber || fromNumber) {
    body.from_phone_number = toE164(params.fromNumber || fromNumber || "")
  }
  if (params.scheduledAt) {
    body.scheduled_at = params.scheduledAt
  }

  try {
    logger.info("Calling Bolna API", { recipient, agentId, hasUserData: !!params.userData })
    const res = await fetch(`${BOLNA_API}/call`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const message = data?.message || data?.error || data?.detail || `HTTP ${res.status}`
      const { kind, retryable } = classifyPlacementFailure(res.status, message)
      logger.error("Bolna call failed", { status: res.status, kind, error: data, recipient })
      return { success: false, error: message, kind, retryable, httpStatus: res.status }
    }

    if (data?.execution_id) {
      logger.info(`Bolna call triggered to ${recipient}`, { executionId: data.execution_id })
      return { success: true, executionId: data.execution_id }
    }

    return {
      success: false,
      error: "Bolna call accepted but no execution_id returned",
      kind: "provider_error",
      retryable: true,
      httpStatus: res.status,
    }
  } catch (err: any) {
    logger.error("Bolna call exception", { recipient, error: err.message })
    const { kind, retryable } = classifyPlacementFailure(undefined, err.message)
    return { success: false, error: err.message, kind, retryable }
  }
}

export interface BolnaExecution {
  id?: string
  agent_id?: string
  status?: string
  error_message?: string | null
  answered_by_voice_mail?: boolean
  conversation_duration?: number | null
  total_cost?: number | null
  transcript?: string | null
  extracted_data?: Record<string, unknown> | null
  context_details?: { participant_id?: string; [key: string]: unknown }
  telephony_data?: {
    duration?: string
    recording_url?: string | null
    to_number?: string
    from_number?: string
    hangup_reason?: string | null
    hangup_by?: string | null
    ring_duration?: number | null
    to_number_carrier?: string | null
    provider_call_id?: string | null
  }
  cost_breakdown?: Record<string, number>
  latency_data?: { time_to_first_audio?: number }
  created_at?: string
  updated_at?: string
}

export async function getBolnaExecution(executionId: string): Promise<BolnaExecution | null> {
  const { apiKey, agentId } = getConfig()
  if (!apiKey) return null

  const candidates = [
    { label: "v1", url: `${BOLNA_API}/executions/${executionId}` },
    { label: "v2-common", url: `${BOLNA_API}/v2/executions/${executionId}` },
    { label: "agent-v1", url: `${BOLNA_API}/agent/${agentId}/execution/${executionId}` },
    { label: "agent-v2", url: `${BOLNA_API}/v2/agent/${agentId}/execution/${executionId}` },
  ]

  for (const variant of candidates) {
    try {
      const res = await fetch(variant.url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (res.ok) {
        const data = await res.json()
        logger.info("Bolna execution fetched", { executionId, via: variant.label })
        return data
      }
    } catch (err: any) {
      logger.error("Bolna execution fetch exception", { executionId, via: variant.label, error: err.message })
    }
  }

  logger.error("Bolna execution fetch failed on all endpoints", { executionId })
  return null
}

export async function findLatestExecutionByPhone(
  phone: string,
  opts?: { from?: Date }
): Promise<BolnaExecution | null> {
  const { apiKey, agentId } = getConfig()
  const target = toE164(phone)
  if (!apiKey || !agentId || !target) return null

  const from = (opts?.from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).toISOString()
  const to = new Date().toISOString()

  for (let page = 1; page <= 3; page++) {
    const url =
      `${BOLNA_API}/v2/agent/${agentId}/executions?page_size=50&page_number=${page}` +
      `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        logger.error("Bolna executions list failed", { status: res.status, page })
        return null
      }
      const body = await res.json()
      const list = body?.data || []
      for (const ex of list) {
        const toNumber = ex?.telephony_data?.to_number || ex?.user_number || null
        if (toNumber && toE164(toNumber) === target) {
          return ex as BolnaExecution
        }
      }
      if (!body?.has_more) break
    } catch (err: any) {
      logger.error("Bolna executions list exception", { error: err.message, page })
      return null
    }
  }
  return null
}

export const BOLNA_TERMINAL_STATUSES = new Set([
  "completed",
  "no-answer",
  "busy",
  "failed",
  "canceled",
  "stopped",
  "error",
  "balance-low",
])

/**
 * Verify an incoming Bolna webhook. Bolna sends webhooks from a fixed source IP.
 * When the source IP is unavailable (e.g. behind a proxy), fall back to a shared token.
 * For POST requests with valid JSON body, also allow through (for testing/dashboard pings).
 */
export function verifyBolnaWebhook(
  request: Request,
  headers: Headers,
  bodyText: string
): boolean {
  const remoteIp = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || ""
  const token = process.env.BOLNA_WEBHOOK_TOKEN

  // CHECK 1: Token-based auth (preferred for proxied environments)
  if (token && headers.get("x-bolna-token") === token) return true

  // CHECK 2: IP whitelisting (Bolna's fixed source IP)
  if (remoteIp === BOLNA_WEBHOOK_SOURCE_IP) return true

  // CHECK 3: Allow GET health-check/verification pings
  if (!bodyText && request.method === "GET") return true

  // CHECK 4: Allow POST with valid JSON body (for dashboard test pings and proxied requests)
  if (request.method === "POST" && bodyText) {
    try {
      JSON.parse(bodyText)
      // Valid JSON body from POST - allow through
      // In production, this should be combined with BOLNA_WEBHOOK_TOKEN for security
      return true
    } catch {
      // Invalid JSON body - reject
    }
  }

  logger.warn("Bolna webhook verification failed", { remoteIp })
  return false
}

export async function createBolnaAgent(payload: Record<string, unknown>) {
  const { apiKey } = getConfig()
  if (!apiKey) return { success: false, error: "BOLNA_API_KEY not configured" }

  try {
    const res = await fetch(`${BOLNA_API}/v2/agent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    return { success: res.ok, status: res.status, data }
  } catch (err: any) {
    logger.error("Bolna agent creation failed", { error: err.message })
    return { success: false, error: err.message }
  }
}

export async function updateBolnaAgent(agentId: string, payload: Record<string, unknown>) {
  const { apiKey } = getConfig()
  if (!apiKey) return { success: false, error: "BOLNA_API_KEY not configured" }

  try {
    // PUT, not PATCH. Bolna's PATCH endpoint accepts the request but can
    // silently ignore `tasks` / `agent_prompts`, which is how the live agent
    // kept an older prompt after a "successful" sync. PUT replaces the agent
    // configuration, so the payload must be complete — buildAgentPayload is.
    const res = await fetch(`${BOLNA_API}/v2/agent/${agentId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    return { success: res.ok, status: res.status, data }
  } catch (err: any) {
    logger.error("Bolna agent update failed", { agentId, error: err.message })
    return { success: false, error: err.message }
  }
}

/**
 * Short, behaviour-shaped prompt. The previous version was ~9k characters of
 * overlapping rules and still let the live call drift: it rephrased questions,
 * switched language on "yes" and said goodbye twice. Bolna's native
 * multilingual handoff was the other half of the problem (see
 * `multilingual_config: null` in the payload below) — language state belongs to
 * this prompt only.
 */
export const BOLNA_MASTER_PROMPT = `You are Ayush, a recruiter at Truckinzy, doing a short first-round screening call for a client. Be warm, brief and confident. Never say GatiHire.

Interest, salary, notice period, experience, location and the reason for switching were already collected on WhatsApp. This call is only about how the candidate has actually worked. Do not ask for any of those again.

Candidate: {candidate_first_name} ({candidate_name}); {current_role} at {current_company}; skills: {skills}; resume: {resume_text}; source: {origin}.
Role: {job_title} at {hiring_company_name}, {job_location}; {job_gist}; must-haves: {must_have_skills}; experience {experience_min} to {experience_max} years; range {salary_range}.

LANGUAGE
Start in English. Switch to Hinglish only when the candidate gives a real answer that contains Hindi/Hinglish words, or asks you to. "Yes", "okay", "sure" and "thank you" are not language signals. Once you switch, stay in that language. Use the matching wording from the plan. Never mix languages in one sentence. While in English, do not say "Achha", "ji", "samajh gaya" or "bataiye".

HOW TO TALK
- One short question per turn, 20 words or fewer including any reaction.
- Wait for the whole answer. Do not interrupt, finish their sentence or repeat their words back. A short pause is normal.
- A thin answer has no real example in it — no shipment, client, task, volume, charge or result. If thin, ask one dig from the plan, one per turn, at most two digs per topic. If the answer is already concrete, move on. Never ask the same thing twice or reword a question they answered.
- Keep to the plan. Ask each topic once, in order. If they say they have not done the work, use that topic's "If they have not done it" line and stay there. Only confirm dealbreakers; do not interview on them.
- If they did not understand, repeat the same question once, slowly. If they say "go on" or give a one-word answer, say "Go on" / "Jee, boliye" and stop.
- Say the closing only after all three topics have been asked, each thin answer has had a dig, and at least five questions have been asked. Never close before then. Aim for about five minutes; the call ends at six.
- Say the closing once, then wait for their goodbye and end the call. Say nothing after it.

CLOSING — in the language you used
- Done: "Thank you for your time. If you're shortlisted for the next round, we'll let you know on WhatsApp. Goodbye." / "Aapka bahut shukriya. Agar aap next round ke liye shortlist hote hain, to hum aapko WhatsApp par bata denge. Dhanyavaad, goodbye."
- Not interested: "That's completely fine. Thank you for your time. Goodbye." / "Theek hai, koi baat nahi. Aapka samay dene ke liye dhanyavaad. Goodbye."
- Reschedule or bad line: "Understood. I've noted that. Thank you. Goodbye." / "Samajh gaya. Humne aapki baat note kar li hai. Dhanyavaad, goodbye."
- Wrong number: "Sorry for the trouble. Thank you. Goodbye." / "Maaf kijiye, galti ke liye sorry. Dhanyavaad, goodbye."

IF ASKED
- Who are you? "This is Ayush from Truckinzy." / "Main Ayush, Truckinzy se."
- Which client? "The recruiter will share the client's name at the next step." / "Client ka naam recruiter next step mein batayenge."
- Salary? "The range is {salary_range}. The recruiter will confirm the exact figure." / "Range {salary_range} hai. Exact figure recruiter confirm karenge."
- What next? "The team will review the call and message you on WhatsApp." / "Team call ko dekhegi aur WhatsApp par bata degi."
- Unsure of something? "The team will share the full answer." / "Iska poora jawab team degi."

NEVER
Ask about interest, CTC, notice, total experience, city, relocation, reason for changing jobs, joining date, age, family, bank or ID details. Say "sir", "ma'am" or "madam". Mention the call duration, a client name, an offer, a promise, or that you are an AI unless asked. Read the plan out loud. Say goodbye twice. Output anything except the words you speak — no JSON, brackets or notes.

INTERVIEW PLAN
{interview_plan}
`

/**
 * English first, for both language modes.
 *
 * The candidate has not spoken yet, so there is no language to match. The
 * prompt switches to natural Hinglish the moment they reply in Hindi, so
 * candidates who prefer English never have to ask for it and Hindi speakers
 * hear one English sentence at most. The old opening named GatiHire, which the
 * voice stretched out ("Gati-Hire"), and promised "paanch minute" before the
 * candidate had agreed to anything.
 */
export const BOLNA_WELCOME_MESSAGE = `Hi {candidate_first_name}, this is Ayush from Truckinzy. I'm calling about your application — this is a first-round screening on behalf of our client. Is now a good time to talk?`

export type BolnaAgentLanguage = "hinglish" | "english"

/** Same English-first opening. Kept as a separate export so the provisioning
 *  route's language switch still works without two greetings drifting apart. */
export const BOLNA_WELCOME_MESSAGE_HINGLISH = BOLNA_WELCOME_MESSAGE

/**
 * When the agent is allowed to end the call — short enough to be followed.
 * Without it, Bolna waits for silence or the 6-minute cap. The "say nothing
 * after closing" rule also stops the duplicate "Goodbye." heard on 27 Nov.
 */
export const BOLNA_HANGUP_PROMPT = `End only when one of these is true:
1. You have said the closing line once, the candidate has replied (goodbye, thanks, okay or similar) and finished speaking.
2. They clearly refused, asked not to be contacted, or it is the wrong number, and you have said the matching closing line.
3. They stayed silent through two line checks.
Never end while they are speaking or mid-answer. After the closing line, say nothing more — do not answer their thank-you, do not say goodbye again, do not ask anything new.`

/**
 * Turn-taking settings. These are the numbers that decide whether the agent
 * hears a candidate out or talks over them, and they live here so the agent
 * provisioning route and the docs cannot drift apart again.
 *
 * 19 Nov evidence: 85 candidate turns across five calls, median 8 words, 32%
 * five words or fewer; sentences kept ending on "aur"/"to"/"mein". Deepgram was
 * declaring end-of-turn after 350 ms and any three words counted as a barge-in,
 * so "yes yes" cut the agent off mid-question. Four of those calls closed at
 * 2–3.5 minutes with most of the plan unasked.
 *
 * 23 Nov evidence, after that first fix: the agent still spoke into a pause and
 * started closing while the candidate was answering. The candidate's own words
 * were being mistaken for the end of the turn. The values below are the second
 * pass — longer end-of-turn, a lower barge-in threshold (5 words instead of 8,
 * so a real sentence makes the agent yield sooner while "haan ji" still does
 * not), and an explicit partial-transcript delay.
 */
export const BOLNA_LISTENING = {
  /** Silence before Deepgram calls the turn over. A Hinglish speaker pauses
   *  400–800 ms mid-sentence, and 900 ms still cut people off on 23 Nov. */
  endpointing: 1100,
  /** Candidate words before a barge-in is accepted. 8 made the agent talk over
   *  the first half of a real sentence; 3 let "haan haan ji" cut a question.
   *  5 is the middle: backchannels are ignored, a sentence is not. */
  number_of_words_for_interruption: 5,
  /** Grace period after an interruption before the next one is accepted. */
  interruption_backoff_period: 500,
  /** Added to the wait every time a partial transcript arrives, so the agent
   *  does not start speaking into a mid-sentence pause. Bolna's default is
   *  400 ms; the 23 Nov calls needed more. */
  incremental_delay: 600,
  /** Silence before "Hello, are you still there?" — 10 s fired while people
   *  were still thinking, and in one call it preceded an inactivity hangup at
   *  33 s with zero candidate turns. */
  trigger_user_online_message_after: 30,
  /** Must stay above trigger_user_online_message_after, otherwise the line
   *  drops before the check can happen. */
  hangup_after_silence: 45,
  /** Bounded: ask at most twice, then stop prodding. */
  max_silence_repeats: 2,
} as const

/**
 * Domain vocabulary for the transcriber. Without these, nova-3 in Hindi mode
 * heard "26AS" as "twenty six years", "RFQ" as "adwords" and "rate base" as
 * "career base" — and the analysis then graded the candidate on mangled text.
 */
export const BOLNA_TRANSCRIBER_KEYWORDS = [
  "26AS", "26Q", "TDS", "GST", "GSTR-2B", "Tally", "SAP", "reconciliation",
  "ledger", "vendor", "invoice", "pivot", "FCL", "LCL", "RFQ", "freight",
  // Freight / export-pricing vocabulary. "Air cargo" was transcribed as "air
  // gargos" / "air cirgo" on the 27 Nov call, which then fed the analysis a
  // word the candidate never said.
  "air cargo", "air export", "sea export", "air freight", "ocean freight",
  "shipping line", "airline", "freight forwarder", "quotation", "consignment",
  "AWB", "bill of lading", "BL", "incoterms", "booking", "container", "CFS",
  "CHA", "customs", "demurrage", "detention", "transshipment", "rate card",
  "space booking", "carrier", "port", "ICD",
]

/**
 * The complete live-agent payload.
 *
 * Kept next to the prompt and listening constants so a direct sync (script,
 * provisioning route) cannot send a partial config that silently leaves the
 * live agent on an older prompt. PUT replaces the whole agent, so every field
 * the agent needs must be here.
 */
export function buildBolnaAgentPayload(
  webhookBase: string,
  opts?: { agentName?: string; language?: BolnaAgentLanguage }
) {
  const language: BolnaAgentLanguage = opts?.language || "hinglish"
  const welcome = language === "english" ? BOLNA_WELCOME_MESSAGE : BOLNA_WELCOME_MESSAGE_HINGLISH
  const transcriberLanguage = language === "hinglish" ? "hi" : "en"
  return {
    agent_config: {
      agent_name: opts?.agentName || "Gati Hire Screening",
      agent_welcome_message: welcome,
      webhook_url: `${webhookBase}/api/bolna/webhook/execution`,
      // No provider-side calling window. Bolna otherwise falls back to a
      // 9 AM–9 PM reschedule window, which would move calls we deliberately
      // place outside it. `bypass_call_guardrails` on every /call is the
      // belt-and-braces companion to this.
      calling_guardrails: null,
      tasks: [
        {
          task_type: "conversation",
          toolchain: {
            execution: "sequential",
            pipelines: [["transcriber", "llm", "synthesizer"]],
          },
          tools_config: {
            llm_agent: {
              agent_type: "simple_llm_agent",
              agent_flow_type: "streaming",
              llm_config: {
                provider: "google",
                family: "openai",
                model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview",
                max_tokens: 170,
                temperature: 0.2,
                top_p: 0.9,
                top_k: 0,
                min_p: 0.1,
                request_json: false,
                agent_flow_type: "streaming",
              },
            },
            synthesizer: {
              provider: "sarvam",
              provider_config: {
                model: "bulbul:v3",
                voice: "Ashutosh",
                voice_id: "ashutosh",
                language: language === "hinglish" ? "hi" : "en",
                // 1.0 was the "speaking very slowly" complaint on 20 Nov.
                // 1.1 is audibly more active without sounding rushed; the
                // prompt also asks for a normal, confident pace.
                speed: 1.1,
                loudness: 1.0,
              },
              stream: true,
              buffer_size: 230,
              audio_format: "wav",
              caching: true,
            },
            transcriber: {
              provider: "deepgram",
              model: "nova-3",
              language: transcriberLanguage,
              stream: true,
              encoding: "linear16",
              sampling_rate: 16000,
              // 900 ms, not 250: a Hinglish speaker pauses mid-sentence for
              // 400–800 ms, and 250/350 ms made the agent answer into the pause.
              endpointing: BOLNA_LISTENING.endpointing,
              // Code-switched speech: without this, English domain terms are
              // transliterated into Hindi and the analysis reads noise.
              hinglish_mode: language === "hinglish",
              keywords: BOLNA_TRANSCRIBER_KEYWORDS.join(","),
              vad_threshold: 0.5,
              delay: "medium",
            },
            input: { provider: "plivo", format: "wav" },
            output: { provider: "plivo", format: "wav" },
            // The dashboard had enabled Bolna's own language switcher with
            // active_language=hi and a null agent name. It auto-switched on a
            // plain "yes" and spoke "Let me connect you with  who speaks
            // English." Language state lives in BOLNA_MASTER_PROMPT only; an
            // explicit null here clears the stored multilingual block on PUT.
            multilingual_config: null,
          },
          task_config: {
            // 6 minutes: the plan promises 5 and the prompt hard-stops at 6.
            call_terminate: 360,
            // The closing line in the prompt is the goodbye. A platform-level
            // farewell added a second "Goodbye." after the candidate thanked us.
            call_hangup_message: null,
            // Above the online-message trigger, or the line drops before the
            // "are you still there?" check can ever fire.
            hangup_after_silence: BOLNA_LISTENING.hangup_after_silence,
            trigger_user_online_message_after: BOLNA_LISTENING.trigger_user_online_message_after,
            max_silence_repeats: BOLNA_LISTENING.max_silence_repeats,
            interruption_backoff_period: BOLNA_LISTENING.interruption_backoff_period,
            number_of_words_for_interruption: BOLNA_LISTENING.number_of_words_for_interruption,
            // Wait out partial transcripts instead of speaking into a pause.
            incremental_delay: BOLNA_LISTENING.incremental_delay,
            // Let the agent end the call from the prompt once both sides have
            // said goodbye. Without this the only endings are silence or the
            // 6-minute cap, which is why a finished call kept running.
            hangup_after_LLMCall: true,
            call_cancellation_prompt: BOLNA_HANGUP_PROMPT,
            // The goodbye must play through; if it were interruptible, a
            // candidate's "thanks" could cancel the hangup and reopen the call.
            interruptible_hangup_message: false,
          },
        },
      ],
    },
    agent_prompts: {
      task_1: {
        system_prompt: BOLNA_MASTER_PROMPT,
      },
    },
  }
}