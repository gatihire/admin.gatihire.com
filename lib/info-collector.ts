import { supabaseAdmin } from "@/lib/supabase"
import { getWhatsAppService } from "@/lib/whatsapp"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import { logger } from "@/lib/logger"

// ── Parsed Info (extended) ──

interface ParsedInfo {
  currentCtc: string | null
  expectedCtc: string | null
  noticePeriod: string | null
  totalExperience: number | null
  location: string | null
  willingToRelocate: boolean | null
  reasonForSwitching: string | null
}

const REJECTION_REASONS = [
  "not_looking_to_switch",
  "comp_mismatch",
  "location_mismatch",
  "already_placed",
  "role_not_relevant",
  "other",
] as const

export type RejectionReason = (typeof REJECTION_REASONS)[number]

export function isValidRejectionReason(value: string): value is RejectionReason {
  return (REJECTION_REASONS as readonly string[]).includes(value)
}

// ── Parse candidate's free-text reply for screening details ──
// Expected format (one reply):
//   "8 LPA, 12 LPA, 5 years, 30 days, Mumbai, yes, better growth"
// Or partial:
//   "8 LPA, 12 LPA, 30 days"
//   "8 LPA, 12 LPA, 30 days, Mumbai, yes, looking for growth"

export function parseDetailedInfoReply(text: string): ParsedInfo {
  const lower = text.toLowerCase().trim()
  const result: ParsedInfo = {
    currentCtc: null,
    expectedCtc: null,
    noticePeriod: null,
    totalExperience: null,
    location: null,
    willingToRelocate: null,
    reasonForSwitching: null,
  }

  // Split by comma, slash, or newline
  const parts = lower.split(/[,\n/]+/).map(p => p.trim()).filter(Boolean)

  for (const part of parts) {
    const p = part.trim()
    if (!p) continue

    // Notice period: "30 days", "1 month", "immediate"
    if (/\d+\s*(day|days|week|weeks|month|months)/.test(p) || /immediate|asap|join now/.test(p)) {
      if (!result.noticePeriod) result.noticePeriod = extractNoticePeriod(p)
      continue
    }

    // Experience: "5 years", "3.5 years", "5 yrs", "5 yoe"
    const expMatch = p.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|yoe|experience)/)
    if (expMatch) {
      result.totalExperience = parseFloat(expMatch[1])
      continue
    }

    // Willing to relocate: "yes", "no", "relocate", "willing"
    if (/^(yes|no|relocate|willing|not?\s*willing|can\s*relocate|cannot\s*relocate|na)$/i.test(p)) {
      result.willingToRelocate = /^(yes|relocate|willing|can\s*relocate)$/i.test(p)
      continue
    }

    // CTC: "8 LPA", "800000", "80K"
    const ctcValue = extractCtc(p)
    if (ctcValue) {
      if (!result.currentCtc) {
        result.currentCtc = ctcValue
      } else if (!result.expectedCtc) {
        result.expectedCtc = ctcValue
      }
      continue
    }

    // Location: if it's a city name (no digits, reasonable length)
    if (/^[a-z\s]{2,30}$/.test(p) && !result.location) {
      result.location = p.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      continue
    }

    // Reason for switching: everything else
    if (!result.reasonForSwitching && p.length > 3) {
      result.reasonForSwitching = p.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    }
  }

  return result
}

// ── Backward-compatible parse for simple info (CTC + notice only) ──

interface ParsedSimpleInfo {
  currentCtc: string | null
  expectedCtc: string | null
  noticePeriod: string | null
}

export function parseInfoReply(text: string): ParsedSimpleInfo {
  const detailed = parseDetailedInfoReply(text)
  return {
    currentCtc: detailed.currentCtc,
    expectedCtc: detailed.expectedCtc,
    noticePeriod: detailed.noticePeriod,
  }
}

function extractCtc(text: string): string | null {
  const cleaned = text.replace(/(current|expected|ctc|lpa|per annum|pa|annual|lakhs|lakh|k|inr|rs|rupees|salary)/g, "").trim()
  const numMatch = cleaned.match(/(\d+(?:\.\d+)?)/)
  if (!numMatch) return null

  const num = parseFloat(numMatch[1])
  if (num < 100) return `${num} LPA`
  if (num > 100000) return `${(num / 100000).toFixed(1)} LPA`
  if (num > 1000 && num < 100000) return `${(num / 1000).toFixed(0)}K`
  return `${num}`
}

function extractNoticePeriod(text: string): string | null {
  const dayMatch = text.match(/(\d+)\s*(day|days)/)
  if (dayMatch) return `${dayMatch[1]} days`

  const weekMatch = text.match(/(\d+)\s*(week|weeks)/)
  if (weekMatch) return `${parseInt(weekMatch[1]) * 7} days`

  const monthMatch = text.match(/(\d+)\s*(month|months)/)
  if (monthMatch) return `${parseInt(monthMatch[1]) * 30} days`

  const numMatch = text.match(/(\d+)/)
  if (numMatch) {
    const num = parseInt(numMatch[1])
    if (num >= 1 && num <= 90) return `${num} days`
    if (num > 90) return `${Math.round(num / 30)} months`
  }

  if (/immediate|immed|asap|join now/.test(text)) return "Immediate"
  return null
}

// ── Handle simple info reply (backward compatible) ──

export async function handleInfoReply(
  participantId: string,
  replyText: string
): Promise<{ success: boolean; error?: string; parsed?: ParsedSimpleInfo }> {
  try {
    const { data: participant, error: fetchError } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, status, job_id, candidate_id, origin,
        candidates: candidate_id (id, name, phone),
        jobs: job_id (id, title, client_name)
      `)
      .eq("id", participantId)
      .single()

    if (fetchError || !participant) {
      return { success: false, error: "Participant not found" }
    }

    const parsed = parseInfoReply(replyText)
    if (!parsed.currentCtc && !parsed.expectedCtc && !parsed.noticePeriod) {
      return { success: false, error: "Could not parse info. Please reply in format: '8 LPA, 12 LPA, 30 days'" }
    }

    const updates: any = { updated_at: new Date().toISOString() }
    if (parsed.currentCtc) updates.current_ctc = parsed.currentCtc
    if (parsed.expectedCtc) updates.expected_ctc = parsed.expectedCtc
    if (parsed.noticePeriod) updates.notice_period = parsed.noticePeriod
    updates.info_collected_at = new Date().toISOString()

    const { error: updateError } = await supabaseAdmin
      .from("candidates")
      .update(updates)
      .eq("id", participant.candidate_id)

    if (updateError) {
      logger.error("Failed to update candidate info", { error: updateError })
      return { success: false, error: "Failed to save info" }
    }

    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "info_received",
        info_received_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", participantId)

    const whatsapp = getWhatsAppService()
    const candidate = participant.candidates as any
    await whatsapp.sendInfoReceivedConfirm({
      phoneNumber: candidate.phone || "",
      candidateName: candidate.name || "",
      currentCtc: parsed.currentCtc || "Not provided",
      expectedCtc: parsed.expectedCtc || "Not provided",
      noticePeriod: parsed.noticePeriod || "Not provided"
    })

    logger.info("Info collected and confirmed", {
      participantId, candidateId: participant.candidate_id,
      currentCtc: parsed.currentCtc, expectedCtc: parsed.expectedCtc, noticePeriod: parsed.noticePeriod
    })

    return { success: true, parsed }
  } catch (error: any) {
    logger.error("Error handling info reply", { error: error.message })
    return { success: false, error: error.message }
  }
}

// ── Handle detailed info reply (extended screening) ──

export async function handleDetailedInfoReply(
  participantId: string,
  replyText: string
): Promise<{ success: boolean; error?: string; parsed?: ParsedInfo; prescreen?: PrescreenResult }> {
  try {
    const { data: participant, error: fetchError } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, status, job_id, candidate_id, origin, screening_context, call_payload_json,
        candidates: candidate_id (id, name, phone),
        jobs: job_id (id, title, client_name, salary_min, salary_max, salary_type,
                       experience_min_years, experience_max_years, city, skills_must_have)
      `)
      .eq("id", participantId)
      .single()

    if (fetchError || !participant) {
      return { success: false, error: "Participant not found" }
    }

    const parsed = parseDetailedInfoReply(replyText)
    const fieldsProvided = [
      parsed.currentCtc, parsed.expectedCtc, parsed.totalExperience != null,
      parsed.noticePeriod, parsed.location, parsed.willingToRelocate != null, parsed.reasonForSwitching,
    ].filter(Boolean).length

    // Reply quality gate: if < 3 fields provided, send reminder (max 1 reminder)
    if (fieldsProvided < 3) {
      const reminderKey = "info_reminder_sent"
      const alreadyReminded = participant.screening_context?.[reminderKey]

      if (!alreadyReminded) {
        const whatsapp = getWhatsAppService()
        const candidate = participant.candidates as any
        await whatsapp.sendInfoReminder({
          phoneNumber: candidate.phone || "",
          candidateName: candidate.name || "",
        })

        // Track reminder in screening_context
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            screening_context: {
              ...(participant.screening_context || {}),
              [reminderKey]: true,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", participantId)

        logger.info("Info reply incomplete, reminder sent", {
          participantId, candidateId: participant.candidate_id, fieldsProvided
        })
        return { success: true } // parsed but incomplete — reminder sent
      }

      // Already reminded and still incomplete → needs_review
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "needs_review",
          info_received_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", participantId)

      logger.info("Info reply incomplete after reminder, flagged for HR review", {
        participantId, candidateId: participant.candidate_id, fieldsProvided
      })
      return { success: true }
    }

    if (!parsed.currentCtc && !parsed.expectedCtc && !parsed.noticePeriod && !parsed.totalExperience) {
      return { success: false, error: "Could not parse info. Please share: CTC, expected CTC, experience, notice period, location, willing to relocate (yes/no), reason for switching" }
    }

    // Save to candidates table
    const candidateUpdates: any = { updated_at: new Date().toISOString(), info_collected_at: new Date().toISOString() }
    if (parsed.currentCtc) candidateUpdates.current_ctc = parsed.currentCtc
    if (parsed.expectedCtc) candidateUpdates.expected_ctc = parsed.expectedCtc
    if (parsed.noticePeriod) candidateUpdates.notice_period = parsed.noticePeriod
    if (parsed.totalExperience != null) candidateUpdates.total_experience_years = parsed.totalExperience
    if (parsed.location) candidateUpdates.location_preference = parsed.location
    if (parsed.willingToRelocate != null) candidateUpdates.willing_to_relocate = parsed.willingToRelocate
    if (parsed.reasonForSwitching) candidateUpdates.reason_for_switching = parsed.reasonForSwitching

    const { error: updateError } = await supabaseAdmin
      .from("candidates")
      .update(candidateUpdates)
      .eq("id", participant.candidate_id)

    if (updateError) {
      logger.error("Failed to update candidate info (detailed)", { error: updateError })
      return { success: false, error: "Failed to save info" }
    }

    // Pre-screening evaluation
    const job = participant.jobs as any
    const prescreen = evaluateCandidate(parsed, job)

    // Save prescreen result to candidates table
    await supabaseAdmin
      .from("candidates")
      .update({
        ai_prescreen_decision: prescreen.decision,
        ai_prescreen_reason: prescreen.reason,
        ai_prescreened_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", participant.candidate_id)

    // Update participant status based on decision
    const participantUpdates: any = {
      info_received_at: new Date().toISOString(),
      prescreen_decision: prescreen.decision,
      prescreen_reason: prescreen.reason,
      updated_at: new Date().toISOString(),
    }
    if (prescreen.decision === "filtered_out") {
      participantUpdates.status = "filtered_out"
    } else if (prescreen.decision === "needs_review") {
      participantUpdates.status = "needs_review"
    } else {
      participantUpdates.status = "info_received"
    }

    await supabaseAdmin
      .from("phone_screening_participants")
      .update(participantUpdates)
      .eq("id", participantId)

    // Send appropriate WhatsApp response
    const whatsapp = getWhatsAppService()
    const candidate = participant.candidates as any

    if (prescreen.decision === "filtered_out") {
      await whatsapp.sendScreeningFilteredOut({
        phoneNumber: candidate.phone || "",
        candidateName: candidate.name || "",
        reason: prescreen.reason
      })
      logger.info("Candidate filtered out after pre-screen", {
        participantId, candidateId: participant.candidate_id, reason: prescreen.reason
      })
    } else if (prescreen.decision === "needs_review") {
      await whatsapp.sendInfoReviewPending({
        phoneNumber: candidate.phone || "",
        candidateName: candidate.name || "",
        jobTitle: job?.title || "",
        companyName: job?.client_name || "",
      })
      logger.info("Candidate flagged for HR review after pre-screen", {
        participantId, candidateId: participant.candidate_id, reason: prescreen.reason
      })
    } else {
      // proceed — send info received confirmation AND auto-schedule AI call
      await whatsapp.sendInfoReceivedConfirm({
        phoneNumber: candidate.phone || "",
        candidateName: candidate.name || "",
        currentCtc: parsed.currentCtc || "Not provided",
        expectedCtc: parsed.expectedCtc || "Not provided",
        noticePeriod: parsed.noticePeriod || "Not provided"
      })

      // Auto-schedule Bolna call (1 minute delay so candidate sees confirmation first)
      const callDelaySec = 60
      const scheduled = await scheduleBolnaCall(participantId, callDelaySec)
      if (scheduled.scheduled) {
        // scheduled_call_at is the real column. Writing scheduled_at (which does
        // not exist) failed silently, so the QStash callback fired at a row whose
        // guard refused it and the candidate was never actually dialled.
        const { error: bookErr } = await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: "call_scheduled",
            scheduled_call_at: new Date(Date.now() + callDelaySec * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", participantId)
        logger.info("Auto-scheduled AI call after info collection", {
          participantId, candidateId: participant.candidate_id, delaySec: callDelaySec,
          persisted: !bookErr, error: bookErr?.message
        })
      } else {
        logger.error("Failed to auto-schedule call after info collection", {
          participantId, candidateId: participant.candidate_id, error: scheduled.error
        })
      }
    }

    return { success: true, parsed, prescreen }
  } catch (error: any) {
    logger.error("Error handling detailed info reply", { error: error.message })
    return { success: false, error: error.message }
  }
}

// ── Pre-screening evaluation (3-tier: proceed / needs_review / filtered_out) ──

export interface PrescreenCheck {
  field: string
  verdict: "pass" | "review" | "fail"
  detail: string
}

export interface PrescreenResult {
  decision: "proceed" | "needs_review" | "filtered_out"
  reason: string
  checks: PrescreenCheck[]
}

function evaluateCandidate(parsed: ParsedInfo, job: any): PrescreenResult {
  const checks: PrescreenCheck[] = []
  const reasons: string[] = []

  // ── 1. Salary range check ──
  if (parsed.expectedCtc && job?.salary_min != null && job?.salary_max != null) {
    const expectedNum = extractCtcNumber(parsed.expectedCtc)
    if (expectedNum != null) {
      const jobMin = Number(job.salary_min)
      const jobMax = Number(job.salary_max)
      const range = jobMax - jobMin
      if (expectedNum < jobMin) {
        const deficit = jobMin - expectedNum
        if (deficit > range * 0.4) {
          checks.push({ field: "salary", verdict: "fail", detail: `Expected ${parsed.expectedCtc} is well below JD range ${jobMin}-${jobMax}` })
          reasons.push(`salary_below_range (${parsed.expectedCtc} vs ${jobMin}-${jobMax})`)
        } else {
          checks.push({ field: "salary", verdict: "review", detail: `Expected ${parsed.expectedCtc} is below JD range ${jobMin}-${jobMax}` })
          reasons.push(`salary_below_range (${parsed.expectedCtc} vs ${jobMin}-${jobMax})`)
        }
      } else if (expectedNum > jobMax) {
        const excess = expectedNum - jobMax
        if (excess > range * 0.4) {
          checks.push({ field: "salary", verdict: "fail", detail: `Expected ${parsed.expectedCtc} is well above JD range ${jobMin}-${jobMax}` })
          reasons.push(`salary_above_range (${parsed.expectedCtc} vs ${jobMin}-${jobMax})`)
        } else {
          checks.push({ field: "salary", verdict: "review", detail: `Expected ${parsed.expectedCtc} is above JD range ${jobMin}-${jobMax}` })
          reasons.push(`salary_above_range (${parsed.expectedCtc} vs ${jobMin}-${jobMax})`)
        }
      } else {
        checks.push({ field: "salary", verdict: "pass", detail: `Expected ${parsed.expectedCtc} within JD range ${jobMin}-${jobMax}` })
      }
    } else {
      checks.push({ field: "salary", verdict: "review", detail: `Could not parse expected CTC: "${parsed.expectedCtc}"` })
    }
  } else if (!parsed.expectedCtc && job?.salary_min != null) {
    checks.push({ field: "salary", verdict: "review", detail: "Expected CTC not provided" })
    reasons.push("salary_not_provided")
  }

  // ── 2. Experience range check ──
  if (parsed.totalExperience != null && (job?.experience_min_years != null || job?.experience_max_years != null)) {
    const minExp = job?.experience_min_years != null ? Number(job.experience_min_years) : 0
    const maxExp = job?.experience_max_years != null ? Number(job.experience_max_years) : 999

    if (parsed.totalExperience < minExp * 0.5) {
      checks.push({ field: "experience", verdict: "fail", detail: `${parsed.totalExperience} yrs — well below minimum ${minExp} yrs` })
      reasons.push(`experience_insufficient (${parsed.totalExperience}y < ${minExp}y)`)
    } else if (parsed.totalExperience < minExp * 0.7) {
      checks.push({ field: "experience", verdict: "review", detail: `${parsed.totalExperience} yrs — below preferred minimum ${minExp} yrs` })
      reasons.push(`experience_low (${parsed.totalExperience}y vs min ${minExp}y)`)
    } else if (parsed.totalExperience > maxExp * 2) {
      checks.push({ field: "experience", verdict: "fail", detail: `${parsed.totalExperience} yrs — well above maximum ${maxExp} yrs` })
      reasons.push(`experience_overqualified (${parsed.totalExperience}y > ${maxExp}y)`)
    } else if (parsed.totalExperience > maxExp * 1.5) {
      checks.push({ field: "experience", verdict: "review", detail: `${parsed.totalExperience} yrs — above preferred maximum ${maxExp} yrs` })
      reasons.push(`experience_high (${parsed.totalExperience}y vs max ${maxExp}y)`)
    } else {
      checks.push({ field: "experience", verdict: "pass", detail: `${parsed.totalExperience} yrs within JD range ${minExp}-${maxExp}` })
    }
  } else if (parsed.totalExperience == null && job?.experience_min_years != null) {
    checks.push({ field: "experience", verdict: "review", detail: "Experience not provided" })
    reasons.push("experience_not_provided")
  }

  // ── 3. Location check ──
  if (parsed.location && job?.city) {
    const candidateCity = parsed.location.toLowerCase()
    const jobCity = String(job.city).toLowerCase()
    const sameCity = candidateCity === jobCity || candidateCity.includes(jobCity) || jobCity.includes(candidateCity)
    if (sameCity) {
      checks.push({ field: "location", verdict: "pass", detail: `Candidate in ${parsed.location}, job in ${job.city} — same city` })
    } else if (parsed.willingToRelocate === true) {
      checks.push({ field: "location", verdict: "pass", detail: `Candidate in ${parsed.location}, job in ${job.city} — willing to relocate` })
    } else if (parsed.willingToRelocate === false) {
      checks.push({ field: "location", verdict: "fail", detail: `Candidate in ${parsed.location}, job in ${job.city} — not willing to relocate` })
      reasons.push(`location_mismatch (${parsed.location} → ${job.city}, not willing)`)
    } else {
      // Location different, relocate unknown → review
      checks.push({ field: "location", verdict: "review", detail: `Candidate in ${parsed.location}, job in ${job.city} — relocation preference unknown` })
      reasons.push(`location_unknown (${parsed.location} → ${job.city}, relocate unclear)`)
    }
  } else if (!parsed.location && job?.city) {
    checks.push({ field: "location", verdict: "review", detail: "Candidate location not provided" })
    reasons.push("location_not_provided")
  }

  // ── 4. Notice period check ──
  if (parsed.noticePeriod) {
    if (parsed.noticePeriod === "Immediate") {
      checks.push({ field: "notice_period", verdict: "pass", detail: "Immediate availability" })
    } else {
      const daysMatch = parsed.noticePeriod.match(/(\d+)/)
      if (daysMatch) {
        const days = parseInt(daysMatch[1])
        if (days <= 30) {
          checks.push({ field: "notice_period", verdict: "pass", detail: `${parsed.noticePeriod} — acceptable` })
        } else if (days <= 60) {
          checks.push({ field: "notice_period", verdict: "pass", detail: `${parsed.noticePeriod} — within range` })
        } else if (days <= 120) {
          checks.push({ field: "notice_period", verdict: "review", detail: `${parsed.noticePeriod} — long notice period` })
          reasons.push(`notice_period_long (${parsed.noticePeriod})`)
        } else {
          checks.push({ field: "notice_period", verdict: "fail", detail: `${parsed.noticePeriod} — excessively long` })
          reasons.push(`notice_period_long (${parsed.noticePeriod})`)
        }
      } else {
        checks.push({ field: "notice_period", verdict: "review", detail: `Could not parse notice period: "${parsed.noticePeriod}"` })
      }
    }
  } else {
    checks.push({ field: "notice_period", verdict: "review", detail: "Notice period not provided" })
    reasons.push("notice_period_not_provided")
  }

  // ── 5. Completeness check ──
  const fieldsProvided = [
    parsed.currentCtc,
    parsed.expectedCtc,
    parsed.totalExperience != null,
    parsed.noticePeriod,
    parsed.location,
    parsed.willingToRelocate != null,
    parsed.reasonForSwitching,
  ].filter(Boolean).length
  const totalFields = 7
  if (fieldsProvided < 3) {
    checks.push({ field: "completeness", verdict: "review", detail: `Only ${fieldsProvided}/${totalFields} fields provided — harder to evaluate` })
    reasons.push(`incomplete_info (${fieldsProvided}/${totalFields} fields)`)
  }

  // ── Overall decision ──
  const hasFail = checks.some(c => c.verdict === "fail")
  const hasReview = checks.some(c => c.verdict === "review")

  if (hasFail) {
    return { decision: "filtered_out", reason: reasons.join("; "), checks }
  }
  if (hasReview) {
    return { decision: "needs_review", reason: reasons.join("; ") || "Some fields need HR review", checks }
  }
  return { decision: "proceed", reason: "All checks passed", checks }
}

function extractCtcNumber(ctc: string): number | null {
  const cleaned = ctc.replace(/(lpa|per annum|pa|annual|lakhs|lakh|k|inr|rs|rupees|salary)/g, "").trim()
  const numMatch = cleaned.match(/(\d+(?:\.\d+)?)/)
  if (!numMatch) return null
  const num = parseFloat(numMatch[1])
  if (num < 100) return num // Already LPA
  if (num > 100000) return num / 100000 // Convert to LPA
  if (num > 1000 && num < 100000) return num / 1000 // Convert K to LPA-ish
  return num
}

// ── Handle rejection reason from WhatsApp button ──

export async function handleRejectionReason(
  participantId: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  if (!isValidRejectionReason(reason)) {
    return { success: false, error: `Invalid rejection reason. Valid: ${REJECTION_REASONS.join(", ")}` }
  }

  try {
    const { error } = await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "not_interested",
        rejection_reason: reason,
        updated_at: new Date().toISOString()
      })
      .eq("id", participantId)

    if (error) {
      logger.error("Failed to save rejection reason", { error })
      return { success: false, error: "Failed to save reason" }
    }

    logger.info("Rejection reason captured", { participantId, reason })
    return { success: true }
  } catch (error: any) {
    logger.error("Error saving rejection reason", { error: error.message })
    return { success: false, error: error.message }
  }
}

// ── Send info request (always uses detailed template for 7-field collection) ──

export async function sendInfoRequest(
  participantId: string,
  mode: "simple" | "extended" = "extended"
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: participant, error: fetchError } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, status, origin,
        candidates: candidate_id (id, name, phone),
        jobs: job_id (id, title, client_name)
      `)
      .eq("id", participantId)
      .single()

    if (fetchError || !participant) {
      return { success: false, error: "Participant not found" }
    }

    const candidate = participant.candidates as any
    const job = participant.jobs as any

    if (!candidate?.phone) {
      return { success: false, error: "No phone number" }
    }

    const whatsapp = getWhatsAppService()

    // Always use the detailed template (7 fields) for both inbound and outbound
    const result = await whatsapp.sendDetailedInfoRequest({
      phoneNumber: candidate.phone,
      candidateName: candidate.name || "",
      jobTitle: job?.title || "",
      companyName: job?.client_name || ""
    })
    const templateName = "detailed_info_request"

    if (result.success) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "info_requested",
          info_request_sent_at: new Date().toISOString(),
          whatsapp_message_id: result.messageId || null,
          whatsapp_sent_at: new Date().toISOString(),
          whatsapp_delivery_status: "sent",
          whatsapp_outbound_template: templateName,
          updated_at: new Date().toISOString()
        })
        .eq("id", participantId)
    }

    return result.success
      ? { success: true }
      : { success: false, error: result.error }
  } catch (error: any) {
    logger.error("Error sending info request", { error: error.message })
    return { success: false, error: error.message }
  }
}
