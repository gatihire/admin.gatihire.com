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
    const [applicationsRes, fitsRes, jobRes, testUpsertRes] = await Promise.all([
      supabaseAdmin.from("applications").select("id, candidate_id, status, origin, source").eq("job_id", jobId),
      supabaseAdmin.from("candidate_job_fit").select("candidate_id, fit_score, fit_json, summary, analyzed_at").eq("job_id", jobId),
      supabaseAdmin.from("jobs").select("id,title,experience_min_years,experience_max_years,skills_must_have").eq("id", jobId).maybeSingle(),
      (async () => {
        const testCandidateId = "00000000-0000-0000-0000-000000000000"
        const { error } = await supabaseAdmin
          .from("candidate_job_fit")
          .upsert({
            job_id: jobId,
            candidate_id: testCandidateId,
            fit_score: 50,
            fit_json: { fit_score: 50, pros: [], misses: [], interview_probes: [], summary: "test" },
            summary: "test",
            analyzed_at: new Date().toISOString(),
          }, { onConflict: "job_id,candidate_id" })
        if (error) return { success: false, error: error.message, code: error.code }
        await supabaseAdmin.from("candidate_job_fit").delete().eq("job_id", jobId).eq("candidate_id", testCandidateId)
        return { success: true }
      })(),
    ])

    if (applicationsRes.error) return NextResponse.json({ error: applicationsRes.error.message }, { status: 500 })

    const applications = applicationsRes.data || []
    const fits = fitsRes.data || []
    const fitMap = new Map(fits.map(f => [f.candidate_id, f]))

    const candidatesWithoutFit = applications.filter(a => !fitMap.has(a.candidate_id))
    const candidatesWithFit = applications.filter(a => fitMap.has(a.candidate_id))

    return NextResponse.json({
      job: jobRes.data,
      tableWritable: testUpsertRes,
      totalApplications: applications.length,
      totalFitScores: fits.length,
      candidatesWithFit: candidatesWithFit.map(a => ({
        candidateId: a.candidate_id,
        status: a.status,
        origin: a.origin,
        source: a.source,
        fitScore: fitMap.get(a.candidate_id)?.fit_score,
      })),
      candidatesWithoutFit: candidatesWithoutFit.map(a => ({
        candidateId: a.candidate_id,
        status: a.status,
        origin: a.origin,
        source: a.source,
      })),
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}