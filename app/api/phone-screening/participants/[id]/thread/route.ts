import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

/**
 * Thread-only read, for live polling.
 *
 * The full participant endpoint parses transcripts on demand, which is far too
 * much work to run every few seconds while a recruiter watches a conversation.
 * This returns just the fields the thread view renders.
 *
 * Note the participant is also selected with `info_data` / `info_sources` /
 * `screening_context`, because the conversation modal shows what the candidate
 * submitted alongside the transcript. A reply can arrive that changes both.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params

  const { data, error } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      id,
      status,
      whatsapp_history,
      info_data,
      info_sources,
      screening_context,
      clarification_asked_at,
      clarification_answered_at
    `)
    .eq("id", id)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: "Participant not found" }, { status: 404 })
  }

  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  })
}