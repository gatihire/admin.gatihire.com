import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { verifyBolnaWebhook } from "@/lib/bolna"
import { placeBolnaCall } from "@/lib/bolna"
import { logCandidateActivity } from "@/lib/activity-logger"
import {
  buildPlanFromQuestions,
  buildTemplatePlan,
  jobContextFromRow,
  planFromUserData,
  renderInterviewPlan,
  renderLegacyQuestions,
  toBolnaUserData,
  PLAN_VERSION,
} from "@/lib/interview-plan"

export const runtime = "nodejs"

interface InboundCallPayload {
  call_id?: string
  from_number?: string
  to_number?: string
  status?: string
  timestamp?: string
}

async function findParticipantByPhone(phone: string): Promise<{
  id: string
  call_payload_json: Record<string, unknown> | null
  candidate_id: string
  status: string
  call_attempts: number
  candidates: { id: string; name: string; phone: string; current_role?: string | null } | null
  jobs: {
    id: string
    title: string
    client_name: string
    skills_must_have?: string[] | null
    /** The JD text. `key_responsibilities` and `daily_work_summary` were dropped
     *  from the table in Feb; the plan generator reads them from here. */
    description?: string | null
    license_type?: string | null
    role_category?: string | null
    city?: string | null
    employment_type?: string | null
    experience_min_years?: number | null
    experience_max_years?: number | null
    salary_min?: number | null
    salary_max?: number | null
    salary_type?: string | null
  } | null
} | null> {
  const e164Phone = phone.startsWith("+") ? phone : `+${phone.replace(/\D/g, "")}`

  const { data, error } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      id,
      call_payload_json,
      candidate_id,
      status,
      call_attempts,
      candidates:candidate_id (id, name, phone, current_role),
      jobs:job_id (id, title, client_name, skills_must_have, description,
        license_type, role_category, city,
        employment_type, experience_min_years, experience_max_years,
        salary_min, salary_max, salary_type)
    `)
    .eq("candidates.phone", e164Phone)
    .in("status", ["failed", "call_scheduled", "not_interested", "unreachable", "completed"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return data as unknown as {
    id: string
    call_payload_json: Record<string, unknown> | null
    candidate_id: string
    status: string
    call_attempts: number
    candidates: { id: string; name: string; phone: string; current_role?: string | null } | null
    jobs: {
      id: string
      title: string
      client_name: string
      skills_must_have?: string[] | null
      key_responsibilities?: string[] | null
      daily_work_summary?: string | null
      license_type?: string | null
      role_category?: string | null
      city?: string | null
      work_type?: string | null
      employment_type?: string | null
      experience_min_years?: number | null
      experience_max_years?: number | null
      salary_min?: number | null
      salary_max?: number | null
      salary_type?: string | null
    } | null
  }
}

export async function POST(request: NextRequest) {
  try {
    const headers = request.headers
    const bodyText = await request.text().catch(() => "")
    if (!verifyBolnaWebhook(request, headers, bodyText)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    let payload: InboundCallPayload
    try {
      payload = JSON.parse(bodyText || "{}")
    } catch {
      return NextResponse.json({ status: "ok" })
    }

    const fromNumber = payload.from_number || payload.to_number
    if (!fromNumber) {
      logger.warn("Bolna inbound webhook: no from_number")
      return NextResponse.json({ status: "ok" })
    }

    const participant = await findParticipantByPhone(fromNumber)
    if (!participant) {
      logger.info("Bolna inbound: no participant found for number", { fromNumber })
      return NextResponse.json({ status: "ok" })
    }

    const candidate = participant.candidates
    if (!candidate?.phone) {
      logger.warn("Bolna inbound: candidate has no phone", { participantId: participant.id })
      return NextResponse.json({ status: "ok" })
    }

    const now = new Date().toISOString()

    // Reset participant status for new call attempt
    const { error: updateError } = await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "calling",
        bolna_execution_id: null,
        bolna_status: "inbound_triggered",
        call_attempts: (participant.call_attempts || 0) + 1,
        last_attempt_at: now,
        next_retry_at: null,
        scheduled_call_at: null,
        updated_at: now,
      })
      .eq("id", participant.id)

    if (updateError) {
      logger.error("Bolna inbound: failed to update participant", { error: updateError.message })
      return NextResponse.json({ status: "ok" })
    }

    const stored = participant.call_payload_json ? toBolnaUserData(participant.call_payload_json) : {}
    let userData: Record<string, unknown> =
      Object.keys(stored).length > 0
        ? { ...stored, participant_id: participant.id, inbound_resume: true }
        : { candidate_name: candidate.name || "", participant_id: participant.id, inbound_resume: true }

    // Same assertion as the outbound path: an inbound callback for a row whose
    // payload was never written must not be screened with no questions, and the
    // prompt now reads {interview_plan}.
    const storedPlan = planFromUserData(userData)
    const stalePlan = !!storedPlan && Number(storedPlan.version || 0) < PLAN_VERSION
    if (!String(userData.interview_plan || "").trim() || stalePlan) {
      const existingQuestions = String(userData.questions || "")
      const planSource = stalePlan
        ? buildTemplatePlan(jobContextFromRow(participant.jobs || { id: "" }), {
            id: candidate.id,
            name: candidate.name,
            current_role: candidate.current_role ?? null,
          })
        : existingQuestions.trim()
          ? buildPlanFromQuestions(existingQuestions, jobContextFromRow(participant.jobs || { id: "" }), {
              id: candidate.id,
              name: candidate.name,
              current_role: candidate.current_role ?? null,
            })
          : buildTemplatePlan(jobContextFromRow(participant.jobs || { id: "" }), {
              id: candidate.id,
              name: candidate.name,
              current_role: candidate.current_role ?? null,
            })
      userData = {
        ...userData,
        job_title: userData.job_title || participant.jobs?.title || "",
        client_name: userData.client_name || participant.jobs?.client_name || "",
        hiring_company_name: userData.hiring_company_name || participant.jobs?.client_name || "",
        interview_plan: renderInterviewPlan(planSource),
        questions: renderLegacyQuestions(planSource)
          .split("\n")
          .map((q, i) => `${i + 1}. ${q.replace(/^\d+\.\s*/, "")}`)
          .join("\n"),
      }
      logger.warn(
        stalePlan
          ? "Bolna inbound: queued interview plan was v1 — regenerated before dialling"
          : "Bolna inbound: payload had no interview plan — built one",
        {
          participantId: participant.id,
          fromExistingQuestions: Boolean(existingQuestions.trim()) && !stalePlan,
          previousVersion: storedPlan?.version ?? null,
        }
      )
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          call_payload_json: { ...(participant.call_payload_json || {}), ...userData, _interview_plan: planSource },
          // Same reason as the outbound path: the card must show the questions
          // that were actually dialled, not the pre-plan list it was built from.
          generated_questions: String(userData.questions || ""),
          updated_at: now,
        })
        .eq("id", participant.id)
    }

    // This route only runs when the candidate themselves called our number
    // (Bolna inbound webhook): they are awake and asking to be connected.
    // There is no calling-hours gate any more; proactive placements still go
    // through `placeCallForParticipant` for the attempt and live-call guards.
    const result = await placeBolnaCall({
      to: candidate.phone,
      userData,
    })

    if (!result.success || !result.executionId) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "failed",
          updated_at: now,
        })
        .eq("id", participant.id)

      logger.error("Bolna inbound: failed to place call", { participantId: participant.id, error: result.error })
      return NextResponse.json({ status: "ok" })
    }

    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        bolna_execution_id: result.executionId,
        bolna_status: "inbound_started",
        updated_at: now,
      })
      .eq("id", participant.id)

    logger.info("Bolna inbound call triggered", { participantId: participant.id, executionId: result.executionId })

    // Log inbound call attempt
    logCandidateActivity({
      jobId: participant.jobs?.id || "",
      candidateId: participant.candidate_id,
      participantId: participant.id,
      eventType: "call_attempted",
      eventData: { direction: "inbound", bolna_execution_id: result.executionId },
    })

    return NextResponse.json({ status: "ok", executionId: result.executionId })
  } catch (error: any) {
    logger.error("Bolna inbound webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}