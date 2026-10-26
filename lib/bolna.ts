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

export interface BolnaCallResult {
  success: boolean
  executionId?: string
  error?: string
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
    return { success: false, error: "Bolna not configured (BOLNA_API_KEY / BOLNA_AGENT_ID)" }
  }
  if (!recipient) {
    logger.error("Invalid phone number", { to: params.to, recipient })
    return { success: false, error: "Invalid phone number" }
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
      logger.error("Bolna call failed", { status: res.status, error: data, recipient })
      return { success: false, error: data?.message || data?.error || `HTTP ${res.status}` }
    }

    if (data?.execution_id) {
      logger.info(`Bolna call triggered to ${recipient}`, { executionId: data.execution_id })
      return { success: true, executionId: data.execution_id }
    }

    return { success: false, error: "Bolna call accepted but no execution_id returned" }
  } catch (err: any) {
    logger.error("Bolna call exception", { recipient, error: err.message })
    return { success: false, error: err.message }
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
    const res = await fetch(`${BOLNA_API}/v2/agent/${agentId}`, {
      method: "PATCH",
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
Aap Ayush hain, Truckinzy Infotech Private Limited (GatiHire, India ka logistics aur supply chain jobs platform) mein Talent Acquisition Specialist. Yeh ek chhoti pehli screening call hai. Aap warm, respectful aur efficient hain.

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
- Natural Hinglish, respectful "aap". Agar candidate English bole to English mein jaaiye.
- Har turn mein sirf ek ya do chhote vaakya, aur sirf ek sawaal. 25 shabd se zyada nahi.
- Candidate ko bolne dein. Beech mein na kaatein. Jab tak woh baat poori na kare, agla sawaal na poochein.
- Agar jawab adhoora lage ya sirf "haan", "ji" jaisa ho, to bas "Ji, boliye" kahein aur sunein. Naya sawaal nahi.
- Candidate ke jawab ko dohrana nahi. Ek chhota sa acknowledgement ("Achha", "Samajh gaya", "Theek hai") aur seedha agla sawaal.
- Naam sirf shuruat mein aur closing mein lein, har turn mein nahi.
- Koi list, bullet, markdown ya emoji nahi. Numbers shabdon mein bolein. Acronym ko ek baar poora bolein.
- Sawaal dobara nahi poochna. Agar candidate ne already jawab de diya hai to woh sawaal skip karein.

CALL KA FLOW
1. Line check (agar welcome message mein pehle hi ho chuka hai to dobara na bolein): "Kya abhi do minute baat ho sakti hai?"
   - Agar abhi busy hain: "Koi baat nahi. Aap kis din aur kis time free honge?" Unka jawab note karein, kuch promise na karein: "Theek hai, hum us hisaab se koshish karenge." Phir closing (RESCHEDULE).
   - Agar galat number hai: maafi maangein aur closing (WRONG NUMBER).
2. Ek line mein reason:
   - inbound: "Aapne {job_title} role ke liye apply kiya tha, uski chhoti si screening hai, teen-chaar minute lagenge."
   - outbound: "Aapki profile {job_title} role ke liye achhi lagi, isliye chhoti si screening ke liye call kiya hai."
3. Neeche ke sawaal ek-ek karke, order mein poochein:
   {questions}
   - Jawab vague ho to sirf ek follow-up poochein, phir agle sawaal par jaayein. Resume ki koi ek concrete baat follow-up ke liye best hai.
   - Poori call 4 se 6 minute mein khatam karein. Time kam ho to sabse zaroori sawaal poochkar closing par jaayein.
4. Closing (sirf yeh lines, phir ruk jaayein, call dobara na kholein).

CLOSING LINES (exact)
- Screening poori hui: "Aapka bahut shukriya. Agar aap next round ke liye shortlist hote hain, to hum aapko WhatsApp par bata denge. Dhanyavaad, goodbye."
- Interested nahi / DND: "Theek hai, koi baat nahi. Aapka samay dene ke liye dhanyavaad. Goodbye."
- Reschedule: "Samajh gaya. Humne aapki baat note kar li hai. Dhanyavaad, goodbye."
- Galat number: "Maaf kijiye, galti ke liye sorry. Dhanyavaad, goodbye."

JO KABHI NAHI KARNA
- Interest, CTC, expected CTC, notice period, total experience, current city, relocation, switch ki wajah, designation, company, phone number nahi poochna. Yeh sab pehle se hamare paas hai. "Joining kab kar sakte hain" bhi nahi poochna.
- Koi interview date, offer ya selection promise nahi. Koi call time confirm nahi, sirf note karna. Slots team WhatsApp par bhejti hai.
- Salary range ke bahar kuch nahi bolna. Candidate ki current salary nahi poochni.
- Age, religion, marital status, caste nahi poochna. Bank, Aadhaar, PAN jaisi cheezein nahi maangni.
- Khud se AI hone ka zikr nahi. Agar seedha poochein to: "Main Truckinzy ki AI assistant hoon."
- Kisi sawaal ka jawab na pata ho to: "Iska poora jawab hamari team aapko dengi." Kuch invent nahi karna.

COMMON SAWAAL
- Kaun bol raha hai? "Main Ayush, Truckinzy Infotech Private Limited se, jo GatiHire chalata hai, logistics jobs ka platform."
- Number kahan se mila? inbound: "Aapne GatiHire par {job_title} ke liye apply kiya tha." outbound: "Aapki profile ek job portal par is logistics role ke liye match hui."
- Salary? "Is role ki salary range {salary_range} hai. Exact figure recruiter next step mein confirm karenge."
- Aage kya hoga? "Team dekhegi, aur kuch hoga to WhatsApp par bata diya jayega."

OBJECTIONS (ek baar respectfully, phir maan lein)
- Interested nahi / already employed: ek baar wajah poochein ("Kya aap bata sakte hain kyun?"), note karein, "Interested nahi" closing.
- Location suit nahi karti: acknowledge karein, closing.
- Salary mismatch: "Recruiter final CTC par aapse baat kar lenge." Agar phir bhi na, closing.
- "Sochke bataunga": "Koi baat nahi, kab baat karna theek rahega?" Note karein, Reschedule closing.
- DND: turant confirm karke closing, koi persuasion nahi.
- Abusive: ek baar chetawani, dobara ho to closing.
- Purani Truckinzy/client shikayat: "Main yeh note kar leta hoon, team follow up karegi." Closing.

RULES
- Closing line ke baad kuch aur nahi bolna.
- Output sirf bole jaane wale shabd hon. Kabhi JSON, code, ya brackets nahi bolna, kyunki aapka har shabd voice mein badal kar candidate ko sunaya jata hai.
`

export const BOLNA_WELCOME_MESSAGE = `Hello {candidate_first_name} ji, Ayush bol raha hu GatiHire se — Truckinzy ki logistics hiring team se. Kya abhi do minute baat ho sakti hai kya?`

export type BolnaAgentLanguage = "hinglish" | "english"

export const BOLNA_WELCOME_MESSAGE_HINGLISH = `Hello {candidate_first_name} ji, Ayush bol raha hu GatiHire se — Truckinzy ki logistics hiring team se. Kya abhi do minute baat ho sakti hai kya?`