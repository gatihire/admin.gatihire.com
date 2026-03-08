
import { GoogleGenerativeAI } from "@google/generative-ai"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash"

function normalize(value: any) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function parseYears(text: string) {
  const t = String(text || "")
  const match = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i)
  if (!match) return 0
  const v = Number(match[1])
  return Number.isFinite(v) ? v : 0
}

function buildFallbackSummary(candidate: any, requirements: any) {
  const matches: string[] = []
  const gaps: string[] = []

  const roleReq = normalize(requirements?.role)
  const roleCand = normalize(candidate?.currentRole)
  if (roleReq && roleCand && (roleCand.includes(roleReq) || roleReq.includes(roleCand))) {
    matches.push("role")
  } else if (roleReq) {
    gaps.push("role alignment")
  }

  const locReq = normalize(requirements?.location)
  const locCand = normalize(candidate?.location)
  if (locReq && locCand && (locCand.includes(locReq) || locReq.includes(locCand))) {
    matches.push("location")
  } else if (locReq) {
    gaps.push("location match")
  }

  const reqSkills = Array.isArray(requirements?.skills) ? requirements.skills : []
  const candSkills = Array.isArray(candidate?.technicalSkills) ? candidate.technicalSkills : []
  const reqSkillNorm = reqSkills.map(normalize).filter(Boolean)
  const candSkillNorm = new Set(candSkills.map(normalize).filter(Boolean))
  const skillHits = reqSkillNorm.filter((s: string) => candSkillNorm.has(s))
  if (skillHits.length) {
    matches.push(`${skillHits.length} skills`)
  }

  const expReq = Number(requirements?.experience?.min || 0)
  const expCand = parseYears(candidate?.totalExperience || "")
  if (expReq) {
    if (expCand >= expReq) matches.push("experience")
    else gaps.push("experience")
  }

  const matchText = matches.length ? matches.join(", ") : "overall fit"
  const gapText = gaps.length ? ` Possible gap: ${gaps[0]}.` : ""

  const roleLabel = candidate?.currentRole ? `${candidate.currentRole}` : "This candidate"
  const locLabel = candidate?.location ? ` in ${candidate.location}` : ""
  const skillLabel = candSkills.length ? ` Skills: ${candSkills.slice(0, 6).join(", ")}.` : ""

  return `${roleLabel}${locLabel} shows ${matchText} vs the requirement.${skillLabel}${gapText}`.trim()
}

export async function generateCandidateSummary(candidate: any, requirements: any): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    return buildFallbackSummary(candidate, requirements)
  }

  try {
    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL })
    
    const reqJson = JSON.stringify(requirements && typeof requirements === "object" ? requirements : {}, null, 2)
    const summary = String(candidate?.summary || candidate?.resumeText || "").trim().slice(0, 350)
    const prompt = `You are an expert recruiter.

Write a single "Why this candidate?" insight (max 45 words).

STRICT OUTPUT RULES:
- Output ONLY the insight sentence(s). No headings, no bullets, no quotes, no markdown.
- Do NOT ask for more input. Do NOT mention curly braces, JSON, or "provide requirements".

Requirements (JSON):
${reqJson}

Candidate:
- Role: ${candidate.currentRole}
- Experience: ${candidate.totalExperience}
- Location: ${candidate.location}
- Skills: ${(candidate.technicalSkills || []).slice(0, 12).join(', ')}
- Summary: ${summary}

Guidance:
- Mention 2-3 strongest matches.
- Mention 1 key gap only if it materially affects fit.`

    const result = await model.generateContent(prompt)
    const response = await result.response
    return response.text().trim()
  } catch (error) {
    console.error("Error generating candidate summary:", error)
    return buildFallbackSummary(candidate, requirements)
  }
}
