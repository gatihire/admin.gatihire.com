import { logger } from "./logger"

interface AisensyConfig {
  apiKey: string
  campaignName: string
  source: string
}

interface WhatsAppMessage {
  phoneNumber: string
  candidateName: string
  jobTitle: string
  companyName: string
  uniqueLink: string
}

interface WhatsAppTemplateOverrides {
  campaignName?: string
  source?: string
  templateParams?: string[]
}

export class AisensyService {
  private config: AisensyConfig
  private baseUrl = "https://backend.aisensy.com/campaign/t1/api/v2"

  constructor() {
    this.config = {
      apiKey: process.env.AISENSY_API_KEY || "",
      campaignName: process.env.AISENSY_CAMPAIGN_NAME || process.env.AISENSY_TEMPLATE_ID || "Job_Recruitment",
      source: process.env.AISENSY_SOURCE || process.env.AISENSY_SENDER_ID || ""
    }

    if (!this.config.apiKey || !this.config.campaignName) {
      logger.warn("Aisensy configuration incomplete - WhatsApp messages will be disabled")
    }
  }

  private normalizePhoneNumber(phone: string): string {
    if (!phone) return ""
    // Remove all non-digit characters
    let cleaned = phone.replace(/\D/g, "")
    
    // If it starts with 0, remove it
    if (cleaned.startsWith("0")) {
      cleaned = cleaned.substring(1)
    }

    // If length is 10, assume India and add 91
    if (cleaned.length === 10) {
      return `91${cleaned}`
    }

    // If length is 12 and starts with 91, it's likely already correct
    if (cleaned.length === 12 && cleaned.startsWith("91")) {
      return cleaned
    }

    // If it's another length, just return digits (best effort)
    return cleaned
  }

  async sendWhatsAppMessage(
    message: WhatsAppMessage,
    overrides?: WhatsAppTemplateOverrides
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.config.apiKey || !this.config.campaignName) {
      return { success: false, error: "Aisensy configuration incomplete" }
    }

    const destination = this.normalizePhoneNumber(message.phoneNumber)
    if (!destination) {
      logger.error("Invalid phone number for WhatsApp", { original: message.phoneNumber })
      return { success: false, error: "Invalid phone number" }
    }

    try {
      const campaignName = overrides?.campaignName || this.config.campaignName
      const source = overrides?.source || this.config.source || undefined
      const templateParams = overrides?.templateParams || [
        message.candidateName,
        message.jobTitle,
        message.companyName,
        message.uniqueLink
      ]
      
      const payload = {
        apiKey: this.config.apiKey,
        campaignName,
        destination,
        userName: message.candidateName,
        source,
        templateParams,
        media: {
          url: "",
          filename: ""
        },
        tags: ["job_recruitment", "external_candidate"]
      }

      logger.info(`Sending WhatsApp to ${destination} (Template: ${campaignName})`, { params: templateParams })

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      })

      const result = await response.json()

      if (response.ok && result.success) {
        logger.info(`WhatsApp message sent successfully to ${destination}`, { messageId: result.messageId })
        return { success: true, messageId: result.messageId }
      } else {
        logger.error(`Failed to send WhatsApp message`, { 
          destination, 
          error: result.message, 
          response: result 
        })
        return { success: false, error: result.message || "Unknown error" }
      }
    } catch (error: any) {
      logger.error(`Error sending WhatsApp message`, { phoneNumber: message.phoneNumber, error: error.message })
      return { success: false, error: error.message }
    }
  }

  async sendBulkWhatsAppMessages(messages: WhatsAppMessage[]): Promise<{ success: number; failed: number; errors: string[] }> {
    const results = await Promise.allSettled(
      messages.map(message => this.sendWhatsAppMessage(message))
    )

    let success = 0
    let failed = 0
    const errors: string[] = []

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.success) {
        success++
      } else {
        failed++
        const error = result.status === "fulfilled" ? result.value.error : result.reason
        errors.push(`Message ${index + 1}: ${error}`)
      }
    })

    logger.info(`Bulk WhatsApp messages completed`, { success, failed, total: messages.length })
    return { success, failed, errors }
  }
}

export const aisensyService = new AisensyService()
