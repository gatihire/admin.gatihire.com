import { GoogleGenerativeAI } from "@google/generative-ai"
import { logger } from "@/lib/logger"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview"

export interface JobContext {
  id: string
  title?: string | null
  client_name?: string | null
  skills_must_have?: string[] | null
  skills_good_to_have?: string[] | null
  experience_min_years?: number | null
  experience_max_years?: number | null
  salary_min?: number | null
  salary_max?: number | null
  salary_type?: string | null
  city?: string | null
  work_type?: string | null
  key_responsibilities?: string[] | null
  daily_work_summary?: string | null
  education_min?: string | null
  languages_required?: string[] | null
  english_level?: string | null
  license_type?: string | null
  role_category?: string | null
  shift_type?: string | null
  employment_type?: string | null
}

export interface CandidateContext {
  id: string
  name?: string | null
  current_role?: string | null
  current_company?: string | null
  total_experience?: number | null
  location?: string | null
  technical_skills?: string[] | string | null
  resume_text?: string | null
}

function skillsToText(skills: string[] | string | null | undefined): string {
  if (!skills) return ""
  if (Array.isArray(skills)) return skills.filter(Boolean).join(", ")
  return String(skills)
}

function buildJobDescription(job: JobContext): string {
  const parts: string[] = []
  if (job.title) parts.push(`Role: ${job.title}`)
  if (job.client_name) parts.push(`Client: ${job.client_name}`)
  if (job.city) parts.push(`Location: ${job.city}`)
  if (job.work_type) parts.push(`Work type: ${job.work_type}`)
  if (job.employment_type) parts.push(`Employment: ${job.employment_type}`)
  if (job.shift_type) parts.push(`Shift: ${job.shift_type}`)
  if (job.experience_min_years != null || job.experience_max_years != null) {
    parts.push(`Experience: ${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"} years`)
  }
  if (job.salary_min != null || job.salary_max != null) {
    parts.push(`Salary band: ${job.salary_min ?? ""} - ${job.salary_max ?? ""}${job.salary_type ? ` per ${job.salary_type}` : ""}`)
  }
  const mustHave = skillsToText(job.skills_must_have)
  if (mustHave) parts.push(`Must-have skills: ${mustHave}`)
  const goodToHave = skillsToText(job.skills_good_to_have)
  if (goodToHave) parts.push(`Good-to-have skills: ${goodToHave}`)
  if (job.education_min) parts.push(`Minimum education: ${job.education_min}`)
  if (job.languages_required?.length) parts.push(`Languages required: ${job.languages_required.join(", ")}`)
  if (job.english_level) parts.push(`English level: ${job.english_level}`)
  if (job.license_type) parts.push(`License required: ${job.license_type}`)
  if (job.key_responsibilities?.length) parts.push(`Key responsibilities:\n- ${job.key_responsibilities.join("\n- ")}`)
  if (job.daily_work_summary) parts.push(`Daily work summary: ${job.daily_work_summary}`)
  return parts.join("\n")
}

function buildCandidateProfile(candidate: CandidateContext): string {
  const parts: string[] = []
  if (candidate.name) parts.push(`Name: ${candidate.name}`)
  if (candidate.current_role) parts.push(`Current role: ${candidate.current_role}`)
  if (candidate.current_company) parts.push(`Current company: ${candidate.current_company}`)
  if (candidate.total_experience != null) parts.push(`Total experience: ${candidate.total_experience} years`)
  if (candidate.location) parts.push(`Location: ${candidate.location}`)
  const skills = skillsToText(candidate.technical_skills)
  if (skills) parts.push(`Skills: ${skills}`)
  return parts.join("\n")
}

export type QuestionGenerationResult = {
  questions: string[]
  promptUsed: string
}

/** Fields already collected on WhatsApp (never re-ask in the voice call). */
const COLLECTED_FIELD_KEYS = [
  "current_ctc",
  "expected_ctc",
  "notice_period",
  "total_experience",
  "location",
  "willing_to_relocate",
  "reason_for_switching",
]

/**
 * Topics the voice call must never raise, because the candidate already gave the
 * answer on WhatsApp or the talent board. The prompt states them, and the same
 * list is applied as a hard filter below — the prompt is guidance, the filter is
 * the guarantee, since an LLM asked for "3-6 questions" will happily invent a
 * CTC question the moment it cannot see the collected value.
 */
const NEVER_ASK: { label: string; re: RegExp }[] = [
  { label: "phone number", re: /(phone|mobile|contact number|whatsapp number|apna number|number (daal|dijiye|share|bata)|kaun sa number)/i },
  { label: "salary / CTC", re: /(\bctc\b|salary|\bpackage\b|compensation|pay structure)/i },
  { label: "notice period", re: /(notice period|\bnotice\b)/i },
  { label: "total experience", re: /(kitne saal|years of experience|total experience|experience (kaisa|kitna|kya|hai|ho))/i },
  { label: "current city / relocation", re: /(\bcity\b|\blocation\b|relocat|shift (to|kar)|kahan reh)/i },
  { label: "reason for switching", re: /(switching ka reason|reason for (switch|leaving|changing)|kyun (badal|leave|chhod)|job (change|badal))/i },
]

export function dropAlreadyAnswered(questions: string[]): string[] {
  const kept: string[] = []
  for (const q of questions) {
    const hit = NEVER_ASK.find((rule) => rule.re.test(q))
    if (hit) {
      logger.info("Dropped JD question: already collected", { topic: hit.label, question: q })
      continue
    }
    kept.push(q)
  }
  return kept
}

/**
 * Every field is printed on every call, present or not. Printing only the
 * collected ones was the bug: an empty `info_data` produced
 * "None collected yet (WhatsApp details phase)" — which told the question
 * generator it was free to ask for salary, notice and experience again, and
 * exactly that reached the candidate.
 *
 * `candidate` supplies the two resume-sourced fields the WhatsApp flow never
 * asks for, so they stop falling through the gap too.
 */
function collectAlreadyKnown(
  infoData: Record<string, unknown> | null | undefined,
  candidate?: CandidateContext | null
): string {
  const data = infoData && typeof infoData === "object" ? infoData : {}
  const resume: Record<string, unknown> = {}
  if (candidate) {
    if (candidate.total_experience != null) resume.total_experience = String(candidate.total_experience)
    if (candidate.location) resume.location = candidate.location
  }
  return [
    ...COLLECTED_FIELD_KEYS.map((k) => {
      const value = data[k] ?? resume[k]
      const has = value !== undefined && value !== null && String(value) !== ""
      // "Not collected" still means never ask — none of these are this call's job.
      return `- ${k.replace(/_/g, " ")}: ${has ? String(value) : "not collected — and not needed on this call"}`
    }),
    "- phone number: already on file, we are calling it right now",
  ].join("\n")
}

export async function generateJDQuestions(
  job: JobContext,
  candidate: CandidateContext,
  infoData?: Record<string, unknown> | null
): Promise<QuestionGenerationResult> {
  const jobDescription = buildJobDescription(job)
  const candidateProfile = buildCandidateProfile(candidate)
  const resumeExcerpt = candidate.resume_text ? candidate.resume_text.slice(0, 3000) : ""
  const alreadyCollected = collectAlreadyKnown(infoData, candidate)

  if (!process.env.GEMINI_API_KEY) {
    return { questions: dropAlreadyAnswered(buildFallbackQuestions(job)), promptUsed: "fallback" }
  }

  const prompt = `You are a recruiter preparing a SHORT first-round confirmation call for a candidate whose basic screening details were already collected on WhatsApp. Generate exactly 3 to 6 highly specific, job-relevant questions in natural Hinglish (Hindi + English mix) that probe ONLY the signals NOT yet collected.

JOB DESCRIPTION:
${jobDescription || "(no job description available)"}

CANDIDATE PROFILE (from resume / database):
${candidateProfile || "(no candidate profile available)"}

${resumeExcerpt ? `RESUME EXCERPT:\n${resumeExcerpt}` : ""}

ALREADY COLLECTED ON WHATSAPP (do NOT re-ask these):
${alreadyCollected}

Requirements for the questions:
- Speak them in natural Hinglish (e.g. "Tell me about a time when aapne iska use kiya tha"), phrased for a voice conversation, one at a time.
- NEVER ask about salary, CTC, notice period, total experience, current city, relocation, or reason for switching — every one of those is listed above and none of them is a question this call exists to ask. Questions on those topics will be discarded.
- Probe the role's must-have skills and key responsibilities: verify claimed experience with concrete examples ("tell me about a time you used X").
- Firm availability / joining timing: ask ONLY as a confirm, phrased as "aap kab tak join kar sakte hain?" — never "what is your notice period?".
- Ask 1-2 category-specific questions where relevant (license type, shifts, WMS/TMS tools, account scale) if the job description hints at them (driver/fleet, warehouse/ops, SCM/TMS, sales/BD).
- Do NOT repeat the candidate's own resume back to them.
- Keep each question to one clear ask — 2 sentences max.

Return ONLY a JSON array of strings, e.g. ["Q1", "Q2"]. No markdown, no code fences, no extra text.`

  try {
    const model = genAI.getGenerativeModel({ model: MODEL })
    const result = await model.generateContent(prompt)
    const text = result.response.text().trim().replace(/^```(json)?\s*/i, "").replace(/```$/, "").trim()
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.length > 0) {
      const filtered = dropAlreadyAnswered(parsed.map((q) => String(q))).slice(0, 6)
      if (filtered.length > 0) return { questions: filtered, promptUsed: prompt }
    }
  } catch (err: any) {
    logger.warn("JD question generation failed, using fallback", { error: err?.message })
  }

  return { questions: buildFallbackQuestions(job), promptUsed: prompt }
}

export function buildFallbackQuestions(job: JobContext): string[] {
  const mustHave = skillsToText(job.skills_must_have) || "the required skills"

  const questions: string[] = []

  // Must-have skill depth. Never phrased as "aapka experience kaisa hai" — that
  // reads as the total-experience question the candidate already answered on
  // WhatsApp, and dropAlreadyAnswered() discards it on sight.
  questions.push(`${mustHave} me se kaun sa aap roz kaam me use karte ho? Ek situation batao jab isne aapka kaam aasaan kiya ho.`)

  if (job.key_responsibilities?.length) {
    questions.push(`Is role me ${job.key_responsibilities[0].toLowerCase()} aana hoga — aisi koi specific task pehle kiya hai aapne?`)
  } else if (job.daily_work_summary) {
    questions.push(`Routine kaam aisa dikhega: ${job.daily_work_summary}. Aapko is type ka kaam pehle karna aata hai?`)
  }

  // Category-specific probes
  const cat = String(job.role_category || "").toLowerCase()
  if (/(driver|fleet|delivery|route|transport|line_haul|long_haul|last_mile)/.test(cat) || /(driver|fleet|delivery)/.test(job.title || "")) {
    questions.push(`Aapke paas LMV ya HMV license kaunsa hai, aur kaunse routes ya regions pe aap regular chalte ho?`)
  } else if (/(warehouse|ops|store|inventory|loader)/.test(cat)) {
    questions.push(`WMS ya kisi inventory system pe kaam kiya hai? Dispatch, inbound ya outbound kaunsa handle karte ho?`)
  } else if (/(scm|supply chain|planning|tms|forecast|operations)/.test(cat)) {
    questions.push(`Aap SAP, TMS platform, ya advanced Excel me se kaun sa use karte aaye hain? Planning ya forecasting me kya kiya hai?`)
  } else if (/(sales|bd|account manager|corporate|key account)/.test(cat)) {
    questions.push(`Client meetings aapne khud ki hain? Portfolio ya revenue scale kitna handle kiya tha aapne?`)
  }

  // Firm availability — a confirm of joining timing, never of notice period.
  questions.push(`Aap kab tak join kar sakte hain? Confirm kar dijiye taki hum next steps schedule kar sakein.`)

  return questions.slice(0, 6)
}
