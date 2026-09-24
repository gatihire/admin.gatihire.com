// Shared Bolna screening-call orchestrator.
// Single code path for creating a phone_screening_campaign + participants and
// placing the Bolna calls. Used by /api/phone-screening/trigger (existing) and
// /api/jobs/[id]/juicebox/call (Juicebox outbound).
// Preserves the exact behavior of the previous inline trigger implementation.

import { supabaseAdmin } from "@/lib/supabase"
import { placeBolnaCall } from "@/lib/bolna"
import { getWhatsAppService } from "@/lib/whatsapp"
import { generateJDQuestions } from "@/lib/jd-questions"
import { scheduleOutreachFollowup, scheduleBolnaCall, outreachNudgeHours, outreachEscalateHours } from "@/lib/scheduled-call"
import { type CandidateOrigin } from "@/lib/origin"
import { logger } from "@/lib/logger"

/** Batch size for WhatsApp sends — delay between batches to avoid rate limits. */
const WHATSAPP_BATCH_SIZE = 50
const WHATSAPP_BATCH_DELAY_MS = 5_000

export interface ScreeningCandidate {
  id: string
  name?: string | null
  phone?: string | null
  current_role?: string | null
  current_company?: string | null
  total_experience?: string | number | null
  location?: string | null
  technical_skills?: unknown
  resume_text?: string | null
}

const ROLE_CATEGORY_MAP: Record<string, string> = {
  last_mile_delivery: "Driver / Fleet",
  line_haul: "Driver / Fleet",
  long_haul: "Driver / Fleet",
  fleet_operations: "Driver / Fleet",
  warehouse_operations: "Warehouse / Ops",
}

const DEPARTMENT_CATEGORY_MAP: Record<string, string> = {
  fleet: "Driver / Fleet",
  dispatch: "Driver / Fleet",
  warehouse: "Warehouse / Ops",
  operations: "SCM Planning / TMS",
}

const SALARY_TYPE_TEXT: Record<string, string> = {
  monthly: "per month",
  daily: "per day",
  per_trip: "per trip",
  hourly: "per hour",
}

function inferJobCategory(job: any): string {
  const role = String(job.role_category || "").toLowerCase()
  if (ROLE_CATEGORY_MAP[role]) return ROLE_CATEGORY_MAP[role]

  const dept = String(job.department_category || "").toLowerCase()
  if (DEPARTMENT_CATEGORY_MAP[dept]) return DEPARTMENT_CATEGORY_MAP[dept]

  const title = `${job.title || ""} ${job.industry || ""}`.toLowerCase()
  if (/(sales|business development|bd|account manager|corporate|key account)/.test(title)) return "Corporate / Sales / BD"
  if (/(scm|supply chain|planning|forecast|tms|transport management|operations)/.test(title)) return "SCM Planning / TMS"
  if (/(warehouse|store|inventory|loader)/.test(title)) return "Warehouse / Ops"
  if (/(driver|fleet|delivery|route|transport)/.test(title)) return "Driver / Fleet"
  return ""
}

function buildBusinessTypeContext(job: any, client: any): string {
  const bits: string[] = []
  if (client?.company_subtype) bits.push(String(client.company_subtype))
  if (job?.industry) bits.push(String(job.industry))
  return bits.length ? bits.join(", ") : "a growing logistics and supply chain company"
}

function buildJobGist(job: any): string {
  if (job?.daily_work_summary) return String(job.daily_work_summary)
  if (Array.isArray(job?.key_responsibilities) && job.key_responsibilities.length) {
    return job.key_responsibilities.slice(0, 3).map(String).join(". ")
  }
  return `A ${job?.employment_type || ""} ${job?.work_type || ""} role`.trim() || job?.title || ""
}

function formatSalaryRange(job: any): string {
  const min = job?.salary_min
  const max = job?.salary_max
  const type = SALARY_TYPE_TEXT[String(job?.salary_type || "").toLowerCase()] || ""
  if (min != null && max != null) return `Rs ${min} - ${max}${type ? ` ${type}` : ""}`
  if (min != null) return `Rs ${min}${type ? ` ${type}` : ""}`
  if (max != null) return `Rs ${max}${type ? ` ${type}` : ""}`
  return ""
}

type CallUserDataResult = {
  userData: Record<string, unknown>
  generatedQuestions: string[]
  geminiPromptUsed: string
}

async function buildCallUserData(
  candidate: ScreeningCandidate,
  job: any,
  client: any,
  origin: string,
  participantId?: string
): Promise<CallUserDataResult> {
  const { questions, promptUsed } = await generateJDQuestions(job, candidate as any)
  const userData = {
    candidate_name: candidate.name || "",
    current_role: candidate.current_role || "",
    current_company: candidate.current_company || "",
    total_experience: candidate.total_experience != null ? String(candidate.total_experience) : "",
    location: candidate.location || "",
    skills: Array.isArray(candidate.technical_skills)
      ? (candidate.technical_skills as string[]).join(", ")
      : candidate.technical_skills || "",
    resume_text: candidate.resume_text || "",
    job_title: job.title || "",
    client_name: job.client_name || "",
    hiring_company_name: job.client_name || client?.name || "",
    business_type_context: buildBusinessTypeContext(job, client),
    job_gist: buildJobGist(job),
    salary_range: formatSalaryRange(job),
    job_category: inferJobCategory(job),
    must_have_skills: Array.isArray(job.skills_must_have)
      ? (job.skills_must_have as string[]).join(", ")
      : job.skills_must_have || "",
    job_location: job.city || "",
    experience_min: job.experience_min_years != null ? String(job.experience_min_years) : "",
    experience_max: job.experience_max_years != null ? String(job.experience_max_years) : "",
    origin,
    questions: questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    timezone: "",
    participant_id: participantId || "",
  }
  return { userData, generatedQuestions: questions, geminiPromptUsed: promptUsed }
}

export interface OrchestrateScreeningInput {
  job: any
  client: any
  candidates: ScreeningCandidate[]
  originByCandidate: Map<string, CandidateOrigin>
  fallbackOrigin: CandidateOrigin
  createdBy: string
  /** "call_now": place AI call immediately. */
  /** "quick_screen": WhatsApp outreach with buttons (Interested/Not Interested/Call Now). */
  /** "collect_info_first": single detailed_info_request template, parse all fields, pre-screen, then call. */
  callMode?: "call_now" | "quick_screen" | "collect_info_first"
  /** Per-job campaign config */
  campaignConfig?: {
    nudgeHours?: number
    escalateHours?: number
    maxCallAttempts?: number
    /** Pre-screen thresholds (for collect_info_first) */
    preScreen?: {
      salaryTolerancePercent?: number    // default 40 - expected CTC within job range ±40%
      experienceMinPercent?: number      // default 50 - min 50% of job min experience
      experienceMaxPercent?: number      // default 200 - max 200% of job max experience
      maxNoticePeriodDays?: number       // default 120 - flag if notice > 120 days
    }
  }
}

export interface OrchestrateScreeningResult {
  campaignId: string
  totalCandidates: number
  callsTriggered: number
  callsFailed: number
  nudgeSent: number
  skippedNoPhone: string[]
  errors?: string[]
}

export async function orchestrateScreening(input: OrchestrateScreeningInput): Promise<OrchestrateScreeningResult> {
  const { job, client, candidates, originByCandidate, fallbackOrigin, createdBy } = input
  const callMode: "call_now" | "quick_screen" | "collect_info_first" = input.callMode || "call_now"
  const isQuickScreen = callMode === "quick_screen"
  const isCollectInfoFirst = callMode === "collect_info_first"

  // Per-job campaign config (with sensible defaults)
  const nudgeH = input.campaignConfig?.nudgeHours ?? outreachNudgeHours()
  const escalateH = input.campaignConfig?.escalateHours ?? outreachEscalateHours()
  const maxAttempts = input.campaignConfig?.maxCallAttempts ?? 2
  
  // Pre-screen config (for collect_info_first)
  const preScreenConfig = {
    salaryTolerancePercent: input.campaignConfig?.preScreen?.salaryTolerancePercent ?? 40,
    experienceMinPercent: input.campaignConfig?.preScreen?.experienceMinPercent ?? 50,
    experienceMaxPercent: input.campaignConfig?.preScreen?.experienceMaxPercent ?? 200,
    maxNoticePeriodDays: input.campaignConfig?.preScreen?.maxNoticePeriodDays ?? 120,
  }

  const validCandidates = candidates.filter((c) => c.phone)
  const skippedNoPhone = candidates
    .filter((c) => !c.phone)
    .map((c) => c.name || c.id)
    .filter(Boolean)

  if (validCandidates.length === 0) {
    throw new Error("No candidates with phone numbers found")
  }

  const { data: campaign, error: campaignError } = await supabaseAdmin
    .from("phone_screening_campaigns")
    .insert({
      job_id: job.id,
      created_by: createdBy,
      total_candidates: validCandidates.length,
      status: "in_progress",
      nudge_hours: nudgeH,
      escalate_hours: escalateH,
      max_call_attempts: maxAttempts,
    })
    .select()
    .single()

  if (campaignError || !campaign) {
    throw new Error("Failed to create campaign")
  }

  const participantRows = validCandidates.map((c) => {
    const origin = originByCandidate.get(c.id) || fallbackOrigin || "inbound"
    return {
      campaign_id: campaign.id,
      candidate_id: c.id,
      job_id: job.id,
      status: isCollectInfoFirst ? "info_requested" : isQuickScreen ? "whatsapp_sent" : "calling",
      origin,
      info_step: isCollectInfoFirst ? "collect_all" : null,
      info_data: isCollectInfoFirst ? {} : null,
      info_confirmed: isCollectInfoFirst ? false : null,
      screening_mode: callMode,
    }
  })

  const { data: insertedParticipants, error: insertError } = await supabaseAdmin
    .from("phone_screening_participants")
    .insert(participantRows)
    .select("id, candidate_id")

  if (insertError) {
    console.error("[ORCHESTRATOR] Insert participants error:", insertError)
    await supabaseAdmin.from("phone_screening_campaigns").delete().eq("id", campaign.id)
    throw new Error(`Failed to add participants: ${insertError.message} (code: ${insertError.code})`)
  }

  const participantByCandidate = new Map<string, string>()
  for (const p of insertedParticipants || []) {
    participantByCandidate.set(p.candidate_id, p.id)
  }

  let triggered = 0
  let failed = 0
  let nudgeSent = 0
  const errors: string[] = []

  for (let i = 0; i < validCandidates.length; i++) {
    const candidate = validCandidates[i]
    const origin = originByCandidate.get(candidate.id) || "outbound"
    const participantId = participantByCandidate.get(candidate.id)

    // Batch delay: pause between batches to avoid WhatsApp rate limits
if (i > 0 && i % WHATSAPP_BATCH_SIZE === 0) {
      logger.info(`WhatsApp batch delay: pausing ${WHATSAPP_BATCH_DELAY_MS}ms after ${i} messages`)
      await new Promise(resolve => setTimeout(resolve, WHATSAPP_BATCH_DELAY_MS))
    }

    // ==================== QUICK SCREEN MODE ====================
    // WhatsApp outreach with buttons (Interested/Not Interested/Call Now)
    if (isQuickScreen) {
      const { userData, generatedQuestions, geminiPromptUsed } = await buildCallUserData(candidate, job, client, origin, participantId)
      const whatsapp = getWhatsAppService()
      
      // Send appropriate template based on origin
      // Outbound: talent_outreach (MARKETING) - HR reaching out to candidates
      // Inbound: inbound_screening_invite (UTILITY) - Candidate applied via board-app
      const outreachResult = origin === "inbound"
        ? await whatsapp.sendInboundScreeningInvite({
            phoneNumber: candidate.phone as string,
            candidateName: candidate.name || "",
            jobTitle: job.title || "",
            companyName: job.client_name || client?.name || "",
          })
        : await whatsapp.sendTalentOutreach({
            phoneNumber: candidate.phone as string,
            candidateName: candidate.name || "",
            jobTitle: job.title || "",
            companyName: job.client_name || client?.name || "",
            location: job.city || "",
            salary: formatSalaryRange(job),
          })

      if (outreachResult.success) {
        const history = [{
          messageId: outreachResult.messageId || null,
          template: origin === "inbound" ? "inbound_screening_invite" : "talent_outreach",
          sentAt: new Date().toISOString(),
          status: "sent",
        }]
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: "whatsapp_sent",
            whatsapp_message_id: outreachResult.messageId || null,
            whatsapp_sent_at: new Date().toISOString(),
            whatsapp_delivery_status: "sent",
            whatsapp_outbound_template: origin === "inbound" ? "inbound_screening_invite" : "talent_outreach",
            whatsapp_outbound_params: { jobTitle: job.title, location: job.city, salaryBudget: formatSalaryRange(job) },
            whatsapp_history: history,
            call_payload_json: userData,
            generated_questions: generatedQuestions.join("\n"),
            gemini_prompt_used: geminiPromptUsed,
            screening_context: {
              jobTitle: job.title,
              clientName: job.client_name || client?.name || "",
              origin,
              salaryRange: formatSalaryRange(job),
              mustHaveSkills: Array.isArray(job.skills_must_have) ? job.skills_must_have.join(", ") : job.skills_must_have || "",
              experienceRange: `${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"}`,
              location: job.city || "",
            },
            updated_at: new Date().toISOString(),
          })
          .eq("campaign_id", campaign.id)
          .eq("candidate_id", candidate.id)
        nudgeSent++

        // Schedule follow-up nudge/escalate
        if (participantId) {
          await scheduleOutreachFollowup(participantId, "nudge", nudgeH * 60 * 60)
          await scheduleOutreachFollowup(participantId, "escalate", escalateH * 60 * 60)
        }
      } else {
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: "needs_manual_followup",
            needs_manual_followup: true,
            updated_at: new Date().toISOString(),
          })
          .eq("campaign_id", campaign.id)
          .eq("candidate_id", candidate.id)
        failed++
        errors.push(`${candidate.name}: outreach send failed (${outreachResult.error})`)
      }
      continue
    }

    // ==================== COLLECT INFO FIRST MODE ====================
    // Single detailed_info_request template, parse all fields, pre-screen, then call
    if (isCollectInfoFirst) {
      const { userData, generatedQuestions, geminiPromptUsed } = await buildCallUserData(candidate, job, client, origin, participantId)
      const whatsapp = getWhatsAppService()
      
      // Use detailed_info_request template (no buttons, free-text)
      // Works for both inbound and outbound
      const infoResult = await whatsapp.sendDetailedInfoRequest({
        phoneNumber: candidate.phone as string,
        candidateName: candidate.name || "",
        jobTitle: job.title || "",
        companyName: job.client_name || client?.name || "",
      })

      if (infoResult.success) {
        const history = [{
          messageId: infoResult.messageId || null,
          template: "detailed_info_request",
          sentAt: new Date().toISOString(),
          status: "sent",
        }]
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: "info_requested",
            screening_mode: "collect_info_first",
            whatsapp_message_id: infoResult.messageId || null,
            whatsapp_sent_at: new Date().toISOString(),
            whatsapp_delivery_status: "sent",
            whatsapp_outbound_template: "detailed_info_request",
            whatsapp_history: history,
            call_payload_json: userData,
            generated_questions: generatedQuestions.join("\n"),
            gemini_prompt_used: geminiPromptUsed,
            screening_context: {
              jobTitle: job.title,
              clientName: job.client_name || client?.name || "",
              origin,
              salaryRange: formatSalaryRange(job),
              mustHaveSkills: Array.isArray(job.skills_must_have) ? job.skills_must_have.join(", ") : job.skills_must_have || "",
              experienceRange: `${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"}`,
              location: job.city || "",
              preScreenConfig: preScreenConfig,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("campaign_id", campaign.id)
          .eq("candidate_id", candidate.id)
        nudgeSent++

        // Schedule follow-up nudge/escalate for no-reply
        if (participantId) {
          await scheduleOutreachFollowup(participantId, "nudge", nudgeH * 60 * 60)
          await scheduleOutreachFollowup(participantId, "escalate", escalateH * 60 * 60)
        }
      } else {
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: "needs_manual_followup",
            needs_manual_followup: true,
            updated_at: new Date().toISOString(),
          })
          .eq("campaign_id", campaign.id)
          .eq("candidate_id", candidate.id)
        failed++
        errors.push(`${candidate.name}: detailed info request failed (${infoResult.error})`)
      }
      continue
    }

    // ==================== CALL NOW MODE ====================
    // Place AI call immediately with no WhatsApp pre-message
    const { userData, generatedQuestions, geminiPromptUsed } = await buildCallUserData(candidate, job, client, origin, participantId)

    const result = await placeBolnaCall({
      to: candidate.phone as string,
      userData,
    })

    if (result.success && result.executionId) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "calling",
          bolna_execution_id: result.executionId,
          bolna_status: "queued",
          call_attempts: 1,
          last_attempt_at: new Date().toISOString(),
          call_payload_json: userData,
          generated_questions: generatedQuestions.join("\n"),
          gemini_prompt_used: geminiPromptUsed,
          screening_context: {
            jobTitle: job.title,
            clientName: job.client_name || client?.name || "",
            origin,
            salaryRange: formatSalaryRange(job),
            mustHaveSkills: Array.isArray(job.skills_must_have) ? job.skills_must_have.join(", ") : job.skills_must_have || "",
            experienceRange: `${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"}`,
            location: job.city || "",
          },
          updated_at: new Date().toISOString(),
        })
        .eq("campaign_id", campaign.id)
        .eq("candidate_id", candidate.id)
      triggered++
    } else {
      // Store call_payload_json even on failure so retries via QStash have full context
      const retryMinutes = 15
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "failed",
          call_payload_json: userData,
          generated_questions: generatedQuestions.join("\n"),
          gemini_prompt_used: geminiPromptUsed,
          next_retry_at: new Date(Date.now() + retryMinutes * 60 * 1000).toISOString(),
          screening_context: {
            jobTitle: job.title,
            clientName: job.client_name || client?.name || "",
            origin,
            salaryRange: formatSalaryRange(job),
            mustHaveSkills: Array.isArray(job.skills_must_have) ? job.skills_must_have.join(", ") : job.skills_must_have || "",
            experienceRange: `${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"}`,
            location: job.city || "",
          },
          updated_at: new Date().toISOString(),
        })
        .eq("campaign_id", campaign.id)
        .eq("candidate_id", candidate.id)

      // Schedule retry via QStash
      if (participantId) {
        const scheduled = await scheduleBolnaCall(participantId, retryMinutes * 60)
        if (!scheduled.scheduled) {
          logger.warn("Failed to schedule retry for call_now failure", { participantId, error: scheduled.error })
        }
      }

      failed++
      errors.push(`${candidate.name}: ${result.error}`)
    }
  }

  const campaignStatus =
    failed > 0 && nudgeSent === 0 && failed === validCandidates.length ? "completed" : "in_progress"
  await supabaseAdmin
    .from("phone_screening_campaigns")
    .update({ status: campaignStatus, updated_at: new Date().toISOString() })
    .eq("id", campaign.id)

  return {
    campaignId: campaign.id,
    totalCandidates: validCandidates.length,
    callsTriggered: triggered,
    callsFailed: failed,
    nudgeSent,
    skippedNoPhone,
    errors: errors.length > 0 ? errors : undefined,
  }
}

export { inferJobCategory, buildBusinessTypeContext, buildJobGist, formatSalaryRange }
export type { CandidateOrigin }
