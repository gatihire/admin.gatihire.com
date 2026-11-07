import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params

  const { data: participant, error: pError } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      *,
      candidates: candidate_id (id, name, email, phone, current_role, current_company, total_experience, location, technical_skills, resume_text),
      jobs: job_id (id, title, client_name)
    `)
    .eq("id", id)
    .single()

  if (pError || !participant) {
    return NextResponse.json({ error: "Participant not found" }, { status: 404 })
  }

  const { data: transcripts } = await supabaseAdmin
    .from("call_transcripts")
    .select("*")
    .eq("participant_id", id)
    .order("start_time_sec", { ascending: true })

  // Fallback: if no parsed transcripts, parse transcript_raw on-the-fly
  let finalTranscripts = transcripts || []
  if (finalTranscripts.length === 0 && participant.transcript_raw) {
    const raw = participant.transcript_raw as string
    const aiPatterns = /^(assistant|ai|agent|bot|system|hiring manager|recruiter):\s*(.*)$/i
    const candidatePatterns = /^(user|candidate|human|applicant|interviewee|respondent):\s*(.*)$/i
    const segments: { speaker: string; text: string }[] = []
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim()
      if (!line) continue
      const aiMatch = line.match(aiPatterns)
      const candidateMatch = line.match(candidatePatterns)
      if (aiMatch) {
        if (aiMatch[2].trim()) segments.push({ speaker: "ai", text: aiMatch[2].trim() })
      } else if (candidateMatch) {
        if (candidateMatch[2].trim()) segments.push({ speaker: "candidate", text: candidateMatch[2].trim() })
      } else {
        const last = segments[segments.length - 1]
        if (last) last.text = `${last.text} ${line}`
      }
    }
    // If still no segments, treat entire raw as single AI block
    if (segments.length === 0 && raw.trim()) {
      segments.push({ speaker: "ai", text: raw.trim() })
    }
    finalTranscripts = segments.map((s, i) => ({
      id: `raw-${i}`,
      participant_id: id,
      speaker: s.speaker,
      text: s.text,
      start_time_sec: null,
      end_time_sec: null,
      created_at: null,
    }))
  }

  const { data: answers } = await supabaseAdmin
    .from("screening_answers")
    .select("*")
    .eq("participant_id", id)

  // Build up to 2 call attempt results for UI (1st/2nd call tabs + summary cards above)
  const vj = participant?.verdict_json && typeof participant.verdict_json === "string"
    ? (() => { try { return JSON.parse(participant.verdict_json) } catch { return participant.verdict_json } })()
    : participant?.verdict_json
  const currentAttempt = {
    attempt: Math.max(1, Number(participant?.call_attempts || 1)),
    is_current: true,
    bolna_execution_id: participant?.bolna_execution_id || null,
    status: participant?.status || null,
    bolna_status: participant?.bolna_status || null,
    classification_outcome: (vj as any)?._classification_outcome || (participant as any)?.classification_outcome || null,
    call_ended_at: participant?.call_ended_at || null,
    call_duration_seconds: participant?.call_duration_seconds ?? null,
    recording_url: participant?.recording_url || null,
    transcript_raw: participant?.transcript_raw || null,
    transcripts: finalTranscripts,
    answers: answers || [],
    ai_score: participant?.ai_score ?? null,
    ai_recommendation: participant?.ai_recommendation || null,
    ai_summary: participant?.ai_summary || null,
    verdict_json: participant?.verdict_json || null,
    hangup_by: participant?.hangup_by || null,
    call_hangup_reason: participant?.call_hangup_reason || null,
    call_disconnect_reason: participant?.call_disconnect_reason || null,
    call_is_partial: participant?.call_is_partial ?? null,
  }

  const history = Array.isArray((participant as any)?.screening_context?.call_attempt_history)
    ? ((participant as any).screening_context.call_attempt_history as any[])
    : []
  const historyAttempts = history
    .filter((h) => h && (h.call_ended_at || h.bolna_execution_id || h.transcript_raw || h.verdict_json || h.ai_summary || h.recording_url))
    .map((h) => ({ ...h, is_current: false, transcripts: undefined, answers: undefined }))

  // Show at most 2 calls total; prefer current + most recent previous
  const seenExec = new Set<string>()
  const callResults: any[] = []
  for (const a of [currentAttempt, ...historyAttempts]) {
    const key = a?.bolna_execution_id ? String(a.bolna_execution_id) : `a-${a?.attempt}-${a?.call_ended_at || ""}`
    if (seenExec.has(key)) continue
    seenExec.add(key)
    callResults.push(a)
    if (callResults.length >= 2) break
  }
  // Ensure chronological/attempt labels are sensible (1st/2nd by attempt or order)
  callResults.sort((a, b) => (Number(a?.attempt || 0) - Number(b?.attempt || 0)) || (String(a?.call_ended_at || "").localeCompare(String(b?.call_ended_at || ""))))

  return NextResponse.json({
    ...participant,
    transcripts: finalTranscripts,
    answers: answers || [],
    call_attempt_history: history,
    call_results: callResults,
  })
}
