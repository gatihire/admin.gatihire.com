import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { orchestrateScreening, type ScreeningCandidate } from "@/lib/call-orchestrator"
import type { CandidateOrigin } from "@/lib/origin"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

interface CallRequest {
  profileIds: string[]
}

function experienceText(months: number | null): string {
  if (months == null) return "Not specified"
  const years = months / 12
  return years >= 1 ? `${years.toFixed(1)} years` : `${months} months`
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId } = await params

  const body: CallRequest = await request.json().catch(() => ({}))
  const profileIds = Array.isArray(body.profileIds) ? body.profileIds : []
  if (profileIds.length === 0) {
    return NextResponse.json({ error: "profileIds are required" }, { status: 400 })
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

  if (jobError || !job) return NextResponse.json({ error: "Job not found" }, { status: 404 })

  let client: any = null
  if (job.client_id) {
    const { data: clientData } = await supabaseAdmin
      .from("clients")
      .select("name, company_subtype, industry")
      .eq("id", job.client_id)
      .maybeSingle()
    client = clientData
  }

  const { data: profiles, error: profileError } = await supabaseAdmin
    .from("juicebox_profiles")
    .select("id, full_name, job_title, job_company_name, location_name, total_experience_months, ai_skills, languages, linkedin_url, summary")
    .eq("job_id", jobId)
    .in("id", profileIds)

  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 })
  if (!profiles || profiles.length === 0) return NextResponse.json({ error: "No profiles found" }, { status: 404 })

  const { data: contacts } = await supabaseAdmin
    .from("juicebox_contacts")
    .select("profile_id, phone, work_email, personal_email")
    .in("profile_id", profiles.map((p) => p.id))
    .eq("provider", "thepeakai")

  const contactByProfile = new Map<string, any>()
  for (const c of contacts || []) contactByProfile.set(c.profile_id, c)

  // Materialize (or reuse) flagged candidates rows for the enriched profiles.
  const { data: existingCandidates } = await supabaseAdmin
    .from("candidates")
    .select("id, source_profile_id, phone")
    .eq("source", "juicebox")
    .in("source_profile_id", profileIds)

  const candidateByProfile = new Map<string, { id: string; phone: string | null }>()
  for (const c of existingCandidates || []) {
    if (c.source_profile_id) candidateByProfile.set(c.source_profile_id, { id: c.id, phone: c.phone })
  }

  const now = new Date().toISOString()
  const candidatesToScreen: ScreeningCandidate[] = []
  const materialized: string[] = []
  const noContact: string[] = []

  for (const profile of profiles) {
    const contact = contactByProfile.get(profile.id)
    const phone = contact?.phone || null

    if (!phone) {
      noContact.push(profile.full_name || profile.id)
      continue
    }

    let candidate = candidateByProfile.get(profile.id)
    if (!candidate) {
      const { data: inserted, error: insError } = await supabaseAdmin
        .from("candidates")
        .insert({
          name: profile.full_name || "Unnamed profile",
          email: "",
          phone,
          current_role: profile.job_title || "Not specified",
          current_company: profile.job_company_name || "",
          location: profile.location_name || "Not specified",
          total_experience: experienceText(profile.total_experience_months),
          technical_skills: profile.ai_skills || [],
          languages_known: profile.languages || [],
          linkedin_profile: profile.linkedin_url || "",
          summary: profile.summary || "",
          source: "juicebox",
          source_profile_id: profile.id,
          status: "new",
          uploaded_at: now,
          updated_at: now,
        })
        .select("id, phone")
        .single()

      if (insError || !inserted) {
        logger.warn("Juicebox candidate materialization failed", { profileId: profile.id, error: insError?.message })
        noContact.push(profile.full_name || profile.id)
        continue
      }
      candidate = { id: inserted.id, phone: inserted.phone }
      candidateByProfile.set(profile.id, candidate)
    }

    // Link the candidate to this job so the origin/source flows through the pipeline.
    await supabaseAdmin
      .from("applications")
      .upsert(
        {
          job_id: jobId,
          candidate_id: candidate.id,
          status: "ai_screen",
          source: "juicebox",
          origin: "outbound",
          applied_at: now,
          updated_at: now,
        },
        { onConflict: "job_id,candidate_id", ignoreDuplicates: true }
      )

    candidatesToScreen.push({
      id: candidate.id,
      name: profile.full_name || "",
      phone: candidate.phone || phone,
      current_role: profile.job_title || "",
      current_company: profile.job_company_name || "",
      total_experience: profile.total_experience_months != null ? experienceText(profile.total_experience_months) : "Not specified",
      location: profile.location_name || "",
      technical_skills: profile.ai_skills || [],
      resume_text: null,
    })
    materialized.push(profile.full_name || profile.id)
  }

  if (candidatesToScreen.length === 0) {
    return NextResponse.json(
      { error: "No profiles with an enriched phone number. Enrich them first.", skippedNoContact: noContact },
      { status: 400 }
    )
  }

  const originByCandidate = new Map<string, CandidateOrigin>()
  for (const c of candidatesToScreen) originByCandidate.set(c.id, "outbound")

  const result = await orchestrateScreening({
    job,
    client,
    candidates: candidatesToScreen,
    originByCandidate,
    fallbackOrigin: "outbound",
    createdBy: ctx.authUser.id,
    callMode: "whatsapp_first",
  })

  return NextResponse.json({
    ...result,
    materialized,
    noContact,
  })
}
