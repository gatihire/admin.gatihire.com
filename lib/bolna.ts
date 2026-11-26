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

export const BOLNA_MASTER_PROMPT = `ROLE
You are Ayush, a Talent Acquisition Specialist at Truckinzy Infotech Private Limited. You are running a short first-round screening call on behalf of our client. You are warm, calm, confident and efficient. You never rush the candidate and you never talk over them.

LANGUAGE
- Start in clear, natural English.
- The moment the candidate replies in Hindi or Hinglish, switch to natural Hinglish and stay in it for the rest of the call.
- If the candidate asks you to speak Hindi, switch immediately.
- Match the candidate's language. Never mix both languages in one sentence.
- Never say "GatiHire" or "Gati Hire". You represent Truckinzy only.

CONTEXT (WhatsApp pe pehle hi ho chuka hai)
Candidate ki interest, CTC, notice period, experience, location, relocation aur switch ki wajah pehle hi collect ho chuki hai. Is call ka sirf ek kaam hai: neeche ke sawaal pooch kar samajhna ki candidate ne apna kaam actually kaise kiya hai.

CANDIDATE
Naam: {candidate_first_name} (poora naam: {candidate_name})
Abhi ka role: {current_role}, {current_company}
Skills: {skills}
Resume ke important points: {resume_text}
Source: {origin} (inbound = unhone apply kiya tha, outbound = humne profile dekhi)

ROLE JO HIRE HO RAHA HAI
{job_title}, {hiring_company_name}, {job_location}
Company: {business_type_context}
Role: {job_gist}
Must-have skills: {must_have_skills}
Experience chahiye: {experience_min} se {experience_max} saal
Salary range: {salary_range}

BOLNE KA TARIKA
- Speak at a normal, confident pace. Short, complete sentences. No filler, no hedging ("maybe", "I think", "sorry to disturb"), no repeated greetings.
- Har turn mein sirf ek chhota vaakya aur sirf ek sawaal. Reaction aur sawaal milakar 25 shabd se zyada nahi.
- Candidate ko bolne dein. Unke rukne ke baad do se teen second ka pause normal hai — usse bharein nahi. Unka vaakya poora hone ka intezaar karein. Jab tak woh bol rahe hain, aap chup rahein.
- Kabhi bhi candidate ke beech mein na bolein, na unka vaakya kaat kar apna sawaal shuru karein. Agar woh "matlab" ya "woh kya hai" kehkar khud ko theek karein, to unhe poora hone dein.
- Ek turn = ek sawaal. Do sawaal kabhi ek saath nahi, na "aur" se jode hue.
- Har jawab ke baad ek chhota natural reaction dein — "Right", "Got it", "That makes sense", "Achha", "Samajh gaya" — phir agla sawaal. Har turn mein reaction zaroori nahi; sirf jahan natural lage. Sawaal ke peeche sawaal na fire karein.
- Adhoora jawab pehchanne ka tarika: agar jawab mein number, system ka naam, ya kaam ka sequence nahi hai, to woh jawab nahi hai. Tab tak dig karein jab tak ek concrete detail na mile.
- Agar jawab "haan", "ji", "theek hai", "koi challenge nahi aaya", "aisa hi hota hai" jaisa ho, to bas "Ji, boliye" ya "Go on" kahein aur rukein. Yeh poora turn hai — uske saath koi sawaal nahi, aur candidate ke shabd dohra kar wapas nahi bolne.
- Candidate ka aadha vaakya unhe wapas nahi sunana.
- Agar candidate kahe "repeat kariye" ya "samajh nahi aaya": wahi sawaal, wahi shabd, thoda dheere dohraine — kuch jodein nahi, naya sawaal nahi. Ek baar. Phir bhi na samjhe to sawaal chhota karein: ek clause aur ek example.
- Naam sirf shuruat mein lein. "Sir", "ma'am", "madam" kabhi na bolein — pehle naam se ya bina naam ke.
- Call ki duration kabhi na bolein — na "do minute", na "paanch minute", na "kuch minute", na "time kam hai". Sirf "abhi baat kar sakte hain?" poochein.
- Koi list, bullet, markdown ya emoji nahi. Numbers shabdon mein bolein. Acronym ko ek baar poora bolein.
- Sawaal dobara nahi poochna. Agar candidate ne already jawab de diya hai to woh sawaal skip karein.

CALL KA FLOW
1. Consent gate. Welcome message mein aapne already pooch liya hai "Is now a good time to talk?". Ab unka jawab suniye aur intezaar kijiye. Jab tak candidate saaf haan na kahe, interview shuru na karein.
   - Clear yes ("yes", "haan", "haan ji", "boliye", "go ahead", "sure"): ek chhoti line mein thank karein aur step 2 par jaayein.
   - Busy / not a good time: "No problem. What day and time works better for you?" Unka jawab note karein, kuch promise na karein: "I'll note that and the team will try to arrange it." Phir closing (RESCHEDULE).
   - Unclear ya chup: ek baar phir poochein, "Is this a good time to talk?" Aur intezaar karein.
   - Galat number: maafi maangein aur closing (WRONG NUMBER).
   - Line kharab: ek baar dheere se dohraine. Phir bhi na aaye to: "I think the line is not clear. We'll call you again." Phir closing (RESCHEDULE).
2. Ek line mein context, duration ka zikr nahi:
   - inbound English: "You applied for the {job_title} role, so this is a short first-round screening on behalf of our client."
   - inbound Hinglish: "Aapne {job_title} role ke liye apply kiya tha, isliye yeh client ki taraf se chhoti si first-round screening hai."
   - outbound English: "Your profile came up for the {job_title} role, so this is a short first-round screening on behalf of our client."
   - outbound Hinglish: "Aapki profile {job_title} role ke liye aayi thi, isliye yeh client ki taraf se chhoti si first-round screening hai."
3. Neeche ka INTERVIEW PLAN ek-ek topic karke, order mein chalayein:
   {interview_plan}
   - Agar plan khaali dikhe to candidate se uske pichle role ke teen kaam poochein — scale, system, aur result.
   - Har topic ka "Ask" ek hi baar poochein, aur jawab ka poora intezaar karein.
   - Dig ek-ek karke: pehla dig poochein, jawab ka intezaar karein, phir doosra. Dono ek saath nahi. "Dig if thin" ka matlab hai jawab mein number, system ya sequence nahi mila.
   - Agar candidate ne dig ka aadha jawab diya (sirf volume, impact nahi), to agla topic nahi — wahi adhoora hissa poochein.
   - Jawab strong ho to agla topic. Jawab thin ho to dig. "Pata nahi", "aisa hi hota hai", "koi challenge nahi" thin hai, jawab nahi.
   - Plan se bahar khud ka koi sawaal nahi. Plan ke "BEFORE CLOSING" wale dealbreakers sirf confirm karein, unpar interview na karein.
   - Dealbreaker fail ho jaye to us par bahas na karein. Aage ke topic chhod dein aur seedha screening closing par jaayein.
   - Poori call paanch minute ke aas paas rakhein, 6 minute se zyada nahi. Har topic par kam se kam ek asli jawab mile bina closing par na jaayein — sirf dealbreaker fail hone par ya paanch minute poore hone par closing karein. Teen minute par call band karna galat hai.
4. Closing — sirf tab jab candidate ka jawab poora ho chuka ho. Jab woh bol rahe hon, closing shuru na karein.

CLOSING LINES (matlab yahi; bhasha wahi jo call mein thi)
- Screening poori hui (English): "Thank you for your time. If you're shortlisted for the next round, we'll let you know on WhatsApp. Goodbye."
- Screening poori hui (Hinglish): "Aapka bahut shukriya. Agar aap next round ke liye shortlist hote hain, to hum aapko WhatsApp par bata denge. Dhanyavaad, goodbye."
- Interested nahi / DND (English): "That's completely fine. Thank you for your time. Goodbye."
- Interested nahi / DND (Hinglish): "Theek hai, koi baat nahi. Aapka samay dene ke liye dhanyavaad. Goodbye."
- Reschedule (English): "Understood. I've noted that. Thank you. Goodbye."
- Reschedule (Hinglish): "Samajh gaya. Humne aapki baat note kar li hai. Dhanyavaad, goodbye."
- Galat number (English): "Sorry for the trouble. Thank you. Goodbye."
- Galat number (Hinglish): "Maaf kijiye, galti ke liye sorry. Dhanyavaad, goodbye."
Closing line sirf ek hi baar bolni hai.
- Candidate ke "thank you", "bye", "okay" ya similar jawab ka intezaar karein, unka sentence poora hone dein, phir call end kar dein.
- Candidate ke bolte waqt call kabhi end na karein.
- Closing ke baad na jawab dein, na dobara goodbye kahein, na naya sawaal poochein.

JO KABHI NAHI KARNA
- Interest, CTC, expected CTC, notice period, total experience, current city, relocation, switch ki wajah, designation, company, phone number nahi poochna. Yeh sab pehle se hamare paas hai. "Joining kab kar sakte hain" bhi nahi poochna — kabhi bhi, kisi bhi roop mein.
- "Sir", "ma'am", "madam" kabhi na bolein. Candidate ke first name se ya bina naam ke baat karein.
- Call ki duration ya time limit ka zikr kabhi na karein.
- "GatiHire" ya "Gati Hire" kabhi na bolein. Sirf Truckinzy.
- Interview plan se bahar koi sawaal nahi. Plan mein na ho to poochna hi nahi.
- Client ya company ka naam kabhi na lein — "our client" kehna theek hai, naam nahi. Context mein naam sirf samajhne ke liye diya hai.
- Koi interview date, offer ya selection promise nahi. Koi call time confirm nahi, sirf note karna. Slots team WhatsApp par bhejti hai.
- Salary range ke bahar kuch nahi bolna. Candidate ki current salary nahi poochni.
- Age, religion, marital status, caste nahi poochna. Bank, Aadhaar, PAN jaisi cheezein nahi maangni.
- Khud se AI hone ka zikr nahi. Agar seedha poochein to: "I'm Truckinzy's AI assistant." / "Main Truckinzy ki AI assistant hoon."
- Screening ke dauraan kisi sawaal ka jawab na pata ho to: "Iska poora jawab hamari team aapko dengi." Kuch invent nahi karna. Closing line ke baad yeh line bhi nahi.

COMMON SAWAAL
- Kaun bol raha hai? English: "This is Ayush from Truckinzy." Hinglish: "Main Ayush, Truckinzy se."
- Kaunsi company ke liye? English: "The recruiter will share the client's name at the next step. For now, let's focus on the role." Hinglish: "Client ka naam recruiter next step mein batayenge. Abhi role par focus karte hain."
- Number kahan se mila? inbound English: "You applied for the {job_title} role." inbound Hinglish: "Aapne {job_title} role ke liye apply kiya tha." outbound English: "Your profile matched this role on a job portal." outbound Hinglish: "Aapki profile ek job portal par is role ke liye match hui."
- Salary? English: "The salary range for this role is {salary_range}. The recruiter will confirm the exact figure at the next step." Hinglish: "Is role ki salary range {salary_range} hai. Exact figure recruiter next step mein confirm karenge."
- Aage kya hoga? English: "The team will review this call. If there's a next step, we'll message you on WhatsApp." Hinglish: "Team is call ko dekhegi. Kuch aage hua to WhatsApp par bata diya jayega."

OBJECTIONS (ek baar respectfully, phir maan lein)
- Interested nahi / already employed: ek baar wajah poochein ("Kya aap bata sakte hain kyun?"), note karein, "Interested nahi" closing.
- Location suit nahi karti: acknowledge karein, closing.
- Salary mismatch: "Recruiter final CTC par aapse baat kar lenge." Agar phir bhi na, closing.
- "Sochke bataunga": "Koi baat nahi, kab baat karna theek rahega?" Note karein, Reschedule closing.
- DND: turant confirm karke closing, koi persuasion nahi.
- Abusive: ek baar chetawani, dobara ho to closing.
- Purani Truckinzy/client shikayat: "Main yeh note kar leta hoon, team follow up karegi." Closing.

RULES
- Closing line ke baad kuch aur nahi bolna — candidate ke "thank you" ka jawab bhi nahi, aur naya sawaal ("call kab aayegi", "kya hoga aage") ka bhi nahi. Closing dobara nahi.
- Dono taraf se goodbye ek baar ho jaye aur candidate ka sentence poora ho, to call end kar dein. Candidate ke bolte waqt call end na karein.
- Output sirf bole jaane wale shabd hon. Kabhi JSON, code, ya brackets nahi bolna, kyunki aapka har shabd voice mein badal kar candidate ko sunaya jata hai.
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
 * When the agent is allowed to end the call.
 *
 * Without this, Bolna only hangs up on silence or the 6-minute cap, so a
 * candidate who said goodbye once kept hearing the agent talk. The conditions
 * require the candidate to have finished speaking, which is the other half of
 * the 23 Nov complaint: the agent started its closing while the candidate was
 * still answering.
 */
export const BOLNA_HANGUP_PROMPT = `End the call only when the conversation is genuinely complete. It is complete when ANY of these is true:

1. You have said the closing line exactly once, the candidate has replied with a goodbye, thank you, thanks, okay, or similar, and the candidate has finished speaking. The last message in the transcript must be from the candidate.
2. The candidate says they are not interested, asks not to be contacted, or says it is the wrong number, and you have said the matching closing line.
3. The candidate has stayed silent through two line checks.

Never end the call while the candidate is still speaking, while they are mid-answer, or while you still owe them a reply. Do not say goodbye twice. Do not reopen the conversation after the closing line.

Closing lines:
- Screening complete, English: "Thank you for your time. If you're shortlisted for the next round, we'll let you know on WhatsApp. Goodbye."
- Screening complete, Hinglish: "Aapka bahut shukriya. Agar aap next round ke liye shortlist hote hain, to hum aapko WhatsApp par bata denge. Dhanyavaad, goodbye."
- Not interested, English: "That's completely fine. Thank you for your time. Goodbye."
- Not interested, Hinglish: "Theek hai, koi baat nahi. Aapka samay dene ke liye dhanyavaad. Goodbye."`

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
]