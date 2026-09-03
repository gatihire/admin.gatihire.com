import { NextRequest, NextResponse } from "next/server"
import { supabase, supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { deriveOrigin } from "@/lib/origin"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view") && !hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const jobId = searchParams.get("jobId")
    const candidateId = searchParams.get("candidateId")

    let query = supabaseAdmin
      .from("applications")
      .select(`
        *,
        candidates:candidate_id (*),
        jobs:job_id (title, industry, sub_category)
      `)
      .order("applied_at", { ascending: false })

    if (jobId) {
      query = query.eq("job_id", jobId)
    }
    if (candidateId) {
      query = query.eq("candidate_id", candidateId)
    }

    const { data, error } = await query

    if (error) {
      console.error("Error fetching applications:", error)
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
  if (!hasPermission(ctx, "applications.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const body = await request.json()
    const { job_id, candidate_id, notes, candidate_notes, status, source = "database", match_score, origin } = body

    if (!job_id || !candidate_id) {
      return NextResponse.json({ error: "Job ID and Candidate ID are required" }, { status: 400 })
    }

    // Check if already applied
    const { data: existing } = await supabase
      .from("applications")
      .select("id")
      .eq("job_id", job_id)
      .eq("candidate_id", candidate_id)
      .single()

    if (existing) {
      return NextResponse.json({ error: "Candidate already applied to this job" }, { status: 409 })
    }

    const { data, error } = await supabaseAdmin
      .from("applications")
      .insert({
        job_id,
        candidate_id,
        status: status || 'applied',
        notes,
        candidate_notes,
        source,
        origin: origin || deriveOrigin(source),
        match_score,
        created_by: ctx.authUser.id,
        applied_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) {
      // Fallback: if 'source', 'origin', or 'match_score' column doesn't exist yet, retry without them
      if ((error as any)?.code === 'PGRST204' || String(error?.message || '').toLowerCase().includes("source") || String(error?.message || '').toLowerCase().includes("origin") || String(error?.message || '').toLowerCase().includes("match_score")) {
        // Try without match_score and origin first
        const { data: dataNoScore, error: errNoScore } = await supabaseAdmin
            .from("applications")
            .insert({
                job_id,
                candidate_id,
                status: status || 'applied',
                notes,
                candidate_notes,
                source,
                created_by: ctx.authUser.id,
                applied_at: new Date().toISOString()
            })
            .select()
            .single()
            
        if (!errNoScore) return NextResponse.json(dataNoScore)

        // Fallback to minimal insert
        const { data: dataMinimal, error: errMinimal } = await supabaseAdmin
          .from("applications")
          .insert({
            job_id,
            candidate_id,
            status: status || 'applied',
            notes,
            candidate_notes,
            created_by: ctx.authUser.id,
            applied_at: new Date().toISOString()
          })
          .select()
          .single()
        if (errMinimal) {
          console.error("Error creating application (fallback):", errMinimal)
          return NextResponse.json({ error: errMinimal.message }, { status: 500 })
        }
        return NextResponse.json(dataMinimal)
      }
      console.error("Error creating application:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    supabaseAdmin
      .from("analytics_events")
      .insert({
        actor_auth_user_id: ctx.authUser.id,
        event_name: "application.created",
        entity_type: "applications",
        entity_id: data?.id ?? null,
        metadata: { job_id, candidate_id, status: status || "applied" },
      })
      .then(() => {})

    return NextResponse.json(data)
  } catch (error) {
    console.error("Internal error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
