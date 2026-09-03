import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const campaignId = searchParams.get("campaignId")
  const jobId = searchParams.get("jobId")
  const status = searchParams.get("status")

  let query = supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      *,
      candidates: candidate_id (id, name, email, phone, current_role, current_company, total_experience, location, technical_skills)
    `)

  if (campaignId) {
    query = query.eq("campaign_id", campaignId)
  }

  if (jobId) {
    query = query.eq("job_id", jobId)
  }

  if (status) {
    query = query.eq("status", status)
  }

  query = query.order("created_at", { ascending: false })

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data || [])
}
