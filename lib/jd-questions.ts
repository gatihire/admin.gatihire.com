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

function collectAlreadyKnown(infoData: Record<string, unknown> | null | undefined): string {
  const data = infoData && typeof infoData === "object" ? infoData : {}
  const present = COLLECTED_FIELD_KEYS.filter((k) => {
    const v = data[k]
    return v !== undefined && v !== null && v !== ""
  })
  if (present.length === 0) return "None collected yet (WhatsApp details phase)."
  return present.map((k) => `- ${k.replace(/_/g, " ")}: ${String(data[k])}`).join("\n")
}

export async function generateJDQuestions(
  job: JobContext,
  candidate: CandidateContext,
  infoData?: Record<string, unknown> | null
): Promise<QuestionGenerationResult> {
  const jobDescription = buildJobDescription(job)
  const candidateProfile = buildCandidateProfile(candidate)
  const resumeExcerpt = candidate.resume_text ? candidate.resume_text.slice(0, 3000) : ""
  const alreadyCollected = collectAlreadyKnown(infoData)

  if (!process.env.GEMINI_API_KEY) {
    return { questions: buildFallbackQuestions(job, candidate, infoData), promptUsed: "fallback" }
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
- Do NOT repeat any of the ALREADY COLLECTED signals above (no salary/CTC, notice period, total experience, city, relocation, or switching-reason questions).
- Probe the role's must-have skills and key responsibilities: verify claimed experience with concrete examples ("tell me about a time you used X").
- Ask about firm availability / joining timing if not already implied by the collected notice period.
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
      return { questions: parsed.map((q) => String(q)).slice(0, 6), promptUsed: prompt }
    }
  } catch (err: any) {
    logger.warn("JD question generation failed, using fallback", { error: err?.message })
  }

  return { questions: buildFallbackQuestions(job, candidate, infoData), promptUsed: prompt }
}

export function buildFallbackQuestions(
  job: JobContext,
  candidate: CandidateContext,
  infoData?: Record<string, unknown> | null
): string[] {
  const mustHave = skillsToText(job.skills_must_have) || "the required skills"
  const present = new Set(
    COLLECTED_FIELD_KEYS.filter((k) => {
      const v = infoData?.[k]
      return v !== undefined && v !== null && v !== ""
    })
  )

  const questions: string[] = []

  // Must-have skill depth (never collected via WhatsApp)
  questions.push(`${mustHave} me aapka experience kaisa hai? Ek concrete example batao jab aapne iska use kiya ho.`)

  if (job.key_responsibilities?.length) {
    questions.push(`Is role me ${job.key_responsibilities[0].toLowerCase()} aana hoga — aisi koi specific task pehle kiya hai aapne?`)
  } else if (job.daily_work_summary) {
    questions.push(`Routine kaam aisa dikhega: ${job.daily_work_summary}. Aapko is type ka kaam pehle karna aata hai?`)
  }

  // Category-specific probes
  const cat = String(job.role_category || "").toLowerCase()
  if (/(driver|fleet|delivery|route|transport|line_haul|long_haul|last_mile)/.test(cat) || /(driver|fleet|delivery)/.test(job.title || "")) {
    questions.push(`Aapke paas LMV ya HMV license kaunsa hai, aur kitne saal driving experience hai?`)
  } else if (/(warehouse|ops|store|inventory|loader)/.test(cat)) {
    questions.push(`Kya aapne kisi WMS ya inventory system pe kaam kiya hai? Kitne warehouse operations ka experience hai?`)
  } else if (/(scm|supply chain|planning|tms|forecast|operations)/.test(cat)) {
    questions.push(`Aap SAP, TMS platform, ya advanced Excel kya use karte aaye hain? Planning ka experience kaisa hai?`)
  } else if (/(sales|bd|account manager|corporate|key account)/.test(cat)) {
    questions.push(`Client-facing ya account management experience kaisa hai? Revenue ya portfolio kitna handle kiya hai?`)
  }

  // Firm availability (notice may be collected, but joining timeline is a new signal)
  questions.push(`Aap kitne time me join kar sakte hain — confirm karo, taki hum next steps schedule kar sakein.`)

  // Salary consistency (verify only if expectation exists, never re-scrape)
  if (present.has("expected_ctc")) {
    questions.push(`Aapne expected CTC WhatsApp pe share kiya tha — usme variable component kaisa hai, aur kya negotiation possible hai?`)
  }

  return questions.slice(0, 6)
}
