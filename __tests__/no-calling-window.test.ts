import assert from "node:assert/strict"
import { test } from "node:test"
import { buildBolnaAgentPayload, placeBolnaCall } from "../lib/bolna"

test("the live agent has no provider-side calling window", () => {
  const payload = buildBolnaAgentPayload("https://admin.gatihire.com")
  const guardrails = (payload.agent_config as Record<string, unknown>).calling_guardrails
  assert.equal(guardrails, null)
})

test("every outbound placement bypasses provider calling guardrails", async () => {
  const previous = {
    key: process.env.BOLNA_API_KEY,
    agent: process.env.BOLNA_AGENT_ID,
    from: process.env.BOLNA_FROM_NUMBER,
  }
  process.env.BOLNA_API_KEY = "test-key"
  process.env.BOLNA_AGENT_ID = "test-agent"
  process.env.BOLNA_FROM_NUMBER = "+911100000000"

  const originalFetch = globalThis.fetch
  const captured: { body?: Record<string, unknown> } = {}
  globalThis.fetch = (async (_input: any, init: any) => {
    captured.body = JSON.parse(init.body)
    return new Response(JSON.stringify({ execution_id: "test-execution" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  try {
    const result = await placeBolnaCall({
      to: "+919876543210",
      userData: { participant_id: "test-participant" },
    })
    assert.equal(result.success, true)
    assert.ok(captured.body)
    assert.equal(captured.body!.bypass_call_guardrails, true)
    assert.equal(captured.body!.call_start_hour, undefined)
    assert.equal(captured.body!.call_end_hour, undefined)
  } finally {
    globalThis.fetch = originalFetch
    if (previous.key === undefined) delete process.env.BOLNA_API_KEY
    else process.env.BOLNA_API_KEY = previous.key
    if (previous.agent === undefined) delete process.env.BOLNA_AGENT_ID
    else process.env.BOLNA_AGENT_ID = previous.agent
    if (previous.from === undefined) delete process.env.BOLNA_FROM_NUMBER
    else process.env.BOLNA_FROM_NUMBER = previous.from
  }
})
