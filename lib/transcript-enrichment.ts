import { GoogleGenerativeAI } from "@google/generative-ai"
import { logger } from "@/lib/logger"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"

export interface EnrichedSummary {
  comprehensive_summary: string
  fit_assessment: string
  strengths: string[]
  concerns: string[]
  salary_analysis: {
    current: string
    expected: string
    risk: string
    notes: string
  }
  relocation_assessment: string
  recommended_next_steps: string
  interview_focus_areas: string[]
  overall_verdict: "strong_fit" | "good_fit" | "possible_fit" | "not_fit"
  confidence_score: number
}

function buildCandidateBlock(candidate: any): string {
  return [
    `- Name: ${candidate.name || "Not specified"}`,
    `- Role: ${candidate.current_role || "Not specified"}`,
    `- Company: ${candidate.current_company || "Not specified"}`,
    `- Experience: ${candidate.total_experience || "Not specified"} years`,
    `- Location: ${candidate.location || "Not specified"}`,
    `- Skills: ${(Array.isArray(candidate.technical_skills) ? candidate.technical_skills : []).join(", ") || "Not specified"}`,
    `- Resume: ${String(candidate.resume_text || "").slice(0, 800) || "Not provided"}`,
  ].join("\n")
}

function buildJobBlock(job: any): string {
  return [
    `- Title: ${job.title || "Not specified"}`,
    `- Company: ${job.client_name || "Not specified"}`,
    `- Location: ${job.city || job.location || "Not specified"}`,
    `- Experience: ${job.experience_min_years ?? "?"}–${job.experience_max_years ?? "?"} years`,
    `- Salary: ${job.salary_min || "?"}–${job.salary_max || "?"} ${job.salary_type || "monthly"}`,
    `- Must-have skills: ${(Array.isArray(job.skills_must_have) ? job.skills_must_have : []).join(", ") || "Not specified"}`,
    `- Good-to-have: ${(Array.isArray(job.skills_good_to_have) ? job.skills_good_to_have : []).join(", ") || "Not specified"}`,
    `- Description: ${String(job.description || "").slice(0, 600) || "Not provided"}`,
  ].join("\n")
}

function parseTranscriptForQA(transcript: string): string {
  const lines = transcript.split("\n").filter((l) => l.trim())
  const qa: string[] = []
  for (const line of lines) {
    const assistantMatch = line.match(/^assistant:\s*(.*)$/i)
    const userMatch = line.match(/^user:\s*(.*)$/i)
    if (assistantMatch) {
      qa.push(`AI: ${assistantMatch[1].trim()}`)
    } else if (userMatch) {
      qa.push(`Candidate: ${userMatch[1].trim()}`)
    }
  }
  return qa.join("\n")
}

export async function enrichTranscript(
  transcript: string,
  candidate: any,
  job: any,
  bolnaVerdict: Record<string, unknown> | null
): Promise<EnrichedSummary | null> {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn("GEMINI_API_KEY not set, skipping transcript enrichment")
    return null
  }
  if (!transcript || transcript.length < 50) {
    logger.warn("Transcript too short for enrichment")
    return null
  }

  try {
    const model = genAI.getGenerativeModel({ model: MODEL })
    const qaTranscript = parseTranscriptForQA(transcript)
    const candidateBlock = buildCandidateBlock(candidate)
    const jobBlock = buildJobBlock(job)

    const verdictBlock = bolnaVerdict
      ? `\nBolna's initial verdict:\n${JSON.stringify(bolnaVerdict, null, 2)}`
      : ""

    const prompt = `You are a senior HR analyst reviewing an AI screening call transcript. Analyze the conversation and candidate profile against the job requirements.

Provide a detailed, actionable assessment.

Return ONLY a JSON object (no markdown, no commentary) with exactly this structure:
{
  "comprehensive_summary": "3-5 sentence summary of the call covering what was discussed, candidate's key responses, and overall impression",
  "fit_assessment": "Detailed paragraph on how well the candidate fits this specific role, referencing specific skills and experience from the transcript",
  "strengths": ["strength 1 backed by transcript evidence", "strength 2", "..."],
  "concerns": ["concern 1 with specific transcript reference", "concern 2", "..."],
  "salary_analysis": {
    "current": "what candidate stated as current salary",
    "expected": "what candidate stated as expected salary",
    "risk": "none/low/medium/high with explanation",
    "notes": "any red flags or observations about salary discussion"
  },
  "relocation_assessment": "Candidate's willingness to relocate/commute, as stated in the call",
  "recommended_next_steps": "Specific next action: advance to interview / schedule callback / reject, with reasoning",
  "interview_focus_areas": ["area 1 the next interviewer should probe deeper", "area 2", "..."],
  "overall_verdict": "strong_fit/good_fit/possible_fit/not_fit",
  "confidence_score": 0.85
}

RULES:
- Base EVERY claim on what was actually said in the transcript. Do not infer or fabricate.
- If the candidate declined to answer something, note it as "declined to share" not a guess.
- If the call was very short (under 60s), note that the assessment has limited confidence.
- Score: strong_fit (8-10), good_fit (6-7), possible_fit (4-5), not_fit (0-3).

Job:
${jobBlock}

Candidate:
${candidateBlock}

Call Transcript:
${qaTranscript}
${verdictBlock}

JSON:`

    const result = await model.generateContent(prompt)
    const text = result.response.text()

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger.warn("Gemini did not return valid JSON for transcript enrichment")
      return null
    }

    const parsed = JSON.parse(jsonMatch[0]) as EnrichedSummary
    return parsed
  } catch (err: any) {
    logger.error("Transcript enrichment failed", { error: err.message })
    return null
  }
}
