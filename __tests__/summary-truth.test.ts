import assert from "node:assert/strict"
import { test } from "node:test"
import { truthfulSummary, truthfulVerdictSummary } from "../lib/summary-truth"

const transcript = [
  "assistant: Hi Rishu, is now a good time to talk?",
  "user: yes sir",
  "assistant: Tell me about one real shipment.",
  "user: We handled twelve vehicles last month.",
].join("\n")

test("replaces an invented duration and exchange count with provider facts", () => {
  const summary =
    "Screening call for Rishu.\nCall duration: ~9 minutes with 37 exchanges.\n\nStrengths: none."
  const result = truthfulSummary(summary, { durationSec: 308, transcript })
  assert.match(result, /Call duration: 5m 08s \(308s\) with 4 transcript turns\./)
  assert.doesNotMatch(result, /9 minutes|37 exchanges/)
})

test("removes the duration claim when no trustworthy length exists", () => {
  const summary = "Call duration: ~4 minutes with 14 exchanges.\nKey finding: none."
  const result = truthfulSummary(summary, { durationSec: null, transcript })
  assert.doesNotMatch(result, /Call duration|4 minutes|14 exchanges/)
  assert.match(result, /Key finding: none/)
})

test("leaves a summary with no duration line untouched", () => {
  const summary = "Screening call for Himanshu.\nNo concrete example was given."
  assert.equal(truthfulSummary(summary, { durationSec: 124, transcript }), summary)
})

test("corrects the copy stored inside verdict_json", () => {
  const verdict = {
    score: 5,
    comprehensive_summary: "Call duration: ~5 minutes with 18 exchanges.\nPossible fit.",
  }
  const result = truthfulVerdictSummary(verdict, { durationSec: 134, transcript })
  assert.equal(result?.score, 5)
  assert.match(String(result?.comprehensive_summary), /2m 14s \(134s\)/)
})
