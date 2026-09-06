import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"
import { supabaseAdmin } from "@/lib/supabase"
import { getOrAnalyzeFit } from "@/lib/candidate-fit"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: jobId } = await params

  try {
    const [applicationsRes, existingFitsRes, jobRes] = await Promise.all([
      supabaseAdmin.from("applications").select("candidate_id").eq("job_id", jobId),
      supabaseAdmin.from("candidate_job_fit").select("candidate_id").eq("job_id", jobId),
      supabaseAdmin.from("jobs").select("id,title,industry,client_name,city,location,experience_min_years,experience_max_years,skills_must_have,skills_good_to_have,description").eq("id", jobId).maybeSingle(),
    ])

    if (applicationsRes.error) return NextResponse.json({ error: applicationsRes.error.message }, { status: 500 })
    if (!jobRes.data) return NextResponse.json({ error: "Job not found" }, { status: 404 })

    const existingIds = new Set(existingFitsRes.data?.map(f => f.candidate_id) || [])
    const missingIds = (applicationsRes.data || [])
      .map(a => a.candidate_id)
      .filter(id => !existingIds.has(id))

    if (missingIds.length === 0) {
      return NextResponse.json({ success: true, generated: 0, message: "All candidates already have fit scores" })
    }

    const { data: candidates } = await supabaseAdmin
      .from("candidates")
      .select("id,current_role,current_company,total_experience,location,technical_skills,resume_text,summary")
      .in("id", missingIds)

    let generated = 0
    let failed = 0
    const errors: Array<{ candidateId: string; error: string }> = []

    for (const candidate of candidates || []) {
      try {
        await getOrAnalyzeFit(jobId, candidate.id, candidate, jobRes.data)
        generated++
      } catch (err: any) {
        console.error(`Fit backfill failed for candidate ${candidate.id}:`, err?.message || err)
        failed++
        errors.push({ candidateId: candidate.id, error: err?.message || String(err) })
      }
    }

    return NextResponse.json({
      success: true,
      generated,
      failed,
      total: missingIds.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Generated ${generated} fit scores (${failed} failed) out of ${missingIds.length} missing`,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}
