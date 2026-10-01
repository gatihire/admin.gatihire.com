import { logger } from "./logger"
import { toDial } from "./phone"

interface WhatsAppConfig {
  phoneNumberId: string
  businessAccountId: string
  accessToken: string
  apiVersion: string
}

interface TemplateParameter {
  type: "text" | "action"
  text?: string
  action?: {
    flow_token?: string
    flow_action_data?: Record<string, unknown>
  }
}

interface TemplateComponent {
  type: "body" | "button"
  sub_type?: "quick_reply" | "flow"
  index?: number | string
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
  /** Meta Graph error code, populated when a send fails (e.g. 132001 language
   *  mismatch, 131042 template not yet approved). */
  errorCode?: string | number
}

/**
 * Coerce a template body parameter to non-empty text.
 *
 * Meta rejects the whole message with #131008 when any body parameter is an
 * empty string, rather than rendering it blank. Guarding centrally keeps a
 * missing job field from taking down the send.
 */
function templateParam(value: string | undefined | null, fallback: string): string {
  const s = String(value ?? "").trim()
  return s || fallback
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
    // Shared canonical dial format (91XXXXXXXXXX) via lib/phone so send and
    // lookup always agree, regardless of how the raw number was stored.
    return toDial(phone)
  }

  private isMetaConfigured(): boolean {
    return !!(this.config.phoneNumberId && this.config.accessToken)
  }

  /**
   * How long to hold a follow-up message so it cannot overtake the one before it.
   *
   * Meta gives no ordering guarantee between an approved template and a
   * free-form session message sent immediately after: on a live run the link
   * arrived ~5s BEFORE the template that introduced it.
   *
   * The obvious fix — poll the Graph API for the first message's status — is not
   * available. `GET /{wamid}` returns 400 "Unsupported get request" for every
   * message id, delivered or not, so it cannot be used as a delivery gate. What
   * actually works is a fixed wait: delivery-status webhooks are not needed and
   * the link lands reliably after the template.
   */
  private static readonly OUTBOUND_ORDERING_DELAY_MS = 12_000

  /**
   * Delay a dependent send until the previous message has had time to arrive.
   *
   * Returns true once the wait has elapsed. Never rejects and never fails the
   * caller's send — this is pacing, not a delivery guarantee.
   */
  async waitForDelivery(messageId?: string | null, delayMs?: number): Promise<boolean> {
    const budget = delayMs ?? WhatsAppService.OUTBOUND_ORDERING_DELAY_MS
    if (budget <= 0) return true
    // A tiny floor even for a zero/short budget: sending in the same instant as
    // the previous message is exactly the race we are avoiding.
    await new Promise((r) => setTimeout(r, Math.max(2_000, budget)))
    return true
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
      }

      // (#132001) "Template name does not exist in the translation" — the
      // requested language code does not match the template's registered
      // language (e.g. template is "en_US" but we asked for "en", or vice
      // versa). Retry once with the alternate code instead of failing.
      if (result?.error?.code === 132001) {
        const requestedLanguage = message.languageCode || "en"
        const altLanguage = requestedLanguage === "en_US" ? "en" : "en_US"
        logger.warn("Template language mismatch, retrying with alternate language", {
          destination,
          template: message.templateName,
          requestedLanguage,
          altLanguage,
        })
        const retryPayload = {
          ...payload,
          template: { ...payload.template, language: { code: altLanguage } },
        }
        const retryResponse = await fetch(`${this.baseUrl}/${this.config.phoneNumberId}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.config.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(retryPayload),
        })
        const retryResult = await retryResponse.json()
        if (retryResponse.ok && retryResult.messages && retryResult.messages[0]) {
          const messageId = retryResult.messages[0].id
          logger.info(`WhatsApp message sent via Meta (alternate language)`, { messageId, destination })
          return { success: true, messageId }
        }
        return {
          success: false,
          error: retryResult.error?.message || "Unknown error",
        }
      }

      const error = result.error?.message || "Unknown error"
      logger.error("Failed to send WhatsApp via Meta", { destination, error, response: result })
      return { success: false, error, errorCode: result.error?.code }
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

  /**
   * Session interactive message with quick-reply buttons.
   * Allowed within the 24-hour customer service window after any user reply —
   * does NOT require an approved template.
   */
  async sendInteractiveButtons(params: {
    phoneNumber: string
    body: string
    buttons: Array<{ id: string; title: string }>
    footer?: string
  }): Promise<SendMessageResult> {
    const destination = this.normalizePhoneNumber(params.phoneNumber)
    if (!this.isMetaConfigured() || !destination) {
      if (!destination) return { success: false, error: "Invalid phone number" }
      return { success: false, error: "Meta WhatsApp not configured" }
    }

    const interactive: Record<string, unknown> = {
      type: "button",
      body: { text: params.body },
      action: {
        buttons: params.buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    }
    if (params.footer) interactive.footer = { text: params.footer }

    try {
      const response = await fetch(`${this.baseUrl}/${this.config.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: destination,
          type: "interactive",
          interactive,
        }),
      })

      const result = await response.json()

      if (response.ok && result.messages && result.messages[0]) {
        return { success: true, messageId: result.messages[0].id }
      }
      const error = result.error?.message || "Unknown error"
      logger.error("Failed to send WhatsApp interactive buttons", { destination, error, response: result })
      return { success: false, error }
    } catch (error: any) {
      logger.error("Error sending WhatsApp interactive buttons", { destination, error: error.message })
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
  }): Promise<SendMessageResult> {
    // Default must match the template that actually exists on the WABA.
    // Falling back to "talent_outreach" (no suffix) means every outbound send
    // fails with #132001 "Template name does not exist" whenever the env var is
    // missing from a deployed environment.
    const templateName = process.env.WHATSAPP_TEMPLATE_TALENT_OUTREACH || "talent_outreach_v2"

    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: templateParam(params.candidateName, "there") },
            { type: "text", text: templateParam(params.jobTitle, "an open role") },
            { type: "text", text: templateParam(params.companyName, "our client") },
            { type: "text", text: templateParam(params.location, "Multiple locations") },
            { type: "text", text: templateParam(params.salary, "As per industry standards") }
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
    const templateName = process.env.WHATSAPP_TEMPLATE_SCREENING_INVITE || "screening_invite_v2"
    
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

  // Flow 2: Info Collection Templates

  async sendOutboundInfoRequest(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_OUTBOUND_INFO_REQUEST || "outbound_info_request"
    
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

  async sendInboundInfoRequest(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_INBOUND_INFO_REQUEST || "inbound_info_request"
    
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

  // Flow A: Portal applicant shortlist + schedule (shortlist_call_schedule).
  // Talent-portal applicants already filled CTC / notice at apply time, so this
  // is the only WhatsApp message they receive before the AI screening call —
  // no 7-field info ask. Button replies (Call Now / In 10 min / In 30 min) schedule
  // the call directly. Tries the latest approved-name templates first, falling back
  // on template-level Graph errors (not yet approved / not found in translation) so
  // a freshly created _v2 can roll out without downtime and without a new deploy.
  async sendShortlistSchedule(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const preferred = (process.env.WHATSAPP_TEMPLATE_SHORTLIST_SCHEDULE || "").trim()
    const templateNames = [
      preferred,
      "shortlist_call_schedule_v2",
      "shortlist_call_schedule",
    ].filter((t) => !!t)

    let lastResult: SendMessageResult | null = null
    for (const templateName of templateNames) {
      const attempts = [
        { languageCode: "en_US" },
        { languageCode: "en" },
      ]
      for (const a of attempts) {
        lastResult = await this.sendTemplateMessage({
          to: params.phoneNumber,
          languageCode: a.languageCode,
          templateName,
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: templateParam(params.candidateName, "there") },
                { type: "text", text: templateParam(params.jobTitle, "an open role") },
                { type: "text", text: templateParam(params.companyName, "our client") }
              ]
            }
          ]
        })
        if (lastResult.success) return lastResult
      }
      // Abort unless the failure is a template-level problem worth switching
      // names for (unapproved template, missing translation, missing text).
      const code = Number((lastResult || {}).errorCode || 0)
      const retryable = [
        131042, // Message template in non-approved state
        131047, // Template paused / not ready
        132000, // Missing template text
        132001, // Template name does not exist in the translation
      ].includes(code)
      if (!retryable) break
    }

    return lastResult || { success: false, error: "Failed to send shortlist schedule" }
  }

  async sendInfoReceivedConfirm(params: {
    phoneNumber: string
    candidateName: string
    currentCtc: string
    expectedCtc: string
    noticePeriod: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_INFO_RECEIVED_CONFIRM || "info_received_confirm"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.currentCtc },
            { type: "text", text: params.expectedCtc },
            { type: "text", text: params.noticePeriod }
          ]
        }
      ]
    })
  }

  async sendInfoReminder(params: {
    phoneNumber: string
    candidateName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_INFO_REMINDER || "info_reminder"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
          ]
        }
      ]
    })
  }

  async sendAiCallReassurance(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_AI_CALL_REASSURANCE || "ai_call_reassurance"
    
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

  // Flow 3: Rejection Reason Template

  async sendNotInterestedReason(params: {
    phoneNumber: string
    candidateName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_NOT_INTERESTED_REASON || "not_interested_reason"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName }
          ]
        }
      ]
    })
  }

  // Flow 4: Extended Info Collection Template

  async sendDetailedInfoRequest(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    console.log("[WHATSAPP] sendDetailedInfoRequest called:", { phoneNumber: params.phoneNumber, candidateName: params.candidateName })
    const templateName = process.env.WHATSAPP_TEMPLATE_DETAILED_INFO_REQUEST || "detailed_info_request"
    console.log("[WHATSAPP] Using template:", templateName)
    
    const result = await this.sendTemplateMessage({
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
    console.log("[WHATSAPP] sendDetailedInfoRequest result:", result)
    return result
  }

  // WhatsApp Flow form — the structured replacement for detailed_info_request.
  // The template's FLOW button opens the candidate screening form; submissions
  // come back to the webhook as interactive nfm_reply with response_json,
  // correlated via flow_token.
  //
  // The v2 form asks only the 5 fields we actually need the candidate to confirm
  // (CTC, expected CTC, notice period, relocation, reason for switching). Total
  // experience and current location are trusted from the resume, so asking for
  // them only produced friction and inflated "collected" counts.
  //
  // v2 is tried first and we fall back to the approved 7-field v1 on
  // template-level errors, so it goes live the moment Meta approves it — no
  // deploy, and no candidate is left without a form while it is pending.
  async sendCollectInfoForm(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
    flowToken: string
  }): Promise<SendMessageResult> {
    const preferred = (process.env.WHATSAPP_TEMPLATE_COLLECT_INFO_FORM || "").trim()
    // Order matters and deliberately SKIPS v2.
    //
    // v3 (collect_info_form_v3) is the corrected 5-field flow — its footer maps
    // every input, so submissions carry real values.
    //
    // v2 is deliberately excluded: its footer payload is `{}`, so every
    // submission arrived as an empty object and candidate data was thrown away.
    // Falling back to it would silently reintroduce that data loss. It is only
    // used if explicitly pinned via WHATSAPP_TEMPLATE_COLLECT_INFO_FORM, and
    // until v3 is approved the working 7-field v1 (collect_info_form) takes over
    // so no candidate is left without a form.
    const candidates: Array<{ templateName: string; screen: string }> = [
      { templateName: preferred, screen: "DETAILS_SCREEN" },
      { templateName: "collect_info_form_v3", screen: "DETAILS_SCREEN" },
      { templateName: "collect_info_form", screen: "DETAILS_SCREEN" },
    ].filter((c) => !!c.templateName)

    let lastResult: SendMessageResult | null = null
    for (const { templateName, screen } of candidates) {
      const attempts = [{ languageCode: "en_US" }, { languageCode: "en" }]
      for (const a of attempts) {
        lastResult = await this.sendTemplateMessage({
          to: params.phoneNumber,
          languageCode: a.languageCode,
          templateName,
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: templateParam(params.candidateName, "there") },
                { type: "text", text: templateParam(params.jobTitle, "an open role") },
                { type: "text", text: templateParam(params.companyName, "our client") },
              ],
            },
            {
              type: "button",
              sub_type: "flow",
              index: "0",
              parameters: [
                {
                  type: "action",
                  action: {
                    flow_token: params.flowToken,
                    flow_action_data: { screen },
                  },
                },
              ],
            },
          ],
        })
        if (lastResult.success) return lastResult
      }
      const code = Number((lastResult || {}).errorCode || 0)
      const retryable = [
        131042, // Message template in non-approved state
        131047, // Template paused / not ready
        132000, // Missing template text
        132001, // Template name does not exist in the translation
      ].includes(code)
      if (!retryable) break
    }

    return lastResult || { success: false, error: "Failed to send the details form" }
  }

  // Flow 5: Screening Decision (filtered out)

  async sendScreeningFilteredOut(params: {
    phoneNumber: string
    candidateName: string
    reason: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_SCREENING_FILTERED_OUT || "screening_filtered_out"
    
    return this.sendTemplateMessage({
      to: params.phoneNumber,
      templateName,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: params.candidateName },
            { type: "text", text: params.reason }
          ]
        }
      ]
    })
  }

  // Flow 6: Second Reminder Nudge (for multi-attempt campaigns)

  async sendSecondReminderNudge(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_SECOND_REMINDER || "second_reminder_nudge"
    
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
  // Flow 7: Info Review Pending (HR reviewing candidate profile)

  async sendInfoReviewPending(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_INFO_REVIEW_PENDING || "info_review_pending"
    
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

  async sendCallCompleted(params: {
    phoneNumber: string
    candidateName: string
    jobTitle: string
    companyName: string
  }): Promise<SendMessageResult> {
    const templateName = process.env.WHATSAPP_TEMPLATE_CALL_COMPLETED || "call_completed"
    
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
