import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { deriveOrigin, type CandidateOrigin } from "@/lib/origin"
import { orchestrateScreening } from "@/lib/call-orchestrator"
import { logger } from "@/lib/logger"
import { logCandidateActivityBatch } from "@/lib/activity-logger"

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

    // Sync application status to "ai_screen" for all candidates being screened.
    // This ensures the pipeline counts correctly while calls are active.
    // Always create an application if one doesn't exist — every screened candidate
    // must have a pipeline row so stage counts stay accurate.
    const now = new Date().toISOString()
    const appIds: string[] = []
    for (const candidate of candidates || []) {
      const existing = appByCandidate.get(candidate.id)
      if (existing) {
        appIds.push(existing.id)
      } else {
        // Auto-create pipeline entry for candidates without an application.
        const origin = fallbackOrigin || deriveOrigin((candidate as any).source)
        const { data: newApp, error: insErr } = await supabaseAdmin
          .from("applications")
          .insert({
            job_id: jobId,
            candidate_id: candidate.id,
            status: "ai_screen",
            source: origin === "outbound" ? "database" : "applied",
            origin,
            applied_at: now,
            updated_at: now,
          })
          .select("id")
          .single()
        if (insErr) {
          logger.warn("Auto-create application failed", { candidateId: candidate.id, error: insErr.message })
        } else if (newApp?.id) {
          appIds.push(newApp.id)
        }
      }
    }

    // Batch-update existing applications to ai_screen (skip if already set)
    if (appIds.length > 0) {
      const { error: updateErr } = await supabaseAdmin
        .from("applications")
        .update({ status: "ai_screen", updated_at: now })
        .in("id", appIds)
        .neq("status", "ai_screen")
      if (updateErr) {
        logger.warn("Failed to sync application status to ai_screen", { error: updateErr.message })
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

    // Log ai_screen_started for all candidates that were triggered
    logCandidateActivityBatch(
      (candidates || []).map((c) => ({
        jobId,
        candidateId: c.id,
        applicationId: appByCandidate.get(c.id)?.id || null,
        eventType: "ai_screen_started" as const,
        eventData: { call_mode: callMode || "call_now" },
        actor: ctx.authUser.id,
      }))
    )

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
