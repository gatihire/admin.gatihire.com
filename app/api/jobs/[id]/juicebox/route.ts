import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

type EnrichmentStatus = "pending" | "enriching" | "enriched" | "failed"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId } = await params

  const { data: job } = await supabaseAdmin.from("jobs").select("id, title").eq("id", jobId).maybeSingle()
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const status = searchParams.get("status")
  const q = (searchParams.get("q") || "").trim()
  const page = Math.max(1, Number(searchParams.get("page") || 1))
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || 50)))
  const offset = (page - 1) * limit

  let query = supabaseAdmin
    .from("juicebox_profiles")
    .select("id, full_name, first_name, last_name, job_title, job_company_name, location_name, total_experience_months, enrichment_status, linkedin_url, import_order, created_at, updated_at", { count: "exact" })
    .eq("job_id", jobId)

  if (status && status !== "all") {
    query = query.eq("enrichment_status", status as EnrichmentStatus)
  }

  if (q) {
    query = query.or(`full_name.ilike.%${q}%,job_title.ilike.%${q}%,job_company_name.ilike.%${q}%`)
  }

  query = query.order("import_order", { ascending: true }).range(offset, offset + limit - 1)

  const { data: rows, error, count } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data: counts } = await supabaseAdmin
    .from("juicebox_profiles")
    .select("enrichment_status")
    .eq("job_id", jobId)

  const statusCounts = { pending: 0, enriching: 0, enriched: 0, failed: 0 }
  for (const row of counts || []) {
    const s = (row.enrichment_status as EnrichmentStatus) || "pending"
    if (s in statusCounts) statusCounts[s]++
  }

  return NextResponse.json({
    profiles: rows || [],
    total: count || 0,
    counts: statusCounts,
    page,
    limit,
  })
}
