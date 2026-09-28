import { logger } from "@/lib/logger"
import { supabaseAdmin } from "@/lib/supabase"

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
  job?: { title?: string; client_name?: string }
): Promise<FallbackSummary | null> {
  if (!transcript || transcript.trim().length < 50) {
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

    const summaryParts = [
      `Screening call for ${candidate?.name || "candidate"} for ${job?.title || "role"} at ${job?.client_name || "company"}.`,
      `Call duration: ~${Math.round(segments.length * 15 / 60)} minutes with ${segments.length} exchanges.`,
      "",
      "Key Discussion Points:",
      ...keyFindings.map(f => `• ${f}`),
      "",
      "Strengths:",
      ...strengths.map(s => `• ${s}`),
      "",
      "Areas of Concern:",
      ...concerns.map(c => `• ${c}`),
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

  const patterns = [
    { key: "current_ctc", regex: /current\s+(ctc|salary|package)[:\s]+([^\n.]+)/i },
    { key: "expected_ctc", regex: /expected\s+(ctc|salary|package)[:\s]+([^\n.]+)/i },
    { key: "notice_period", regex: /notice\s+period[:\s]+([^\n.]+)/i },
    { key: "total_experience", regex: /(\d+(\.\d+)?)\s*(years?|yrs?)\s*(experience|exp)/i },
    { key: "location", regex: /(based in|located in|living in|from)\s+([^\n.]+)/i },
    { key: "willing_to_relocate", regex: /willing\s+to\s+relocate[:\s]*(yes|no|maybe)/i },
    { key: "reason_for_switching", regex: /reason\s+(for|to)\s+(switch|change|leave)[:\s]+([^\n.]+)/i },
  ]

  for (const p of patterns) {
    const match = candidateText.match(p.regex)
    if (match) {
      info[p.key] = match[match.length - 1].trim()
    }
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

  const positiveKeywords = [
    "experience", "expert", "skilled", "proficient", "led", "managed", "achieved",
    "improved", "increased", "reduced", "delivered", "successful", "award", "certified",
    "flexible", "adaptable", "quick learner", "team player", "leadership", "mentor"
  ]

  const negativeKeywords = [
    "gap", "unemployed", "fired", "laid off", "conflict", "difficult", "stress",
    "overworked", "burnout", "no experience", "limited", "basic", "learning",
    "notice period", "long notice", "not willing", "reluctant", "salary expectation"
  ]

  for (const kw of positiveKeywords) {
    if (fullText.includes(kw)) {
      strengths.push(kw.charAt(0).toUpperCase() + kw.slice(1))
    }
  }

  for (const kw of negativeKeywords) {
    if (fullText.includes(kw)) {
      concerns.push(kw.charAt(0).toUpperCase() + kw.slice(1))
    }
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

  if (findings.includes("Work experience discussed")) score += 10
  if (findings.includes("Technical skills discussed")) score += 10
  if (findings.includes("Current compensation discussed") && findings.includes("Expected compensation discussed")) score += 10
  if (findings.includes("Notice period discussed")) score += 5
  if (strengths.length > concerns.length) score += 15
  else if (concerns.length > strengths.length) score -= 15

  if (fullText.includes("not interested") || fullText.includes("not willing")) score -= 20
  if (fullText.includes("overqualified") || fullText.includes("too senior")) score -= 10

  if (score >= 70) return "pass"
  if (score <= 35) return "fail"
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
  const { error } = await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      ai_summary: summary.comprehensive_summary,
      ai_recommendation: summary.overall_verdict,
      ai_score: Math.round(summary.confidence_score / 10) * 10,
      verdict_json: summary,
      enriched_summary: summary,
      fallback_summary_used: true,
      updated_at: now,
    })
    .eq("id", participantId)

  if (error) {
    logger.error("Failed to store fallback summary", { participantId, error: error.message })
  }
}