import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const jobId = url.searchParams.get("jobId")
    const candidateId = url.searchParams.get("candidateId")
    const participantId = url.searchParams.get("participantId")
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200)

    if (!jobId || !candidateId) {
      return NextResponse.json({ error: "jobId and candidateId are required" }, { status: 400 })
    }

    let query = supabaseAdmin
      .from("candidate_activity")
      .select("*")
      .eq("job_id", jobId)
      .eq("candidate_id", candidateId)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (participantId) {
      query = query.eq("participant_id", participantId)
    }

    const { data, error } = await query

    if (error) {
      logger.error("Failed to fetch candidate activity", { error: error.message })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ activities: data || [] })
  } catch (error: any) {
    logger.error("Candidate activity API error", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
