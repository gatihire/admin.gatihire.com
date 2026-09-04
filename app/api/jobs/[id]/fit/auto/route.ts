import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getOrAnalyzeFit } from "@/lib/candidate-fit"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: jobId } = await params

    // 1. Get all applications for this job
    const { data: applications, error: appError } = await supabaseAdmin
      .from("applications")
      .select("candidate_id")
      .eq("job_id", jobId)

    if (appError) return NextResponse.json({ error: appError.message }, { status: 500 })
    if (!applications || applications.length === 0) return NextResponse.json({ fits: {} })

    // 2. Get existing fit scores
    const { data: existingFits } = await supabaseAdmin
      .from("candidate_job_fit")
      .select("candidate_id")
      .eq("job_id", jobId)

    // 3. Find candidates without fit scores
    const existingIds = new Set(existingFits?.map(f => f.candidate_id) || [])
    const missingIds = applications
      .map(a => a.candidate_id)
      .filter(id => !existingIds.has(id))

    if (missingIds.length === 0) return NextResponse.json({ fits: {} })

    // 4. Get job data
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

    // 5. Get candidate data for missing IDs
    const { data: candidates, error: candError } = await supabaseAdmin
      .from("candidates")
      .select("id,name,current_role,current_company,total_experience,location,technical_skills,resume_text,summary")
      .in("id", missingIds)

    if (candError) return NextResponse.json({ error: candError.message }, { status: 500 })

    // 6. Run fit analysis for each candidate
    const results: Record<string, unknown> = {}
    for (const candidate of candidates || []) {
      try {
        results[candidate.id] = await getOrAnalyzeFit(jobId, candidate.id, candidate, job)
      } catch (err: any) {
        logger.warn("Auto-fit analysis failed for candidate", { candidateId: candidate.id, error: err.message })
        results[candidate.id] = { fit_score: null, pros: [], misses: [], interview_probes: [], summary: "Analysis failed" }
      }
    }

    return NextResponse.json({ fits: results, analyzed: Object.keys(results).length })
  } catch (error: any) {
    logger.error("Auto-fit route failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
