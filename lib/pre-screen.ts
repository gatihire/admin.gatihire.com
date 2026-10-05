import { GoogleGenerativeAI } from '@google/generative-ai'
import { toLpa, toCtcLpa, toNoticeDays, toExperienceYears, jobSalaryBandToLpa } from '@/lib/units'
import { logger } from '@/lib/logger'

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

export const PRE_SCREEN_DECISIONS: readonly PreScreenDecision[] = [
  "proceed",
  "needs_review",
  "filtered_out",
] as const

export function isPreScreenDecision(value: unknown): value is PreScreenDecision {
  return typeof value === "string" && (PRE_SCREEN_DECISIONS as readonly string[]).includes(value)
}

/**
 * The AI's opinion, kept separate from what the SYSTEM did about it.
 *
 * "filtered_out" here means "the AI believes this candidate is a poor fit" — it
 * is a recommendation, never an instruction to message the candidate. Deciding to
 * actually reject someone is a human action (see screening_context.preScreenReview),
 * because a mis-parsed CTC or a units mistake is otherwise indistinguishable from
 * a genuine mismatch, and we were auto-sending rejections off the back of it.
 */
export interface PreScreenResult {
  decision: PreScreenDecision
  reasons: string[]
  salaryFit?: { match: boolean; details: string }
  experienceFit?: { match: boolean; details: string }
  locationFit?: { match: boolean; details: string }
  noticeFit?: { match: boolean; details: string }
  summary: string
  /**
   * True when a check could not run because its input was unparseable (e.g.
   * "30% hike"). Surfaced so HR can see that "passing" partly means "we could
   * not tell", instead of reading it as a clean pass.
   */
  skippedChecks?: string[]
}

const DEFAULT_CONFIG: PreScreenConfig = {
  salaryTolerancePercent: 40,
  experienceMinPercent: 50,
  experienceMaxPercent: 200,
  maxNoticePeriodDays: 120,
}

/**
 * All unit conversion lives in lib/units. The old local parseLpa/parseYears/
 * parseDays stripped non-digits and returned whatever was left, which turned
 * "30% hike" into 30 and "6,50,000" into 650000 — confident wrong numbers that
 * failed candidates. Do not reintroduce digit-stripping parsers here.
 */

/**
 * Build a typed CandidateInfo from the snake_case values we hold (the portal
 * apply form, a WhatsApp Flow submission, or free text). evaluatePreScreen
 * expects camelCase NUMBERS, so this is where every unit conversion happens —
 * once, in one place, via lib/units.
 *
 * Every field is optional and every failure mode returns undefined. That is
 * deliberate: the checks skip on missing data rather than failing it, because a
 * candidate whose CTC came through as "30% hike" must reach a human, not be
 * discarded by a parser.
 */
export function buildCandidateInfoFromCollected(info: Record<string, any>): CandidateInfo {
  // Total experience and location are trusted from the resume. They reach the
  // call prompt via buildResumeInfo(); here we only read them so the
  // experience/location checks have something to run against.
  const experienceRaw = info.total_experience ?? info.total_experience_years
  const relocation = info.willing_to_relocate

  return {
    // toCtcLpa, not toLpa: candidates answer the CTC question with a bare
    // integer ("5", "6"), which toLpa reads as a rupee figure and returns null
    // for. That silently skipped the salary check on the strongest signal we
    // collect — see toCtcLpa for why the bare-integer reading is correct here.
    currentCtcLpa: toCtcLpa(info.current_ctc) ?? undefined,
    expectedCtcLpa: toCtcLpa(info.expected_ctc) ?? undefined,
    totalExperienceYears: toExperienceYears(experienceRaw) ?? undefined,
    // 0 days ("Immediate") is a real answer, so check for null rather than falsy.
    noticePeriodDays: toNoticeDays(info.notice_period) ?? undefined,
    preferredCity:
      typeof info.location === "string" && info.location.trim() ? info.location.trim() : undefined,
    willingToRelocate:
      relocation === true ||
      relocation === "yes" ||
      relocation === "Yes" ||
      relocation === "true",
    switchingReason:
      typeof info.reason_for_switching === "string" && info.reason_for_switching.trim()
        ? info.reason_for_switching
        : undefined,
  }
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

/**
 * Result of one hard check. `skipped` means the check could not run because its
 * input was missing or unparseable — it counts as a pass, but is reported
 * separately so HR can see that a "pass" partly means "we could not tell".
 */
interface FitResult {
  match: boolean
  details: string
  skipped?: boolean
}

/**
 * Both sides are normalised through lib/units before they are compared.
 *
 * This is the check that produced the "Expected: 1140000 LPA, Job range:
 * 40000-70000 LPA" rejection: the candidate's annual CTC was compared against a
 * job band stored per month, a 1000x error, and the candidate was filtered out
 * on the strength of it. Job bands in this database mix monthly and annual units
 * in the same column, so neither side can be trusted as-is.
 */
function evaluateSalaryFit(
  candidate: CandidateInfo,
  job: JobRequirements,
  config: PreScreenConfig
): FitResult {
  const expected = candidate.expectedCtcLpa
  const band = jobSalaryBandToLpa(job.salaryMinLpa, job.salaryMaxLpa)

  if (!expected || !band) {
    return { match: true, details: "Salary data incomplete or unparseable - skipping check", skipped: true }
  }

  const tolerance = config.salaryTolerancePercent / 100
  const acceptableMin = band.min * (1 - tolerance)
  const acceptableMax = band.max * (1 + tolerance)

  const match = expected >= acceptableMin && expected <= acceptableMax
  return {
    match,
    details: `Expected: ${expected} LPA, Job range: ${band.min}-${band.max} LPA, Acceptable range: ${acceptableMin.toFixed(1)}-${acceptableMax.toFixed(1)} LPA`,
  }
}

function evaluateExperienceFit(
  candidate: CandidateInfo,
  job: JobRequirements,
  config: PreScreenConfig
): FitResult {
  const exp = candidate.totalExperienceYears
  const min = job.experienceMinYears
  const max = job.experienceMaxYears

  if (!exp || !min || !max) {
    return { match: true, details: "Experience data incomplete or unparseable - skipping check", skipped: true }
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
): FitResult {
  const candidateCity = candidate.preferredCity
  const jobCity = job.city || job.location
  const willingToRelocate = candidate.willingToRelocate

  if (!candidateCity || !jobCity) {
    return { match: true, details: "Location data incomplete - skipping check", skipped: true }
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
): FitResult {
  const notice = candidate.noticePeriodDays
  const maxAllowed = config.maxNoticePeriodDays

  // `notice === undefined`, not `!notice`: 0 days is a real answer ("Immediate"
  // / "can join now") and must be compared, not skipped.
  if (notice === undefined) {
    return { match: true, details: "Notice period not provided - skipping check", skipped: true }
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
  const skippedChecks: string[] = []

  const salaryFit = evaluateSalaryFit(candidate, job, config)
  const experienceFit = evaluateExperienceFit(candidate, job, config)
  const locationFit = evaluateLocationFit(candidate, job)
  const noticeFit = evaluateNoticeFit(candidate, config)

  const fits: Array<[string, FitResult]> = [
    ["Salary", salaryFit],
    ["Experience", experienceFit],
    ["Location", locationFit],
    ["Notice", noticeFit],
  ]

  for (const [name, fit] of fits) {
    if (!fit.match) reasons.push(`${name}: ${fit.details}`)
    else if (fit.skipped) skippedChecks.push(name)
  }

  const hardFilterCount = fits.filter(([, f]) => !f.match).length

  let decision: PreScreenDecision
  if (hardFilterCount === 0) {
    decision = "proceed"
  } else if (hardFilterCount <= 2 && (salaryFit.match || experienceFit.match || locationFit.match)) {
    decision = "needs_review"
  } else {
    decision = "filtered_out"
  }

  const caveat = skippedChecks.length
    ? ` ${skippedChecks.length} check(s) could not run (${skippedChecks.join(", ")}) — data was missing or unparseable.`
    : ""

  let summary = ""
  switch (decision) {
    case "proceed":
      summary = `Candidate passes all pre-screen checks. Ready for AI call.${caveat}`
      break
    case "needs_review":
      summary = `Candidate has ${hardFilterCount} concern(s): ${reasons.join("; ")}. HR review recommended.${caveat}`
      break
    case "filtered_out":
      // Deliberately phrased as the AI's opinion. It is never acted on without a
      // human decision — see the PreScreenResult doc comment.
      summary = `AI suggests this candidate may not be a fit: ${reasons.join("; ")}.${caveat}`
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
    skippedChecks,
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
    // Normalised once here so the model sees the same LPA scale the rule checks
    // used, rather than the raw rupee figures the columns happen to hold.
    const band = jobSalaryBandToLpa(job.salaryMinLpa, job.salaryMaxLpa)
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
- Salary Range: ${band ? `${band.min} - ${band.max} LPA` : "Not provided"}
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
}

Important: "filtered_out" is only a RECOMMENDATION to the recruiter, never a
decision that is acted on automatically. Say so when you are genuinely unsure.
All salary figures above are already normalised to annual LPA.`

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const aiResult = JSON.parse(jsonMatch[0])

      // The model's `decision` is untrusted free text. It used to be assigned
      // straight through, so a hallucinated value ("maybe", "REJECT", null)
      // became a participant status. Anything outside the enum is discarded and
      // we keep the rule-based verdict instead.
      if (!isPreScreenDecision(aiResult.decision)) {
        logger.warn("[PRE-SCREEN] Ignoring out-of-range AI decision", {
          received: aiResult.decision,
          fallingBackTo: ruleResult.decision,
        })
        return ruleResult
      }

      // Note on escalation: the AI is only consulted when the rules returned
      // "needs_review" (see the early return above), so it can only move a
      // borderline candidate to proceed or to filtered_out — it cannot
      // manufacture a rejection out of a clean pass. Either way filtered_out is
      // advisory and needs a human before it reaches the candidate.
      return {
        ...ruleResult,
        decision: aiResult.decision,
        reasons: [...ruleResult.reasons, `AI: ${aiResult.reasoning}`],
        summary: aiResult.summary || ruleResult.summary,
      }
    }
  } catch (error) {
    console.error("[PRE-SCREEN] AI evaluation failed:", error)
  }

  return ruleResult
}