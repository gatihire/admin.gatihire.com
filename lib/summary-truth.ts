/**
 * Keep the human-readable duration line tied to provider facts.
 *
 * Two 27 Nov Rishu calls carried "Call duration: ~9 minutes with 37 exchanges"
 * and "~5 minutes with 18 exchanges" against real lengths of 308s and 134s.
 * Gemini inferred both from transcript size, and HR read the invented number
 * as the length of the screening. The provider duration and the actual speaker
 * turns are both available on the row, so never let a model estimate stand in
 * for them.
 */
const DURATION_LINE = /^[ \t]*Call duration:.*$/im

function transcriptTurns(transcript: string | null | undefined): number {
  if (!transcript) return 0
  return String(transcript)
    .split("\n")
    .filter((line) =>
      /^(assistant|ai|agent|bot|system|user|candidate|human|applicant|interviewee|respondent):/i.test(
        line.trim()
      )
    ).length
}

function formatDuration(seconds: number): string {
  const total = Math.max(1, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return `${minutes}m ${String(remainder).padStart(2, "0")}s (${total}s)`
}

/** Replace an invented duration/exchange line with the provider truth. */
export function truthfulSummary(
  summary: string | null | undefined,
  opts: { durationSec?: number | null; transcript?: string | null }
): string {
  const text = String(summary || "")
  if (!DURATION_LINE.test(text)) return text

  const duration = Number(opts.durationSec)
  if (!Number.isFinite(duration) || duration <= 0) {
    // No trustworthy length: remove the claim rather than guess from turns.
    return text.replace(DURATION_LINE, "").replace(/\n{3,}/g, "\n\n").trim()
  }

  const turns = transcriptTurns(opts.transcript)
  const suffix = turns > 0 ? ` with ${turns} transcript turns` : ""
  return text.replace(DURATION_LINE, `Call duration: ${formatDuration(duration)}${suffix}.`)
}

/** Same correction for a stored verdict_json.comprehensive_summary. */
export function truthfulVerdictSummary<T extends Record<string, unknown>>(
  verdictJson: T | null | undefined,
  opts: { durationSec?: number | null; transcript?: string | null }
): T | null | undefined {
  if (!verdictJson || typeof verdictJson.comprehensive_summary !== "string") return verdictJson
  return {
    ...verdictJson,
    comprehensive_summary: truthfulSummary(verdictJson.comprehensive_summary, opts),
  }
}
