import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import {
  createBolnaAgent, updateBolnaAgent, BOLNA_MASTER_PROMPT,
  BOLNA_WELCOME_MESSAGE, BOLNA_WELCOME_MESSAGE_HINGLISH, BOLNA_LISTENING,
  BOLNA_HANGUP_PROMPT, BOLNA_TRANSCRIBER_KEYWORDS, type BolnaAgentLanguage,
} from "@/lib/bolna"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

const PROMPTS: Record<BolnaAgentLanguage, { master: string; welcome: string; transcriberLanguage: string }> = {
  hinglish: {
    master: BOLNA_MASTER_PROMPT,
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
                provider: "google",
                family: "openai",
                model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview",
                max_tokens: 170,
                temperature: 0.2,
                top_p: 0.9,
                top_k: 0,
                min_p: 0.1,
                request_json: false,
                agent_flow_type: "streaming",
              },
            },
            synthesizer: {
              provider: "sarvam",
              provider_config: {
                model: "bulbul:v3",
                voice: "Ashutosh",
                voice_id: "ashutosh",
                language: language === "hinglish" ? "hi" : "en",
                // 1.0 was the "speaking very slowly" complaint on 20 Nov.
                // 1.1 is audibly more active without sounding rushed; the
                // prompt also asks for a normal, confident pace.
                speed: 1.1,
                loudness: 1.0,
              },
              stream: true,
              buffer_size: 230,
              audio_format: "wav",
              caching: true,
            },
            transcriber: {
              provider: "deepgram",
              model: "nova-3",
              language: transcriberLanguage,
              stream: true,
              encoding: "linear16",
              sampling_rate: 16000,
              // 900 ms, not 250: a Hinglish speaker pauses mid-sentence for
              // 400–800 ms, and 250/350 ms made the agent answer into the pause.
              endpointing: BOLNA_LISTENING.endpointing,
              // Code-switched speech: without this, English domain terms are
              // transliterated into Hindi and the analysis reads noise.
              hinglish_mode: language === "hinglish",
              keywords: BOLNA_TRANSCRIBER_KEYWORDS.join(","),
              vad_threshold: 0.5,
              delay: "medium",
            },
            input: { provider: "plivo", format: "wav" },
            output: { provider: "plivo", format: "wav" },
          },
          task_config: {
            // 6 minutes: the plan promises 5 and the prompt hard-stops at 6.
            call_terminate: 360,
            // Above the online-message trigger, or the line drops before the
            // "are you still there?" check can ever fire.
            hangup_after_silence: BOLNA_LISTENING.hangup_after_silence,
            trigger_user_online_message_after: BOLNA_LISTENING.trigger_user_online_message_after,
            max_silence_repeats: BOLNA_LISTENING.max_silence_repeats,
            interruption_backoff_period: BOLNA_LISTENING.interruption_backoff_period,
            number_of_words_for_interruption: BOLNA_LISTENING.number_of_words_for_interruption,
            // Wait out partial transcripts instead of speaking into a pause.
            incremental_delay: BOLNA_LISTENING.incremental_delay,
            // Let the agent end the call from the prompt once both sides have
            // said goodbye. Without this the only endings are silence or the
            // 6-minute cap, which is why a finished call kept running.
            hangup_after_LLMCall: true,
            call_cancellation_prompt: BOLNA_HANGUP_PROMPT,
            // The goodbye must play through; if it were interruptible, a
            // candidate's "thanks" could cancel the hangup and reopen the call.
            interruptible_hangup_message: false,
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
