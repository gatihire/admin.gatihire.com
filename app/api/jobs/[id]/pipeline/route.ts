import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view") && !hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId } = await params
  try {
    // Explicit candidate columns on purpose. `candidates (*)` used to pull
    // resume_text, the 768-dim embedding and search_vector for every applicant
    // on the job — tens of KB per row. On a busy job that single query could
    // serialise hundreds of MB and pin Postgres CPU. The profile sidebar fetches
    // the full record from /api/candidates/[id] when opened, so the pipeline only
    // needs the card fields.
    const [applicationsRes, participantsRes, fitScoresRes, sharesRes] = await Promise.all([
      supabaseAdmin
        .from("applications")
        .select(`
          *,
          candidates:candidate_id (
            id, name, email, phone, phone_e164, current_role, current_company,
            total_experience, location, preferred_location, technical_skills,
            current_salary, expected_salary, notice_period, highest_qualification,
            degree, specialization, summary, tags, status, source, file_url,
            file_name, linkedin_profile
          ),
          jobs:job_id (title, industry, sub_category)
        `)
        .eq("job_id", jobId)
        .order("applied_at", { ascending: false }),

      supabaseAdmin
        .from("phone_screening_participants")
        .select(`
          *,
          candidates: candidate_id (id, name, email, phone, current_role, current_company, total_experience, location, technical_skills)
        `)
        .eq("job_id", jobId)
        .order("created_at", { ascending: false }),

      supabaseAdmin
        .from("candidate_job_fit")
        .select("candidate_id, fit_score, fit_json, summary")
        .eq("job_id", jobId),

      supabaseAdmin
        .from("shortlist_shares")
        .select("id, candidates:share_candidates(application_id, status)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: false })
        .limit(1),
    ])

    if (applicationsRes.error) {
      return NextResponse.json({ error: applicationsRes.error.message }, { status: 500 })
    }

    const applications = applicationsRes.data || []

    const participants: Record<string, any> = {}
    for (const p of participantsRes.data || []) {
      if (p?.candidate_id && !participants[p.candidate_id]) {
        participants[p.candidate_id] = p
      }
    }

    const fitScores: Record<string, number | null> = {}
    for (const row of fitScoresRes.data || []) {
      const parsed = row.fit_json as any
      fitScores[row.candidate_id] = row.fit_score ?? parsed?.fit_score ?? null
    }

    const clientDecisions: Record<string, string | null> = {}
    for (const share of sharesRes.data || []) {
      for (const c of share.candidates || []) {
        clientDecisions[c.application_id] = c.status || null
      }
    }

    applications.sort((a, b) => {
      const scoreA = fitScores[a.candidate_id] ?? -1
      const scoreB = fitScores[b.candidate_id] ?? -1
      return scoreB - scoreA
    })

    const missingFitCount = applications.filter(a => !(a.candidate_id in fitScores)).length

    return NextResponse.json({
      applications,
      participants,
      fitScores,
      clientDecisions,
      missingFitCount,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}
