import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')
const PRE_SCREEN_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview'

function getGeminiModel() {
  return genAI.getGenerativeModel({ model: PRE_SCREEN_MODEL })
}

export interface CandidateInfo {
  currentCtcLpa?: number
  expectedCtcLpa?: number
  totalExperienceYears?: number
  noticePeriodDays?: number
  preferredCity?: string
  willingToRelocate?: boolean
  switchingReason?: string
}

export interface JobRequirements {
  salaryMinLpa?: number
  salaryMaxLpa?: number
  experienceMinYears?: number
  experienceMaxYears?: number
  city?: string
  location?: string
  title?: string
}

export interface PreScreenConfig {
  salaryTolerancePercent: number
  experienceMinPercent: number
  experienceMaxPercent: number
  maxNoticePeriodDays: number
}

export type PreScreenDecision = "proceed" | "needs_review" | "filtered_out"

export interface PreScreenResult {
  decision: PreScreenDecision
  reasons: string[]
  salaryFit?: { match: boolean; details: string }
  experienceFit?: { match: boolean; details: string }
  locationFit?: { match: boolean; details: string }
  noticeFit?: { match: boolean; details: string }
  summary: string
}

const DEFAULT_CONFIG: PreScreenConfig = {
  salaryTolerancePercent: 40,
  experienceMinPercent: 50,
  experienceMaxPercent: 200,
  maxNoticePeriodDays: 120,
}

function parseLpa(value: string | undefined): number | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/[^0-9.]/g, "")
  const num = parseFloat(cleaned)
  return isNaN(num) ? undefined : num
}

function parseYears(value: string | undefined): number | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/[^0-9.]/g, "")
  const num = parseFloat(cleaned)
  return isNaN(num) ? undefined : num
}

function parseDays(value: string | undefined): number | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/[^0-9]/g, "")
  const num = parseInt(cleaned, 10)
  return isNaN(num) ? undefined : num
}

function normalizeCity(city: string): string {
  return city
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z]/g, "")
}

function citiesMatch(city1: string, city2: string): boolean {
  const c1 = normalizeCity(city1)
  const c2 = normalizeCity(city2)
  if (c1 === c2) return true
  
  const metroAliases: Record<string, string[]> = {
    bangalore: ["bangalore", "bengaluru", "blr"],
    mumbai: ["mumbai", "bombay", "bom"],
    delhi: ["delhi", "newdelhi", "ncr", "gurgaon", "gurugram", "noida", "faridabad", "ghaziabad"],
    hyderabad: ["hyderabad", "hyd", "secunderabad"],
    chennai: ["chennai", "madras", "maa"],
    pune: ["pune", "poona"],
    kolkata: ["kolkata", "calcutta", "ccu"],
    ahmedabad: ["ahmedabad", "amdavad"],
  }
  
  for (const [canonical, aliases] of Object.entries(metroAliases)) {
    if (aliases.includes(c1) && aliases.includes(c2)) return true
  }
  return false
}

function evaluateSalaryFit(
  candidate: CandidateInfo,
  job: JobRequirements,
  config: PreScreenConfig
): { match: boolean; details: string } {
  const expected = candidate.expectedCtcLpa
  const min = job.salaryMinLpa
  const max = job.salaryMaxLpa

  if (!expected || !min || !max) {
    return { match: true, details: "Salary data incomplete - skipping check" }
  }

  const tolerance = config.salaryTolerancePercent / 100
  const acceptableMin = min * (1 - tolerance)
  const acceptableMax = max * (1 + tolerance)

  const match = expected >= acceptableMin && expected <= acceptableMax
  return {
    match,
    details: `Expected: ${expected} LPA, Job range: ${min}-${max} LPA, Acceptable range: ${acceptableMin.toFixed(1)}-${acceptableMax.toFixed(1)} LPA`,
  }
}

function evaluateExperienceFit(
  candidate: CandidateInfo,
  job: JobRequirements,
  config: PreScreenConfig
): { match: boolean; details: string } {
  const exp = candidate.totalExperienceYears
  const min = job.experienceMinYears
  const max = job.experienceMaxYears

  if (!exp || !min || !max) {
    return { match: true, details: "Experience data incomplete - skipping check" }
  }

  const minAcceptable = min * (config.experienceMinPercent / 100)
  const maxAcceptable = max * (config.experienceMaxPercent / 100)

  const match = exp >= minAcceptable && exp <= maxAcceptable
  return {
    match,
    details: `Candidate: ${exp} yrs, Job range: ${min}-${max} yrs, Acceptable: ${minAcceptable}-${maxAcceptable} yrs`,
  }
}

function evaluateLocationFit(
  candidate: CandidateInfo,
  job: JobRequirements
): { match: boolean; details: string } {
  const candidateCity = candidate.preferredCity
  const jobCity = job.city || job.location
  const willingToRelocate = candidate.willingToRelocate

  if (!candidateCity || !jobCity) {
    return { match: true, details: "Location data incomplete - skipping check" }
  }

  const cityMatch = citiesMatch(candidateCity, jobCity)
  const match = cityMatch || willingToRelocate === true
  
  let details = `Candidate: ${candidateCity}, Job: ${jobCity}`
  if (cityMatch) details += " - City match"
  else if (willingToRelocate) details += " - Willing to relocate"
  else details += " - Location mismatch, not willing to relocate"

  return { match, details }
}

function evaluateNoticeFit(
  candidate: CandidateInfo,
  config: PreScreenConfig
): { match: boolean; details: string } {
  const notice = candidate.noticePeriodDays
  const maxAllowed = config.maxNoticePeriodDays

  if (!notice) {
    return { match: true, details: "Notice period not provided - skipping check" }
  }

  const match = notice <= maxAllowed
  return {
    match,
    details: `Notice: ${notice} days, Max allowed: ${maxAllowed} days`,
  }
}

export function evaluatePreScreen(
  candidate: CandidateInfo,
  job: JobRequirements,
  config: PreScreenConfig = DEFAULT_CONFIG
): PreScreenResult {
  const reasons: string[] = []

  const salaryFit = evaluateSalaryFit(candidate, job, config)
  const experienceFit = evaluateExperienceFit(candidate, job, config)
  const locationFit = evaluateLocationFit(candidate, job)
  const noticeFit = evaluateNoticeFit(candidate, config)

  if (!salaryFit.match) reasons.push(`Salary: ${salaryFit.details}`)
  if (!experienceFit.match) reasons.push(`Experience: ${experienceFit.details}`)
  if (!locationFit.match) reasons.push(`Location: ${locationFit.details}`)
  if (!noticeFit.match) reasons.push(`Notice: ${noticeFit.details}`)

  const hardFilters = [salaryFit, experienceFit, locationFit, noticeFit].filter((f) => !f.match)
  const hardFilterCount = hardFilters.length

  let decision: PreScreenDecision
  if (hardFilterCount === 0) {
    decision = "proceed"
  } else if (hardFilterCount <= 2 && (salaryFit.match || experienceFit.match || locationFit.match)) {
    decision = "needs_review"
  } else {
    decision = "filtered_out"
  }

  let summary = ""
  switch (decision) {
    case "proceed":
      summary = "Candidate passes all pre-screen checks. Ready for AI call."
      break
    case "needs_review":
      summary = `Candidate has ${hardFilterCount} concern(s): ${reasons.join("; ")}. HR review recommended.`
      break
    case "filtered_out":
      summary = `Candidate fails ${hardFilterCount} critical check(s): ${reasons.join("; ")}. Not suitable for this role.`
      break
  }

  return {
    decision,
    reasons,
    salaryFit,
    experienceFit,
    locationFit,
    noticeFit,
    summary,
  }
}

export async function evaluatePreScreenWithAI(
  candidate: CandidateInfo,
  job: JobRequirements,
  config: PreScreenConfig = DEFAULT_CONFIG
): Promise<PreScreenResult> {
  const ruleResult = evaluatePreScreen(candidate, job, config)

  if (ruleResult.decision === "proceed" || ruleResult.decision === "filtered_out") {
    return ruleResult
  }

  try {
    const model = getGeminiModel()
    const prompt = `You are an HR pre-screening evaluator. A candidate has some concerns but may still be worth interviewing.

Candidate Info:
- Current CTC: ${candidate.currentCtcLpa ? candidate.currentCtcLpa + " LPA" : "Not provided"}
- Expected CTC: ${candidate.expectedCtcLpa ? candidate.expectedCtcLpa + " LPA" : "Not provided"}
- Total Experience: ${candidate.totalExperienceYears ? candidate.totalExperienceYears + " years" : "Not provided"}
- Notice Period: ${candidate.noticePeriodDays ? candidate.noticePeriodDays + " days" : "Not provided"}
- Preferred City: ${candidate.preferredCity || "Not provided"}
- Willing to Relocate: ${candidate.willingToRelocate ? "Yes" : "No/Not provided"}
- Switching Reason: ${candidate.switchingReason || "Not provided"}

Job Requirements:
- Title: ${job.title || "Not provided"}
- Salary Range: ${job.salaryMinLpa ? job.salaryMinLpa + " LPA" : "?"} - ${job.salaryMaxLpa ? job.salaryMaxLpa + " LPA" : "?"}
- Experience Range: ${job.experienceMinYears ? job.experienceMinYears + " yrs" : "?"} - ${job.experienceMaxYears ? job.experienceMaxYears + " yrs" : "?"}
- Location: ${job.city || job.location || "Not provided"}

Rule-based evaluation flagged these concerns:
${ruleResult.reasons.map((r) => `- ${r}`).join("\n")}

Consider:
1. Is the expected salary negotiable? (Candidate may accept lower for right role)
2. Is the experience gap acceptable? (e.g., 4 yrs vs 5 yrs min is often fine)
3. Is relocation genuinely possible? (Candidate said yes but is it realistic?)
4. Is notice period manageable? (Buyout options, garden leave, etc.)

Return JSON only:
{
  "decision": "proceed" | "needs_review" | "filtered_out",
  "reasoning": "Brief explanation of your decision",
  "summary": "One-line summary for HR dashboard"
}`

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const aiResult = JSON.parse(jsonMatch[0])
      return {
        ...ruleResult,
        decision: aiResult.decision,
        reasons: [...ruleResult.reasons, `AI: ${aiResult.reasoning}`],
        summary: aiResult.summary,
      }
    }
  } catch (error) {
    console.error("[PRE-SCREEN] AI evaluation failed:", error)
  }

  return ruleResult
}