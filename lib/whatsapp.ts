import { logger } from "./logger"

interface WhatsAppConfig {
  phoneNumberId: string
  businessAccountId: string
  accessToken: string
  apiVersion: string
}

interface TemplateParameter {
  type: "text"
  text: string
}

interface TemplateComponent {
  type: "body" | "button"
  sub_type?: "quick_reply"
  index?: number
  parameters?: TemplateParameter[]
}

interface TemplateMessage {
  to: string
  templateName: string
  languageCode?: string
  components?: TemplateComponent[]
}

interface SendMessageResult {
  success: boolean
  messageId?: string
  error?: string
}

export class WhatsAppService {
  private config: WhatsAppConfig
  private baseUrl: string
  private aisensy: any

  constructor() {
    this.config = {
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
      businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
      apiVersion: process.env.WHATSAPP_API_VERSION || "v21.0"
    }
    this.baseUrl = `https://graph.facebook.com/${this.config.apiVersion}`

    // Initialize Aisensy as fallback (lazy load)
    this.aisensy = null

    if (!this.config.phoneNumberId || !this.config.accessToken) {
      logger.warn("WhatsApp Meta API configuration incomplete - will use Aisensy fallback")
    }
  }

  private async getAisensyService() {
    if (!this.aisensy) {
      try {
        const { AisensyService } = await import("./aisensy")
        this.aisensy = new AisensyService()
      } catch {
        // Aisensy not available
      }
    }
    return this.aisensy
  }

  private normalizePhoneNumber(phone: string): string {
    if (!phone) return ""
    let cleaned = phone.replace(/\D/g, "")
    
    if (cleaned.startsWith("0")) {
      cleaned = cleaned.substring(1)
    }

    if (cleaned.length === 10) {
      return `91${cleaned}`
    }

    if (cleaned.length === 12 && cleaned.startsWith("91")) {
      return cleaned
    }

    if (cleaned.length > 12 && cleaned.startsWith("91")) {
      return cleaned.substring(cleaned.length - 12)
    }

    return cleaned
  }

  private isMetaConfigured(): boolean {
    return !!(this.config.phoneNumberId && this.config.accessToken)
  }

  async sendTemplateMessage(message: TemplateMessage): Promise<SendMessageResult> {
    // Use Meta API if configured
    if (this.isMetaConfigured()) {
      return this.sendViaMeta(message)
    }

    // Fallback to Aisensy
    if (this.aisensy) {
      logger.info("Meta API not configured, falling back to Aisensy")
      return this.sendViaAisensy(message)
    }

    return { success: false, error: "No WhatsApp provider configured" }
  }

  private async sendViaMeta(message: TemplateMessage): Promise<SendMessageResult> {
    const destination = this.normalizePhoneNumber(message.to)
    if (!destination) {
      return { success: false, error: "Invalid phone number" }
    }

    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: destination,
        type: "template",
        template: {
          name: message.templateName,
          language: {
            code: message.languageCode || "en"
          },
          components: message.components || []
        }
      }

      logger.info(`Sending WhatsApp via Meta to ${destination} (Template: ${message.templateName})`)

      const response = await fetch(`${this.baseUrl}/${this.config.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      })

      const result = await response.json()

      if (response.ok && result.messages && result.messages[0]) {
        const messageId = result.messages[0].id
        logger.info(`WhatsApp message sent successfully via Meta`, { messageId, destination })
        return { success: true, messageId }
      } else {
        const error = result.error?.message || "Unknown error"
        logger.error("Failed to send WhatsApp via Meta", { destination, error, response: result })
        return { success: false, error }
      }
    } catch (error: any) {
      logger.error("Error sending WhatsApp via Meta", { destination, error: error.message })
      return { success: false, error: error.message }
    }
  }

  private async sendViaAisensy(message: TemplateMessage): Promise<SendMessageResult> {
    try {
      const aisensy = await this.getAisensyService()
      if (!aisensy) {
        return { success: false, error: "Aisensy not available" }
      }

      const templateParams = message.components
        ?.filter(c => c.type === "body" && c.parameters)
        .flatMap(c => c.parameters?.map(p => p.text) || []) || []

      const result = await aisensy.sendWhatsAppMessage(
        {
          phoneNumber: message.to,
          candidateName: templateParams[0] || "",
          jobTitle: templateParams[1] || "",
          companyName: templateParams[2] || "",
          uniqueLink: templateParams[3] || ""
        },
        { campaignName: message.templateName }
      )

      return result
    } catch (error: any) {
      logger.error("Error sending WhatsApp via Aisensy fallback", { error: error.message })
      return { success: false, error: error.message }
    }
  }

  // Template-specific methods

  async sendTalentOutreach(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
    location: string
    salary: string
    matchScore: string
    skills: string
    applyLink: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_TALENT_OUTREACH || "talent_outreach"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.jobTitle },
            { type: "text", text: params.companyName },
            { type: "text", text: params.location },
            { type: "text", text: params.salary },
            { type: "text", text: params.matchScore },
            { type: "text", text: params.skills },
            { type: "text", text: params.applyLink }
          ]
        }
      ]
    })
  }

  async sendScreeningInvite(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_SCREENING_INVITE || "screening_invite"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.jobTitle },
            { type: "text", text: params.companyName }
          ]
        }
      ]
    })
  }

  async sendScheduleOptions(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_SCHEDULE_OPTIONS || "schedule_options"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.jobTitle }
          ]
        }
      ]
    })
  }

  async sendCallNudge(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_CALL_NUDGE || "call_nudge"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.jobTitle },
            { type: "text", text: params.companyName }
          ]
        }
      ]
    })
  }

  async sendTriedCalling(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_TRIED_CALLING || "tried_calling"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.jobTitle },
            { type: "text", text: params.companyName }
          ]
        }
      ]
    })
  }

  async sendMissedCallReschedule(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_MISSED_CALL_RESCHEDULE || "missed_call_reschedule"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.jobTitle },
            { type: "text", text: params.companyName }
          ]
        }
      ]
    })
  }

  async sendReminderNudge(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
    location: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_REMINDER_NUDGE || "reminder_nudge"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.jobTitle },
            { type: "text", text: params.companyName },
            { type: "text", text: params.location }
          ]
        }
      ]
    })
  }

  async sendInboundScreeningInvite(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_INBOUND_SCREENING || "inbound_screening_invite"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.jobTitle },
            { type: "text", text: params.companyName }
          ]
        }
      ]
    })
  }
}

// Singleton instance
let instance: WhatsAppService | null = null

export function getWhatsAppService(): WhatsAppService {
  if (!instance) {
    instance = new WhatsAppService()
  }
  return instance
}
