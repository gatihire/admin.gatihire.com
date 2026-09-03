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

  const { data: answers } = await supabaseAdmin
    .from("screening_answers")
    .select("*")
    .eq("participant_id", id)

  return NextResponse.json({
    ...participant,
    transcripts: transcripts || [],
    answers: answers || [],
  })
}
