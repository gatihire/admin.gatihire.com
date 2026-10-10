// Shared Bolna screening-call orchestrator.
// Single code path for creating a phone_screening_campaign + participants and
// placing the Bolna calls. Used by /api/phone-screening/trigger (existing) and
// /api/jobs/[id]/juicebox/call (Juicebox outbound).
// Preserves the exact behavior of the previous inline trigger implementation.

import { supabaseAdmin } from "@/lib/supabase"
import { placeBolnaCall } from "@/lib/bolna"
import { getWhatsAppService, talentOutreachTemplateName } from "@/lib/whatsapp"
import { generateJDQuestions } from "@/lib/jd-questions"
import { buildAlreadyCollectedUserData, buildResumeInfo } from "@/lib/prompt-user-data"
import { scheduleOutreachFollowup, scheduleBolnaCall, outreachNudgeHours, outreachEscalateHours, prepareScheduleOffer, markScheduleOffer } from "@/lib/scheduled-call"
import { type CandidateOrigin, type CandidateFlow, deriveCandidateFlow } from "@/lib/origin"
import { type InfoSource, stampSources, mergeSources } from "@/lib/info-provenance"
import { updateParticipant } from "@/lib/participant-update"
import { logger } from "@/lib/logger"
import { getBoardAppBaseUrl } from "@/lib/utils"
import { sendSessionMessage } from "@/lib/info-collector-v2"
import { appendThreadEntry } from "@/lib/whatsapp-thread"

/**
 * Public job page the candidate can open to review the role before sharing
 * details. Deliberately the job-detail URL, not /apply: outbound candidates are
 * being screened for a role and may never apply, so linking an apply form would
 * imply they should.
 */
export function getPublicJobUrl(jobId: string): string {
  return `${getBoardAppBaseUrl()}/jobs/${jobId}`
}

/** All open roles — offered when a candidate declines so the relationship survives. */
export function getPortalJobsUrl(): string {
  return `${getBoardAppBaseUrl()}/jobs`
}

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
  source?: string | null
  current_ctc?: string | null
  expected_ctc?: string | null
  notice_period?: string | null
  /**
   * The `candidates.willing_to_relocate` COLUMN is a boolean (246 true / 17
   * false in production), while some intake paths write the string "yes"/"no".
   * The old seed only compared against "yes"/"no", so every real boolean value
   * failed the test and the answer was silently dropped — which is why cards
   * showed an empty relocation field for candidates who had answered it.
   */
  willing_to_relocate?: string | boolean | null
  reason_for_switching?: string | null
}

// Flow A (portal applicants) have compensation + profile details captured in the
// talent-portal apply form / candidate profile, so their already_collected_*
// fields are pre-seeded instead of asking for the 5-field WhatsApp request.
// Only fields we genuinely know are set — anything unset stays "Not provided on
// WhatsApp" in the call prompt and becomes a NEW-signal probe on the call.
//
// Total experience and current location are deliberately NOT seeded here: they
// come from the resume, we trust them, and we never ask the candidate to confirm
// them. Putting them in info_data made the portal count WhatsApp-collected fields
// we never actually collected. They reach the call via buildResumeInfo() so the
// AI still treats them as known and does not ask.
//
// Every key written here is stamped "application" in the returned
// info_sources, because that is where it came from. Without that stamp the UI
// rendered these values under "Confirmed by the candidate on WhatsApp", which is
// false — we never messaged them before they applied.
function seedAlreadyCollectedInfo(candidate: ScreeningCandidate): Record<string, unknown> {
  const info: Record<string, unknown> = {}
  if (candidate.current_ctc) info.current_ctc = String(candidate.current_ctc)
  if (candidate.expected_ctc) info.expected_ctc = String(candidate.expected_ctc)
  if (candidate.notice_period) info.notice_period = String(candidate.notice_period)
  if (candidate.reason_for_switching) info.reason_for_switching = String(candidate.reason_for_switching)

  // Accept the boolean column, plus the string forms some intake paths write,
  // and ignore sentinels like "void" (an unanswered optional form question).
  const relocation = candidate.willing_to_relocate
  if (relocation === true || relocation === "yes" || relocation === "Yes" || relocation === "true") {
    info.willing_to_relocate = "Yes"
  } else if (relocation === false || relocation === "no" || relocation === "No" || relocation === "false") {
    info.willing_to_relocate = "No"
  }

  return info
}

/** Provenance for whatever seedAlreadyCollectedInfo() just wrote. */
function seedInfoSources(candidate: ScreeningCandidate): Record<string, InfoSource> {
  return stampSources(Object.keys(seedAlreadyCollectedInfo(candidate)), "application")
}

/** The resume-only fields, kept separate so provenance stays honest. */
export { buildResumeInfo } from '@/lib/prompt-user-data'

type OutboundSendResult = { sent: boolean; error?: string; messageId?: string }

function screeningContextFor(job: any, client: any, origin: string, extra?: Record<string, unknown>) {
  return {
    jobTitle: job.title,
    clientName: job.client_name || client?.name || "",
    origin,
    salaryRange: formatSalaryRange(job),
    mustHaveSkills: Array.isArray(job.skills_must_have) ? job.skills_must_have.join(", ") : job.skills_must_have || "",
    experienceRange: `${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"}`,
    location: jobLocation(job),
    ...(extra || {}),
  }
}

// Flow A: send the shortlist + schedule template (portal applicants only) and
// mark the participant as already having their info (from the apply form).
async function sendShortlistMessage(opts: {
  candidate: ScreeningCandidate
  job: any
  client: any
  origin: string
  participantId?: string
  campaignId: string
  nudgeH: number
  escalateH: number
}): Promise<OutboundSendResult> {
  // Filtering by the exact participant id is stricter than the previous
  // campaign_id + candidate_id pair, which could have matched sibling rows for
  // the same candidate.
  const { candidate, job, client, origin, participantId, nudgeH, escalateH } = opts
  const whatsapp = getWhatsAppService()
  const seededInfo = seedAlreadyCollectedInfo(candidate)
  const { userData, generatedQuestions, geminiPromptUsed } = await buildCallUserData(
    candidate, job, client, origin, participantId, seededInfo
  )
  // The template promises a picker the gate may refuse. Run the clearance first
  // so we never tell a candidate to pick a time we will not honour — for portal
  // applicants this is where the pre-screen actually happens, since their flow
  // never sends the 7-field WhatsApp collection that runs it.
  if (participantId) {
    const offer = await prepareScheduleOffer(participantId)
    if (!offer.ok) {
      logger.warn("Shortlist slot picker withheld — call would be refused", {
        participantId,
        reason: offer.reason,
      })
      return { sent: false, error: offer.reason }
    }
  }

  const result = await whatsapp.sendShortlistSchedule({
    phoneNumber: candidate.phone as string,
    candidateName: candidate.name || "",
    jobTitle: job.title || "",
    companyName: job.client_name || client?.name || "",
  })
  if (!result.success) return { sent: false, error: result.error }
  if (!participantId) return { sent: true, messageId: result.messageId }
  await markScheduleOffer(participantId)

  const now = new Date().toISOString()
  // direction/text are what make the conversation view readable; legacy rows
  // without them fall back to a template description in the UI.
  const history = [{
    messageId: result.messageId || null,
    template: "shortlist_call_schedule",
    direction: "out",
    text: `You're shortlisted for ${job.title || "the role"} at ${job.client_name || client?.name || "our client"}. Pick a slot for a quick screening call.`,
    sentAt: now,
    status: "sent",
  }]
  // Preserve any provenance already recorded (e.g. an earlier WhatsApp answer the
  // candidate gave before this nudge) and add "application" for the seeded keys.
  // `screening_context` is read here too: prepareScheduleOffer and markScheduleOffer
  // wrote preScreenResult.decision and awaitingScheduleDecision into it just a few
  // lines above, and the write below must merge — not replace — or every slot tap
  // is refused by the eligibility gate ("pre-screen has not cleared this candidate").
  const { data: existing } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("info_sources, screening_context")
    .eq("id", participantId)
    .maybeSingle()

  // This one statement carries status, info_data, info_sources and the screening
  // context. A single bad column rejects the WHOLE update, leaving the candidate
  // looking un-nudged while the code believes the WhatsApp went out.
  // updateParticipant retries without info_sources if that column has not been
  // migrated yet, and throws for every other failure.
  await updateParticipant(participantId, {
    status: "whatsapp_sent",
    screening_mode: "collect_info_first",
    info_step: "confirmed",
    info_data: seededInfo,
    info_sources: mergeSources(existing?.info_sources, seedInfoSources(candidate)),
    info_confirmed: false,
    whatsapp_message_id: result.messageId || null,
    whatsapp_sent_at: now,
    whatsapp_delivery_status: "sent",
    whatsapp_outbound_template: "shortlist_call_schedule",
    whatsapp_outbound_params: { jobTitle: job.title, location: jobLocation(job), salaryBudget: formatSalaryRange(job) },
    whatsapp_history: history,
    call_payload_json: userData,
    generated_questions: generatedQuestions.join("\n"),
    gemini_prompt_used: geminiPromptUsed,
    screening_context: {
      ...((existing as any)?.screening_context || {}),
      ...screeningContextFor(job, client, origin),
    },
    updated_at: now,
  })

  await scheduleOutreachFollowup(participantId, "nudge", nudgeH * 60 * 60)
  await scheduleOutreachFollowup(participantId, "escalate", escalateH * 60 * 60)
  return { sent: true, messageId: result.messageId }
}

// Flow B (external resumes) + Flow C outbound interested step: send the
// WhatsApp Flows form (structured 7-field collect_info_form template), then
// pre-screen and call from the nfm_reply submission.
async function sendDetailedInfoMessage(opts: {
  candidate: ScreeningCandidate
  job: any
  client: any
  origin: string
  participantId?: string
  campaignId: string
  nudgeH: number
  escalateH: number
  preScreenConfig: Record<string, number>
}): Promise<OutboundSendResult> {
  const { candidate, job, client, origin, participantId, campaignId, nudgeH, escalateH, preScreenConfig } = opts
  const whatsapp = getWhatsAppService()
  const { userData, generatedQuestions, geminiPromptUsed } = await buildCallUserData(candidate, job, client, origin, participantId)
  const result = await whatsapp.sendCollectInfoForm({
    phoneNumber: candidate.phone as string,
    candidateName: candidate.name || "",
    jobTitle: job.title || "",
    companyName: job.client_name || client?.name || "",
    flowToken: participantId || candidate.id,
  })
  if (!result.success) return { sent: false, error: result.error }
  if (!participantId) return { sent: true, messageId: result.messageId }

  const now = new Date().toISOString()
  const history = [{
    messageId: result.messageId || null,
    template: "collect_info_form",
    direction: "out",
    // The rendered registry body, not a hand-written approximation.
    //
    // This used to record "Please share a few details so we can screen you for
    // <title>." while the template actually sends "Hi {{1}}, thanks for your
    // interest in the {{2}} position at {{3}}. Please share a few details in the
    // form below…" — so the thread dropped the greeting and the company name, and
    // a recruiter reading it could not tell the candidate had been addressed by
    // name. The fallback still names them, which is closer to the real body than
    // the fragment it replaces.
    text:
      result.renderedBody ||
      `Hi ${candidate.name || "there"}, thanks for your interest in the ${job.title || "open role"} position at ${job.client_name || "our client"}. Please share a few details in the form below so we can screen you for the role.`,
    sentAt: now,
    status: "sent",
  }]
  await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      status: "info_requested",
      screening_mode: "collect_info_first",
      info_step: "collect_form",
      info_data: {},
      info_confirmed: false,
      whatsapp_message_id: result.messageId || null,
      whatsapp_sent_at: now,
      whatsapp_delivery_status: "sent",
      whatsapp_outbound_template: "collect_info_form",
      whatsapp_history: history,
      call_payload_json: userData,
      generated_questions: generatedQuestions.join("\n"),
      gemini_prompt_used: geminiPromptUsed,
      screening_context: screeningContextFor(job, client, origin, { preScreenConfig, infoViaForm: true }),
      updated_at: now,
    })
    .eq("campaign_id", campaignId)
    .eq("candidate_id", candidate.id)
  await scheduleOutreachFollowup(participantId, "nudge", nudgeH * 60 * 60)
  await scheduleOutreachFollowup(participantId, "escalate", escalateH * 60 * 60)
  return { sent: true, messageId: result.messageId }
}

/**
 * Flow C (outbound) opener: matched-role outreach + job link, and STOP there.
 *
 * Outbound candidates have not opted in to anything yet. Asking a stranger for
 * their CTC before they have agreed to be considered reads as a data grab, so we
 * only sell the role and offer Interested / Not Interested. The details form is
 * sent later, from the `interested` case in the Meta webhook, and the call is
 * offered after the pre-screen passes.
 *
 * The job link rides in a separate session message because talent_outreach_v2 is
 * already approved with five body parameters; adding a sixth would require a new
 * Meta approval round before anything could be sent at all.
 */
async function sendOutboundWithJobLink(opts: {
  candidate: ScreeningCandidate
  job: any
  client: any
  origin: string
  participantId?: string
  campaignId: string
  nudgeH: number
  escalateH: number
  preScreenConfig: Record<string, number>
}): Promise<OutboundSendResult> {
  const { candidate, job, client, origin, participantId, campaignId, nudgeH, escalateH, preScreenConfig } = opts
  const { userData, generatedQuestions, geminiPromptUsed } = await buildCallUserData(
    candidate, job, client, origin, participantId
  )
const jobLink = getPublicJobUrl(job.id)

  // Hoisted so the values recorded in the thread are literally the values sent.
  // They were previously re-derived on each side and could drift apart.
  const outreachTemplate = talentOutreachTemplateName()
  const outreachLocation = jobLocation(job) || "Multiple locations"
  const outreachSalary = formatSalaryRange(job) || "As per industry standards"
  const outreachCompany = job.client_name || client?.name || "our client"

  const outreachResult = await getWhatsAppService().sendTalentOutreach({
    phoneNumber: candidate.phone as string,
    candidateName: candidate.name || "",
    jobTitle: job.title || "",
    companyName: outreachCompany,
    // talent_outreach_v2 has five required body parameters. Meta rejects the
    // whole send with #131008 if any one arrives empty, so a job with no city
    // and no salary took down the message rather than degrading the text.
    location: outreachLocation,
    salary: outreachSalary,
  })
  if (!outreachResult.success) return { sent: false, error: outreachResult.error }

  // Preserve the webhook idempotency ledger. Replacing screening_context wholesale
  // dropped processedMessages, so every message Meta had ever delivered for this
  // participant became "unseen" again: a single retry of an old webhook event was
  // then re-run as a fresh reply. Observed live — an old message was stamped as
  // processed at 05:48:14 against a nudge sent at 05:47:44.
  const { data: existingParticipant } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("id, screening_context")
    .eq("campaign_id", campaignId)
    .eq("candidate_id", candidate.id)
    .maybeSingle()
  const existingContext = (existingParticipant?.screening_context || {}) as Record<string, any>

  const now = new Date().toISOString()
  await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      status: "whatsapp_sent",
      screening_mode: "collect_info_first",
      // Nothing is asked until they opt in; the webhook moves this to
      // collect_form on Interested.
      info_step: "awaiting_interest",
      info_data: {},
      info_confirmed: false,
      whatsapp_message_id: outreachResult.messageId || null,
      whatsapp_sent_at: now,
      whatsapp_delivery_status: "sent",
      whatsapp_outbound_template: outreachTemplate,
      whatsapp_outbound_params: {
        jobTitle: job.title,
        location: jobLocation(job),
        salaryBudget: formatSalaryRange(job),
      },
      // whatsapp_history is deliberately NOT written here. Assigning it
      // replaced the whole array, so re-running outreach erased the entire
      // existing conversation — every prior reply, button tap and delivery
      // receipt — leaving a recruiter card that looked like a brand-new thread.
      // The thread is appended below instead.
      call_payload_json: userData,
      generated_questions: generatedQuestions.join("\n"),
      gemini_prompt_used: geminiPromptUsed,
      screening_context: {
        ...screeningContextFor(job, client, origin, { preScreenConfig }),
        ...existingContext,
        processedMessages: existingContext.processedMessages || {},
        awaitingInterest: true,
        jobUrl: jobLink,
      },
      updated_at: now,
    })
    .eq("campaign_id", campaignId)
    .eq("candidate_id", candidate.id)

  // Record only what we know is true: the template that was sent and the exact
  // parameter values it was sent with. The rendered body lives in Meta and cannot
  // be read back, so it is summarised from those values rather than invented.
  // The old hand-written sentence ("we have an opening for ... Would you be
  // interested?") bore no relation to the template the candidate actually read,
  // which showed location and salary and asked a different question.
  const resolvedParticipantId = participantId || existingParticipant?.id
  if (resolvedParticipantId) {
    await appendThreadEntry(resolvedParticipantId, {
      messageId: outreachResult.messageId || null,
      template: outreachResult.templateName || outreachTemplate,
      direction: "out",
      // The rendered registry body first: it is what the candidate read, name and
      // salary included. The parameter list below is only a fallback for a send
      // that produced no body, where the values are still true and the wording
      // is at least derived from the same parameters rather than invented.
      text: outreachResult.renderedBody || [
        `${candidate.name || "there"} — ${job.title || "an open role"} at ${outreachCompany}`,
        `Location: ${outreachLocation}`,
        `Salary: ${outreachSalary}`,
      ].join("\n"),
      sentAt: now,
      status: outreachResult.success ? "sent" : "failed",
      ...(outreachResult.success ? {} : { error: outreachResult.error ?? null }),
    })
  }

  if (jobLink) {
    // Hold the link back so it cannot overtake the outreach. Meta delivered a
    // free-form session message ~5s BEFORE the approved template sent just
    // before it, so the candidate saw a bare URL first and the message
    // introducing it second.
    await getWhatsAppService()
      .waitForDelivery(outreachResult.messageId)
      .catch(() => false)

    // Fire-and-forget: a failed link must not fail the outreach itself.
    const linkText = `Here's the full role details if you'd like to review it first:\n${jobLink}`
    const linkResult = await sendSessionMessage(candidate.phone as string, linkText).catch(() => null)
    if (participantId && linkResult?.success) {
      await appendThreadEntry(participantId, {
        direction: "out",
        text: linkText,
        status: "sent",
        kind: "job_link",
        messageId: linkResult.messageId ?? null,
      })
    }
  }

  if (participantId) {
    await scheduleOutreachFollowup(participantId, "nudge", nudgeH * 60 * 60)
    await scheduleOutreachFollowup(participantId, "escalate", escalateH * 60 * 60)
  }
  return { sent: true, messageId: outreachResult.messageId }
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

/**
 * Best available location string for a job.
 *
 * `jobs.city` is null on a large share of rows while `jobs.location` holds the
 * real value, so reading only `city` sent an empty string. That is not a
 * cosmetic bug: an empty template parameter makes Meta reject the entire send
 * with #131008 "Required parameter is missing", so every outbound nudge to such
 * a job silently failed.
 */
export function jobLocation(job: any): string {
  const candidates = [job?.city, job?.location, job?.work_location, job?.state]
  for (const c of candidates) {
    const v = String(c ?? "").trim()
    if (v) return v
  }
  return ""
}

/**
 * Render a job's salary for a candidate-facing message.
 *
 * Candidates read "Rs 500000 - 600000" as noise at best and as an error at
 * worst — Indian salary convention is lakhs per annum, so an annual figure in
 * raw rupees is both unreadable and easy to misread as monthly. Annual amounts
 * are converted to LPA; per-period amounts keep their unit.
 */
export function formatSalaryRange(job: any): string {
  const min = job?.salary_min
  const max = job?.salary_max
  const rawType = String(job?.salary_type || "").toLowerCase()

  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null
    const n = Number(v)
    return isNaN(n) ? null : n
  }
  const lo = num(min)
  const hi = num(max)

  if (lo == null && hi == null) return ""

  const isAnnual = rawType === "annual" || rawType === "yearly" || rawType === "pa" || rawType === "ctc"
  const unit = SALARY_TYPE_TEXT[rawType] || ""

  if (isAnnual) {
    // 500000/yr -> "5 LPA". Keep one decimal only when it carries information.
    const lpa = (n: number) => {
      const v = n / 100000
      return Number.isInteger(v) ? String(v) : v.toFixed(1)
    }
    if (lo != null && hi != null) return `${lpa(lo)} - ${lpa(hi)} LPA`
    return `${lpa((lo ?? hi)!)} LPA`
  }

  const suffix = unit ? ` ${unit}` : ""
  if (lo != null && hi != null) return `Rs ${lo} - ${hi}${suffix}`
  return `Rs ${lo ?? hi}${suffix}`
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
  participantId?: string,
  infoData?: Record<string, unknown> | null
): Promise<CallUserDataResult> {
  const { questions, promptUsed } = await generateJDQuestions(job, candidate as any, infoData)
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
    ...buildAlreadyCollectedUserData(infoData, buildResumeInfo(candidate)),
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
    job_location: jobLocation(job),
    experience_min: job.experience_min_years != null ? String(job.experience_min_years) : "",
    experience_max: job.experience_max_years != null ? String(job.experience_max_years) : "",
    origin,
    questions: questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    timezone: "",
    participant_id: participantId || "",
  }
  return { userData, generatedQuestions: questions, geminiPromptUsed: promptUsed }
}

export type ScreeningCallMode = "call_now" | "quick_screen" | "collect_info_first"

// Who decides the nudge type?
// The SYSTEM decides for the inbound flows based on how the candidate entered:
//   - Flow A (portal apply)   -> shortlist_call_schedule (info already in the apply form)
//   - Flow B (external resume)-> 7-field detailed_info_request
//   - Flow C (outbound)       -> HR's chosen mode wins (call_now / outreach / 7-field)
// So "call_now" is honored ONLY for outbound candidates; an HR clicking Call Now
// on a portal applicant or external resume still gets the WhatsApp-first flow.
export function systemDecidesMode(
  callMode: ScreeningCallMode | undefined,
  flow: string
): ScreeningCallMode {
  // An explicit call_now from HR wins. It used to be discarded for portal and
  // external candidates, so pressing "Call Now" silently became a re-collect:
  // the candidate was asked to answer the screening questions a second time
  // instead of getting a call. Flow defaults only apply when HR did not choose.
  if (callMode === "call_now") return "call_now"
  if (flow === "portal") return "quick_screen"
  if (flow === "external") return "collect_info_first"
  return callMode || "call_now"
}

export interface OrchestrateScreeningInput {
  job: any
  client: any
  candidates: ScreeningCandidate[]
  originByCandidate: Map<string, CandidateOrigin>
  fallbackOrigin: CandidateOrigin
  /** Application source per candidate (used to distinguish portal / external / outbound flows). */
  sourceByCandidate?: Map<string, string>
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

  // Flow classification with resilient fallbacks:
  //  1. application-derived source (preferred — candidate.source is often null)
  //  2. the candidate's own source column
  //  3. existing form data (current/expected CTC, notice) -> almost certainly a portal applicant
  const flowForCandidate = (c: ScreeningCandidate): CandidateFlow => {
    const origin = originByCandidate.get(c.id) || fallbackOrigin || "inbound"
    const src = input.sourceByCandidate?.get(c.id) || c.source
    let flow = deriveCandidateFlow(src, origin)
    if (flow !== "portal" && (c.current_ctc || c.expected_ctc || c.notice_period)) {
      flow = "portal"
    }
    return flow
  }

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
    const flow = flowForCandidate(c)
    // System decides the nudge type per candidate (see systemDecidesMode) —
    // HR's mode only matters for outbound candidates.
    const mode = systemDecidesMode(callMode, flow)
    // Flow A (portal): info already captured in the apply form -> shortlist +
    // schedule only, marked info as confirmed so no 5-field ask happens later.
    const isPortal = flow === "portal"
    const isCollect = mode === "collect_info_first"
    const seededInfo = isPortal ? seedAlreadyCollectedInfo(c) : null
    return {
      campaign_id: campaign.id,
      candidate_id: c.id,
      job_id: job.id,
      status: isPortal
        ? "whatsapp_sent"
        : isCollect
          ? "info_requested"
          : mode === "call_now"
            ? "calling"
            : "whatsapp_sent",
      origin,
      info_step: isPortal ? "confirmed" : isCollect ? "collect_all" : null,
      info_data: seededInfo ?? (isCollect ? {} : null),
      // Written next to info_data by the same expression, so the two can never
      // disagree about where a value came from.
      info_sources: seededInfo ? stampSources(Object.keys(seededInfo), "application") : {},
      info_confirmed: isPortal ? false : isCollect ? false : null,
      screening_mode: mode,
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
    const flow = flowForCandidate(candidate)
    const participantId = participantByCandidate.get(candidate.id)

    // THE SYSTEM decides the nudge type per candidate (see systemDecidesMode):
    // portal -> shortlist, external -> 7-field, only outbound honors HR's mode.
    const mode = systemDecidesMode(callMode, flow)
    const isQuickScreen = mode === "quick_screen"
    const isCollectInfoFirst = mode === "collect_info_first"

    // Batch delay: pause between batches to avoid WhatsApp rate limits
if (i > 0 && i % WHATSAPP_BATCH_SIZE === 0) {
      logger.info(`WhatsApp batch delay: pausing ${WHATSAPP_BATCH_DELAY_MS}ms after ${i} messages`)
      await new Promise(resolve => setTimeout(resolve, WHATSAPP_BATCH_DELAY_MS))
    }

    // ==================== QUICK SCREEN MODE ====================
    // WhatsApp outreach with buttons (Interested/Not Interested/Call Now)
    if (isQuickScreen) {
      // Flow A (portal): shortlist + schedule. Info already in the apply form.
      if (flow === "portal") {
        const shortlist = await sendShortlistMessage({
          candidate, job, client, origin, participantId,
          campaignId: campaign.id, nudgeH, escalateH,
        })
        if (shortlist.sent) nudgeSent++
        else {
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
          errors.push(`${candidate.name}: shortlist message failed (${shortlist.error})`)
        }
        continue
      }

      // Flow B (external resume): no form data -> 7-field WhatsApp ask.
      if (flow === "external") {
        const info = await sendDetailedInfoMessage({
          candidate, job, client, origin, participantId,
          campaignId: campaign.id, nudgeH, escalateH, preScreenConfig,
        })
        if (info.sent) nudgeSent++
        else {
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
          errors.push(`${candidate.name}: detailed info request failed (${info.error})`)
        }
        continue
      }

      // Flow C (outbound): talent_outreach with the job link, gated on interest.
      const outreach = await sendOutboundWithJobLink({
        candidate, job, client, origin, participantId,
        campaignId: campaign.id, nudgeH, escalateH,
        preScreenConfig,
      })
      if (outreach.sent) nudgeSent++
      else {
        failed++
        errors.push(`${candidate.name}: outreach send failed (${outreach.error})`)
      }
      continue
    }

    // ==================== COLLECT INFO FIRST MODE ====================
    // Single detailed_info_request template, parse all fields, pre-screen, then call
    if (isCollectInfoFirst) {
      // Flow A (portal): shortlist + schedule (info already in the apply form).
      if (flow === "portal") {
        const shortlist = await sendShortlistMessage({
          candidate, job, client, origin, participantId,
          campaignId: campaign.id, nudgeH, escalateH,
        })
        if (shortlist.sent) nudgeSent++
        else {
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
          errors.push(`${candidate.name}: shortlist message failed (${shortlist.error})`)
        }
        continue
      }

      // Flow C (outbound): the candidate has NOT opted in yet. Asking a
      // stranger for their CTC before they have agreed to anything reads as a
      // data grab, so outbound leads with the matched-role outreach (job link +
      // Interested / Not Interested). The form is only sent after they tap
      // Interested — see the `interested` case in the Meta webhook.
      if (flow === "outbound") {
        const outbound = await sendOutboundWithJobLink({
          candidate, job, client, origin, participantId,
          campaignId: campaign.id, nudgeH, escalateH, preScreenConfig,
        })
        if (outbound.sent) nudgeSent++
        else {
          failed++
          errors.push(`${candidate.name}: outreach send failed (${outbound.error})`)
        }
        continue
      }

      // Flow B external: no form data -> the details ask.
      const info = await sendDetailedInfoMessage({
        candidate, job, client, origin, participantId,
        campaignId: campaign.id, nudgeH, escalateH, preScreenConfig,
      })
      if (info.sent) nudgeSent++
      else {
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
        errors.push(`${candidate.name}: detailed info request failed (${info.error})`)
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
            location: jobLocation(job),
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
            location: jobLocation(job),
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

export { inferJobCategory, buildBusinessTypeContext, buildJobGist }
export type { CandidateOrigin }
