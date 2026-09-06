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
    console.log(`[backfill] Starting backfill for job=${jobId}`)

    const [applicationsRes, existingFitsRes, jobRes] = await Promise.all([
      supabaseAdmin.from("applications").select("candidate_id").eq("job_id", jobId),
      supabaseAdmin.from("candidate_job_fit").select("candidate_id").eq("job_id", jobId),
      supabaseAdmin.from("jobs").select("id,title,industry,client_name,city,location,experience_min_years,experience_max_years,skills_must_have,skills_good_to_have,description").eq("id", jobId).maybeSingle(),
    ])

    if (applicationsRes.error) {
      console.error(`[backfill] Applications query error:`, applicationsRes.error)
      return NextResponse.json({ error: applicationsRes.error.message }, { status: 500 })
    }
    if (!jobRes.data) return NextResponse.json({ error: "Job not found" }, { status: 404 })

    const existingIds = new Set(existingFitsRes.data?.map(f => f.candidate_id) || [])
    const allCandidateIds = (applicationsRes.data || []).map(a => a.candidate_id)
    const missingIds = allCandidateIds.filter(id => !existingIds.has(id))

    console.log(`[backfill] Total applications: ${allCandidateIds.length}, Existing fits: ${existingIds.size}, Missing: ${missingIds.length}`)

    if (missingIds.length === 0) {
      return NextResponse.json({ success: true, generated: 0, message: "All candidates already have fit scores" })
    }

    const { data: candidates, error: candidatesError } = await supabaseAdmin
      .from("candidates")
      .select("id,current_role,current_company,total_experience,location,technical_skills,resume_text,summary")
      .in("id", missingIds)

    if (candidatesError) {
      console.error(`[backfill] Candidates query error:`, candidatesError)
      return NextResponse.json({ error: candidatesError.message }, { status: 500 })
    }

    console.log(`[backfill] Found ${candidates?.length || 0} candidates for ${missingIds.length} missing IDs`)

    if (!candidates || candidates.length === 0) {
      console.warn(`[backfill] No candidates found for missing IDs:`, missingIds)
      return NextResponse.json({ 
        success: true, 
        generated: 0, 
        failed: 0, 
        total: missingIds.length,
        errors: missingIds.map(id => ({ candidateId: id, error: "Candidate not found in candidates table" })),
        message: `No candidate data found for ${missingIds.length} missing IDs` 
      })
    }

    let generated = 0
    let failed = 0
    const errors: Array<{ candidateId: string; error: string }> = []

    for (const candidate of candidates) {
      try {
        console.log(`[backfill] Processing candidate ${candidate.id}`)
        await getOrAnalyzeFit(jobId, candidate.id, candidate, jobRes.data)
        generated++
      } catch (err: any) {
        console.error(`[backfill] Failed for candidate ${candidate.id}:`, err?.message || err)
        failed++
        errors.push({ candidateId: candidate.id, error: err?.message || String(err) })
      }
    }

    console.log(`[backfill] Complete: generated=${generated}, failed=${failed}, total=${missingIds.length}`)
    return NextResponse.json({
      success: true,
      generated,
      failed,
      total: missingIds.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Generated ${generated} fit scores (${failed} failed) out of ${missingIds.length} missing`,
    })
  } catch (error: any) {
    console.error(`[backfill] Unexpected error:`, error)
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}
