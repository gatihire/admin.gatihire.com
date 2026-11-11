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
  // Projection modes:
  //   default  — full rows for the pipeline cards (transcript/verdict included)
  //   card     — list rows only: no transcript/JSONB payloads
  //   status   — ids + status for polling and per-campaign counters
  const fields = searchParams.get("fields")

  const FULL_COLUMNS = `
      *,
      candidates: candidate_id (id, name, email, phone, current_role, current_company, total_experience, location, technical_skills),
      jobs:job_id (id, title, client_name, city, location, salary_min, salary_max, salary_type, experience_min_years, experience_max_years, skills_must_have)
    `
  const CARD_COLUMNS = `
      id, campaign_id, job_id, candidate_id, status, origin,
      ai_score, ai_recommendation, call_duration_seconds,
      scheduled_call_at, callback_preference, review_status, created_at,
      candidates: candidate_id (id, name, email, phone, current_role)
    `
  const STATUS_COLUMNS = "id, campaign_id, job_id, status, bolna_status, updated_at"

  const selectClause =
    fields === "status" ? STATUS_COLUMNS : fields === "card" ? CARD_COLUMNS : FULL_COLUMNS

  let query: any = supabaseAdmin
    .from("phone_screening_participants")
    .select(selectClause)
  // NOTE: `jobs` has no `skills` column (it has skills_must_have / skills_good_to_have).
  // Naming a column that does not exist makes PostgREST reject the WHOLE request with
  // a 400 ("column jobs_1.skills does not exist"), which this route surfaced as a 500 —
  // so every participant list call failed, and the job page silently fell back to no
  // screening data at all (no call status, and "View Results" had no participant to open).

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
