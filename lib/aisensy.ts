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

    // If more than 12 digits with 91 prefix, trim to last 12
    if (cleaned.length > 12 && cleaned.startsWith("91")) {
      return cleaned.substring(cleaned.length - 12)
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

  async sendCallNudge(
    phoneNumber: string,
    candidateName: string,
    jobTitle: string,
    companyName: string,
    opts?: { missed?: boolean }
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.config.apiKey || !this.config.campaignName) {
      return { success: false, error: "Aisensy configuration incomplete" }
    }

    const destination = this.normalizePhoneNumber(phoneNumber)
    if (!destination) {
      logger.error("Invalid phone number for WhatsApp call nudge", { original: phoneNumber })
      return { success: false, error: "Invalid phone number" }
    }

    try {
      const campaignName = opts?.missed
        ? process.env.AISENSY_MISSED_CALL_TEMPLATE || process.env.AISENSY_CALL_NUDGE_TEMPLATE || this.config.campaignName
        : process.env.AISENSY_CALL_NUDGE_TEMPLATE || this.config.campaignName
      const source = this.config.source || undefined

      const payload = {
        apiKey: this.config.apiKey,
        campaignName,
        destination,
        userName: candidateName,
        source,
        templateParams: [candidateName, jobTitle, companyName],
        media: {
          url: "",
          filename: ""
        },
        tags: [opts?.missed ? "ai_call_missed_nudge" : "ai_call_nudge"]
      }

      logger.info(`Sending WhatsApp call nudge to ${destination} (Template: ${campaignName})`, {
        params: [candidateName, jobTitle, companyName],
      })

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      })

      const result = await response.json()

      if (response.ok && result.success) {
        logger.info(`WhatsApp call nudge sent successfully to ${destination}`, { messageId: result.messageId })
        return { success: true, messageId: result.messageId }
      } else {
        logger.error(`Failed to send WhatsApp call nudge`, {
          destination,
          error: result.message,
          response: result,
        })
        return { success: false, error: result.message || "Unknown error" }
      }
    } catch (error: any) {
      logger.error(`Error sending WhatsApp call nudge`, { phoneNumber, error: error.message })
      return { success: false, error: error.message }
    }
  }

  private async sendTemplate(
    destination: string,
    campaignName: string,
    templateParams: string[],
    tags: string[]
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.config.apiKey || !campaignName) {
      return { success: false, error: "Aisensy configuration incomplete" }
    }

    try {
      const payload = {
        apiKey: this.config.apiKey,
        campaignName,
        destination,
        userName: templateParams[0] || "",
        source: this.config.source || undefined,
        templateParams,
        media: {
          url: "",
          filename: ""
        },
        tags
      }

      logger.info(`Sending WhatsApp template to ${destination} (Template: ${campaignName})`, { params: templateParams })

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      })

      const result = await response.json()

      if (response.ok && result.success) {
        logger.info(`WhatsApp template sent successfully to ${destination}`, { messageId: result.messageId })
        return { success: true, messageId: result.messageId }
      }
      logger.error(`Failed to send WhatsApp template`, {
        destination,
        error: result.message,
        response: result,
      })
      return { success: false, error: result.message || "Unknown error" }
    } catch (error: any) {
      logger.error(`Error sending WhatsApp template`, { destination, error: error.message })
      return { success: false, error: error.message }
    }
  }

  /**
   * Step 4.1/4.2 — WhatsApp context outreach: job title, location, salary
   * budget + a link to the job board and [Interested][Not interested] buttons.
   * `shortlisted` picks the inbound congrats template.
   */
  async sendOutreachMessage(
    phoneNumber: string,
    candidateName: string,
    params: { jobTitle: string; location: string; salaryBudget: string; jobLink: string },
    opts?: { shortlisted?: boolean }
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const destination = this.normalizePhoneNumber(phoneNumber)
    if (!destination) return { success: false, error: "Invalid phone number" }

    const campaignName = opts?.shortlisted
      ? process.env.AISENSY_SHORTLIST_TEMPLATE || process.env.AISENSY_OUTREACH_TEMPLATE || ""
      : process.env.AISENSY_OUTREACH_TEMPLATE || ""

    return this.sendTemplate(
      destination,
      campaignName,
      [candidateName, params.jobTitle, params.location, params.salaryBudget, params.jobLink],
      [opts?.shortlisted ? "ai_outreach_shortlisted" : "ai_outreach_context"]
    )
  }

  /**
   * Schedule-options message sent after the candidate says Interested, with
   * Quick Replies: [Call me now] [In 10 minutes] [Today evening].
   */
  async sendScheduleOptions(
    phoneNumber: string,
    candidateName: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const destination = this.normalizePhoneNumber(phoneNumber)
    if (!destination) return { success: false, error: "Invalid phone number" }

    return this.sendTemplate(
      destination,
      process.env.AISENSY_SCHEDULE_OPTIONS_TEMPLATE || "",
      [candidateName],
      ["ai_outreach_schedule_options"]
    )
  }

  /**
   * Reminder nudge (outreach_followup action="nudge"). Sent once after
   * OUTREACH_NUDGE_HOURS hours of silence.
   */
  async sendReminderNudge(
    phoneNumber: string,
    candidateName: string,
    jobTitle: string,
    location: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const destination = this.normalizePhoneNumber(phoneNumber)
    if (!destination) return { success: false, error: "Invalid phone number" }

    return this.sendTemplate(
      destination,
      process.env.AISENSY_REMINDER_TEMPLATE || "",
      [candidateName, jobTitle, location],
      ["ai_outreach_reminder"]
    )
  }

  /**
   * Missed-call reschedule: sent when a Bolna call fails (no-answer/busy).
   * Includes quick-reply buttons: [Call Now] [In 10 min] [In 1 hour] [Tomorrow morning].
   * Falls back to the missed-call template if the reschedule template isn't configured.
   */
  async sendMissedCallReschedule(
    phoneNumber: string,
    candidateName: string,
    jobTitle: string,
    companyName: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const destination = this.normalizePhoneNumber(phoneNumber)
    if (!destination) return { success: false, error: "Invalid phone number" }

    const campaignName = process.env.AISENSY_MISSED_CALL_RESCHEDULE_TEMPLATE
      || process.env.AISENSY_MISSED_CALL_TEMPLATE
      || process.env.AISENSY_CALL_NUDGE_TEMPLATE
      || this.config.campaignName

    return this.sendTemplate(
      destination,
      campaignName,
      [candidateName, jobTitle, companyName],
      ["ai_call_missed_reschedule"]
    )
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
