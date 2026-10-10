import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { evaluateCallQuality } from "@/lib/ai-learning"
import { getWhatsAppService } from "@/lib/whatsapp"
import { scheduleBolnaCall, MAX_CALL_ATTEMPTS } from "@/lib/scheduled-call"
import { enrichTranscript } from "@/lib/transcript-enrichment"
import { logCandidateActivity } from "@/lib/activity-logger"
import { toE164 } from "@/lib/phone"
import { appendWhatsappHistory } from "@/lib/whatsapp-history"
import { describeTemplate } from "@/lib/whatsapp-thread-shared"
import {
  getBolnaExecution,
  findLatestExecutionByPhone,
  BOLNA_TERMINAL_STATUSES,
  type BolnaExecution,
} from "@/lib/bolna"
import { generateFallbackSummary } from "@/lib/fallback-summary"

// Terminal-execution handling shared by the live webhook and the manual
// sync/reconcile recovery routes. Everything here must be idempotent enough to
// re-run on an execution whose webhook was missed.

export interface ParsedVerdict {
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

export function extractVerdictFromTranscript(transcript: string): ParsedVerdict | null {
  if (!transcript) return null
  // Bolna appends its own metadata to the transcript that is also a JSON object —
  // `{"General":{"Call Summary":{"subjective":"…"}}}` — and the transcript can
  // wrap the verdict in markdown fences. Both tripped the old regex-parse,
  // which stored that blob as verdict_json and silently dropped score and
  // recommendation, so 19/23 completed calls ended up with no worst verdict.
  const clean = transcript.replace(/```(?:json)?/gi, "").replace(/```/g, "")

  const attempts: string[] = []
  const match = clean.match(/\{[\s\S]*\}/)
  if (match) attempts.push(match[0])
  const firstBrace = clean.indexOf("{")
  const lastBrace = clean.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(clean.slice(firstBrace, lastBrace + 1))
  }

  for (const text of attempts) {
    if (!text) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && looksLikeVerdict(parsed)) {
        return parsed as ParsedVerdict
      }
    } catch {
      // Try the next candidate string.
    }
  }
  return null
}

/** Arbitrary JSON is not a verdict — Bolna's own `General/Call Summary` blob
 *  is JSON too. Only accept objects that carry the verdict's vocabulary. */
export function looksLikeVerdict(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  return [
    "score", "recommendation", "next_round_ready", "verdict_explanation",
    "pluses", "minuses", "relocation_willing", "current_salary",
    "expected_salary", "salary_manipulation_risk", "salary_notes",
    "callback_requested", "callback_time", "callback_preference_text",
    "key_answers", "summary",
  ].some((k) => k in obj)
}

/** Normalize a verdict so a score and a recommendation always travel together,
 *  and translate every alias ("pass", "review", "strong_fit", …) into the one
 *  value the column's CHECK constraint accepts. */
export function normalizeVerdict(pending: ParsedVerdict | Record<string, unknown>): ParsedVerdict {
  const raw = pending as ParsedVerdict
  const alias: Record<string, string> = {
    pass: "advance", fail: "not_a_fit", review: "further_review",
    strong_fit: "advance", good_fit: "further_review",
    possible_fit: "further_review", not_fit: "not_a_fit",
    advance: "advance", further_review: "further_review", not_a_fit: "not_a_fit",
  }
  const recommendation = raw.recommendation
    ? alias[String(raw.recommendation).toLowerCase()]
    : undefined
  const score =
    typeof raw.score === "number" ? Math.max(0, Math.min(10, Number(raw.score))) : undefined

  // One present implies the other, per the scoring band in the prompt:
  // advance = 8–10, further_review = 5–7, not_a_fit = 0–4.
  const resolvedScore =
    score ??
    (recommendation === "advance" ? 8
      : recommendation === "further_review" ? 6
      : recommendation === "not_a_fit" ? 2
      : raw.score)
  const resolvedRecommendation =
    recommendation ??
    (score !== undefined ? (score >= 8 ? "advance" : score >= 5 ? "further_review" : "not_a_fit")
      : raw.recommendation)

  return { ...raw, score: resolvedScore, recommendation: resolvedRecommendation }
}

export function transcriptToSegments(
  transcript: string
): { speaker: "ai" | "candidate"; text: string }[] {
  if (!transcript) return []
  const segments: { speaker: "ai" | "candidate"; text: string }[] = []

  // Patterns for AI speaker
  const aiPatterns = /^(assistant|ai|agent|bot|system|hiring manager|recruiter):\s*(.*)$/i
  // Patterns for candidate/user speaker
  const candidatePatterns = /^(user|candidate|human|applicant|interviewee|respondent):\s*(.*)$/i

  for (const rawLine of transcript.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue

    const aiMatch = line.match(aiPatterns)
    const candidateMatch = line.match(candidatePatterns)

    if (aiMatch) {
      if (aiMatch[2].trim()) segments.push({ speaker: "ai", text: aiMatch[2].trim() })
    } else if (candidateMatch) {
      if (candidateMatch[2].trim()) segments.push({ speaker: "candidate", text: candidateMatch[2].trim() })
    } else {
      // Continuation of the previous speaker's line.
      const last = segments[segments.length - 1]
      if (last) last.text = `${last.text} ${line}`
    }
  }

  // If no segments were parsed but transcript has content, treat entire thing as AI speech
  if (segments.length === 0 && transcript.trim()) {
    segments.push({ speaker: "ai", text: transcript.trim() })
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

export async function writeTranscriptSegments(
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

/**
 * Build a verdict from the transcript when Bolna's own extraction gave us
 * nothing. Every call must leave a summary behind — a recruiter opening a
 * candidate whose call produced no JSON cannot tell a short conversation from a
 * broken one, and that is exactly what was happening on the failed-call path.
 *
 * Returns the patch keys to merge, or null when generation failed.
 */
async function buildFallbackVerdictPatch(
  participantId: string,
  transcript: string
): Promise<Record<string, unknown> | null> {
  if (!transcript) return null
  try {
    const { data: participantMeta } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        candidate_id, job_id,
        candidates: candidate_id (id, name, phone, current_role),
        jobs: job_id (id, title, client_name)
      `)
      .eq("id", participantId)
      .single()

    if (!participantMeta) return null
    const fallback = await generateFallbackSummary(
      participantId,
      transcript,
      participantMeta.candidates as any,
      participantMeta.jobs as any
    )
    if (!fallback) return null

    await writeScreeningAnswers(participantId, fallback as any)
    const ratingAlias: Record<string, string> = {
      pass: "advance", fail: "not_a_fit", review: "further_review",
    }
    const rating = String(fallback.overall_verdict).toLowerCase()
    const recommendation = ratingAlias[rating] ?? ("further_review")
    const score = Math.max(0, Math.min(10, Math.round((fallback.confidence_score ?? 0) / 10)))
    return {
      verdict_json: fallback,
      ai_summary: fallback.comprehensive_summary,
      ai_recommendation: recommendation,
      ai_score: score,
      fallback_summary_used: true,
    }
  } catch (err: any) {
    logger.warn("Fallback summary generation failed", { participantId, error: err.message })
    return null
  }
}

export async function handleCompletedExecution(
  participantId: string,
  execution: BolnaExecution
): Promise<void> {
  const transcript = execution.transcript || ""
  const verdict = extractVerdictFromTranscript(transcript)
  const extracted = execution.extracted_data as Record<string, unknown> | null

  await writeTranscriptSegments(participantId, transcript)

  // Accept only verdict-shaped objects (Bolna appends a `{"General":{"Call
  // Summary":…}}` metadata blob to transcripts — JSON, but not a verdict), and
  // always normalize so score + recommendation are stored together.
  let effectiveVerdict: ParsedVerdict | null = null
  if (verdict) {
    effectiveVerdict = normalizeVerdict(verdict)
  } else if (extracted && looksLikeVerdict(extracted)) {
    effectiveVerdict = normalizeVerdict(extracted)
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

  // Resolve job/candidate for activity logging
  const { data: participantMeta } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("candidate_id, job_id")
    .eq("id", participantId)
    .single()

  if (effectiveVerdict) {
    patch.verdict_json = effectiveVerdict
    patch.ai_summary =
      typeof effectiveVerdict.summary === "string" && effectiveVerdict.summary.trim()
        ? effectiveVerdict.summary
        : JSON.stringify(effectiveVerdict)
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

  } else if (transcript) {
    const fallbackPatch = await buildFallbackVerdictPatch(participantId, transcript)
    if (fallbackPatch) Object.assign(patch, fallbackPatch)
  }

  // Log call completed event
  logCandidateActivity({
    jobId: participantMeta?.job_id || "",
    candidateId: participantMeta?.candidate_id || "",
    participantId,
    eventType: "call_completed",
    eventData: {
      duration_sec: rawDuration ? Number(rawDuration) : null,
      score: effectiveVerdict?.score,
      recommendation: effectiveVerdict?.recommendation,
      hangup_reason: execution.telephony_data?.hangup_reason,
    },
  })

  // Write the terminal patch first (completed status, transcript, etc.)
  await supabaseAdmin
    .from("phone_screening_participants")
    .update(patch)
    .eq("id", participantId)

  // Close the loop in the thread: "Call Now" was tapped, the call happened, and
  // here is what came of it — without this the chat ends on a booking that never
  // resolves.
  await appendWhatsappHistory(participantId, {
    at: now,
    kind: "call_completed",
    direction: "internal",
    text:
      effectiveVerdict?.score != null
        ? `Call completed — screening score ${Math.round(effectiveVerdict.score)}/100 is ready to review.`
        : "Call completed — transcript and summary recorded.",
    status: "completed",
  })

  // If the candidate requested a callback, override the status to call_scheduled
  // and schedule the re-dial via QStash.
  if (effectiveVerdict?.callback_requested || effectiveVerdict?.callback_preference_text) {
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

    // Log callback scheduled event
    logCandidateActivity({
      jobId: participantMeta?.job_id || "",
      candidateId: participantMeta?.candidate_id || "",
      participantId,
      eventType: "callback_scheduled",
      eventData: {
        scheduled_at: callbackAt,
        preference: callbackText,
      },
    })
  }

  evaluateCallQuality(participantId).then(() => {}).catch((err: any) => {
    logger.error("Async call quality evaluation failed", { participantId, error: err?.message })
  })

  // Enrich transcript with Gemini: resume + JD + transcript → detailed summary
  enrichTranscriptAsync(participantId, transcript, effectiveVerdict).catch((err: any) => {
    logger.error("Async transcript enrichment failed", { participantId, error: err?.message })
  })

  // Send post-call WhatsApp confirmation to candidate
  sendPostCallWhatsApp(participantId).catch((err: any) => {
    logger.error("Async post-call WhatsApp failed", { participantId, error: err?.message })
  })
}

async function sendPostCallWhatsApp(participantId: string): Promise<void> {
  const { data: participant } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      candidate_id, job_id,
      candidates: candidate_id (id, name, phone),
      jobs: job_id (id, title, client_name)
    `)
    .eq("id", participantId)
    .single()

  if (!participant) return
  const candidate = participant.candidates as any
  const job = participant.jobs as any
  if (!candidate?.phone) return

  const whatsapp = getWhatsAppService()
  const result = await whatsapp.sendCallCompleted({
    phoneNumber: candidate.phone,
    candidateName: candidate.name || "",
    jobTitle: job?.title || "",
    companyName: job?.client_name || "",
  })

  // sendTemplateMessage reports API-level rejections as success:false rather than
  // throwing, and the result was being discarded. So when the post-call template
  // was missing or misconfigured, every candidate who finished a call simply got
  // nothing afterwards and no log said why — the flow looked healthy end to end.
  // Recorded in the thread so a failed post-call send is visible to a recruiter
  // instead of being indistinguishable from "we decided not to text them".
  // The body is the rendered registry text, not our own one-liner. The template
  // name comes from what was actually sent, because the send resolves it through
  // an env override that a hardcoded "call_completed" would contradict.
  const postCallTemplate =
    result.templateName || process.env.WHATSAPP_TEMPLATE_CALL_COMPLETED || "call_completed"
  await appendWhatsappHistory(participantId, {
    at: new Date().toISOString(),
    kind: "post_call_message",
    direction: "out",
    template: postCallTemplate,
    text: result.renderedBody
      ?? (result.success ? describeTemplate(postCallTemplate) : "Post-call message was not sent."),
    status: result.success ? "sent" : "failed",
    messageId: result.messageId ?? null,
    error: result.success ? null : result.error ?? null,
  })

  if (!result.success) {
    logger.error("Post-call WhatsApp failed", {
      participantId,
      candidateId: participant.candidate_id,
      error: result.error,
    })
  }
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
      candidate_id, job_id, ai_score, ai_recommendation,
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

  // Derive a score/recommendation when this call never produced one (e.g. the
  // Bolna verdict was rejected or never emitted). Never overwrite a real one.
  const ratingAlias: Record<string, string> = {
    strong_fit: "advance", good_fit: "further_review",
    possible_fit: "further_review", not_fit: "not_a_fit",
  }
  const recommendation = ratingAlias[enriched.overall_verdict] ?? "further_review"
  // Derive an internally consistent score from the verdict band (not the model's
  // confidence, which is a separate measure): advance ~8, further_review ~6,
  // not_a_fit ~2. Keeps "8/10 advance" style labels coherent on the card.
  const derivedScore = { advance: 8, further_review: 6, not_a_fit: 2 }[recommendation]
  const hasScore = typeof participant.ai_score === "number" || typeof participant.ai_recommendation === "string"

  // Store enriched summary
  await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      enriched_summary: enriched,
      ai_summary: enriched.comprehensive_summary,
      ...(hasScore ? {} : {
        ai_score: derivedScore,
        ai_recommendation: recommendation,
      }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", participantId)

  logger.info(`Transcript enriched for participant ${participantId}`, {
    verdict: enriched.overall_verdict,
    confidence: enriched.confidence_score,
    derivedScore: !hasScore ? derivedScore : undefined,
  })
}

export interface ParticipantRecord {
  id: string
  call_attempts: number
  retry_count: number
  whatsapp_missed_nudge_sent: boolean
  whatsapp_history: Array<{ messageId: string | null; template: string; sentAt: string; status: string }> | null
  candidates?: { id: string; name?: string | null; phone?: string | null } | null
  jobs?: { id: string; title?: string | null; client_name?: string | null } | null
}

const PARTICIPANT_SELECT = `
  id, status, call_attempts, retry_count, whatsapp_missed_nudge_sent, whatsapp_history,
  candidates: candidate_id (id, name, phone),
  jobs: job_id (id, title, client_name)
`

export async function findParticipant(
  execution: BolnaExecution,
  requestedExecutionId?: string
): Promise<ParticipantRecord | null> {
  // Bolna's GET /executions/{id} response `id` field can differ from the
  // execution_id used in the path / recording URL / what we stored — so match
  // the requested id first, then the response id, then context.
  const idsToTry = [requestedExecutionId, execution.id].filter((x) => !!x) as string[]
  for (const executionId of idsToTry) {
    const { data } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(PARTICIPANT_SELECT)
      .eq("bolna_execution_id", executionId)
      .maybeSingle()
    if (data) return data as unknown as ParticipantRecord
  }

  const contextPid =
    execution.context_details?.participant_id ||
    (execution.context_details?.recipient_data as Record<string, unknown> | undefined)?.participant_id
  const participantId = typeof contextPid === "string" ? contextPid : undefined
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

// Find a participant by the candidate attached to it (email and/or phone).
// Storage formats vary (spaces, hyphens, prefixes, missing phone_e164 until the
// migration/backfill runs), so phone matching is done on the stable last-10
// digits via ILIKE and a participant-side scan as a final fallback.
export async function findParticipantByCandidate(input: {
  phone?: string
  email?: string
}): Promise<ParticipantRecord | null> {
  const candidateIds = new Set<string>()

  const last10 = input.phone ? (input.phone.replace(/\D/g, "").slice(-10)) : ""
  const validLast10 = last10.length === 10

  const addCandidates = (rows: { id: string }[] | null) => {
    for (const row of rows || []) candidateIds.add(row.id)
  }

  if (input.email) {
    const email = input.email.trim().toLowerCase()
    const { data } = await supabaseAdmin
      .from("candidates")
      .select("id")
      .ilike("email", email)
      .limit(5)
    addCandidates(data)
    if (candidateIds.size === 0) {
      // Fields may carry surrounding whitespace or extra casing.
      const { data: loose } = await supabaseAdmin
        .from("candidates")
        .select("id")
        .ilike("email", `%${email}%`)
        .limit(5)
      addCandidates(loose)
    }
  }

  if (input.phone) {
    const e164 = toE164(input.phone)
    if (e164) {
      const { data } = await supabaseAdmin
        .from("candidates")
        .select("id")
        .eq("phone_e164", e164)
        .limit(5)
      addCandidates(data)
    }
    if (validLast10) {
      // Match any stored formatting — last 10 digits are stable.
      const { data } = await supabaseAdmin
        .from("candidates")
        .select("id")
        .ilike("phone", `%${last10}%`)
        .limit(5)
      addCandidates(data)
    }
    for (const variant of phoneMatchVariants(input.phone)) {
      const { data } = await supabaseAdmin
        .from("candidates")
        .select("id")
        .eq("phone", variant)
        .limit(5)
      addCandidates(data)
    }
  }

  const candidateIdsArray = [...candidateIds]

  if (candidateIdsArray.length > 0) {
    const { data: participants } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(PARTICIPANT_SELECT)
      .in("candidate_id", candidateIdsArray)
      .order("last_attempt_at", { ascending: false })
      .limit(10)
    if (participants && participants.length > 0) {
      return pickStuckParticipant(participants)
    }
  }

  // Participant-side fallback: scan recent drill participants and compare the
  // candidate's stored phone by last-10 digits (covers null/candidate_id drift).
  if (validLast10) {
    const { data: candidates } = await supabaseAdmin
      .from("candidates")
      .select("id, phone")
      .ilike("phone", `%${last10}%`)
      .limit(20)
    const ids = candidates?.map((c) => c.id) || []
    if (ids.length > 0) {
      const { data: participants } = await supabaseAdmin
        .from("phone_screening_participants")
        .select(PARTICIPANT_SELECT)
        .in("candidate_id", ids)
        .order("last_attempt_at", { ascending: false })
        .limit(10)
      if (participants && participants.length > 0) {
        return pickStuckParticipant(participants)
      }
    }
  }

  return null
}

function pickStuckParticipant(
  participants: any[]
): ParticipantRecord | null {
  // Prefer a still-stuck drill (calling/in_progress) so recovery targets live calls.
  const stuck = participants.find(
    (p) => p?.status === "calling" || p?.status === "in_progress"
  )
  return ((stuck || participants[0]) as unknown) as ParticipantRecord
}

function phoneMatchVariants(phone: string): string[] {
  const clean = phone.replace(/[^0-9]/g, "")
  const variants = new Set<string>([clean])
  if (clean.startsWith("91") && clean.length === 12) {
    variants.add(clean.slice(2)) // national format
    variants.add(`+${clean}`)
  } else if (clean.length === 10) {
    variants.add(`91${clean}`)
    variants.add(`+91${clean}`)
  } else if (clean.length === 11 && clean.startsWith("0")) {
    variants.add(clean.slice(1))
    variants.add(`91${clean.slice(1)}`)
  }
  return [...variants]
}

// Resolve the participant (and fetch its Bolna execution) from whatever lookup
// is available. Shared by sync-execution and reconcile single-target recovery.
export async function resolveSyncTarget(params: {
  executionId?: string
  phone?: string
  email?: string
}): Promise<{ execution: BolnaExecution | null; participant: ParticipantRecord | null }> {
  let execution: BolnaExecution | null = null
  let participant: ParticipantRecord | null = null

  // 1. By execution id (recording URL id == execution id per Bolna).
  if (params.executionId) {
    execution = await getBolnaExecution(params.executionId)
    if (execution) {
      participant = await findParticipant(execution, params.executionId)
      // 1a. Executions API usually doesn't echo user_data context for single
      //     calls — fall back to matching the dialed number if we can't match.
      if (!participant) {
        const dialed = execution.telephony_data?.to_number || (execution as any).user_number || null
        if (dialed) participant = await findParticipantByCandidate({ phone: dialed })
      }
    }
  }

  // 2. By phone / email against our candidates.
  if (!participant && (params.phone || params.email)) {
    participant = await findParticipantByCandidate({
      phone: params.phone,
      email: params.email,
    })
  }

  // 3. We found the participant but still lack the execution: use the stored id
  //    or locate the execution on Bolna by the dialed number.
  if (participant && !execution) {
    const { data: stored } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("bolna_execution_id")
      .eq("id", participant.id)
      .maybeSingle()
    if (stored?.bolna_execution_id) {
      execution = await getBolnaExecution(stored.bolna_execution_id)
    }
    if (!execution) {
      const candidatePhone = participant.candidates?.phone
      if (candidatePhone) {
        execution = await findLatestExecutionByPhone(candidatePhone)
      }
    }
  }

  return { execution, participant }
}

// Adopt a Bolna execution id that was missing/mismatched so future webhooks match.
export async function persistBolnaExecutionId(
  participantId: string,
  executionId: string
): Promise<void> {
  if (!executionId) return
  const { data } = await supabaseAdmin
    .from("phone_screening_participants")
    .select("bolna_execution_id")
    .eq("id", participantId)
    .maybeSingle()
  if (!data?.bolna_execution_id) {
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ bolna_execution_id: executionId, updated_at: new Date().toISOString() })
      .eq("id", participantId)
  }
}

export async function handleFailedExecution(
  participant: ParticipantRecord,
  execution: BolnaExecution
): Promise<void> {
  const now = new Date().toISOString()

  // Detect a partial / mid-conversation drop: candidate (or agent) hung up while a
  // conversation had started — we have a partial transcript but never reached a verdict.
  const isPartialCall =
    execution.transcript &&
    execution.status !== "no-answer" &&
    execution.status !== "busy" &&
    ["stopped", "canceled", "failed", "error"].includes(execution.status || "")

  const currentRetryCount = (participant.retry_count || 0) + 1
  const maxRetriesReached = currentRetryCount >= MAX_CALL_ATTEMPTS

  const retryMinutes =
    execution.status === "no-answer" || execution.status === "busy" ? 15 : 60

  const patch: Record<string, unknown> = {
    status: isPartialCall ? "failed_partial" : maxRetriesReached ? "unreachable" : "failed",
    bolna_status: execution.status || "failed",
    call_ended_at: now,
    retry_count: currentRetryCount,
    call_is_partial: isPartialCall ? true : null,
    updated_at: now,
  }

  // Only set next_retry_at if we haven't reached max retries
  if (!maxRetriesReached) {
    patch.next_retry_at = new Date(Date.now() + retryMinutes * 60 * 1000).toISOString()
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
    patch.call_disconnect_reason = execution.telephony_data.hangup_reason
  }
  if (execution.context_details?.timezone) {
    patch.candidate_timezone = execution.context_details.timezone
  }

  // Store partial transcript if call disconnected mid-conversation
  if (execution.transcript && execution.status !== "no-answer" && execution.status !== "busy") {
    patch.transcript_raw = execution.transcript
    // Also store partial segments
    const segments = transcriptToSegments(execution.transcript)
    if (segments.length > 0) {
      const rows = segments.map((s) => ({
        participant_id: participant.id,
        speaker: s.speaker,
        text: s.text,
        is_partial: true,
      }))
      await supabaseAdmin.from("call_transcripts").insert(rows)
    }

    // Best-effort partial verdict + answers from whatever the transcript captured.
    const partialVerdict = extractVerdictFromTranscript(execution.transcript)
    if (partialVerdict) {
      const normalized = normalizeVerdict(partialVerdict)
      patch.verdict_json = normalized
      patch.ai_summary =
        typeof normalized.summary === "string" && normalized.summary.trim()
          ? normalized.summary
          : JSON.stringify(normalized)
      if (typeof normalized.score === "number") patch.ai_score = normalized.score
      if (normalized.recommendation) patch.ai_recommendation = normalized.recommendation
      await writeScreeningAnswers(participant.id, normalized)
    } else {
      // The model ended without emitting its JSON — a dropped line, a busy tone,
      // a candidate who hung up first. The conversation still happened, so it
      // still gets a summary; without this the candidate showed up in review
      // with a transcript and no score, indistinguishable from a no-op call.
      const fallbackPatch = await buildFallbackVerdictPatch(participant.id, execution.transcript)
      if (fallbackPatch) Object.assign(patch, fallbackPatch)
    }
  }

  await supabaseAdmin
    .from("phone_screening_participants")
    .update(patch)
    .eq("id", participant.id)

  // Log call failed event
  logCandidateActivity({
    jobId: participant.jobs?.id || "",
    candidateId: participant.candidates?.id || "",
    participantId: participant.id,
    eventType: execution.status === "no-answer" || execution.status === "busy" ? "call_missed" : "call_failed",
    eventData: {
      reason: execution.status || execution.error_message,
      attempts: currentRetryCount,
      maxRetriesReached,
    },
  })

  // Explain the failure inside the thread itself, in plain language. Without
  // this, a recruiter reads only the WhatsApp exchange and has to dig into
  // provider metadata to learn the call never connected.
  const unanswered = execution.status === "no-answer" || execution.status === "busy"
  await appendWhatsappHistory(participant.id, {
    at: now,
    kind: unanswered ? "call_missed" : "call_failed",
    direction: "internal",
    text: isPartialCall
      ? "Call got cut off mid-conversation — whatever was captured is flagged for human review."
      : maxRetriesReached
        ? "Couldn't reach the candidate after several attempts — the profile is marked unreachable."
        : unanswered
          ? "The candidate didn't pick up — we'll retry shortly."
          : execution.status === "error" || execution.status === "failed"
            ? "The call failed to connect — we'll try again later."
            : `The call ended early (${execution.status}).`,
    status: "failed",
    error: execution.error_message || execution.status || undefined,
  })

  // If max retries reached, don't send any more WhatsApp messages
  if (maxRetriesReached) {
    logger.info("Max call retries reached, marking as unreachable", {
      participantId: participant.id,
      retryCount: currentRetryCount,
    })
    return
  }

  // Missed-call reschedule: send WhatsApp with [Call Now] [In 10 min] [In 1 hour] [Tomorrow morning]
  if (!participant.whatsapp_missed_nudge_sent && participant.candidates?.phone) {
    const candidate = participant.candidates
    const job = participant.jobs
    const whatsapp = getWhatsAppService()
    const nudge = await whatsapp.sendMissedCallReschedule({
      phoneNumber: candidate.phone || "",
      candidateName: candidate.name || "",
      jobTitle: job?.title || "",
      companyName: job?.client_name || "",
    })
    if (nudge.success) {
      // Append to WhatsApp history instead of overwriting. This used to push
      // onto `participant.whatsapp_history`, a copy taken before the attempt —
      // which silently erased any thread entry recorded after that snapshot
      // (e.g. the call-outcome note above).
      await appendWhatsappHistory(participant.id, {
        at: now,
        kind: "outbound_template",
        direction: "out",
        template: "missed_call_reschedule",
        text: nudge.renderedBody || null,
        sentAt: now,
        status: "sent",
        messageId: nudge.messageId || null,
      })
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          whatsapp_missed_nudge_sent: true,
          whatsapp_message_id: nudge.messageId || null,
          whatsapp_sent_at: now,
          whatsapp_delivery_status: "sent",
          whatsapp_outbound_template: "missed_call_reschedule",
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

export { BOLNA_TERMINAL_STATUSES }