import { GoogleGenerativeAI } from "@google/generative-ai"
import { logger } from "@/lib/logger"
import { SCREENING_HARD_CAP_SECONDS } from "@/lib/call-scoring"
import type { JobContext, CandidateContext } from "@/lib/jd-questions"

/**
 * The interview plan is what the voice agent actually screens with.
 *
 * It exists because the old payload was a flat list of five strings: the agent
 * had one follow-up per call and no idea what a *good* answer sounds like, so
 * every call ended at ~2.5 minutes with ~11 one-line answers. A topic carries
 * the ask, the digs, and the judgement criteria together, which is the only
 * shape that lets the agent dig and lets the scorer cite evidence.
 *
 * Stored as JSON in call_payload_json._interview_plan, rendered to prose for
 * Bolna. See docs/ai-call-quality-plan.md §4.
 */

export const PLAN_VERSION = 1
export const TARGET_SECONDS = 300
export const HARD_CAP_SECONDS = SCREENING_HARD_CAP_SECONDS
/**
 * Two digs, not three. Three topics x (1 ask + 3 digs) is twelve questions, which
 * at ~33s an exchange is 6.6 minutes — the plan promised five and could not
 * deliver it. 3 x (1 + 2) = 9 questions is about five minutes.
 */
export const MAX_DIGS_PER_TOPIC = 2
export const MAX_ASK_WORDS = 15
export const MAX_DIG_WORDS = 12
export const MAX_DEALBREAKER_WORDS = 12

const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview"

export interface InterviewPlanDig {
  key: string
  prompt: string
}

export interface InterviewPlanTopic {
  id: string
  label: string
  source: "jd_must_have" | "resume_claim" | "manual"
  must_have: boolean
  order: number
  ask: string
  digs: InterviewPlanDig[]
  strong: string
  weak: string
  resume_hook: string | null
}

export interface InterviewPlanDealbreaker {
  id: string
  label: string
  type: "confirm"
  confirm: string
  if_missing: "close_politely" | "flag"
  mandatory: boolean
}

export interface InterviewPlan {
  version: number
  job_id: string
  generated_at: string
  language: "hinglish" | "english"
  call_shape: {
    target_seconds: number
    hard_cap_seconds: number
    topics: number
    max_digs_per_topic: number
  }
  topics: InterviewPlanTopic[]
  dealbreakers: InterviewPlanDealbreaker[]
}

export interface PlanValidationContext {
  /** Client / company names that must never appear inside a question. */
  clientNames?: (string | null | undefined)[]
  /** Resume + JD text. Acronyms are only allowed when they appear here. */
  allowedText?: string
  jobTitle?: string
}

function words(text: string): string[] {
  return String(text || "").trim().split(/\s+/).filter(Boolean)
}

function wordCount(text: string): number {
  return words(text).length
}

function slug(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "topic"
}

/** Acronyms the client asked us to keep out unless the candidate's own paperwork uses them. */
const ACRONYMS = [
  "GRIR", "P2P", "FEFO", "WMS", "TMS", "SAP", "3PL", "CLRA", "ECR", "ESIC",
  "ESI", "PF", "HRIS", "ATS", "MIS", "SQL", "ERP", "SKU", "OTIF", "TAT",
  "FIFO", "GRN", "B2B", "B2C", "KRA", "KPI",
]

/**
 * Closed / leading / already-answered shapes. The generator prompt asks for open
 * questions; this is the guarantee. A phone screener that opens with
 * "kya aapne kabhi" gets a one-word answer and the call is over.
 */
const BANNED_ASK: { re: RegExp; label: string }[] = [
  { re: /kya aapne kabhi/i, label: "closed past-experience question" },
  { re: /\bkya aap\b/i, label: "closed yes/no question" },
  { re: /comfortable (hain|ho|hai)/i, label: "comfort question" },
  { re: /idea hai/i, label: "idea/opinion question" },
  { re: /(kab tak join|kab join|joining (date|time)|join kar sakte|notice period)/i, label: "joining / notice question" },
  { re: /(\bctc\b|salary|package|compensation)/i, label: "salary question" },
  { re: /(kitne saal|years of experience|total experience)/i, label: "experience question" },
  { re: /(\bcity\b|relocat|kahan reh)/i, label: "location / relocation question" },
  { re: /(switching ka reason|kyun (badal|leave|chhod)|job (change|badal))/i, label: "reason-for-switching question" },
  { re: /kar sakte hain\s*\??$/i, label: "capability question" },
  { re: /\b(hamare|humare)\b/i, label: "company claim inside the question" },
]

function hasAcronymOutsideContext(text: string, allowedText: string): string | null {
  const upper = text.toUpperCase()
  const allowed = allowedText.toUpperCase()
  for (const acronym of ACRONYMS) {
    const re = new RegExp(`(^|[^A-Z0-9])${acronym}($|[^A-Z0-9])`, "i")
    if (!re.test(upper)) continue
    if (!allowed.includes(acronym)) return acronym
  }
  return null
}

function mentionsName(text: string, names: (string | null | undefined)[]): string | null {
  const haystack = text.toLowerCase()
  for (const raw of names) {
    const name = String(raw || "").trim()
    if (name.length < 4) continue
    if (haystack.includes(name.toLowerCase())) return name
  }
  return null
}

/**
 * Everything wrong with a single spoken question. Shared by the plan validator
 * and by the bridge that reuses old queued questions, so both apply exactly the
 * same rules — a row queued before the plan existed cannot smuggle a banned
 * question past the new prompt.
 */
function checkAsk(
  ask: string,
  clientNames: (string | null | undefined)[],
  allowedText: string,
  maxWords = MAX_ASK_WORDS
): string[] {
  const errors: string[] = []
  if (wordCount(ask) > maxWords) {
    errors.push(`ask too long (${wordCount(ask)} words): ${ask}`)
  }
  if ((ask.match(/\?/g) || []).length > 1) {
    errors.push(`stacked question (more than one "?"): ${ask}`)
  }
  // "Aapne dispatch kaise plan kiya aur kitni gaadiyan thi?" has one "?" but two
  // asks, so the model would answer whichever half it heard. Counting marks is
  // not enough: require two DIFFERENT interrogatives joined by "aur". Distinct,
  // because "kya kya tasks kiye" is one ask (the reduplication is idiomatic), and
  // "dispatch aur tracking kaise manage ki?" is one ask with two objects.
  const interrogatives = new Set(
    (ask.match(/(kaise|kaun|kaunsa|kaunsi|kaunse|kab|kahan|kahaan|kyun|kyu|kitna|kitni|kitne|kya)\b/gi) || [])
      .map((w) => w.toLowerCase())
  )
  if (/\baur\b/i.test(ask) && interrogatives.size >= 2) {
    errors.push(`stacked question (two asks joined by "aur"): ${ask}`)
  }
  // "Kya kiya aapne Tally ERP.9 ka use karke financial reports generate karne ke
  // liye?" is answerable with "haan" and was answered "हां जी हां जी हां जी" on a
  // live call. A question that opens with "Kya" and carries no other
  // interrogative is a closed shape, even when it looks long.
  const hasOtherInterrogative = /(kaise|kaun|kaunsa|kaunsi|kaunse|kab|kahan|kahaan|kyun|kyu|kitna|kitni|kitne)\b/i.test(ask)
  if (/^\s*kya\b/i.test(ask) && !hasOtherInterrogative) {
    errors.push(`yes/no question (opens with "Kya", no other interrogative): ${ask}`)
  }
  // The voice is Hinglish in Latin script. A stray Devanagari word (Gemini does
  // this) changes pronunciation for the TTS voice and reads as broken on screen.
  if (/[\u0900-\u097F]/.test(ask)) {
    errors.push(`non-Latin script (Devanagari) in question: ${ask}`)
  }
  for (const rule of BANNED_ASK) {
    if (rule.re.test(ask)) errors.push(`banned ${rule.label}: ${ask}`)
  }
  // A procedure question ("export quotation se final shipment tak ka process
  // step-by-step bataiye") invites a narrated walkthrough. It fills the call and
  // produces no evidence of skill — the candidate reads out a process, not their
  // own work. Ask for an instance instead.
  if (/\b(step[-\s]?by[-\s]?step|end[-\s]to[-\s]end|pura\s+process|poora\s+process|process\s+bataiye)\b/i.test(ask)) {
    errors.push(`procedure ask, not an evidence ask: ${ask}`)
  }
  const leakedName = mentionsName(ask, clientNames)
  if (leakedName) errors.push(`client name "${leakedName}" inside question: ${ask}`)
  const leakedAcronym = hasAcronymOutsideContext(ask, allowedText)
  if (leakedAcronym) errors.push(`acronym ${leakedAcronym} not in resume/JD: ${ask}`)
  return errors
}

/**
 * Reject-and-retry rather than silently repairing: a question that broke a rule
 * should be rewritten, not patched, otherwise the retry prompt has nothing to
 * learn from.
 */
export function validateInterviewPlan(
  plan: InterviewPlan,
  ctx: PlanValidationContext = {}
): { ok: boolean; errors: string[]; plan: InterviewPlan } {
  const errors: string[] = []
  const clientNames = [...(ctx.clientNames || []), "Truckinzy", "GatiHire"]
  const allowedText = ctx.allowedText || ""

  const rawTopics = Array.isArray(plan.topics) ? plan.topics.slice(0, 3) : []
  if (rawTopics.length < 2) {
    errors.push(`plan needs at least 2 topics, got ${rawTopics.length}`)
  }

  const seenIds = new Set<string>()
  const topics: InterviewPlanTopic[] = []

  for (const raw of rawTopics) {
    const ask = String(raw?.ask || "").trim()
    const label = String(raw?.label || "").trim()
    if (!ask) {
      errors.push("topic has no ask")
      continue
    }
    errors.push(...checkAsk(ask, clientNames, allowedText))

    const digs = (Array.isArray(raw.digs) ? raw.digs : [])
      .map((d) => ({ key: slug(String(d?.key || "dig")), prompt: String(d?.prompt || "").trim() }))
      .filter((d) => d.prompt)
      .slice(0, MAX_DIGS_PER_TOPIC)
    if (digs.length === 0) errors.push(`topic has no digs: ${label || ask}`)
    for (const d of digs) {
      // A dig is spoken on its own turn, so it must pass the same rules as an
      // ask: one question, open shape, no client name, no procedure ask. This
      // was the gap that let "Kya kiya aapne Tally ERP.9 ka use karke financial
      // reports generate karne ke liye?" ship — and collect "हां जी हां जी हां जी".
      errors.push(...checkAsk(d.prompt, clientNames, allowedText, MAX_DIG_WORDS))
    }

    const strong = String(raw?.strong || "").trim()
    const weak = String(raw?.weak || "").trim()
    if (!strong) errors.push(`topic has no strong signal: ${label || ask}`)
    if (!weak) errors.push(`topic has no weak signal: ${label || ask}`)
    if (strong && strong.toLowerCase() === weak.toLowerCase()) {
      errors.push(`strong and weak are identical: ${label || ask}`)
    }

    let id = slug(String(raw?.id || label || ask))
    if (seenIds.has(id)) id = `${id}_${topics.length + 1}`
    seenIds.add(id)

    topics.push({
      id,
      label: label || ask,
      source:
        raw?.source === "resume_claim" || raw?.source === "manual" ? raw.source : "jd_must_have",
      must_have: raw?.must_have !== false,
      order: Number(raw?.order) || topics.length + 1,
      ask,
      digs,
      strong,
      weak,
      resume_hook: raw?.resume_hook ? String(raw.resume_hook) : null,
    })
  }

  // Easy to hard: the resume-claim test always goes last, never first.
  topics.sort((a, b) => {
    if (a.source === "resume_claim" && b.source !== "resume_claim") return 1
    if (b.source === "resume_claim" && a.source !== "resume_claim") return -1
    return a.order - b.order
  })
  topics.forEach((t, i) => (t.order = i + 1))

  const dealbreakers: InterviewPlanDealbreaker[] = []
  for (const raw of Array.isArray(plan.dealbreakers) ? plan.dealbreakers.slice(0, 3) : []) {
    const confirm = String(raw?.confirm || "").trim()
    if (!confirm) continue
    if (wordCount(confirm) > MAX_DEALBREAKER_WORDS) {
      errors.push(`dealbreaker confirm too long: ${confirm}`)
    }
    if (/(kyun|why)\b/i.test(confirm)) {
      errors.push(`dealbreaker must not ask why: ${confirm}`)
    }
    dealbreakers.push({
      id: slug(String(raw?.id || raw?.label || confirm)),
      label: String(raw?.label || confirm).trim(),
      type: "confirm",
      confirm,
      if_missing: raw?.if_missing === "flag" ? "flag" : "close_politely",
      mandatory: raw?.mandatory !== false,
    })
  }

  return {
    ok: errors.length === 0 && topics.length >= 2,
    errors,
    plan: {
      ...plan,
      topics,
      dealbreakers,
      call_shape: {
        target_seconds: TARGET_SECONDS,
        hard_cap_seconds: HARD_CAP_SECONDS,
        topics: topics.length,
        max_digs_per_topic: MAX_DIGS_PER_TOPIC,
      },
    },
  }
}

// ── Template plan (deterministic, no network) ────────────────────────────────

function short(text: string, maxWords = 5): string {
  return String(text || "")
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, maxWords)
    .join(" ")
}

/** A JD bullet starts with an action verb ("Handle …", "Obtain …"); a spoken
 *  topic needs the object of that verb, not the verb. */
const LEADING_ACTION =
  /^(handle|handling|manage|managing|prepare|preparing|maintain|maintaining|coordinate|coordinating|obtain|obtaining|negotiate|negotiating|ensure|ensuring|support|supporting|oversee|overseeing|process|processing|monitor|monitoring|create|creating|develop|developing|execute|executing|plan|planning|track|tracking|check|checking|submit|submitting|verify|verifying|update|updating|arrange|arranging|follow|following|assist|assisting|responsible for)\b\s*/i

function responsibilityPhrase(text: string, maxWords: number): string {
  const cleaned = String(text || "")
    .replace(/\.$/, "")
    .replace(LEADING_ACTION, "")
    .trim()
  return short(cleaned, maxWords)
}

function isManagerRole(job: JobContext): boolean {
  const hay = `${job.title || ""} ${job.role_category || ""}`.toLowerCase()
  return /(manager|head|lead|supervisor|incharge|in-charge|director|avp|vp|chief)/.test(hay)
}

/** A number from the resume is the one claim worth testing in a first call. */
export function findResumeClaims(resumeText?: string | null): string[] {
  if (!resumeText) return []
  const text = String(resumeText).replace(/\s+/g, " ")
  const units =
    "drivers|vehicles|trucks|people|employees|team members|staff|skus|orders|shipments|branches|stores|clients|vendors|members"
  const re = new RegExp(`(\\d[\\d,]{0,5})\\s*\\+?\\s*(${units})`, "gi")
  const found: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const claim = `${match[1]} ${match[2].toLowerCase()}`
    if (!found.includes(claim)) found.push(claim)
  }
  return found
}

export function findResumeClaim(resumeText?: string | null): string | null {
  return findResumeClaims(resumeText)[0] ?? null
}

/** A `jobs` row the way PostgREST returns it — `description` holds the JD text. */
export type JobRowLike = Partial<JobContext> & {
  id?: string
  description?: string | null
}

const JD_HEADINGS =
  /^(key responsibilities|responsibilities|roles? (and|&) responsibilities|requirements|qualifications|desired|skills|about|job description|position|department|industry|budget|location|salary|benefits|why join|company|candidate profile)\b/i

/**
 * Pull the responsibility sentences out of a free-form JD.
 *
 * Why this exists: `jobs.key_responsibilities` and `jobs.daily_work_summary` were
 * dropped in `supabase/migrations/trim_job_fields.sql` (Feb), but the call
 * placement query still asked for them. PostgREST answers 42703, and the caller
 * reads any error as "participant not found" — so every retry and every inbound
 * callback silently stopped placing. The JD text is still in `jobs.description`,
 * so the plan generator reads it from there instead of from a column that no
 * longer exists.
 */
export function responsibilitiesFromDescription(description: string): string[] {
  return String(description || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s•·‣▪◦*\-–—]+/, "").trim())
    .filter((line) => {
      if (line.length < 20 || line.length > 160) return false
      if (JD_HEADINGS.test(line)) return false
      if (line.endsWith(":")) return false
      // "Position: Sea Export Pricing Executive" — a field, not a responsibility.
      if (line.slice(0, 30).includes(":")) return false
      if (/^[A-Z\s&/]+$/.test(line)) return false
      return /^[A-Za-z]/.test(line)
    })
    .filter((line, i, all) => all.indexOf(line) === i)
    .slice(0, 6)
}

/**
 * Normalise a `jobs` row into the shape the plan generator expects, filling the
 * dropped columns from the JD text when the row still carries them.
 */
export function jobContextFromRow(row: JobRowLike | null | undefined): JobContext {
  if (!row) return { id: "" }
  const context = { ...row } as JobContext & { description?: string | null }
  if (!context.key_responsibilities?.length) {
    const parsed = responsibilitiesFromDescription(String(row.description || ""))
    if (parsed.length) context.key_responsibilities = parsed
  }
  return context
}

/**
 * The domains we can tell apart cheaply, used only to decide whether a candidate
 * is crossing into a different kind of work.
 *
 * The first place this mattered: a procurement executive screened for a sea
 * export *pricing* desk. The call asked three pricing questions, the enrichment
 * then told HR "the next interviewer should verify he can move from procurement
 * to pricing" — a question the call should have asked. See docs §7.2.
 */
const ROLE_DOMAINS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: "procurement", label: "procurement / purchasing", re: /procurement|purchasing|sourcing|vendor development|buyer|supplier management/i },
  { key: "pricing", label: "freight pricing / quotations", re: /pricing|quotation|quote|rate sheet|freight rate|ocean freight|rate negotiation/i },
  { key: "import", label: "import / customs clearance", re: /\bimport\b|customs|icegate|bill of entry/i },
  { key: "export", label: "export documentation", re: /\bexport\b|shipping bill|bill of lading/i },
  { key: "sales", label: "sales / business development", re: /\bsales\b|business development|client acquisition|key account/i },
  { key: "warehouse", label: "warehouse / inventory", re: /warehouse|inventory|\bstores?\b|\bstock\b|3pl|fulfil/i },
  { key: "transport", label: "transport / fleet", re: /\bfleet\b|transport|\bdrivers?\b|\bvehicles?\b|\btrucks?\b|dispatch/i },
  { key: "accounting", label: "accounts / finance", re: /accounts\b|payable|receivable|\bgst\b|\btds\b|tally|ledger/i },
  { key: "hr", label: "HR / recruitment", re: /recruit|\bhr\b|payroll|talent/i },
  { key: "tracking", label: "tracking / MIS", re: /tracking|\bmis\b|\bgps\b|telematics|dashboard/i },
]

function domainsIn(text: string): string[] {
  const hay = String(text || "")
  return ROLE_DOMAINS.filter((d) => d.re.test(hay)).map((d) => d.key)
}

function domainLabel(key: string): string {
  return ROLE_DOMAINS.find((d) => d.key === key)?.label ?? key
}

/**
 * Non-null when the candidate's own work and the role's work share no domain —
 * i.e. the candidate is switching lanes, which is exactly what a screening call
 * must test rather than defer to the next interviewer.
 */
export function detectRoleShift(
  job: JobContext,
  candidate?: CandidateContext | null
): { from: string; to: string } | null {
  // Title and must-haves only. Responsibilities are full of counterparties —
  // "share quotations with sales and operations teams" would read as a sales
  // domain and put the wrong words in topic 3.
  const jobText = [job.title, job.role_category, (job.skills_must_have || []).join(" ")]
    .filter(Boolean)
    .join(" ")
  const candText = [
    candidate?.current_role,
    String(candidate?.resume_text || "").slice(0, 1200),
  ]
    .filter(Boolean)
    .join(" ")
  const jobDomains = domainsIn(jobText)
  const candDomains = domainsIn(candText)
  if (jobDomains.length === 0 || candDomains.length === 0) return null
  const overlap = jobDomains.filter((d) => candDomains.includes(d))
  if (overlap.length > 0) return null
  // Two labels at most: the prompt is a sentence, not an inventory.
  return {
    from: candDomains.slice(0, 2).map(domainLabel).join(", "),
    to: jobDomains.slice(0, 2).map(domainLabel).join(", "),
  }
}

const COMMON_DIGS: InterviewPlanDig[] = [
  { key: "scale", prompt: "Kitne log ya kitna volume handle karte the?" },
  { key: "system", prompt: "Kaun sa system ya software use karte the?" },
  { key: "ownership", prompt: "Yeh aap khud karte the ya team?" },
  { key: "result", prompt: "Result kya nikla — ek example?" },
]

/**
 * Always safe, never clever. This is what runs when Gemini is down, and it is
 * also what rebuilds a payload-less retry before dialling. It can never ask the
 * joining question, name the client, or use an acronym the resume does not.
 */
export function buildTemplatePlan(
  job: JobContext,
  candidate?: CandidateContext | null
): InterviewPlan {
  const topics: InterviewPlanTopic[] = []
  const mustHave = Array.isArray(job.skills_must_have) ? job.skills_must_have.filter(Boolean) : []
  const responsibilities = Array.isArray(job.key_responsibilities)
    ? job.key_responsibilities.filter(Boolean)
    : []

  const firstSkill = mustHave[0] ? short(String(mustHave[0]), 5) : ""
  if (firstSkill) {
    topics.push({
      id: slug(`skill ${firstSkill}`),
      label: `Core skill: ${firstSkill}`,
      source: "jd_must_have",
      must_have: true,
      order: topics.length + 1,
      ask: `${firstSkill} ka ek real example bataiye — aapne kaise kiya?`,
      digs: COMMON_DIGS,
      strong: "Names a real system or task, gives a number, describes their own action",
      weak: "Only theory, says the team did it, cannot give one example",
      resume_hook: null,
    })
  }

  // A manager screened without a people-management question is not a screening.
  // Employee management is merged into the same topic because 3 topics cannot
  // cover five competencies, and "team size + how you ran them" is the one that
  // separates a manager from a coordinator.
  if (isManagerRole(job)) {
    topics.push({
      id: "team_and_employee_management",
      label: "Team & employee management",
      source: "jd_must_have",
      must_have: true,
      order: topics.length + 1,
      ask: "Aapke under kitne log the — unka kaam kaise check karte the?",
      digs: [
        { key: "scale", prompt: "Kitne log the, aur kaun kaun roles?" },
        { key: "cadence", prompt: "Review ya meeting kaise karte the?" },
        { key: "employee_issue", prompt: "Ek employee dispute kaise handle kiya?" },
        { key: "result", prompt: "Attrition kitna tha — kya badla?" },
      ],
      strong: "Names team size and roles, a review rhythm, one employee case they owned",
      weak: "Says 'team handle karti thi', no size, no example",
      resume_hook: null,
    })
  } else if (responsibilities[0]) {
    const resp = responsibilityPhrase(String(responsibilities[0]), 8)
    topics.push({
      id: slug(resp),
      label: `Daily work: ${responsibilityPhrase(String(responsibilities[0]), 5)}`,
      source: "jd_must_have",
      must_have: true,
      order: topics.length + 1,
      ask: `${resp} ka ek real example bataiye?`,
      digs: COMMON_DIGS,
      strong: "Describes a real instance, the system used, and the outcome",
      weak: "Generic yes, cannot describe one instance",
      resume_hook: null,
    })
  } else if (job.daily_work_summary) {
    topics.push({
      id: "daily_work",
      label: "Daily work",
      source: "jd_must_have",
      must_have: true,
      order: topics.length + 1,
      ask: "Roz ka kaam kaisa hota tha — ek din ka example bataiye?",
      digs: COMMON_DIGS,
      strong: "Walks through a real day, in order, with names or numbers",
      weak: "Generic description, no sequence, no example",
      resume_hook: null,
    })
  } else if (mustHave[1]) {
    const second = short(String(mustHave[1]), 5)
    topics.push({
      id: slug(`skill ${second}`),
      label: `Core skill: ${second}`,
      source: "jd_must_have",
      must_have: true,
      order: topics.length + 1,
      ask: `${second} pe aapne kaam kiya — ek example bataiye.`,
      digs: COMMON_DIGS,
      strong: "A concrete instance with numbers or a system name",
      weak: "No example, only a claim",
      resume_hook: null,
    })
  }

  if (topics.length === 0) {
    topics.push({
      id: "last_role",
      label: "Last role",
      source: "jd_must_have",
      must_have: true,
      order: 1,
      ask: "Pichle role mein aapka main kaam kya tha — ek din bataiye?",
      digs: COMMON_DIGS,
      strong: "Describes a real day and their own decisions",
      weak: "Only a designation, no work described",
      resume_hook: null,
    })
  }

  const allClaims = findResumeClaims(candidate?.resume_text)
  // Never repeat the team topic as the resume test. If every numeric claim on the
  // CV is a headcount, test a skill the resume actually names — for an HR
  // Manager that is the difference between testing "statutory compliance" and
  // asking about team size twice.
  const peopleClaim = /(employees|people|team members|members|staff|drivers|workers)/i
  const claim =
    allClaims.find((c) => !(isManagerRole(job) && peopleClaim.test(c))) || null
  const resumeText = String(candidate?.resume_text || "").toLowerCase()
  const resumeSkill = !claim
    ? mustHave
        .slice(1)
        .map(String)
        .map((s) => short(s, 4))
        .find((s) => s && resumeText.includes(s.toLowerCase())) || null
    : null
  const hook = claim || resumeSkill
  topics.push({
    id: hook ? slug(`resume ${hook}`) : "resume_claim",
    label: hook ? `Resume claim: ${hook}` : "Last role detail",
    source: "resume_claim",
    must_have: false,
    order: topics.length + 1,
    ask: claim
      ? `Resume mein "${claim}" likha hai — wo aapne kaise kiya?`
      : resumeSkill
        ? `Resume mein ${resumeSkill} likha hai — ek example bataiye?`
        : "Pichle role mein sabse mushkil kaam kya tha — kya kiya aapne?",
    digs: [
      { key: "situation", prompt: "Us waqt exactly kya ho raha tha?" },
      { key: "ownership", prompt: "Aapne khud kya kiya usme?" },
      { key: "result", prompt: "Aakhir mein kya hua?" },
    ],
    strong: "Speaks from memory, gives specifics, owns the action and the outcome",
    weak: "Repeats the resume line, cannot describe the situation",
    resume_hook: hook,
  })

  const license = String(job.license_type || "").trim()
  const dealbreakers: InterviewPlanDealbreaker[] = license
    ? [
        {
          id: "licence",
          label: /licen[cs]e/i.test(license) ? license : `${license} licence`,
          type: "confirm",
          confirm: `Aapke paas ${license.replace(/\s*licen[cs]e\s*/i, "").trim()} licence hai na?`,
          if_missing: "close_politely",
          mandatory: true,
        },
      ]
    : []

  return {
    version: PLAN_VERSION,
    job_id: String(job.id || ""),
    generated_at: new Date().toISOString(),
    language: "hinglish",
    call_shape: {
      target_seconds: TARGET_SECONDS,
      hard_cap_seconds: HARD_CAP_SECONDS,
      topics: Math.min(topics.length, 3),
      max_digs_per_topic: MAX_DIGS_PER_TOPIC,
    },
    topics: topics.slice(0, 3),
    dealbreakers,
  }
}

/**
 * Everything wrong with one spoken question, under exactly the rules the
 * generator and the bridge apply. Exported so the manual editor can tell HR
 * which of their edits were refused — and why — instead of silently replacing
 * their wording with something else.
 */
export function questionRuleErrors(
  ask: string,
  job: JobContext,
  candidate?: CandidateContext | null
): string[] {
  const allowedText = `${candidate?.resume_text || ""}\n${(job.skills_must_have || []).join(" ")}\n${
    (job.key_responsibilities || []).join(" ")
  }`
  return checkAsk(ask, [job.client_name, "Truckinzy", "GatiHire"], allowedText)
}

/**
 * Bridge for rows queued before plans existed, and for recruiters who edited the
 * old numbered list by hand. Their wording is kept — but only the questions that
 * would pass today's rules, because the whole point of the plan is that the
 * agent can no longer speak a banned question. If fewer than two survive, the
 * safe template is used instead.
 *
 * Being strict here is what makes the prompt swap safe with 30+ old rows still
 * in the queue (see docs/ai-call-quality-plan.md §4.7a).
 */
export function buildPlanFromQuestions(
  questionsText: string,
  job: JobContext,
  candidate?: CandidateContext | null
): InterviewPlan {
  const asks = String(questionsText || "")
    .split("\n")
    .map((q) => q.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean)
    .filter((q) => questionRuleErrors(q, job, candidate).length === 0)
    .slice(0, 3)

  if (asks.length < 2) return buildTemplatePlan(job, candidate)

  const topics: InterviewPlanTopic[] = asks.map((ask, i) => ({
    id: slug(`question ${i + 1}`),
    label: `Screening topic ${i + 1}`,
    source: "jd_must_have",
    must_have: true,
    order: i + 1,
    ask,
    digs: COMMON_DIGS,
    strong: "Gives a concrete example with a number, a system, and their own action",
    weak: "Only theory, says the team did it, cannot give one example",
    resume_hook: null,
  }))

  return {
    version: PLAN_VERSION,
    job_id: String(job.id || ""),
    generated_at: new Date().toISOString(),
    language: "hinglish",
    call_shape: {
      target_seconds: TARGET_SECONDS,
      hard_cap_seconds: HARD_CAP_SECONDS,
      topics: topics.length,
      max_digs_per_topic: MAX_DIGS_PER_TOPIC,
    },
    topics,
    dealbreakers: [],
  }
}

// ── Generation ───────────────────────────────────────────────────────────────

function buildPlanPrompt(
  job: JobContext,
  candidate: CandidateContext,
  infoData?: Record<string, unknown> | null
): string {
  const jd = [
    job.title ? `Role: ${job.title}` : "",
    job.city ? `Location: ${job.city}` : "",
    job.experience_min_years != null || job.experience_max_years != null
      ? `Experience: ${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"} years`
      : "",
    job.skills_must_have?.length ? `Must-have skills: ${job.skills_must_have.join(", ")}` : "",
    job.key_responsibilities?.length
      ? `Key responsibilities:\n- ${job.key_responsibilities.join("\n- ")}`
      : "",
    job.daily_work_summary ? `Daily work: ${job.daily_work_summary}` : "",
    job.license_type ? `Licence required: ${job.license_type}` : "",
    job.role_category ? `Category: ${job.role_category}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  const profile = [
    candidate.current_role ? `Current role: ${candidate.current_role}` : "",
    candidate.current_company ? `Current company: ${candidate.current_company}` : "",
    candidate.total_experience != null ? `Experience: ${candidate.total_experience} years` : "",
    candidate.resume_text ? `Resume:\n${String(candidate.resume_text).slice(0, 2500)}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  const collected = Object.keys(infoData || {}).length
    ? `Already collected on WhatsApp (never ask): ${Object.keys(infoData || {}).join(", ")}`
    : "Nothing collected yet."

  // When the candidate is crossing lanes, the third topic has to test that move.
  // Otherwise the call scores the old job and the enrichment has to tell HR to
  // "verify in the next round" what this round should have asked.
  const shift = detectRoleShift(job, candidate)
  const shiftHint = shift
    ? `ROLE SHIFT: the candidate's background is ${shift.from}; this role is ${shift.to}.`
    : ""
  const topic3Rule = shift
    ? `Topic 3 MUST test that shift: ask for one real instance where they did ${shift.to} work,
  or how they handled a move from ${shift.from} into it. An opinion about being a
  fast learner is a weak answer; a real instance is the point.`
    : `Topic 3 MUST verify one concrete claim from the resume; copy the phrase into resume_hook.`

  return `You are designing a 3-topic interview plan for a 5-minute Hinglish phone screening.
Return ONLY a JSON object, no markdown, matching exactly this shape:

{
  "topics": [
    {
      "id": "short_snake_case_id",
      "label": "Human label",
      "source": "jd_must_have" | "resume_claim",
      "must_have": true,
      "order": 1,
      "ask": "one open question",
      "digs": [{"key":"scale","prompt":"..."},{"key":"ownership","prompt":"..."}],
      "strong": "what a strong answer contains",
      "weak": "what a weak answer looks like",
      "resume_hook": null
    }
  ],
  "dealbreakers": [
    {"id":"hmv_licence","label":"HMV licence","type":"confirm","confirm":"Aapke paas HMV licence hai na?","if_missing":"close_politely","mandatory":true}
  ]
}

JOB:
${jd || "(no job description available)"}

CANDIDATE:
${profile || "(no candidate profile available)"}

${collected}

${shiftHint}

HARD RULES — a plan that breaks any of these is rejected and regenerated:
- Exactly 3 topics. Topic 1 and 2 come from the JD's must-have skills/responsibilities
  and must test DIFFERENT skills — never two questions about the same thing.
- ${topic3Rule}
- Every "ask" is OPEN: start with "Kaise", "Bataiye", "Ek baar bataiye", "Kaun sa".
  Never "Kya kiya", "kya aapne kabhi", "kya aap", "comfortable hain", "idea hai", "kar sakte hain".
  A question that can be answered "haan" is a failed question.
- "ask" is 15 words or fewer, ONE ask, at most one "?".
- Never ask for a procedure or a walkthrough: no "step-by-step", "pura process",
  "end to end", "process bataiye". Ask for one REAL instance instead — what they
  actually did, at what volume, with what result. A process narration fills five
  minutes and proves nothing.
- Never ask about salary/CTC, notice period, joining date, total experience, city,
  relocation, or reason for switching. They are already collected.
- Never put a client or company name in an "ask". Never say "hamare"/"humare".
- No acronyms (PF, ESIC, GRIR, P2P, FEFO, WMS, TMS, CLRA, SKU...) unless the resume
  or JD above uses them.
- At most 2 digs per topic (3 x 2 digs + 3 asks = 9 spoken questions, ~5 minutes).
  Each dig is 12 words or fewer, asks for ONE thing (scale, system, own role vs
  team, result), and is spoken on its own turn — never joined to another dig.
  Bad: "Total kitne vendors the aur financial impact kya tha?" (two asks in one)
  Good: "Total kitne vendors ka volume handle karte the?" then, next turn,
        "Uska financial impact kya tha?"
  No dig may start with "Kya" — that shape returns a yes/no answer.
- "strong" and "weak" are one line each, in English, describing EVIDENCE not
  personality. They are never spoken aloud.
- Dealbreakers are confirm-only, yes/no, 12 words or fewer, no "why". Only include
  one if the JD states a hard requirement (licence, certification). If none, return [].
- Order easy to hard: warm-up first, resume-verification last.`
}

function normalizePlan(
  raw: any,
  job: JobContext,
  candidate: CandidateContext
): InterviewPlan {
  const topics = (Array.isArray(raw?.topics) ? raw.topics : []).map((t: any, i: number) => ({
    id: String(t?.id || `topic_${i + 1}`),
    label: String(t?.label || `Topic ${i + 1}`),
    source:
      t?.source === "resume_claim" || t?.source === "manual"
        ? t.source
        : ("jd_must_have" as const),
    must_have: t?.must_have !== false,
    order: Number(t?.order) || i + 1,
    ask: String(t?.ask || "").trim(),
    digs: (Array.isArray(t?.digs) ? t.digs : []).map((d: any, j: number) => ({
      key: String(d?.key || `dig_${j + 1}`),
      prompt: String(d?.prompt || "").trim(),
    })),
    strong: String(t?.strong || "").trim(),
    weak: String(t?.weak || "").trim(),
    resume_hook: t?.resume_hook ? String(t.resume_hook) : null,
  }))

  const dealbreakers = (Array.isArray(raw?.dealbreakers) ? raw.dealbreakers : []).map((d: any, i: number) => ({
    id: String(d?.id || `dealbreaker_${i + 1}`),
    label: String(d?.label || d?.confirm || "Dealbreaker"),
    type: "confirm" as const,
    confirm: String(d?.confirm || "").trim(),
    if_missing: d?.if_missing === "flag" ? ("flag" as const) : ("close_politely" as const),
    mandatory: d?.mandatory !== false,
  }))

  const claim = topics.find((t: any) => t.source === "resume_claim")?.resume_hook
  if (!claim) {
    const found = findResumeClaim(candidate.resume_text)
    if (found) {
      const last = topics[topics.length - 1]
      if (last && last.source !== "resume_claim") last.resume_hook = found
    }
  }

  return {
    version: PLAN_VERSION,
    job_id: String(job.id || ""),
    generated_at: new Date().toISOString(),
    language: "hinglish",
    call_shape: {
      target_seconds: TARGET_SECONDS,
      hard_cap_seconds: HARD_CAP_SECONDS,
      topics: Math.min(topics.length, 3),
      max_digs_per_topic: MAX_DIGS_PER_TOPIC,
    },
    topics: topics.slice(0, 3),
    dealbreakers: dealbreakers.slice(0, 3),
  }
}

function parseJson(text: string): any | null {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf("{")
    const end = cleaned.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

export type GeneratePlanResult = {
  plan: InterviewPlan
  promptUsed: string
  source: "gemini" | "gemini_retry" | "template"
  errors: string[]
}

/**
 * Never throws and never blocks a call. A bad model answer degrades to the
 * template, which is safe by construction (no joining question, no client name,
 * no acronyms).
 */
export async function generateInterviewPlan(
  job: JobContext,
  candidate: CandidateContext,
  infoData?: Record<string, unknown> | null
): Promise<GeneratePlanResult> {
  const prompt = buildPlanPrompt(job, candidate, infoData)
  const validationCtx: PlanValidationContext = {
    clientNames: [job.client_name],
    allowedText: `${candidate.resume_text || ""}\n${(job.skills_must_have || []).join(" ")}\n${
      job.key_responsibilities || []
    }`,
    jobTitle: job.title || undefined,
  }
  const key = process.env.GEMINI_API_KEY
  if (!key) {
    return { plan: buildTemplatePlan(job, candidate), promptUsed: "template", source: "template", errors: [] }
  }

  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: MODEL })
  let firstErrors: string[] = []

  for (const attempt of [1, 2]) {
    try {
      const attemptPrompt =
        attempt === 1
          ? prompt
          : `${prompt}\n\nYour previous answer broke these rules. Fix every one:\n- ${firstErrors.join(
              "\n- "
            )}`
      const result = await model.generateContent(attemptPrompt)
      const parsed = parseJson(result.response.text())
      if (!parsed) {
        firstErrors = ["response was not valid JSON"]
        continue
      }
      const normalized = normalizePlan(parsed, job, candidate)
      const checked = validateInterviewPlan(normalized, validationCtx)
      if (checked.ok) {
        return {
          plan: checked.plan,
          promptUsed: attemptPrompt,
          source: attempt === 1 ? "gemini" : "gemini_retry",
          errors: [],
        }
      }
      firstErrors = checked.errors
      logger.warn("Interview plan failed validation", { attempt, errors: checked.errors.slice(0, 5) })
    } catch (err: any) {
      firstErrors = [err?.message || "generation failed"]
      logger.warn("Interview plan generation failed", { attempt, error: err?.message })
    }
  }

  const template = buildTemplatePlan(job, candidate)
  return { plan: template, promptUsed: prompt, source: "template", errors: firstErrors }
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * This is the only thing that reaches the agent. Plain prose, ~200 words.
 * Structured in the DB, spoken as notes — never JSON, because the prompt is
 * explicitly told never to speak brackets and `buildCallUserData` flags braces as
 * unfilled placeholders.
 */
export function renderInterviewPlan(plan: InterviewPlan): string {
  const lines: string[] = []
  const topics = plan.topics || []
  const targetMin = Math.round((plan.call_shape?.target_seconds || TARGET_SECONDS) / 60)
  // Clamp, do not trust: plans generated before this round stored 420 s and
  // 3 digs per topic, and there are 600+ of them queued in the database. The
  // renderer is the one place every plan passes through, so the current budget
  // wins over whatever the stored shape says.
  const capMin = Math.round(Math.min(plan.call_shape?.hard_cap_seconds || HARD_CAP_SECONDS, HARD_CAP_SECONDS) / 60)
  const maxDigs = Math.min(plan.call_shape?.max_digs_per_topic || MAX_DIGS_PER_TOPIC, MAX_DIGS_PER_TOPIC)

  lines.push(
    `INTERVIEW PLAN — ${topics.length} topic${topics.length === 1 ? "" : "s"}, about ${targetMin} minutes (hard stop ${capMin})`
  )
  lines.push("")

  topics.forEach((t, i) => {
    const tag = t.must_have ? "  [must-have]" : ""
    lines.push(`TOPIC ${i + 1} — ${t.label}${tag}`)
    lines.push(`Ask: ${t.ask}`)
    if (t.digs?.length) {
      // Numbered, one per line. Joined with "·" they read as one long turn
      // ("Total kitne vendors… aur iska financial impact…") and the agent spoke
      // both at once. The dig is a turn boundary, not a list to read out.
      lines.push("Dig if thin — ask ONE per turn, never two together:")
      t.digs.slice(0, maxDigs).forEach((d, i) => {
        lines.push(`  ${i + 1}) ${d.prompt}`)
      })
    }
    if (t.strong) lines.push(`A strong answer: ${t.strong}.`)
    if (t.weak) lines.push(`A weak answer: ${t.weak}.`)
    lines.push("")
  })

  if (plan.dealbreakers?.length) {
    lines.push("BEFORE CLOSING — confirm only, do not interview on these")
    for (const d of plan.dealbreakers) {
      lines.push(
        `- ${d.label}: "${d.confirm}"${
          d.if_missing === "close_politely" ? " If no, close politely. Do not argue." : " If no, note it and continue."
        }`
      )
    }
    lines.push("")
  }

  lines.push("HOW TO RUN THIS")
  lines.push("- One topic at a time, in this order. Easy first, hardest last.")
  lines.push(`- Ask the topic question once. Dig up to ${maxDigs} times, only when the answer is thin.`)
  lines.push("- One question per turn. Never join two digs with \"aur\" and never ask the next one while the candidate is still answering.")
  lines.push("- If the answer is already strong, move to the next topic. Do not pad.")
  lines.push("- Never read this plan out loud. It is your notes, not your script.")

  return lines.join("\n").trim()
}

/** Backwards compatibility for the current `{questions}` placeholder. */
export function renderLegacyQuestions(plan: InterviewPlan): string {
  return (plan.topics || [])
    .map((t, i) => `${i + 1}. ${t.ask}`)
    .join("\n")
}

/** Read the plan back out of a stored payload (used by the scoring gate). */
export function planFromUserData(payload: unknown): InterviewPlan | null {
  if (!payload || typeof payload !== "object") return null
  const candidate = (payload as Record<string, unknown>)._interview_plan
  if (!candidate || typeof candidate !== "object") return null
  const topics = (candidate as any).topics
  if (!Array.isArray(topics) || topics.length === 0) return null
  return candidate as InterviewPlan
}

/**
 * The payload is persisted with the plan inside it, but Bolna must never receive
 * a nested JSON object — the agent would either speak it or choke on it.
 */
export function toBolnaUserData(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {}
  const rest = { ...(payload as Record<string, unknown>) }
  delete rest._interview_plan
  return rest
}
