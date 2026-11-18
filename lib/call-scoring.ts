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
 */

export const SCORE_BANDS = {
  advance: 8,
  further_review: 6,
  not_a_fit: 2,
} as const

export type ScoreBand = keyof typeof SCORE_BANDS

/** Gemini's enrichment vocabulary → the board's three bands. */
const VERDICT_ALIAS: Record<string, ScoreBand> = {
  strong_fit: "advance",
  good_fit: "further_review",
  possible_fit: "further_review",
  not_fit: "not_a_fit",
  advance: "advance",
  further_review: "further_review",
  not_a_fit: "not_a_fit",
}

export function bandFromVerdict(verdict: string | null | undefined): ScoreBand | null {
  if (!verdict) return null
  return VERDICT_ALIAS[String(verdict).trim().toLowerCase()] ?? null
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
  const recommendation = bandFromVerdict(opts.verdict)
  if (!recommendation) return null
  return { score: SCORE_BANDS[recommendation], recommendation }
}
