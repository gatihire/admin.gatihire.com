import { GoogleGenerativeAI } from "@google/generative-ai"
import { logger } from "@/lib/logger"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"

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

export async function generateJDQuestions(
  job: JobContext,
  candidate: CandidateContext
): Promise<string[]> {
  const jobDescription = buildJobDescription(job)
  const candidateProfile = buildCandidateProfile(candidate)
  const resumeExcerpt = candidate.resume_text ? candidate.resume_text.slice(0, 3000) : ""

  if (!process.env.GEMINI_API_KEY) {
    return buildFallbackQuestions(job, candidate)
  }

  try {
    const model = genAI.getGenerativeModel({ model: MODEL })
    const prompt = `You are a recruiter preparing a first-round phone screening for a candidate. Generate exactly 5 to 8 highly specific, job-relevant screening questions that probe the candidate's fit for the role.

JOB DESCRIPTION:
${jobDescription || "(no job description available)"}

CANDIDATE PROFILE (from resume / database):
${candidateProfile || "(no candidate profile available)"}

${resumeExcerpt ? `RESUME EXCERPT:\n${resumeExcerpt}` : ""}

Requirements for the questions:
- Each question must be specific to the role's must-have skills and responsibilities above, not generic.
- Verify claimed experience against the required range; probe skill depth with concrete examples ("tell me about a time you used X").
- Include a question about current salary and expected salary.
- Include a question about notice period / availability.
- Include a question about willingness to relocate or commute if the job location differs from the candidate's location.
- Do NOT repeat the candidate's own resume back to them.
- Questions must be phrased for a natural voice conversation, one at a time.

Return ONLY a JSON array of strings, e.g. ["Question 1", "Question 2"]. No markdown, no code fences, no extra text.`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim().replace(/^```(json)?\s*/i, "").replace(/```$/, "").trim()
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((q) => String(q)).slice(0, 8)
    }
  } catch (err: any) {
    logger.warn("JD question generation failed, using fallback", { error: err?.message })
  }

  return buildFallbackQuestions(job, candidate)
}

export function buildFallbackQuestions(
  job: JobContext,
  candidate: CandidateContext
): string[] {
  const mustHave = skillsToText(job.skills_must_have) || "the required skills"
  const expRange =
    job.experience_min_years != null || job.experience_max_years != null
      ? `${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"} years`
      : "the required range"

  const questions: string[] = [
    `Can you walk me through your current role and what you do on a daily basis?`,
    `How many years of experience do you have overall?`,
    `Can you tell me about your experience with ${mustHave}? Could you give me a specific example of a time you used it?`,
    `How does your experience of ${expRange} compare to what this role requires?`,
  ]

  if (job.city && candidate.location && job.city.toLowerCase() !== candidate.location.toLowerCase()) {
    questions.push(`The role is based in ${job.city} and I see you are in ${candidate.location}. Would you be willing to relocate or commute for this role?`)
  }

  questions.push(
    `What is your current monthly and annual salary, including any variable component?`,
    `What is your expected salary for this role?`,
    `What is your notice period, and how soon could you join if selected?`
  )

  return questions.slice(0, 8)
}
