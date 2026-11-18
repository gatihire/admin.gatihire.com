import { logger } from "@/lib/logger"
import {
  buildTemplatePlan,
  generateInterviewPlan,
  renderLegacyQuestions,
  type InterviewPlan,
} from "@/lib/interview-plan"

/**
 * The screening questions come from a 3-topic interview plan
 * (`lib/interview-plan.ts`). This module keeps the public surface the call
 * pipeline already uses — `generateJDQuestions`, `dropAlreadyAnswered`,
 * `buildFallbackQuestions` — because the plan replaced the *content* of the call,
 * not its wiring.
 */

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

export type QuestionGenerationResult = {
  questions: string[]
  /** The structured plan. Stored on the payload and used by the scorer. */
  plan: InterviewPlan
  promptUsed: string
}

/**
 * Topics the voice call must never raise, because the candidate already gave the
 * answer on WhatsApp or the talent board. The prompt states them, and the same
 * list is applied as a hard filter below — the prompt is guidance, the filter is
 * the guarantee.
 *
 * The joining/availability rules are here because the *generator* used to be
 * told to ask them. 16% of real conversations still contained the banned
 * question after the prompt was fixed, and the remaining source was this path.
 */
const NEVER_ASK: { label: string; re: RegExp }[] = [
  { label: "phone number", re: /(phone|mobile|contact number|whatsapp number|apna number|number (daal|dijiye|share|bata)|kaun sa number)/i },
  { label: "salary / CTC", re: /(\bctc\b|salary|\bpackage\b|compensation|pay structure)/i },
  { label: "notice period", re: /(notice period|\bnotice\b)/i },
  { label: "joining / availability", re: /(kab tak join|kab join|joining (date|time)|join kar sakte|join karne)/i },
  { label: "total experience", re: /(kitne saal|years of experience|total experience|experience (kaisa|kitna|kya|hai|ho))/i },
  { label: "current city / relocation", re: /(\bcity\b|\blocation\b|relocat|shift (to|kar)|kahan reh)/i },
  { label: "reason for switching", re: /(switching ka reason|reason for (switch|leaving|changing)|kyun (badal|leave|chhod)|job (change|badal))/i },
  { label: "closed past-experience question", re: /(kya aapne kabhi|kya aap (kabhi|pehle))/i },
  { label: "comfort / capability question", re: /(comfortable (hain|ho|hai)|kar sakte hain\s*\??$)/i },
]

export function dropAlreadyAnswered(questions: string[]): string[] {
  const kept: string[] = []
  for (const q of questions) {
    const hit = NEVER_ASK.find((rule) => rule.re.test(q))
    if (hit) {
      logger.info("Dropped screening question: already collected or banned", { topic: hit.label, question: q })
      continue
    }
    kept.push(q)
  }
  return kept
}

/**
 * Build the plan, then expose its asks as the legacy numbered list. The plan
 * itself is what travels in the payload — `questions` stays for the current
 * `{questions}` placeholder and for the preview screen.
 */
export async function generateJDQuestions(
  job: JobContext,
  candidate: CandidateContext,
  infoData?: Record<string, unknown> | null
): Promise<QuestionGenerationResult> {
  const { plan, promptUsed, source, errors } = await generateInterviewPlan(job, candidate, infoData)

  if (source !== "gemini") {
    logger.info("Interview plan built without Gemini", {
      source,
      errors: errors.slice(0, 3),
      jobId: job.id,
      topics: plan.topics.length,
    })
  }

  const filtered = dropAlreadyAnswered(plan.topics.map((t) => t.ask))
  // The validator already rejected banned shapes; if the belt-and-braces filter
  // empties the list, keep the plan's own asks rather than dialling with none.
  const questions = filtered.length > 0 ? filtered : plan.topics.map((t) => t.ask)

  return { questions, plan, promptUsed }
}

/** Deterministic, always-safe questions. Used when the model is unavailable. */
export function buildFallbackQuestions(job: JobContext): string[] {
  return renderLegacyQuestions(buildTemplatePlan(job))
    .split("\n")
    .map((q) => q.replace(/^\d+\.\s*/, ""))
    .filter(Boolean)
}
