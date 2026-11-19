/**
 * The one rule for turning a post-call verdict into a score.
 *
 * The board shows a score as a judgement: "6/10, further review" tells a
 * recruiter that a screening happened and the answer was middling. So a score
 * may only come from a call that actually happened and was actually read.
 *
 * Why this module exists: the rule was written three times in three places
 * (`buildFallbackVerdictPatch`, the enrichment pass, and the legacy transcript
 * webhook) and one of them had the condition inverted, so every failed or
 * partial call with no score was labelled 6/10 "further review" — the exact
 * card that makes HR open a transcript of a call that never took place.
 *
 * Why the bands are not 8/6/2 any more: `good_fit` and `possible_fit` both used
 * to land on 6, so a strong-but-not-exceptional call was mathematically unable
 * to score above 6 no matter how long it ran or how well it went. HR read that
 * as "6 minutes on the phone for a 6/10". The verdict vocabulary has four
 * levels; the score now has four too.
 */

/** The board's three recommendation values. The column has a CHECK constraint. */
export const SCORE_BANDS = {
  advance: 8,
  further_review: 6,
  not_a_fit: 2,
} as const

export type ScoreBand = keyof typeof SCORE_BANDS

/**
 * Verdict → (score, board band). Four levels in, four levels out.
 *
 * `advance` / `further_review` / `not_a_fit` without a finer verdict fall back
 * to the mid-point of the band (8 / 6 / 2) because nothing more is known.
 */
export const VERDICT_SCORES: Record<string, { score: number; recommendation: ScoreBand }> = {
  strong_fit: { score: 9, recommendation: "advance" },
  good_fit: { score: 7, recommendation: "further_review" },
  possible_fit: { score: 5, recommendation: "further_review" },
  not_fit: { score: 2, recommendation: "not_a_fit" },
  advance: { score: 8, recommendation: "advance" },
  further_review: { score: 6, recommendation: "further_review" },
  not_a_fit: { score: 2, recommendation: "not_a_fit" },
  // the fallback summariser's own vocabulary
  pass: { score: 8, recommendation: "advance" },
  review: { score: 6, recommendation: "further_review" },
  fail: { score: 2, recommendation: "not_a_fit" },
}

/**
 * The plan promises five minutes and the agent is terminated at six. It lives
 * here because the scorer has to recognise "this call ended because we stopped
 * it" as distinct from "this call broke".
 */
export const SCREENING_HARD_CAP_SECONDS = 360

/** Provider duration is rounded and lands a second or two either side of the
 *  cap, so a call is treated as capped when it reaches the cap within 15s. */
export function isCapTimeout(durationSec: number | null | undefined): boolean {
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec)) return false
  return durationSec >= SCREENING_HARD_CAP_SECONDS - 15
}

/**
 * A call can be interrupted and still be a screening. The 6-minute cap is a
 * content outcome — the topics were covered, the clock ran out. A synthesizer
 * error or an inactivity timeout is not, and must never carry a score.
 *
 * `handleCompletedExecution` and `handleFailedExecution` both decide this, so
 * the rule lives here rather than being written twice.
 */
export function isSubstantiveInterruptedCall(opts: {
  durationSec: number
  substantiveAnswers: number
  candidateWords: number
  hangupReason?: string | null
}): boolean {
  const technicalDrop =
    /synthesizer_error|inactivity_timeout|no audio|audio issue|cannot hear|can't hear|inaudible/i.test(
      opts.hangupReason || ""
    )
  return (
    opts.durationSec >= 120 &&
    opts.substantiveAnswers >= 2 &&
    opts.candidateWords >= 60 &&
    !technicalDrop
  )
}

/**
 * True when the score on the row came from the offline heuristic rather than a
 * real transcript analysis. Those scores are placeholders: the enrichment pass
 * must be allowed to replace them, otherwise every completed call keeps the
 * heuristic's 6/10 because `hasScore` is already true when it runs.
 */
export function scoreIsHeuristic(verdictJson: unknown): boolean {
  if (!verdictJson || typeof verdictJson !== "object" || Array.isArray(verdictJson)) return false
  return (verdictJson as Record<string, unknown>)._fallback_summary_used === true
}

export function bandFromVerdict(verdict: string | null | undefined): ScoreBand | null {
  if (!verdict) return null
  return VERDICT_SCORES[String(verdict).trim().toLowerCase()]?.recommendation ?? null
}

/** Score for a verdict word, or null when the word is not recognised. */
export function scoreFromVerdict(verdict: string | null | undefined): number | null {
  if (!verdict) return null
  return VERDICT_SCORES[String(verdict).trim().toLowerCase()]?.score ?? null
}

/**
 * Returns the score to write, or `null` to write nothing.
 *
 * `null` means "leave the row alone" — never "write null". The caller decides
 * whether an unscored card should read "not screened"; that is a classification
 * decision and belongs with the verdict, not with the score.
 */
export function deriveFallbackScore(opts: {
  /** A verdict or band already on the row. A real score is never second-guessed. */
  hasScore: boolean
  /** Failed, partial, cut off, or otherwise not a completed screening. */
  isIncomplete: boolean
  /** The verdict band Gemini read from the transcript. */
  verdict: string | null | undefined
}): { score: number; recommendation: ScoreBand } | null {
  if (opts.hasScore) return null
  if (opts.isIncomplete) return null
  if (!opts.verdict) return null
  const row = VERDICT_SCORES[String(opts.verdict).trim().toLowerCase()]
  if (!row) return null
  return { score: row.score, recommendation: row.recommendation }
}
