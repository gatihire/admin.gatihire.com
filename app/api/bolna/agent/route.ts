import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import {
  createBolnaAgent, updateBolnaAgent, BOLNA_MASTER_PROMPT, BOLNA_MASTER_PROMPT_HINGLISH,
  BOLNA_WELCOME_MESSAGE, BOLNA_WELCOME_MESSAGE_HINGLISH, type BolnaAgentLanguage,
} from "@/lib/bolna"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

const PROMPTS: Record<BolnaAgentLanguage, { master: string; welcome: string; transcriberLanguage: string }> = {
  hinglish: {
    master: BOLNA_MASTER_PROMPT_HINGLISH,
    welcome: BOLNA_WELCOME_MESSAGE_HINGLISH,
    transcriberLanguage: "hi",
  },
  english: {
    master: BOLNA_MASTER_PROMPT,
    welcome: BOLNA_WELCOME_MESSAGE,
    transcriberLanguage: "en",
  },
}

function buildAgentPayload(webhookBase: string, opts?: { agentName?: string; language?: BolnaAgentLanguage }) {
  const language: BolnaAgentLanguage = opts?.language || "hinglish"
  const { master, welcome, transcriberLanguage } = PROMPTS[language]
  return {
    agent_config: {
      agent_name: opts?.agentName || "Gati Hire Screening",
      agent_welcome_message: welcome,
      webhook_url: `${webhookBase}/api/bolna/webhook/execution`,
      calling_guardrails: {
        call_start_hour: 9,
        call_end_hour: 21,
      },
      tasks: [
        {
          task_type: "conversation",
          toolchain: {
            execution: "sequential",
            pipelines: [["transcriber", "llm", "synthesizer"]],
          },
          tools_config: {
            llm_agent: {
              agent_type: "simple_llm_agent",
              agent_flow_type: "streaming",
              llm_config: {
                provider: "openai",
                model: "gpt-4.1-mini",
                max_tokens: 800,
                temperature: 0.2,
                request_json: false,
              },
            },
            synthesizer: {
              provider: "elevenlabs",
              provider_config: {
                voice: "Nila",
                voice_id: "V9LCAAi4tTlqe9JadbCo",
                model: "eleven_turbo_v2_5",
              },
              stream: true,
              buffer_size: 250,
              audio_format: "wav",
            },
            transcriber: {
              provider: "deepgram",
              model: "nova-3",
              language: transcriberLanguage,
              stream: true,
              encoding: "linear16",
              sampling_rate: 16000,
              endpointing: 250,
            },
            input: { provider: "plivo", format: "wav" },
            output: { provider: "plivo", format: "wav" },
          },
          task_config: {
            call_terminate: 420,
            hangup_after_silence: 10,
          },
        },
      ],
    },
    agent_prompts: {
      task_1: {
        system_prompt: master,
      },
    },
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "settings.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const webhookBase = (body.webhookBase as string) || process.env.PHONE_SCREENING_WEBHOOK_BASE
    if (!webhookBase) {
      return NextResponse.json({ error: "webhookBase is required (or set PHONE_SCREENING_WEBHOOK_BASE)" }, { status: 400 })
    }

    const existingAgentId = process.env.BOLNA_AGENT_ID
    const force = body.force === true
    if (existingAgentId && !force) {
      // Create-only unless force:true. The agent already lives in the Bolna
      // account and is the live source of truth for the prompt — dashboard
      // edits (prompt, voice, guardrails) must never be silently overwritten.
      return NextResponse.json({
        agent_id: existingAgentId,
        created: false,
        overwritten: false,
        note: "Agent already exists. BOLNA_AGENT_ID is set — no changes made. Pass force:true to overwrite the agent's prompt/config from lib/bolna.ts.",
      })
    }

    if (existingAgentId) {
      // Explicit force:true — re-sync the agent's prompt + webhook from code.
      const payload = buildAgentPayload(webhookBase, {
        agentName: body.agentName as string | undefined,
        language: body.language as BolnaAgentLanguage | undefined,
      })
      const result = await updateBolnaAgent(existingAgentId, {
        agent_config: payload.agent_config,
        agent_prompts: payload.agent_prompts,
      })
      return NextResponse.json({ agent_id: existingAgentId, updated: true, overwritten: true, ...result })
    }

    const result = await createBolnaAgent(buildAgentPayload(webhookBase, {
      agentName: body.agentName as string | undefined,
      language: body.language as BolnaAgentLanguage | undefined,
    }))
    if (!result.success) {
      return NextResponse.json({ error: result.error || "Agent creation failed" }, { status: 500 })
    }

    const agentId = result.data?.agent_id as string | undefined
    logger.info("Bolna agent provisioned", { agentId, status: result.status })
    return NextResponse.json({ agent_id: agentId, state: result.data?.state })
  } catch (error: any) {
    logger.error("Bolna agent provisioning failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
