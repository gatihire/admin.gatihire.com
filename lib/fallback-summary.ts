import { logger } from "@/lib/logger"
import { updateParticipantSafely } from "@/lib/participant-update"
import { bandFromVerdict, scoreFromVerdict } from "@/lib/call-scoring"

export interface FallbackSummary {
  comprehensive_summary: string
  overall_verdict: "pass" | "fail" | "review"
  confidence_score: number
  key_findings: string[]
  strengths: string[]
  concerns: string[]
  candidate_info: Record<string, unknown>
}

/**
 * Generate a fallback summary from raw transcript when Bolna doesn't provide
 * a structured verdict. Uses simple heuristics and keyword extraction.
 */
export async function generateFallbackSummary(
  participantId: string,
  transcript: string,
  candidate?: { name?: string; phone?: string; current_role?: string },
  job?: { title?: string; client_name?: string },
  /** Real call length from the provider. The old estimate multiplied transcript
   *  lines by 15s; a 217s call was reported as "~11 minutes". */
  durationSeconds?: number | null
): Promise<FallbackSummary | null> {
  if (!transcript || transcript.trim().length < 30) {
    return null
  }

  try {
    const segments = parseTranscriptSegments(transcript)
    const candidateText = segments.filter(s => s.speaker === "candidate").map(s => s.text).join(" ")
    const aiText = segments.filter(s => s.speaker === "ai").map(s => s.text).join(" ")
    const fullText = `${candidateText} ${aiText}`.toLowerCase()

    const candidateInfo = extractCandidateInfo(candidateText, candidate)
    const keyFindings = extractKeyFindings(candidateText, fullText)
    const { strengths, concerns } = analyzeStrengthsConcerns(fullText, keyFindings)

    const overallVerdict = determineVerdict(fullText, keyFindings, strengths, concerns)
    const confidenceScore = calculateConfidence(fullText, keyFindings, segments.length)

    const durationLabel =
      typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
        ? `${Math.max(1, Math.round(durationSeconds / 60))} minutes (${Math.round(durationSeconds)}s)`
        : `${Math.max(1, Math.round(segments.length * 15 / 60))} minutes`

    const summaryParts = [
      `Screening call for ${candidate?.name || "candidate"} for ${job?.title || "role"} at ${job?.client_name || "company"}.`,
      `Call duration: ~${durationLabel} with ${segments.length} exchanges.`,
      "",
      "Key Discussion Points:",
      ...keyFindings.map(f => `• ${f}`),
      "",
      "Strengths:",
      ...(strengths.length ? strengths.map(s => `• ${s}`) : ["• None established on this call."]),
      "",
      "Areas of Concern:",
      ...(concerns.length ? concerns.map(c => `• ${c}`) : ["• None recorded."]),
      "",
      `Overall Assessment: ${overallVerdict.toUpperCase()} (confidence: ${confidenceScore}%)`,
    ]

    return {
      comprehensive_summary: summaryParts.join("\n"),
      overall_verdict: overallVerdict,
      confidence_score: confidenceScore,
      key_findings: keyFindings,
      strengths,
      concerns,
      candidate_info: candidateInfo,
    }
  } catch (err: any) {
    logger.error("Fallback summary generation failed", { participantId, error: err.message })
    return null
  }
}

function parseTranscriptSegments(transcript: string): { speaker: "ai" | "candidate"; text: string }[] {
  const segments: { speaker: "ai" | "candidate"; text: string }[] = []
  const aiPatterns = /^(assistant|ai|agent|bot|system|hiring manager|recruiter):\s*(.*)$/i
  const candidatePatterns = /^(user|candidate|human|applicant|interviewee|respondent):\s*(.*)$/i

  for (const rawLine of transcript.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue

    const aiMatch = line.match(aiPatterns)
    const candidateMatch = line.match(candidatePatterns)

    if (aiMatch) {
      if (aiMatch[2].trim()) segments.push({ speaker: "ai", text: aiMatch[2].trim() })
    } else if (candidateMatch) {
      if (candidateMatch[2].trim()) segments.push({ speaker: "candidate", text: candidateMatch[2].trim() })
    } else {
      const last = segments[segments.length - 1]
      if (last) last.text = `${last.text} ${line}`
    }
  }

  if (segments.length === 0 && transcript.trim()) {
    segments.push({ speaker: "ai", text: transcript.trim() })
  }

  return segments
}

function extractCandidateInfo(candidateText: string, candidate?: { name?: string; phone?: string; current_role?: string }): Record<string, unknown> {
  const info: Record<string, unknown> = {}
  if (candidate?.name) info.name = candidate.name
  if (candidate?.current_role) info.current_role = candidate.current_role

  // Every capture is bounded and stripped at punctuation. The old location rule
  // triggered on the bare word "from" and captured the rest of the answer —
  // one call stored "every icd possible आरव किस दिन हुआ था we win certain sports…"
  // as the candidate's location.
  // Location is deliberately not extracted here. The candidate profile already
  // has it, and guessing it from a code-switched transcript produced
  // "every icd possible आरव किस दिन हुआ था…" as a city name. A fallback must not
  // invent a fact the profile already owns.
  const patterns = [
    { key: "current_ctc", regex: /current\s+(ctc|salary|package)[:\s]+([^\n.,;]{1,40})/i },
    { key: "expected_ctc", regex: /expected\s+(ctc|salary|package)[:\s]+([^\n.,;]{1,40})/i },
    { key: "notice_period", regex: /notice\s+period[:\s]+([^\n.,;]{1,40})/i },
    { key: "total_experience", regex: /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\s*(?:of\s+)?(?:experience|exp)\b/i },
    { key: "willing_to_relocate", regex: /willing\s+to\s+relocate[:\s]*(yes|no|maybe)/i },
    { key: "reason_for_switching", regex: /reason\s+(?:for|to)\s+(?:switch|change|leave)[:\s]+([^\n.,;]{1,60})/i },
  ]

  const clean = (value: string): string | null => {
    const trimmed = value.replace(/\s+/g, " ").trim()
    // Reject transcript noise: a location or reason is a short noun phrase, not
    // a sentence, and never contains an interrogative.
    if (!trimmed || trimmed.split(/\s+/).length > 8 || /\?/.test(trimmed)) return null
    return trimmed
  }

  for (const p of patterns) {
    const match = candidateText.match(p.regex)
    if (!match) continue
    const value = clean(match[match.length - 1] || "")
    if (value) info[p.key] = value
  }

  return info
}

function extractKeyFindings(candidateText: string, fullText: string): string[] {
  const findings: string[] = []

  const topics = [
    { keyword: "current_ctc", label: "Current compensation discussed" },
    { keyword: "expected_ctc", label: "Expected compensation discussed" },
    { keyword: "notice_period", label: "Notice period discussed" },
    { keyword: "experience", label: "Work experience discussed" },
    { keyword: "skill", label: "Technical skills discussed" },
    { keyword: "relocat", label: "Relocation willingness discussed" },
    { keyword: "switch", label: "Reason for switching discussed" },
    { keyword: "project", label: "Project experience discussed" },
    { keyword: "challenge", label: "Challenges faced discussed" },
    { keyword: "achieve", label: "Achievements mentioned" },
  ]

  for (const t of topics) {
    if (fullText.includes(t.keyword)) {
      findings.push(t.label)
    }
  }

  return findings.slice(0, 8)
}

function analyzeStrengthsConcerns(fullText: string, _findings: string[]): { strengths: string[]; concerns: string[] } {
  const strengths: string[] = []
  const concerns: string[] = []

  // Word-boundary matching, not `includes`. The old check matched "led" inside
  // "ledger", so a 217s AP call whose only "strength" was the word "ledger"
  // produced the bullet "• Led". An empty list is honest; a fabricated one is not.
  const positive: { phrase: string; label: string }[] = [
    { phrase: "experience", label: "Work experience discussed" },
    { phrase: "expert", label: "Described themselves as an expert" },
    { phrase: "skilled", label: "Described a specific skill" },
    { phrase: "proficient", label: "Described proficiency with a tool" },
    { phrase: "led", label: "Led a team or process" },
    { phrase: "managed", label: "Managed a team or process" },
    { phrase: "achieved", label: "Stated an achieved outcome" },
    { phrase: "improved", label: "Improved a metric" },
    { phrase: "increased", label: "Increased a metric" },
    { phrase: "reduced", label: "Reduced a metric" },
    { phrase: "delivered", label: "Delivered a stated outcome" },
    { phrase: "successful", label: "Described a successful outcome" },
    { phrase: "award", label: "Mentioned an award" },
    { phrase: "certified", label: "Mentioned a certification" },
    { phrase: "flexible", label: "Said they are flexible" },
    { phrase: "adaptable", label: "Said they are adaptable" },
    { phrase: "quick learner", label: "Said they learn quickly" },
    { phrase: "team player", label: "Said they are a team player" },
    { phrase: "leadership", label: "Mentioned leadership" },
    { phrase: "mentor", label: "Mentioned mentoring" },
  ]

  const negative: { phrase: string; label: string }[] = [
    { phrase: "gap", label: "Mentioned an employment gap" },
    { phrase: "unemployed", label: "Currently unemployed" },
    { phrase: "fired", label: "Was fired" },
    { phrase: "laid off", label: "Was laid off" },
    { phrase: "conflict", label: "Mentioned a conflict" },
    { phrase: "difficult", label: "Described a difficulty" },
    { phrase: "stress", label: "Mentioned stress" },
    { phrase: "overworked", label: "Mentioned being overworked" },
    { phrase: "burnout", label: "Mentioned burnout" },
    { phrase: "no experience", label: "Said they had no experience" },
    { phrase: "limited", label: "Described limited experience" },
    { phrase: "basic", label: "Described basic-level skills" },
    { phrase: "learning", label: "Said they are still learning" },
    { phrase: "long notice", label: "Long notice period" },
    { phrase: "not willing", label: "Not willing to proceed" },
    { phrase: "reluctant", label: "Was reluctant" },
    { phrase: "salary expectation", label: "Salary expectation was raised" },
  ]

  const has = (phrase: string) =>
    new RegExp(`(^|[^a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(fullText)

  for (const { phrase, label } of positive) {
    if (has(phrase)) strengths.push(label)
  }

  for (const { phrase, label } of negative) {
    if (has(phrase)) concerns.push(label)
  }

  return {
    strengths: [...new Set(strengths)].slice(0, 5),
    concerns: [...new Set(concerns)].slice(0, 5),
  }
}

function determineVerdict(
  fullText: string,
  findings: string[],
  strengths: string[],
  concerns: string[]
): "pass" | "fail" | "review" {
  let score = 50

  // Penalize very short conversations
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length
  if (wordCount < 30) score -= 50
  else if (wordCount < 50) score -= 40
  else if (wordCount < 100) score -= 20

  if (findings.includes("Work experience discussed")) score += 10
  if (findings.includes("Technical skills discussed")) score += 10
  if (findings.includes("Current compensation discussed") && findings.includes("Expected compensation discussed")) score += 10
  if (findings.includes("Notice period discussed")) score += 5
  if (strengths.length > concerns.length) score += 15
  else if (concerns.length > strengths.length) score -= 15

  if (fullText.includes("not interested") || fullText.includes("not willing")) score -= 20
  if (fullText.includes("overqualified") || fullText.includes("too senior")) score -= 10

  if (score >= 70) return "pass"
  if (score <= 25) return "fail"
  return "review"
}

function calculateConfidence(fullText: string, findings: string[], segmentCount: number): number {
  let confidence = 30

  confidence += Math.min(findings.length * 5, 25)
  confidence += Math.min(segmentCount * 2, 20)
  confidence += fullText.length > 500 ? 15 : 0
  confidence += fullText.length > 2000 ? 10 : 0

  return Math.min(confidence, 95)
}

/**
 * Store the fallback summary in the participant record
 */
export async function storeFallbackSummary(
  participantId: string,
  summary: FallbackSummary
): Promise<void> {
  const now = new Date().toISOString()
  // The column has a CHECK constraint: ai_recommendation IN
  // ('advance','further_review','not_a_fit') — translate the internal wording.
  // Verdict → (score, band) from the one shared table: pass 8/advance,
  // review 6/further_review, fail 2/not_a_fit.
  const recommendation = bandFromVerdict(String(summary.overall_verdict)) ?? "further_review"
  const score = scoreFromVerdict(String(summary.overall_verdict)) ?? 6
  // `fallback_summary_used` lives inside verdict_json: there is no such column,
  // and writing it top-level made PostgREST reject the entire update
  // (PGRST204), silently dropping the summary. The safe writer also strips any
  // future unknown column instead of losing the whole patch.
  await updateParticipantSafely(
    participantId,
    {
      ai_summary: summary.comprehensive_summary,
      ai_recommendation: recommendation,
      ai_score: score,
      verdict_json: { ...(summary as any), _fallback_summary_used: true },
      enriched_summary: summary,
      updated_at: now,
    },
    { source: "storeFallbackSummary" }
  )
}
