import assert from "node:assert/strict"
import { test } from "node:test"
import { isIncompleteScreening } from "../lib/call-truth"

const base = {
  status: "completed",
  bolna_status: "completed",
  call_duration_seconds: 300,
  call_attempts: 4,
  hangup_by: "Plivo",
  call_hangup_reason: "end_call_tool",
}

test("a provider-completed partial screening is still retryable", () => {
  const row = {
    ...base,
    call_is_partial: true,
    verdict_json: {
      _classification_outcome: "incomplete",
      _call_coverage: { closed_before_coverage: true },
    },
  }
  assert.equal(isIncompleteScreening(row), true)
})

test("a genuinely completed screening is not retryable as a partial", () => {
  const row = {
    ...base,
    call_is_partial: false,
    ai_score: 7,
    transcript_raw: [
      "assistant: Tell me about one shipment you handled.",
      "user: I handled a 40-foot FCL shipment last month and coordinated the carrier.",
    ].join("\n"),
    verdict_json: { score: 7 },
  }
  assert.equal(isIncompleteScreening(row), false)
})
