import Plivo from "plivo"
import { logger } from "./logger"

function getConfig() {
  const authId = process.env.PLIVO_AUTH_ID
  const authToken = process.env.PLIVO_AUTH_TOKEN
  const whatsappNumber = process.env.PLIVO_WHATSAPP_NUMBER
  const voiceNumber = process.env.PLIVO_VOICE_NUMBER
  const webhookBase = process.env.PHONE_SCREENING_WEBHOOK_BASE

  if (!authId || !authToken) {
    logger.warn("Plivo configuration incomplete")
  }

  return { authId, authToken, whatsappNumber, voiceNumber, webhookBase }
}

function getClient(): Plivo.Client | null {
  const { authId, authToken } = getConfig()
  if (!authId || !authToken) return null
  return new Plivo.Client(authId, authToken)
}

const PLIVO_API = "https://api.plivo.com/v1"

function basicAuthHeader(): string {
  const { authId, authToken } = getConfig()
  return "Basic " + Buffer.from(`${authId}:${authToken}`).toString("base64")
}

export interface InteractiveButton {
  title: string
  id: string
}

export interface WhatsAppInteractiveMessage {
  to: string
  body: string
  buttons: InteractiveButton[]
  footer?: string
}

export interface SendWhatsAppResult {
  success: boolean
  messageUuid?: string
  error?: string
}

function normalizePhone(phone: string): string {
  if (!phone) return ""
  let cleaned = phone.replace(/\D/g, "")
  if (cleaned.startsWith("0")) cleaned = cleaned.substring(1)
  if (cleaned.length === 10) return `91${cleaned}`
  if (cleaned.length === 12 && cleaned.startsWith("91")) return cleaned
  return cleaned
}

export async function sendWhatsAppInteractive(
  msg: WhatsAppInteractiveMessage
): Promise<SendWhatsAppResult> {
  const { authId, whatsappNumber } = getConfig()
  if (!authId || !whatsappNumber) {
    return { success: false, error: "Plivo WhatsApp not configured" }
  }

  const dst = normalizePhone(msg.to)
  if (!dst) return { success: false, error: "Invalid phone number" }

  const interactive: Record<string, unknown> = {
    type: "button",
    body: { text: msg.body },
    action: {
      buttons: msg.buttons.map((b) => ({
        type: "reply",
        title: b.title,
        id: b.id,
      })),
    },
  }

  if (msg.footer) {
    interactive.footer = { text: msg.footer }
  }

  try {
    const res = await fetch(`${PLIVO_API}/Account/${authId}/Message/`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        src: whatsappNumber,
        dst,
        type: "whatsapp",
        interactive,
        url: `${getConfig().webhookBase || ""}/api/phone-screening/webhook/whatsapp`,
      }),
    })

    const data = await res.json()
    if (res.ok) {
      logger.info(`WhatsApp interactive sent to ${dst}`, { messageUuid: data.message_uuid })
      return { success: true, messageUuid: data.message_uuid }
    }
    logger.error("WhatsApp send failed", { dst, error: data })
    return { success: false, error: data.error || data.message || "Unknown error" }
  } catch (err: any) {
    logger.error("WhatsApp send exception", { dst, error: err.message })
    return { success: false, error: err.message }
  }
}

export interface OutboundCallParams {
  to: string
  candidateName: string
  candidateProfile: Record<string, unknown>
  jobDetails: Record<string, unknown>
  origin?: "inbound" | "outbound"
  playbook?: string
}

export interface OutboundCallResult {
  success: boolean
  requestUuid?: string
  error?: string
}

export async function triggerOutboundCall(
  params: OutboundCallParams
): Promise<OutboundCallResult> {
  const { authId, voiceNumber, webhookBase } = getConfig()
  if (!authId || !voiceNumber || !webhookBase) {
    return { success: false, error: "Plivo voice not configured" }
  }

  const dst = normalizePhone(params.to)
  if (!dst) return { success: false, error: "Invalid phone number" }

  const answerUrl = new URL(`${webhookBase}/api/phone-screening/webhook/answer`)
  answerUrl.searchParams.set("candidateName", String(params.candidateName))
  answerUrl.searchParams.set("candidateProfile", JSON.stringify(params.candidateProfile))
  answerUrl.searchParams.set("jobDetails", JSON.stringify(params.jobDetails))
  if (params.origin) {
    answerUrl.searchParams.set("origin", params.origin)
  }
  if (params.playbook) {
    answerUrl.searchParams.set("playbook", params.playbook)
  }

  try {
    const client = getClient()
    if (!client) return { success: false, error: "Plivo client not initialized" }

    const result = await client.calls.create(
      voiceNumber,
      dst,
      answerUrl.toString(),
      {
        answerMethod: "POST",
        ringUrl: `${webhookBase}/api/phone-screening/webhook/ring`,
        hangupUrl: `${webhookBase}/api/phone-screening/webhook/hangup`,
        fallbackUrl: `${webhookBase}/api/phone-screening/webhook/fallback`,
        machineDetection: true,
      }
    )

    const uuid = Array.isArray(result.requestUuid) ? result.requestUuid[0] : result.requestUuid
    logger.info(`Outbound call triggered to ${dst}`, { requestUuid: uuid })
    return { success: true, requestUuid: uuid }
  } catch (err: any) {
    logger.error("Outbound call failed", { dst, error: err.message })
    return { success: false, error: err.message }
  }
}

export async function triggerScheduledCall(
  params: OutboundCallParams
): Promise<OutboundCallResult> {
  return triggerOutboundCall(params)
}

export async function hangupCall(callUuid: string): Promise<boolean> {
  try {
    const { authId } = getConfig()
    if (!authId) return false

    const res = await fetch(`${PLIVO_API}/Account/${authId}/Call/${callUuid}/`, {
      method: "DELETE",
      headers: { Authorization: basicAuthHeader() },
    })
    return res.ok
  } catch (err: any) {
    logger.error("Hangup failed", { callUuid, error: err.message })
    return false
  }
}

export function validateWebhook(
  signature: string | null,
  method: string,
  uri: string,
  body: string,
  nonce: string
): boolean {
  if (!signature) return false
  try {
    const { authToken } = getConfig()
    if (!authToken) return false
    return !!Plivo.validateV3Signature(method, uri, authToken, nonce, signature)
  } catch {
    return false
  }
}

export function getPlivoAnswerXml(agentConfig: {
  agentId: string
  candidateName: string
  candidateProfile: Record<string, unknown>
  jobDetails: Record<string, unknown>
  origin?: "inbound" | "outbound"
  playbook?: string
}): string {
  const context = encodeURIComponent(
    JSON.stringify({
      candidate_name: agentConfig.candidateName,
      candidate_profile: agentConfig.candidateProfile,
      job_details: agentConfig.jobDetails,
      origin: agentConfig.origin || "inbound",
      ...(agentConfig.playbook ? { ai_playbook: agentConfig.playbook } : {}),
    })
  )

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Agent
    agentId="${agentConfig.agentId}"
    context="${context}"
    language="en-US"
    voice="Nova"
    transcriptionType="auto"
    transcriptionUrl="${getConfig().webhookBase || ""}/api/phone-screening/webhook/transcript"
  />
</Response>`
}
