// Step 3 — AI CV-vs-JD fit analysis (Gemini).
// Produces a 0-100 fit score plus recruiter-facing pros / misses / interview
// probes. Results are cached in candidate_job_fit per (job, candidate).

import { GoogleGenerativeAI } from "@google/generative-ai"
import { supabaseAdmin } from "@/lib/supabase"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"

export interface FitResult {
  fit_score: number
  pros: string[]
  misses: string[]
  interview_probes: string[]
  summary: string
}

// Jobs can carry a long keyword dump as must-haves (30+ entries); judging a
// human against all of them makes every verdict "risky". Score against the
// top 10 real requirements instead.
const topMustHave = (job: any): string[] =>
  Array.isArray(job?.skills_must_have) ? job.skills_must_have.map(String).filter(Boolean).slice(0, 10) : []

export function fallbackFit(candidate: any, job: any): FitResult {
  const skills: string[] = Array.isArray(candidate.technical_skills)
    ? (candidate.technical_skills as string[]).map(String)
    : []

  const mustHave: string[] = topMustHave(job)

  const matched = mustHave.filter((s) => skills.some((k) => k.toLowerCase().includes(s.toLowerCase())))
  const score = mustHave.length === 0 ? 60 : Math.min(95, Math.round((matched.length / mustHave.length) * 90) + 5)

  return {
    fit_score: score,
    pros: matched.length
      ? [`Matches ${matched.length} of ${mustHave.length} must-have skills (${matched.slice(0, 5).join(", ")})`]
      : ["Requires manual review — limited skill overlap detected"],
    misses: mustHave.length > matched.length ? [`Missing ${mustHave.length - matched.length} must-have skill(s)`] : [],
    interview_probes: [
      `Verify hands-on experience with ${mustHave.slice(0, 3).join(", ") || "the core role responsibilities"}`,
      "Confirm availability, notice period and expected salary",
    ],
    summary: `Roughly ${score}/100 fit — ${matched.length}/${mustHave.length} must-have skills matched.`,
  }
}

function extractJson(text: string): FitResult | null {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = block ? block[1] : text
  try {
    const parsed = JSON.parse(candidate)
    if (typeof parsed?.fit_score !== "number") return null
    return {
      fit_score: Math.max(0, Math.min(100, Math.round(parsed.fit_score))),
      pros: Array.isArray(parsed.pros) ? parsed.pros.slice(0, 6).map(String) : [],
      misses: Array.isArray(parsed.misses) ? parsed.misses.slice(0, 6).map(String) : [],
      interview_probes: Array.isArray(parsed.interview_probes) ? parsed.interview_probes.slice(0, 6).map(String) : [],
      summary: String(parsed.summary || "").slice(0, 240),
    }
  } catch {
    return null
  }
}

export async function analyzeFit(candidate: any, job: any): Promise<FitResult> {
  if (!process.env.GEMINI_API_KEY) return fallbackFit(candidate, job)

  try {
    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL })

    const candidateText = [
      `- Role: ${candidate.current_role || "Not specified"}`,
      `- Company: ${candidate.current_company || "Not specified"}`,
      `- Experience: ${candidate.total_experience || "Not specified"}`,
      `- Location: ${candidate.location || "Not specified"}`,
      `- Skills: ${(Array.isArray(candidate.technical_skills) ? candidate.technical_skills : []).slice(0, 20).join(", ") || "Not specified"}`,
      `- Summary: ${String(candidate.resume_text || candidate.summary || "").slice(0, 400) || "Not provided"}`,
    ].join("\n")

    const jobText = [
      `- Title: ${job.title || "Not specified"}`,
      `- Industry: ${job.industry || job.client_name || "Not specified"}`,
      `- City: ${job.city || "Not specified"}`,
      `- Experience: ${job.experience_min_years ?? ""}–${job.experience_max_years ?? ""} years`,
      `- Must-have (score against these only): ${topMustHave(job).join(", ") || "Not specified"}`,
      `- Good-to-have: ${(Array.isArray(job.skills_good_to_have) ? job.skills_good_to_have : []).slice(0, 10).join(", ") || "Not specified"}`,
      `- Responsibilities: ${String(job.daily_work_summary || "").slice(0, 300) || (Array.isArray(job.key_responsibilities) ? job.key_responsibilities.slice(0, 3).join(". ") : "")}`,
    ].join("\n")

    const prompt = `You are a senior recruiter scoring a candidate against a job description.

Return ONLY a JSON object (no markdown, no commentary) with exactly:
{
  "fit_score": <integer 0-100>,
  "pros": ["<3-5 strongest matches, concrete>"],
  "misses": ["<0-4 gaps or concerns, concrete>"],
  "interview_probes": ["<2-4 questions the AI interviewer must verify on the call>"],
  "summary": "<one line verdict, max 40 words>"
}

Job:
${jobText}

Candidate:
${candidateText}

Guidance:
- Judge fit against the "Must-have" list above (it is the prioritized top 10), not an exhaustive checklist.
- Score based on must-have skills, relevant experience, and location fit.
- Pros/misses must be specific to this candidate and job (no placeholders).
- Interview probes must be answerable on a voice call in plain language.`

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const parsed = extractJson(text)
    return parsed || fallbackFit(candidate, job)
  } catch (error: any) {
    return fallbackFit(candidate, job)
  }
}

export async function getOrAnalyzeFit(
  jobId: string,
  candidateId: string,
  candidate: any,
  job: any
): Promise<FitResult> {
  const { data: cached } = await supabaseAdmin
    .from("candidate_job_fit")
    .select("fit_score, fit_json, summary")
    .eq("job_id", jobId)
    .eq("candidate_id", candidateId)
    .maybeSingle()

  if (cached?.fit_json) {
    const parsed = cached.fit_json as FitResult
    return {
      fit_score: cached.fit_score ?? parsed.fit_score,
      pros: parsed.pros || [],
      misses: parsed.misses || [],
      interview_probes: parsed.interview_probes || [],
      summary: cached.summary || parsed.summary || "",
    }
  }

  const fit = await analyzeFit(candidate, job)
  await supabaseAdmin.from("candidate_job_fit").upsert(
    {
      job_id: jobId,
      candidate_id: candidateId,
      fit_score: fit.fit_score,
      fit_json: fit,
      summary: fit.summary,
      analyzed_at: new Date().toISOString(),
    },
    { onConflict: "job_id,candidate_id" }
  )
  return fit
}
