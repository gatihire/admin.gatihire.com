// Shared Bolna screening-call orchestrator.
// Single code path for creating a phone_screening_campaign + participants and
// placing the Bolna calls. Used by /api/phone-screening/trigger (existing) and
// /api/jobs/[id]/juicebox/call (Juicebox outbound).
// Preserves the exact behavior of the previous inline trigger implementation.

import { supabaseAdmin } from "@/lib/supabase"
import { placeBolnaCall } from "@/lib/bolna"
import { aisensyService } from "@/lib/aisensy"
import { generateJDQuestions } from "@/lib/jd-questions"
import { scheduleOutreachFollowup, outreachNudgeHours, outreachEscalateHours } from "@/lib/scheduled-call"
import { getBoardAppBaseUrl } from "@/lib/utils"
import { type CandidateOrigin } from "@/lib/origin"
import { logger } from "@/lib/logger"

/** Delay before placing a call after the pre-call WhatsApp context (ms). */
const PRE_CALL_DELAY_MS = Number(process.env.SCREENING_PRE_CALL_DELAY_MS) || 60_000

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
  /** "whatsapp_first": send an Aisensy nudge before calling (outbound only). */
  callMode?: "call_now" | "whatsapp_first"
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
  const callMode: "call_now" | "whatsapp_first" = input.callMode || "call_now"
  const whatsappFirst = callMode === "whatsapp_first"

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
      // WhatsApp-first: every candidate gets the WhatsApp context outreach first
      // (4.1 outbound / 4.2 shortlisted inbound). call_now bypasses WhatsApp.
      status: whatsappFirst ? "whatsapp_sent" : "calling",
      origin,
    }
  })

  const { data: insertedParticipants, error: insertError } = await supabaseAdmin
    .from("phone_screening_participants")
    .insert(participantRows)
    .select("id, candidate_id")

  if (insertError) {
    await supabaseAdmin.from("phone_screening_campaigns").delete().eq("id", campaign.id)
    throw new Error("Failed to add participants")
  }

  const participantByCandidate = new Map<string, string>()
  for (const p of insertedParticipants || []) {
    participantByCandidate.set(p.candidate_id, p.id)
  }

  let triggered = 0
  let failed = 0
  let nudgeSent = 0
  const errors: string[] = []

  for (const candidate of validCandidates) {
    const origin = originByCandidate.get(candidate.id) || "outbound"
    const participantId = participantByCandidate.get(candidate.id)

    if (whatsappFirst) {
      const { userData, generatedQuestions, geminiPromptUsed } = await buildCallUserData(candidate, job, client, origin, participantId)
      const jobLink = `${getBoardAppBaseUrl()}/board/${job.id}`
      const outreachResult = await aisensyService.sendOutreachMessage(
        candidate.phone as string,
        candidate.name || "",
        {
          jobTitle: job.title || "",
          location: job.city || "",
          salaryBudget: formatSalaryRange(job),
          jobLink,
        },
        { shortlisted: origin === "inbound" }
      )

      if (outreachResult.success) {
        const history = [{
          messageId: outreachResult.messageId || null,
          template: origin === "inbound" ? "outreach_shortlisted" : "outreach_context",
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
            whatsapp_outbound_template: origin === "inbound" ? "outreach_shortlisted" : "outreach_context",
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

        // No blind calls. If the candidate stays silent we send one WhatsApp
        // reminder at +4h, then hand over to a human recruiter at +8h.
        if (participantId) {
          await scheduleOutreachFollowup(participantId, "nudge", outreachNudgeHours() * 60 * 60)
          await scheduleOutreachFollowup(participantId, "escalate", outreachEscalateHours() * 60 * 60)
        }
      } else {
        // Outreach failed to send → surface for manual follow-up.
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

    const { userData, generatedQuestions, geminiPromptUsed } = await buildCallUserData(candidate, job, client, origin, participantId)

    // Pre-call WhatsApp: always send context so the candidate expects the call.
    // In call_now mode this is the only WhatsApp; in whatsapp_first mode the
    // outreach was already sent above.
    let preCallMessageId: string | null = null
    if (!whatsappFirst) {
      const jobLink = `${getBoardAppBaseUrl()}/board/${job.id}`
      const preCallResult = await aisensyService.sendOutreachMessage(
        candidate.phone as string,
        candidate.name || "",
        {
          jobTitle: job.title || "",
          location: job.city || "",
          salaryBudget: formatSalaryRange(job),
          jobLink,
        },
        { shortlisted: origin === "inbound" }
      )
      if (preCallResult.success) {
        preCallMessageId = preCallResult.messageId || null
        // Track WhatsApp history
        const history = [{
          messageId: preCallMessageId,
          template: "pre_call_context",
          sentAt: new Date().toISOString(),
          status: "sent",
        }]
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            whatsapp_outbound_template: "pre_call_context",
            whatsapp_outbound_params: { jobTitle: job.title, location: job.city },
            whatsapp_sent_at: new Date().toISOString(),
            whatsapp_delivery_status: "sent",
            whatsapp_history: history,
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
        logger.info(`Pre-call WhatsApp sent to ${candidate.name}`, { messageId: preCallMessageId })
      } else {
        logger.warn(`Pre-call WhatsApp failed for ${candidate.name}, proceeding with call anyway`, { error: preCallResult.error })
      }

      // Wait for the candidate to see the message before calling
      if (preCallResult.success && PRE_CALL_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, PRE_CALL_DELAY_MS))
      }
    }

    const result = await placeBolnaCall({
      to: candidate.phone as string,
      userData,
    })

    if (result.success && result.executionId) {
      const history = preCallMessageId
        ? [{ messageId: preCallMessageId, template: "pre_call_context", sentAt: new Date().toISOString(), status: "sent" }]
        : []
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
          whatsapp_message_id: preCallMessageId,
          whatsapp_history: history,
          updated_at: new Date().toISOString(),
        })
        .eq("campaign_id", campaign.id)
        .eq("candidate_id", candidate.id)
      triggered++
    } else {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("campaign_id", campaign.id)
        .eq("candidate_id", candidate.id)
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
