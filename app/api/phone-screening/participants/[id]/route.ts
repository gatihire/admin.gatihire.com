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
      candidates: candidate_id (id, name, email, phone, current_role, current_company, total_experience, location, technical_skills, resume_text)
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

  return NextResponse.json({
    ...participant,
    transcripts: finalTranscripts,
    answers: answers || [],
  })
}
