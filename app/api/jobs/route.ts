import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseSearchRequirement, intelligentCandidateSearch } from "@/lib/intelligent-search"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const paginate = searchParams.get("paginate") === "true"
    const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1)
    const perPageRaw = Number(searchParams.get("perPage") ?? "50") || 50
    const perPage = Math.min(100, Math.max(1, perPageRaw))

    const status = searchParams.get("status")
    const source = searchParams.get("source")
    const clientId = searchParams.get("clientId")
    const q = (searchParams.get("search") || "").trim()

    let query = supabaseAdmin.from("jobs").select("*", { count: paginate ? "exact" : undefined as any })
    query = query.order("created_at", { ascending: false })

    if (status && status !== "all") {
      query = query.eq("status", status)
    }
    if (source && source !== "all") {
      query = query.eq("source", source)
    }
    if (clientId && clientId !== "all") {
      query = query.eq("client_id", clientId)
    }
    if (q) {
      const term = `%${q.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`
      query = query.or(`title.ilike.${term},location.ilike.${term},industry.ilike.${term},client_name.ilike.${term}`)
    }

    if (paginate) {
      const from = (page - 1) * perPage
      const to = from + perPage - 1
      const { data, error, count } = await query.range(from, to)

      if (error) {
        console.error("Error fetching jobs:", error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ items: data || [], page, perPage, total: count ?? 0 })
    }

    const { data, error } = await query

    if (error) {
      console.error("Error fetching jobs:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error("Internal error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.post") && !hasPermission(ctx, "jobs.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const {
      title,
      description,
      industry,
      sub_category,
      location,
      city,
      apply_type,
      external_apply_url,
      salary_type,
      salary_min,
      salary_max,
      shift_type,
      employment_type,
      urgency_tag,
      openings,
      education_min,
      experience_min_years,
      experience_max_years,
      languages_required,
      english_level,
      license_type,
      age_min,
      age_max,
      gender_preference,
      role_category,
      department_category,
      skills_must_have,
      skills_good_to_have,
      status,
      client_name,
      client_id,
      sections,
      source,
      is_external_link,
      external_link,
      auto_matchmaking_enabled,
      messaging_preferences,
    } = body || {}

    if (!title) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 })
    }

    const normalizeOptionalString = (value: unknown) => {
      if (typeof value !== "string") return null
      const trimmed = value.trim()
      return trimmed.length ? trimmed : null
    }

    const normalizedEmploymentType = typeof employment_type === "string" ? employment_type : null
    const normalizedShiftType = typeof shift_type === "string" ? shift_type : null
    const normalizedSalaryType = typeof salary_type === "string" ? salary_type : null
    const normalizedOpenings = typeof openings === "number" ? openings : null
    const normalizedApplyType = apply_type === "external" ? "external" : "in_platform"
    const normalizedExternalApplyUrl = normalizeOptionalString(external_apply_url)

    const safeArray = (v: any): any[] | null => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : null)

    const { data, error } = await supabaseAdmin
      .from("jobs")
      .insert({
        title,
        description,
        industry: normalizeOptionalString(industry),
        sub_category: normalizeOptionalString(sub_category),
        location,
        city: normalizeOptionalString(city),
        apply_type: normalizedApplyType,
        external_apply_url: normalizedApplyType === "external" ? normalizedExternalApplyUrl : null,
        salary_type: normalizedSalaryType,
        salary_min: typeof salary_min === "number" ? salary_min : null,
        salary_max: typeof salary_max === "number" ? salary_max : null,
        shift_type: normalizedShiftType,
        employment_type: normalizedEmploymentType,
        urgency_tag: normalizeOptionalString(urgency_tag),
        openings: normalizedOpenings,
        education_min: normalizeOptionalString(education_min),
        experience_min_years: typeof experience_min_years === "number" ? experience_min_years : null,
        experience_max_years: typeof experience_max_years === "number" ? experience_max_years : null,
        languages_required: safeArray(languages_required),
        english_level: normalizeOptionalString(english_level),
        license_type: normalizeOptionalString(license_type),
        age_min: typeof age_min === "number" ? age_min : null,
        age_max: typeof age_max === "number" ? age_max : null,
        gender_preference: normalizeOptionalString(gender_preference),
        role_category: normalizeOptionalString(role_category),
        department_category: normalizeOptionalString(department_category),
        skills_must_have: safeArray(skills_must_have),
        skills_good_to_have: safeArray(skills_good_to_have),
        status: status || 'open',
        client_name,
        client_id: normalizeOptionalString(client_id),
        source: normalizeOptionalString(source) || "truckinzy",
        is_external_link: is_external_link === true,
        external_link: is_external_link === true ? normalizeOptionalString(external_link) : null,
        auto_matchmaking_enabled: auto_matchmaking_enabled !== false,
        messaging_preferences: normalizeOptionalString(messaging_preferences) || "both",
        created_by: ctx.authUser.id,
      })
      .select()
      .single()

    if (error) {
      console.error("Error creating job:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const jobId = data.id

    if (Array.isArray(sections) && sections.length > 0) {
      try {
        await supabaseAdmin.from("job_sections").delete().eq("job_id", jobId)
        const rows = sections
          .filter((s: any) => s && typeof s.section_key === "string" && typeof s.heading === "string" && typeof s.body_md === "string")
          .map((s: any, idx: number) => ({
            job_id: jobId,
            section_key: s.section_key,
            heading: s.heading,
            body_md: s.body_md,
            sort_order: typeof s.sort_order === "number" ? s.sort_order : idx,
            is_visible: typeof s.is_visible === "boolean" ? s.is_visible : true,
          }))
        if (rows.length) {
          const { error: sErr } = await supabaseAdmin.from("job_sections").insert(rows)
          if (sErr) console.warn("Failed to save job sections:", sErr)
        }
      } catch (e) {
        console.warn("Failed to save job sections:", e)
      }
    }

    // Trigger initial match generation (without heavy AI insights per candidate)
    try {
        console.log("Generating initial matches for job:", jobId)
        const baseText = [data.title || "", data.description || ""].join("\n").trim()
        
        const candidates = await SupabaseCandidateService.getAllCandidates()
        // This uses Gemini only once to parse requirements, which is fast enough
        const parsedRequirements = await parseSearchRequirement(baseText)
        // This uses local scoring, very fast
        const ranked = await intelligentCandidateSearch(parsedRequirements, candidates)
        
        const matches = ranked.map((c: any) => ({
            job_id: jobId,
            candidate_id: c.id,
            relevance_score: c.relevanceScore || 0,
            match_summary: null, // No AI insight initially as requested
            score_breakdown: c.scoreBreakdown || null,
            source: "database",
            created_at: new Date().toISOString()
        }))
        
        if (matches.length > 0) {
             const { error: matchError } = await supabaseAdmin
                .from("job_matches")
                .upsert(matches, { onConflict: "job_id,candidate_id" })
             
             if (matchError) {
                 console.warn("Failed to store initial matches:", matchError)
             } else {
                 console.log(`Stored ${matches.length} initial matches for job ${jobId}`)
             }
        }
    } catch (matchErr) {
        console.error("Failed to generate initial matches:", matchErr)
        // Don't fail the job creation if matching fails
    }

    supabaseAdmin
      .from("analytics_events")
      .insert({
        actor_auth_user_id: ctx.authUser.id,
        event_name: "job.created",
        entity_type: "jobs",
        entity_id: data?.id ?? null,
        metadata: { title: data?.title ?? null, status: data?.status ?? null },
      })
      .then(() => {})

    return NextResponse.json(data)
  } catch (error) {
    console.error("Internal error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
