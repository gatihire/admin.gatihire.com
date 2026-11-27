/**
 * Push the live Bolna agent config from lib/bolna.ts.
 *
 * The admin route (/api/bolna/agent) does the same thing behind HR auth, but a
 * prompt fix must not wait on an admin password. This script is the direct
 * path: build the complete payload, PUT it, then read the agent back and assert
 * that the new rules actually landed.
 *
 *   npx tsx --env-file=.env.local scripts/sync-bolna-agent.ts
 */
import { buildBolnaAgentPayload, updateBolnaAgent } from "../lib/bolna"

const apiKey = process.env.BOLNA_API_KEY
const agentId = process.env.BOLNA_AGENT_ID
const webhookBase = process.env.PHONE_SCREENING_WEBHOOK_BASE

if (!apiKey) throw new Error("BOLNA_API_KEY is not set")
if (!agentId) throw new Error("BOLNA_AGENT_ID is not set")
if (!webhookBase) throw new Error("PHONE_SCREENING_WEBHOOK_BASE is not set")

const language = (process.argv[2] as "hinglish" | "english" | undefined) || "hinglish"

async function main() {
  const payload = buildBolnaAgentPayload(webhookBase!, { language })

  console.log(`Syncing agent ${agentId} (${language})…`)
  const result = await updateBolnaAgent(agentId!, {
    agent_config: payload.agent_config,
    agent_prompts: payload.agent_prompts,
  })
  if (!result.success) {
    console.error("Update failed", result)
    process.exit(1)
  }

  const res = await fetch(`https://api.bolna.ai/v2/agent/${agentId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const live: any = await res.json().catch(() => ({}))
  // GET returns the agent flat; PUT takes the { agent_config, agent_prompts }
  // envelope. Support both so this check keeps working if Bolna aligns them.
  const liveConfig = live?.agent_config || live
  const livePrompt: string =
    live?.agent_prompts?.task_1?.system_prompt ||
    liveConfig?.agent_prompts?.task_1?.system_prompt ||
    ""
  const task = (liveConfig?.tasks || [])[0] || {}
  const tools = task?.tools_config || {}
  const transcriber = tools.transcriber || {}
  const taskConfig = task?.task_config || {}
  const liveBlob = JSON.stringify(live)

  const checks: [string, boolean, string][] = [
    ["simple prompt (under 5k chars)", livePrompt.length < 5000, `${livePrompt.length} chars`],
    ["English-first language rule", livePrompt.includes("Start in English"), "prompt"],
    ["consent words are not language signals", livePrompt.includes("are not language signals"), "prompt"],
    ["closing gate", livePrompt.includes("Say the closing only after"), "prompt"],
    ["no-repeat rule", livePrompt.includes("Never ask the same thing twice"), "prompt"],
    ["no-experience bridge", livePrompt.includes("If they have not done it"), "prompt"],
    ["Bolna language switcher disabled", !tools.multilingual_config?.enabled, "multilingual_config"],
    ["no blank handoff line", !liveBlob.includes("Let me connect you with"), "live agent"],
    ["no platform goodbye", taskConfig.call_hangup_message == null, "call_hangup_message"],
    ["6-minute cap", Number(taskConfig.call_terminate) === 360, `call_terminate=${taskConfig.call_terminate}`],
    ["air cargo keyword", String(transcriber.keywords || "").includes("air cargo"), "keywords"],
    ["AWB keyword", String(transcriber.keywords || "").includes("AWB"), "keywords"],
    ["endpointing", Number(transcriber.endpointing) === 1100, `endpointing=${transcriber.endpointing}`],
  ]

  let failed = false
  for (const [name, ok, where] of checks) {
    console.log(`${ok ? "OK  " : "FAIL"} ${name} (${where})`)
    if (!ok) failed = true
  }
  console.log(`Live prompt length: ${livePrompt.length} chars`)
  if (failed) process.exit(1)
  console.log("Agent sync verified.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
