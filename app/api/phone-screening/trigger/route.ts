import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { deriveOrigin, type CandidateOrigin } from "@/lib/origin"
import { orchestrateScreening } from "@/lib/call-orchestrator"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

interface TriggerRequest {
  jobId: string
  candidateIds: string[]
  origin?: CandidateOrigin
  createApplication?: boolean
  callMode?: "call_now" | "whatsapp_first"
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const body: TriggerRequest = await request.json().catch(() => ({}))
    const { jobId, candidateIds, createApplication, callMode } = body

    if (!jobId || !Array.isArray(candidateIds) || candidateIds.length === 0) {
      return NextResponse.json({ error: "jobId and candidateIds are required" }, { status: 400 })
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from("jobs")
      .select(`
        id, title, client_name, client_id, industry, skills_must_have, skills_good_to_have,
        experience_min_years, experience_max_years, salary_min, salary_max,
        salary_type, city, location, education_min, languages_required, english_level, license_type, role_category,
        department_category, shift_type, employment_type, description
      `)
      .eq("id", jobId)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    let client: any = null
    if (job.client_id) {
      const { data: clientData } = await supabaseAdmin
        .from("clients")
        .select("name, company_subtype, industry")
        .eq("id", job.client_id)
        .maybeSingle()
      client = clientData
    }

    const { data: candidates, error: candError } = await supabaseAdmin
      .from("candidates")
      .select("id,name,phone,current_role,current_company,total_experience,location,technical_skills,resume_text")
      .in("id", candidateIds)

    if (candError) {
      return NextResponse.json({ error: candError.message }, { status: 500 })
    }

    // Direct outbound AI voice call — cold outreach for sourced profiles,
    // application follow-up for inbound applicants. Agent confirms it's a good
    // time, otherwise captures a callback preference.
    const fallbackOrigin: CandidateOrigin = body.origin || "outbound"

    const { data: applications } = await supabaseAdmin
      .from("applications")
      .select("id, candidate_id, source, origin, match_score")
      .eq("job_id", jobId)
      .in("candidate_id", candidateIds)

    const originByCandidate = new Map<string, CandidateOrigin>()
    const appByCandidate = new Map<string, any>()
    for (const app of applications || []) {
      const a = app as any
      // Respect the application's own origin (inbound applicants stay inbound).
      if (!originByCandidate.has(a.candidate_id)) {
        originByCandidate.set(a.candidate_id, (a.origin as CandidateOrigin) || deriveOrigin(a.source))
      }
      if (!appByCandidate.has(a.candidate_id)) {
        appByCandidate.set(a.candidate_id, a)
      }
    }

    // Auto-create pipeline entries (e.g. launching calls directly from DB Matches).
    if (createApplication) {
      const now = new Date().toISOString()
      for (const candidate of candidates || []) {
        if (appByCandidate.has(candidate.id)) continue
        const origin = fallbackOrigin || deriveOrigin((candidate as any).source)
        const { error: insErr } = await supabaseAdmin.from("applications").insert({
          job_id: jobId,
          candidate_id: candidate.id,
          status: "ai_screen",
          source: origin === "outbound" ? "database" : "applied",
          origin,
          applied_at: now,
          updated_at: now,
        })
        if (insErr) {
          logger.warn("Auto-create application failed", { candidateId: candidate.id, error: insErr.message })
        }
      }
    }

    const result = await orchestrateScreening({
      job,
      client,
      candidates: (candidates || []) as any[],
      originByCandidate,
      fallbackOrigin,
      createdBy: ctx.authUser.id,
      callMode,
    })

    return NextResponse.json({
      campaignId: result.campaignId,
      totalCandidates: result.totalCandidates,
      callsTriggered: result.callsTriggered,
      callsFailed: result.callsFailed,
      nudgeSent: result.nudgeSent,
      skippedNoPhone: result.skippedNoPhone.length > 0 ? result.skippedNoPhone : undefined,
      errors: result.errors,
    })
  } catch (error: any) {
    if (error?.message === "No candidates with phone numbers found") {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    logger.error("Trigger screening failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
