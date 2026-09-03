import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { verifyBolnaWebhook, BOLNA_TERMINAL_STATUSES, type BolnaExecution } from "@/lib/bolna"
import { evaluateCallQuality } from "@/lib/ai-learning"
import { aisensyService } from "@/lib/aisensy"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import { enrichTranscript, type EnrichedSummary } from "@/lib/transcript-enrichment"

export const runtime = "nodejs"

interface ParsedVerdict {
  score?: number
  recommendation?: string
  next_round_ready?: boolean
  verdict_explanation?: string
  pluses?: string[]
  minuses?: string[]
  relocation_willing?: string
  current_salary?: string
  expected_salary?: string
  salary_manipulation_risk?: string
  salary_notes?: string
  callback_requested?: boolean
  callback_time?: string
  callback_preference_text?: string
  key_answers?: Record<string, string>
  summary?: string
  [key: string]: unknown
}

function extractVerdictFromTranscript(transcript: string): ParsedVerdict | null {
  if (!transcript) return null
  const match = transcript.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    if (parsed && typeof parsed === "object") return parsed as ParsedVerdict
  } catch {
    // Fall through — try to find a JSON-looking substring.
    try {
      const firstBrace = transcript.indexOf("{")
      const lastBrace = transcript.lastIndexOf("}")
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(transcript.slice(firstBrace, lastBrace + 1)) as ParsedVerdict
      }
    } catch {
      return null
    }
  }
  return null
}

function transcriptToSegments(transcript: string): { speaker: "ai" | "candidate"; text: string }[] {
  if (!transcript) return []
  const segments: { speaker: "ai" | "candidate"; text: string }[] = []
  for (const rawLine of transcript.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const assistantMatch = line.match(/^assistant:\s*(.*)$/i)
    const userMatch = line.match(/^user:\s*(.*)$/i)
    if (assistantMatch) {
      if (assistantMatch[1].trim()) segments.push({ speaker: "ai", text: assistantMatch[1].trim() })
    } else if (userMatch) {
      if (userMatch[1].trim()) segments.push({ speaker: "candidate", text: userMatch[1].trim() })
    } else {
      // Continuation of the previous speaker's line.
      const last = segments[segments.length - 1]
      if (last) last.text = `${last.text} ${line}`
    }
  }
  return segments
}

function parseCallbackTime(
  callbackTime: string | undefined,
  timezone: string | undefined
): string | null {
  if (!callbackTime) return null
  const match = callbackTime.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!match) return null
  const [, y, m, d, hh, mm] = match
  try {
    const iso = new Date(
      Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm))
    ).toISOString()
    if (!timezone || timezone === "UTC") return iso
    // Interpret the local wall-clock time in the candidate's timezone.
    const local = new Date(
      `${y}-${m}-${d}T${hh}:${mm}:00${timezoneOffsetSuffix(timezone)}`
    )
    if (!isNaN(local.getTime())) return local.toISOString()
    return iso
  } catch {
    return null
  }
}

function timezoneOffsetSuffix(timezone: string): string {
  // Only handle simple fixed-offset names like "Asia/Kolkata" -> +05:30, "UTC" -> Z
  const offsets: Record<string, string> = {
    "Asia/Kolkata": "+05:30",
    "Asia/Karachi": "+05:00",
    "Asia/Dhaka": "+06:00",
    "Asia/Kathmandu": "+05:45",
    "Asia/Colombo": "+05:30",
    "Asia/Bangkok": "+07:00",
    "Asia/Singapore": "+08:00",
    "Asia/Dubai": "+04:00",
    "Asia/Riyadh": "+03:00",
  }
  return offsets[timezone] || "Z"
}

async function writeScreeningAnswers(
  participantId: string,
  verdict: ParsedVerdict
): Promise<void> {
  const rows: {
    participant_id: string
    question_key: string
    question_text: string
    answer_text: string
  }[] = []

  const salaryMap: Record<string, string> = {
    current_salary: "What is your current monthly/annual salary?",
    expected_salary: "What is your expected salary for this role?",
    salary_manipulation_risk: "Any red flags in salary expectations?",
  }

  for (const [key, questionText] of Object.entries(salaryMap)) {
    const value = verdict[key]
    if (typeof value === "string" && value) {
      rows.push({
        participant_id: participantId,
        question_key: key,
        question_text: questionText,
        answer_text: value,
      })
    }
  }

  if (verdict.relocation_willing) {
    rows.push({
      participant_id: participantId,
      question_key: "relocation_willing",
      question_text: "Are you willing to relocate or commute for this role?",
      answer_text: String(verdict.relocation_willing),
    })
  }

  for (const [key, value] of Object.entries(verdict.key_answers || {})) {
    if (typeof value === "string" && value) {
      rows.push({
        participant_id: participantId,
        question_key: key,
        question_text: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        answer_text: value,
      })
    }
  }

  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("screening_answers").insert(rows)
    if (error) {
      logger.warn("Failed to write Bolna screening answers", { participantId, error: error.message })
    }
  }
}

async function writeTranscriptSegments(
  participantId: string,
  transcript: string
): Promise<void> {
  const segments = transcriptToSegments(transcript)
  if (segments.length === 0) return

  const rows = segments.map((s) => ({
    participant_id: participantId,
    speaker: s.speaker,
    text: s.text,
  }))

  const { error } = await supabaseAdmin.from("call_transcripts").insert(rows)
  if (error) {
    logger.warn("Failed to write Bolna transcript", { participantId, error: error.message })
  }
}

async function handleCompletedExecution(
  participantId: string,
  execution: BolnaExecution
): Promise<void> {
  const transcript = execution.transcript || ""
  const verdict = extractVerdictFromTranscript(transcript)
  const extracted = execution.extracted_data as Record<string, unknown> | null

  await writeTranscriptSegments(participantId, transcript)

  let effectiveVerdict = verdict
  if (!effectiveVerdict && extracted) {
    effectiveVerdict = extracted as ParsedVerdict
  }

  const now = new Date().toISOString()
  const rawDuration = execution.conversation_duration ?? execution.telephony_data?.duration
  const patch: Record<string, unknown> = {
    status: "completed",
    bolna_status: "completed",
    call_duration_seconds: rawDuration ? Number(rawDuration) : null,
    call_ended_at: now,
    updated_at: now,
  }

  if (execution.telephony_data?.recording_url) {
    patch.recording_url = execution.telephony_data.recording_url
  }

  // Store cost, voicemail detection, hangup reason (data we were throwing away)
  if (typeof execution.total_cost === "number") {
    patch.call_cost_cents = Math.round(execution.total_cost * 100)
  }
  if (typeof execution.answered_by_voice_mail === "boolean") {
    patch.call_voicemail = execution.answered_by_voice_mail
  }
  if (execution.telephony_data?.hangup_reason) {
    patch.call_hangup_reason = execution.telephony_data.hangup_reason
  }

  // Store raw transcript, cost breakdown, ring duration, carrier, hangup_by
  if (transcript) {
    patch.transcript_raw = transcript
  }
  if (execution.cost_breakdown) {
    patch.cost_breakdown = execution.cost_breakdown
  }
  if (execution.telephony_data?.ring_duration) {
    patch.ring_duration = execution.telephony_data.ring_duration
  }
  if (execution.telephony_data?.to_number_carrier) {
    patch.carrier = execution.telephony_data.to_number_carrier
  }
  if (execution.telephony_data?.hangup_by) {
    patch.hangup_by = execution.telephony_data.hangup_by
  }

  // Store candidate timezone from Bolna context
  if (execution.context_details?.timezone) {
    patch.candidate_timezone = execution.context_details.timezone
  }

  if (effectiveVerdict) {
    patch.verdict_json = effectiveVerdict
    patch.ai_summary = JSON.stringify(effectiveVerdict)
    if (typeof effectiveVerdict.score === "number") patch.ai_score = effectiveVerdict.score
    if (effectiveVerdict.recommendation) patch.ai_recommendation = effectiveVerdict.recommendation

    await writeScreeningAnswers(participantId, effectiveVerdict)

    const { data: participantRow } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("candidate_id")
      .eq("id", participantId)
      .single()

    if (participantRow?.candidate_id) {
      const candidatePatch: Record<string, unknown> = {}
      if (effectiveVerdict.current_salary) candidatePatch.current_salary = String(effectiveVerdict.current_salary)
      if (effectiveVerdict.expected_salary) candidatePatch.expected_salary = String(effectiveVerdict.expected_salary)
      if (Object.keys(candidatePatch).length > 0) {
        await supabaseAdmin
          .from("candidates")
          .update({ ...candidatePatch, updated_at: now })
          .eq("id", participantRow.candidate_id)
      }
    }

    // If the candidate was busy and requested a callback, schedule a QStash
    // delayed publish so the trigger route places the next call at the agreed time.
    if (effectiveVerdict.callback_requested || effectiveVerdict.callback_preference_text) {
      const timezone = (execution.context_details?.timezone as string) || undefined
      const callbackAt = parseCallbackTime(
        effectiveVerdict.callback_time,
        timezone || "UTC"
      )
      const callbackText =
        effectiveVerdict.callback_preference_text ||
        (effectiveVerdict.callback_time ? `Call back at ${effectiveVerdict.callback_time}` : "Call back")
      const callbackPatch: Record<string, unknown> = {
        status: callbackAt ? "call_scheduled" : "failed",
        callback_preference: callbackText,
        updated_at: now,
      }
      if (callbackAt) {
        callbackPatch.scheduled_call_at = callbackAt
        callbackPatch.next_retry_at = callbackAt
        const delaySec = Math.max(
          0,
          Math.round((new Date(callbackAt).getTime() - Date.now()) / 1000)
        )
        const scheduled = await scheduleBolnaCall(participantId, delaySec)
        if (!scheduled.scheduled) {
          logger.error("Failed to schedule callback call", { participantId, error: scheduled.error })
        }
      } else {
        callbackPatch.next_retry_at = new Date(Date.now() + 15 * 60 * 1000).toISOString()
        callbackPatch.call_attempts = 1
        const scheduled = await scheduleBolnaCall(participantId, 15 * 60)
        if (!scheduled.scheduled) {
          logger.error("Failed to schedule callback retry", { participantId, error: scheduled.error })
        }
      }
      await supabaseAdmin
        .from("phone_screening_participants")
        .update(callbackPatch)
        .eq("id", participantId)
    }
  }

  await supabaseAdmin
    .from("phone_screening_participants")
    .update(patch)
    .eq("id", participantId)

  evaluateCallQuality(participantId).then(() => {}).catch((err: any) => {
    logger.error("Async call quality evaluation failed", { participantId, error: err?.message })
  })

  // Enrich transcript with Gemini: resume + JD + transcript → detailed summary
  enrichTranscriptAsync(participantId, transcript, effectiveVerdict).catch((err: any) => {
    logger.error("Async transcript enrichment failed", { participantId, error: err?.message })
  })
}

async function enrichTranscriptAsync(
  participantId: string,
  transcript: string,
  bolnaVerdict: Record<string, unknown> | null
): Promise<void> {
  // Fetch participant with candidate and job data
  const { data: participant } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      candidate_id, job_id,
      candidates: candidate_id (id, name, current_role, current_company, total_experience, location, technical_skills, resume_text),
      jobs: job_id (id, title, client_name, city, location, experience_min_years, experience_max_years, salary_min, salary_max, salary_type, skills_must_have, skills_good_to_have, description)
    `)
    .eq("id", participantId)
    .single()

  if (!participant) return

  const candidate = participant.candidates
  const job = participant.jobs
  if (!candidate || !job) return

  const enriched = await enrichTranscript(transcript, candidate, job, bolnaVerdict)
  if (!enriched) return

  // Store enriched summary
  await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      enriched_summary: enriched,
      ai_summary: enriched.comprehensive_summary,
      updated_at: new Date().toISOString(),
    })
    .eq("id", participantId)

  logger.info(`Transcript enriched for participant ${participantId}`, {
    verdict: enriched.overall_verdict,
    confidence: enriched.confidence_score,
  })
}

async function handleFailedExecution(
  participant: ParticipantRecord,
  execution: BolnaExecution
): Promise<void> {
  const now = new Date().toISOString()
  const retryMinutes =
    execution.status === "no-answer" || execution.status === "busy" ? 15 : 60

  const patch: Record<string, unknown> = {
    status: "failed",
    bolna_status: execution.status || "failed",
    call_ended_at: now,
    next_retry_at: new Date(Date.now() + retryMinutes * 60 * 1000).toISOString(),
    updated_at: now,
  }
  if (execution.error_message) {
    patch.callback_preference = `Bolna error: ${execution.error_message}`
  }

  // Store cost and hangup reason even on failed calls
  if (typeof execution.total_cost === "number") {
    patch.call_cost_cents = Math.round(execution.total_cost * 100)
  }
  if (execution.telephony_data?.hangup_reason) {
    patch.call_hangup_reason = execution.telephony_data.hangup_reason
  }
  if (execution.context_details?.timezone) {
    patch.candidate_timezone = execution.context_details.timezone
  }

  await supabaseAdmin
    .from("phone_screening_participants")
    .update(patch)
    .eq("id", participant.id)

  // Missed-call reschedule: send WhatsApp with [Call Now] [In 10 min] [In 1 hour] [Tomorrow morning]
  if (!participant.whatsapp_missed_nudge_sent && participant.candidates?.phone) {
    const candidate = participant.candidates
    const job = participant.jobs
    const nudge = await aisensyService.sendMissedCallReschedule(
      candidate.phone || "",
      candidate.name || "",
      job?.title || "",
      job?.client_name || ""
    )
    if (nudge.success) {
      // Append to WhatsApp history instead of overwriting
      const history = participant.whatsapp_history || []
      history.push({
        messageId: nudge.messageId || null,
        template: "missed_call_reschedule",
        sentAt: now,
        status: "sent",
      })
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          whatsapp_missed_nudge_sent: true,
          whatsapp_message_id: nudge.messageId || null,
          whatsapp_sent_at: now,
          whatsapp_delivery_status: "sent",
          whatsapp_outbound_template: "missed_call_reschedule",
          whatsapp_history: history,
          updated_at: now,
        })
        .eq("id", participant.id)
    }
  }

  // Schedule the retry via a QStash delayed publish (no DB polling).
  const scheduled = await scheduleBolnaCall(participant.id, retryMinutes * 60)
  if (!scheduled.scheduled) {
    logger.error("Failed to schedule retry call", {
      participantId: participant.id,
      error: scheduled.error,
    })
  }
}

interface ParticipantRecord {
  id: string
  call_attempts: number
  whatsapp_missed_nudge_sent: boolean
  whatsapp_history: Array<{ messageId: string | null; template: string; sentAt: string; status: string }> | null
  candidates?: { id: string; name?: string | null; phone?: string | null } | null
  jobs?: { id: string; title?: string | null; client_name?: string | null } | null
}

const PARTICIPANT_SELECT = `
  id, call_attempts, whatsapp_missed_nudge_sent, whatsapp_history,
  candidates: candidate_id (id, name, phone),
  jobs: job_id (id, title, client_name)
`

async function findParticipant(execution: BolnaExecution): Promise<ParticipantRecord | null> {
  const executionId = execution.id
  if (executionId) {
    const { data } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(PARTICIPANT_SELECT)
      .eq("bolna_execution_id", executionId)
      .maybeSingle()
    if (data) return data as unknown as ParticipantRecord
  }

  const participantId = execution.context_details?.participant_id
  if (participantId) {
    const { data } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(PARTICIPANT_SELECT)
      .eq("id", participantId)
      .maybeSingle()
    if (data) return data as unknown as ParticipantRecord
  }

  return null
}

export async function POST(request: NextRequest) {
  try {
    const headers = request.headers
    const bodyText = await request.text().catch(() => "")
    if (!verifyBolnaWebhook(request, headers, bodyText)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    let payload: BolnaExecution
    try {
      payload = JSON.parse(bodyText || "{}")
    } catch {
      return NextResponse.json({ status: "ok" })
    }
    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ status: "ok" })
    }

    const status = payload.status || ""
    const participant = await findParticipant(payload)

    if (!participant) {
      // Could be a pre-call in-progress webhook with no execution id yet, or a
      // scheduled/queued event before we persisted. Nothing to do.
      return NextResponse.json({ status: "ok" })
    }

    if (!BOLNA_TERMINAL_STATUSES.has(status)) {
      // Intermediate status — keep bolna_status fresh, do nothing else.
      const patch: Record<string, unknown> = {
        bolna_status: status,
        updated_at: new Date().toISOString(),
      }
      if (status === "in-progress") {
        patch.status = "in_progress"
        patch.call_started_at = new Date().toISOString()
      } else if (status === "initiated" || status === "ringing") {
        patch.status = "calling"
      }
      await supabaseAdmin
        .from("phone_screening_participants")
        .update(patch)
        .eq("id", participant.id)
      return NextResponse.json({ status: "ok" })
    }

    if (status === "completed") {
      await handleCompletedExecution(participant.id, payload)
    } else {
      await handleFailedExecution(participant, payload)
    }

    return NextResponse.json({ status: "ok" })
  } catch (error: any) {
    logger.error("Bolna execution webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}
