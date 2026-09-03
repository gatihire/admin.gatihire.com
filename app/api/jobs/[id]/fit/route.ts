import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { getOrAnalyzeFit } from "@/lib/candidate-fit"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    // Read-only fit analysis — part of job sourcing, so jobs.view is sufficient
    if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id: jobId } = await params
    const body = await request.json().catch(() => ({}))
    const candidateIds: string[] = Array.isArray(body.candidateIds) ? body.candidateIds : []
    if (candidateIds.length === 0) {
      return NextResponse.json({ error: "candidateIds are required" }, { status: 400 })
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from("jobs")
      .select(`
        id, title, industry, client_name, city, location,
        experience_min_years, experience_max_years,
        skills_must_have, skills_good_to_have, description
      `)
      .eq("id", jobId)
      .single()

    if (jobError || !job) return NextResponse.json({ error: "Job not found" }, { status: 404 })

    const { data: candidates, error: candError } = await supabaseAdmin
      .from("candidates")
      .select("id,name,current_role,current_company,total_experience,location,technical_skills,resume_text,summary")
      .in("id", candidateIds)

    if (candError) return NextResponse.json({ error: candError.message }, { status: 500 })

    const results: Record<string, unknown> = {}
    for (const candidate of candidates || []) {
      try {
        results[candidate.id] = await getOrAnalyzeFit(jobId, candidate.id, candidate, job)
      } catch (err: any) {
        logger.warn("Fit analysis failed for candidate", { candidateId: candidate.id, error: err.message })
        results[candidate.id] = { fit_score: null, pros: [], misses: [], interview_probes: [], summary: "Fit analysis failed" }
      }
    }

    return NextResponse.json({ fits: results })
  } catch (error: any) {
    logger.error("Fit analysis route failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params
  const ids = request.nextUrl.searchParams.get("candidateIds")?.split(",").filter(Boolean) || []

  const query = supabaseAdmin
    .from("candidate_job_fit")
    .select("candidate_id, fit_score, fit_json, summary")
    .eq("job_id", jobId)
  if (ids.length > 0) query.in("candidate_id", ids)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const byCandidate: Record<string, unknown> = {}
  for (const row of data || []) {
    const parsed = row.fit_json as any
    byCandidate[row.candidate_id] = {
      fit_score: row.fit_score ?? parsed?.fit_score ?? null,
      pros: parsed?.pros || [],
      misses: parsed?.misses || [],
      interview_probes: parsed?.interview_probes || [],
      summary: row.summary || parsed?.summary || "",
    }
  }
  return NextResponse.json({ fits: byCandidate })
}
