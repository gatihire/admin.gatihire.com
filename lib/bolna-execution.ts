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
import { updateParticipantSafely } from "@/lib/participant-update"

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
  const aiPatterns = /^(assistant|ai|agent|bot|system|hiring manager|recruiter|ai screener|screener):\s*(.*)$/i
  // Patterns for candidate/user speaker
  const candidatePatterns = /^(user|candidate|human|applicant|interviewee|respondent):\s*(.*)$/i

  const lines = transcript.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const line = rawLine.trim()
    if (!line) continue

    const aiMatch = line.match(aiPatterns)
    const candidateMatch = line.match(candidatePatterns)

    if (aiMatch) {
      if (aiMatch[2] && aiMatch[2].trim()) {
        segments.push({ speaker: "ai", text: aiMatch[2].trim() })
      } else if (i + 1 < lines.length) {
        // Label on its own line, next line is the speech
        const nextLine = lines[i + 1].trim()
        if (nextLine && !/^(assistant|ai|agent|bot|system|hiring manager|recruiter|ai screener|screener|user|candidate|human|applicant|interviewee|respondent):/i.test(nextLine) && !/^Candidate$/i.test(nextLine) && !/^AI Screener$/i.test(nextLine)) {
          segments.push({ speaker: "ai", text: nextLine })
          i++ // skip next line
          continue
        }
      }
      continue
    } else if (candidateMatch) {
      if (candidateMatch[2] && candidateMatch[2].trim()) {
        segments.push({ speaker: "candidate", text: candidateMatch[2].trim() })
      } else if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim()
        if (nextLine && !/^(assistant|ai|agent|bot|system|hiring manager|recruiter|ai screener|screener|user|candidate|human|applicant|interviewee|respondent):/i.test(nextLine) && !/^Candidate$/i.test(nextLine) && !/^AI Screener$/i.test(nextLine)) {
          segments.push({ speaker: "candidate", text: nextLine })
          i++
          continue
        }
      }
      continue
    } else if (/^AI Screener$/i.test(line)) {
      // Label on its own line
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim()
        if (nextLine && !/^Candidate$/i.test(nextLine) && !/^AI Screener$/i.test(nextLine)) {
          segments.push({ speaker: "ai", text: nextLine })
          i++
          continue
        }
      }
      continue
    } else if (/^Candidate$/i.test(line)) {
      // Label on its own line
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim()
        if (nextLine && !/^Candidate$/i.test(nextLine) && !/^AI Screener$/i.test(nextLine)) {
          segments.push({ speaker: "candidate", text: nextLine })
          i++
          continue
        }
      }
      continue
    } else {
      // Continuation of the previous speaker's line.
      const last = segments[segments.length - 1]
      if (last) {
        last.text = `${last.text} ${line}`
      } else {
        // No previous speaker, might be candidate response
        segments.push({ speaker: "candidate", text: line })
      }
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
    // Same rerun-safety as transcripts: replace instead of stacking duplicates.
    const { error: clearError } = await supabaseAdmin
      .from("screening_answers")
      .delete()
      .eq("participant_id", participantId)
    if (clearError) {
      logger.warn("Failed to replace Bolna screening answers", { participantId, error: clearError.message })
    }

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

  // Replace, don't append: handleCompletedExecution is intentionally re-runnable
  // (webhook retry, reconcile, on-view heal). Blind inserts stacked the same
  // transcript several times in the sheet.
  const { error: clearError } = await supabaseAdmin
    .from("call_transcripts")
    .delete()
    .eq("participant_id", participantId)
  if (clearError) {
    logger.warn("Failed to replace Bolna transcript", { participantId, error: clearError.message })
  }

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
    // Derive score from recommendation for consistency (not from confidence)
    // Penalize very short conversations
    const wordCount = transcript.split(/\s+/).filter(w => w.length > 0).length
    const unavailablePattern = /unavailable|not available|couldn't speak|immediately terminated|hung up|disconnected|call back later/i.test(transcript)
    let derivedScore = recommendation === "advance" ? 8 : recommendation === "further_review" ? 6 : 2
    if (wordCount < 50 || unavailablePattern) derivedScore = 2
    else if (wordCount < 100) derivedScore = Math.min(derivedScore, 4)
    const score = derivedScore
    const cls = (wordCount < 50 || unavailablePattern) ? "not_screened" : undefined
    const vj: any = { ...(fallback as any) }
    if (cls) vj._classification_outcome = cls
    // NOTE: `fallback_summary_used` is deliberately stored INSIDE verdict_json.
    // phone_screening_participants has no such column, and writing it top-level
    // made PostgREST reject the whole update (PGRST204) — which silently left
    // finished calls stuck as "calling now" and summaries unwritten.
    vj._fallback_summary_used = true
    const result: Record<string, unknown> = {
      verdict_json: vj,
      ai_summary: fallback.comprehensive_summary,
      ai_recommendation: (wordCount < 50 || unavailablePattern) ? "not_a_fit" : recommendation,
      ai_score: score,
    }
    // Only include `status` when it must change. Returning `status: undefined`
    // and merging it with Object.assign used to overwrite the terminal
    // "completed" status set by the caller, leaving finished calls stuck as
    // "in_progress"/"on the call now" even though every other field saved.
    if (wordCount < 50 || unavailablePattern) result.status = "failed"
    return result
  } catch (err: any) {
    logger.warn("Fallback summary generation failed", { participantId, error: err.message })
    return null
  }
}

type CallAttemptSnapshot = {
  attempt: number
  bolna_execution_id: string | null
  status: string | null
  bolna_status: string | null
  classification_outcome: string | null
  call_ended_at: string | null
  call_duration_seconds: number | null
  recording_url: string | null
  transcript_raw: string | null
  ai_score: number | null
  ai_recommendation: string | null
  ai_summary: string | null
  verdict_json: any
  hangup_by: string | null
  call_hangup_reason: string | null
  call_disconnect_reason: string | null
  call_is_partial?: boolean | null
}

function extractClassificationFromVerdict(vj: any): string | null {
  if (!vj) return null
  try {
    const obj = typeof vj === "string" ? JSON.parse(vj) : vj
    return obj?._classification_outcome || obj?.classification_outcome || null
  } catch {
    return null
  }
}

async function snapshotPreviousCallAttempt(participantId: string, incomingExecutionId?: string | null): Promise<void> {
  try {
    const { data: p } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, screening_context, verdict_json, ai_score, ai_recommendation, ai_summary, recording_url, call_duration_seconds, call_ended_at, call_hangup_reason, call_disconnect_reason, hangup_by, status, bolna_status, bolna_execution_id, call_attempts, transcript_raw, call_is_partial")
      .eq("id", participantId)
      .maybeSingle()
    if (!p) return

    const incoming = incomingExecutionId ? String(incomingExecutionId) : null
    const currentExec = p.bolna_execution_id ? String(p.bolna_execution_id) : null
    // Same execution sync/update: do not create duplicate history
    if (incoming && currentExec && incoming === currentExec) return

    // Only snapshot if there is evidence of a previous ended call/result
    const hasPreviousResult = !!(
      p.call_ended_at || p.recording_url || p.transcript_raw || p.verdict_json || p.ai_summary ||
      (p.bolna_status && ["completed","failed","stopped","canceled","no-answer","busy","error","call-disconnected"].includes(String(p.bolna_status).toLowerCase()))
    )
    if (!hasPreviousResult) return

    const ctx = (p.screening_context && typeof p.screening_context === "object" && !Array.isArray(p.screening_context))
      ? { ...(p.screening_context as any) }
      : {}
    const history: CallAttemptSnapshot[] = Array.isArray(ctx.call_attempt_history) ? [...ctx.call_attempt_history] : []

    // Avoid duplicating the same execution snapshot
    if (currentExec && history.some(h => h?.bolna_execution_id && String(h.bolna_execution_id) === currentExec)) return

    const attemptNum = Math.max(1, Number(p.call_attempts || 1))
    const snapshot: CallAttemptSnapshot = {
      attempt: attemptNum,
      bolna_execution_id: currentExec,
      status: p.status ?? null,
      bolna_status: p.bolna_status ?? null,
      classification_outcome: extractClassificationFromVerdict(p.verdict_json),
      call_ended_at: p.call_ended_at ?? null,
      call_duration_seconds: p.call_duration_seconds ?? null,
      recording_url: p.recording_url ?? null,
      transcript_raw: p.transcript_raw ?? null,
      ai_score: p.ai_score ?? null,
      ai_recommendation: p.ai_recommendation ?? null,
      ai_summary: p.ai_summary ?? null,
      verdict_json: p.verdict_json ?? null,
      hangup_by: p.hangup_by ?? null,
      call_hangup_reason: p.call_hangup_reason ?? null,
      call_disconnect_reason: p.call_disconnect_reason ?? null,
      call_is_partial: p.call_is_partial ?? null,
    }

    // Keep latest snapshots (max 2)
    history.unshift(snapshot)
    ctx.call_attempt_history = history.slice(0, 2)

    await supabaseAdmin
      .from("phone_screening_participants")
      .update({ screening_context: ctx, updated_at: new Date().toISOString() })
      .eq("id", participantId)
  } catch (err) {
    logger.warn("Failed to snapshot previous call attempt", { participantId, error: (err as any)?.message })
  }
}

export async function handleCompletedExecution(
  participantId: string,
  execution: BolnaExecution,
  options?: { suppressSideEffects?: boolean }
): Promise<void> {
  // Backfills/repairs re-apply terminal handling to calls that already went
  // through the webhook. They must not text the candidate again, re-schedule a
  // callback, or duplicate timelime/quality entries.
  const sideEffects = options?.suppressSideEffects !== true
  const transcript = execution.transcript || ""
  const verdict = extractVerdictFromTranscript(transcript)
  const extracted = (execution.extracted_data as Record<string, unknown> | null) || (execution as any).custom_extractions || null

  await writeTranscriptSegments(participantId, transcript)

  // Prefer extracted_data from Bolna; fallback to parsing transcript for backward compat
  let effectiveVerdict: ParsedVerdict | null = null
  if (extracted && looksLikeVerdict(extracted)) {
    effectiveVerdict = normalizeVerdict(extracted)
  } else if (verdict) {
    effectiveVerdict = normalizeVerdict(verdict)
  }

  const now = new Date().toISOString()
  const rawDuration = execution.conversation_duration ?? execution.telephony_data?.duration
  const hangupReason = execution.telephony_data?.hangup_reason || null
  const hangupBy = execution.telephony_data?.hangup_by || null
  const isSynthesizerError = hangupReason === "synthesizer_error"
  const isVoicemail =
    execution.answered_by_voice_mail === true || hangupReason === "voicemail_detected" || hangupReason === "voicemail"

  // Classify outcomes per fix plan (B.2.3)
  const statusFromExec = (execution.status || "").toLowerCase()
  const isRetryStatus = ["busy", "no-answer", "failed", "canceled"].includes(statusFromExec)

  let classification: "screened" | "not_screened" | "interrupted" | "retry" | "voicemail" = "screened"

  if (isRetryStatus) {
    classification = "retry"
  } else if (isVoicemail) {
    classification = "voicemail"
  } else {
    const durationSec = rawDuration ? Number(rawDuration) : 0
    // Count user turns roughly
    // Count candidate turns more robustly
    const segmentsForCount = transcriptToSegments(transcript)
    const userTurnCount = segmentsForCount.filter(s => s.speaker === "candidate").filter(s => s.text && s.text.trim().length > 0).length
    const hasClosingLine = /Dhanyavaad|Thank you.*goodbye|goodbye|Aapka bahut shukriya/i.test(transcript)
    const hasRecommendation = !!effectiveVerdict?.recommendation
    const hungUpByCandidate = hangupBy === "user" || hangupBy === "candidate"
    const unavailablePattern = /unavailable|not available|couldn't speak|immediately terminated|hung up|disconnected|cannot hear|can't hear|not able to listen|audio issue|voice not audible|inaudible|no audio/i.test(transcript)

    // If it's a very short call with minimal engagement, it's not a proper screening
    if (durationSec < 30 || userTurnCount < 2 || (hungUpByCandidate && durationSec < 60) || unavailablePattern && durationSec < 90) {
      classification = "not_screened"
    } else if (durationSec < 60 || userTurnCount < 3) {
      // Very short call - likely not a proper screening
      classification = "not_screened"
    } else if (hasClosingLine || hasRecommendation) {
      classification = "screened"
    } else {
      // Candidate was mid-answer when call died (or synthesizer error)
      classification = "interrupted"
    }
  }

  const patch: Record<string, unknown> = {
    // `failed_partial` is NOT in the status CHECK constraint, so writing it made
    // Postgres reject the entire patch (partial calls never persisted at all).
    // `failed` + call_is_partial carries the same meaning and always saves.
    status:
      classification === "interrupted" ||
      classification === "not_screened" ||
      classification === "retry" ||
      classification === "voicemail"
        ? "failed"
        : "completed",
    call_is_partial: classification === "interrupted" ? true : undefined,
    bolna_status: execution.status || "completed",
    call_duration_seconds: rawDuration != null && rawDuration !== '' && !Number.isNaN(Number(rawDuration)) ? Math.round(Number(rawDuration)) : null,
    // Prefer the provider's own terminal timestamp: a repaired call must not
    // look like it ended at repair time (that made old calls look "recent").
    call_ended_at: execution.updated_at || now,
    updated_at: now,
  }
  // Flag incomplete screenings for HR follow-up (send call again / WhatsApp).
  // Voicemail and provider-retry outcomes never screened the candidate either,
  // so they must surface in /jobs and /today just like other incomplete calls.
  if (
    classification === "not_screened" ||
    classification === "interrupted" ||
    classification === "voicemail" ||
    classification === "retry"
  ) {
    patch.needs_manual_followup = true
  }

  const recordingUrl =
    execution.telephony_data?.recording_url ||
    (execution as any).recording_url ||
    (execution as any).conversation_recording_url ||
    (execution as any).recording?.url ||
    null
  if (recordingUrl) {
    patch.recording_url = recordingUrl
  }

  // Store cost, voicemail detection, hangup reason (data we were throwing away)
  if (typeof execution.total_cost === "number") {
    patch.call_cost_cents = Math.round(execution.total_cost * 100)
  }
  if (typeof execution.answered_by_voice_mail === "boolean") {
    patch.call_voicemail = execution.answered_by_voice_mail
  }
  if (hangupReason) {
    patch.call_hangup_reason = hangupReason
  }
  if (hangupBy) {
    patch.hangup_by = hangupBy
  }
  if (hangupBy) {
    patch.hangup_by = hangupBy
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
    // Don't trust scores from very short calls with minimal engagement
    const segmentsForCountCheck = transcriptToSegments(transcript)
    const userTurnCountCheck = segmentsForCountCheck.filter(s => s.speaker === "candidate").filter(s => s.text && s.text.trim().length > 0).length
    const durationSecCheck = rawDuration ? Number(rawDuration) : 0
    const unavailablePatternCheck = /unavailable|not available|couldn't speak|immediately terminated|hung up|disconnected|cannot hear|can't hear|not able to listen|audio issue|voice not audible|inaudible|no audio/i.test(transcript)
    if (typeof effectiveVerdict.score === "number") {
      if (durationSecCheck < 30 || userTurnCountCheck < 2 || (hangupBy === "user" && durationSecCheck < 60) || (unavailablePatternCheck && durationSecCheck < 90)) {
        // For very short calls, be conservative - mark as not screened (1st screening incomplete)
        classification = "not_screened"
        if (patch.status === "completed") patch.status = "failed"
        patch.needs_manual_followup = true
        patch.ai_score = Math.min(effectiveVerdict.score, 2)
        patch.ai_recommendation = "not_a_fit"
        patch.verdict_json = { ...(effectiveVerdict as any), score: 2, recommendation: "not_a_fit", notes: "1st screening incomplete (call ended/couldn’t hear/auto-cut or too short). Assessment not based on a completed conversation. HR should review transcript and send call again." }
      } else {
        patch.ai_score = effectiveVerdict.score
        if (effectiveVerdict.recommendation) patch.ai_recommendation = effectiveVerdict.recommendation
      }
    } else if (effectiveVerdict.recommendation) {
      patch.ai_recommendation = effectiveVerdict.recommendation
    }

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
    // Never let an undefined value in the fallback blob erase a field the
    // terminal handler already set (notably `status: "completed"`).
    if (fallbackPatch) {
      for (const [key, value] of Object.entries(fallbackPatch)) {
        if (value !== undefined) patch[key] = value
      }
    }
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
  // If classified as not_screened due to minimal engagement, ensure status reflects it
  if (classification === "not_screened" && patch.status !== "failed" && patch.status !== "failed_partial") {
    patch.status = "failed"
  }
  // Persist classification in verdict_json metadata (classification_outcome column may not exist)
  try {
    const vj = patch.verdict_json
    if (vj && typeof vj === "object" && !Array.isArray(vj)) {
      ;(vj as any)._classification_outcome = classification
      ;(vj as any)._hangup_by = hangupBy || null
      ;(vj as any)._call_hangup_reason = hangupReason || null
      patch.verdict_json = vj
    } else if (classification && classification !== "screened") {
      patch.verdict_json = { _classification_outcome: classification, _hangup_by: hangupBy || null, _call_hangup_reason: hangupReason || null }
    }
  } catch {}
  // Never swallow this: a failed write here is exactly what leaves a finished
  // call stuck as "calling now" in the portal.
  await updateParticipantSafely(participantId, patch, {
    executionId: execution.id,
    source: "handleCompletedExecution",
  })

  // Close the loop in the thread: "Call Now" was tapped, the call happened, and
  // here is what came of it — without this the chat ends on a booking that never
  // resolves.
  if (sideEffects) {
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
  }

  // If the candidate requested a callback, override the status to call_scheduled
  // and schedule the re-dial via QStash.
  if (sideEffects && (effectiveVerdict?.callback_requested || effectiveVerdict?.callback_preference_text)) {
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

  if (sideEffects) {
    evaluateCallQuality(participantId).then(() => {}).catch((err: any) => {
      logger.error("Async call quality evaluation failed", { participantId, error: err?.message })
    })

    // Enrich transcript with Gemini: resume + JD + transcript → detailed summary
    enrichTranscriptAsync(participantId, transcript, effectiveVerdict).catch((err: any) => {
      logger.error("Async transcript enrichment failed", { participantId, error: err?.message })
    })

    // Send post-call WhatsApp confirmation to candidate
    sendPostCallWhatsApp(participantId, execution.id).catch((err: any) => {
      logger.error("Async post-call WhatsApp failed", { participantId, error: err?.message })
    })
  }
}

async function sendPostCallWhatsApp(participantId: string, executionId?: string | null): Promise<void> {
  const { data: participant } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      candidate_id, job_id, whatsapp_history, call_started_at, call_attempts,
      candidates: candidate_id (id, name, phone),
      jobs: job_id (id, title, client_name)
    `)
    .eq("id", participantId)
    .single()

  if (!participant) return
  const candidate = participant.candidates as any
  const job = participant.jobs as any
  if (!candidate?.phone) return

  // Re-healing the same execution (webhook retried, reconcile, on-view heal)
  // must not text the candidate twice. Execution ids are recorded going
  // forward; for older entries fall back to a short recency window.
  const history = Array.isArray((participant as any).whatsapp_history)
    ? ((participant as any).whatsapp_history as any[])
    : []
  const callStartedMs = (participant as any).call_started_at
    ? new Date((participant as any).call_started_at).getTime()
    : 0
  const alreadySent = history.some((h) => {
    if (!h || h.kind !== "post_call_message") return false
    if (executionId && h.executionId === executionId) return true
    // Older entries have no execution id: if the message was sent after this
    // attempt started, it belongs to this call.
    if (!h.executionId && h.at) {
      const at = new Date(h.at).getTime()
      if (!Number.isFinite(at)) return false
      return callStartedMs ? at >= callStartedMs - 5 * 60 * 1000 : Date.now() - at < 15 * 60 * 1000
    }
    return false
  })
  if (alreadySent) {
    logger.info("Skipping duplicate post-call WhatsApp", { participantId, executionId })
    return
  }

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
    executionId: executionId ?? null,
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
      candidate_id, job_id, ai_score, ai_recommendation, status, call_is_partial, bolna_status, call_duration_seconds,
      candidates: candidate_id (id, name, current_role, current_company, total_experience, location, technical_skills, resume_text),
      jobs: job_id (id, title, client_name, city, location, experience_min_years, experience_max_years, salary_min, salary_max, salary_type, skills_must_have, skills_good_to_have, description)
    `)
    .eq("id", participantId)
    .single()

  if (!participant) return

  const candidate = participant.candidates
  const job = participant.jobs
  if (!candidate || !job) return

  // Never assign a default score to a call that didn't complete a proper
  // screening (wife picked up, auto-cut, too short, couldn't hear, etc.).
  // A 6/10 "further_review" default on an incomplete call misleads HR into
  // thinking a real screening happened — it shows "View Results" instead of
  // "Send Call Again".
  const status = String(participant.status || "")
  const isIncompleteCall = !!(participant.call_is_partial || status === "failed_partial" || status === "failed")
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
  //
  // For incomplete calls (wife picked up, auto-cut, too short) never assign a
  // default score — a 6/10 "further_review" implies a real screening happened.
  const derivedScore = { advance: 8, further_review: 6, not_a_fit: 2 }[recommendation]
  const hasScore = typeof participant.ai_score === "number" || typeof participant.ai_recommendation === "string"
  const shouldScore = hasScore || !isIncompleteCall

  // Store enriched summary
  await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      enriched_summary: enriched,
      ai_summary: enriched.comprehensive_summary,
      ...(shouldScore ? {} : {
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
    skippedDefaultScore: isIncompleteCall && !hasScore,
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
  // Snapshot previous call result before overwriting (supports "Call 1 / Call 2" history in UI)
  await snapshotPreviousCallAttempt(participant.id, (execution as any)?.id || (execution as any)?.execution_id || null)
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

  const hangupBy = (execution as any)?.hangup_by ?? execution.telephony_data?.hangup_by ?? null
  const hangupReason = execution.telephony_data?.hangup_reason ?? (execution as any)?.hangup_reason ?? null
  const classification: "not_screened" | "interrupted" | "retry" = isPartialCall ? "interrupted" : "retry"

  const patch: Record<string, unknown> = {
    // Same constraint note as above: never write `failed_partial`, which is not
    // an allowed status. call_is_partial identifies a mid-conversation drop.
    status: maxRetriesReached ? "unreachable" : "failed",
    bolna_status: execution.status || "failed",
    call_ended_at: execution.updated_at || now,
    retry_count: currentRetryCount,
    call_is_partial: isPartialCall ? true : null,
    updated_at: now,
  }
  // Incomplete/partial screenings and failed attempts need HR attention in /jobs and /today.
  if (isPartialCall || maxRetriesReached || execution.status === "no-answer" || execution.status === "busy") {
    patch.needs_manual_followup = true
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
  if (hangupBy) patch.hangup_by = hangupBy
  if (hangupReason) {
    patch.call_hangup_reason = hangupReason
    patch.call_disconnect_reason = hangupReason
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
      if (fallbackPatch) {
        for (const [key, value] of Object.entries(fallbackPatch)) {
          if (value !== undefined) patch[key] = value
        }
      }
    }
  }

  // Persist classification/hangup metadata for UI (who ended call, incomplete screening)
  try {
    const vj = patch.verdict_json
    if (vj && typeof vj === "object" && !Array.isArray(vj)) {
      ;(vj as any)._classification_outcome = classification
      ;(vj as any)._hangup_by = hangupBy || null
      ;(vj as any)._call_hangup_reason = hangupReason || null
      patch.verdict_json = vj
    } else if (isPartialCall) {
      patch.verdict_json = { _classification_outcome: classification, _hangup_by: hangupBy || null, _call_hangup_reason: hangupReason || null, summary: "1st screening incomplete (call ended mid-conversation). Review transcript and send call again." }
      if (!patch.ai_summary) patch.ai_summary = "1st screening incomplete (call ended mid-conversation). Review transcript and send call again."
    }
  } catch {}
  await updateParticipantSafely(participant.id, patch, {
    executionId: execution.id,
    source: "handleFailedExecution",
  })

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