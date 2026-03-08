import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

function parseDateRange(searchParams: URLSearchParams) {
  const now = new Date()
  const fromParam = searchParams.get("from")
  const toParam = searchParams.get("to")
  const to = toParam ? new Date(toParam) : now
  const from = fromParam ? new Date(fromParam) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

async function count(params: { table: string; column: string; from: string; to: string; filters: (q: any) => any }) {
  let q = supabaseAdmin.from(params.table).select("id", { count: "exact", head: true }).gte(params.column, params.from).lt(params.column, params.to)
  q = params.filters(q)
  const { count } = await q
  return count ?? 0
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage") && !hasPermission(ctx, "analytics.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { userId } = await params
  const { searchParams } = new URL(request.url)
  const { from, to } = parseDateRange(searchParams)

  const [uploads, jobs, outreach, applicationsCreated] = await Promise.all([
    count({
      table: "candidates",
      column: "uploaded_at",
      from,
      to,
      filters: q => q.eq("uploaded_by_auth_user_id", userId),
    }),
    count({
      table: "jobs",
      column: "created_at",
      from,
      to,
      filters: q => q.eq("created_by", userId),
    }),
    count({
      table: "outreach_messages",
      column: "created_at",
      from,
      to,
      filters: q => q.eq("created_by", userId),
    }),
    count({
      table: "applications",
      column: "applied_at",
      from,
      to,
      filters: q => q.eq("created_by", userId),
    }),
  ])

  const { data: recentJobs } = await supabaseAdmin
    .from("jobs")
    .select("id,title,created_at,status")
    .eq("created_by", userId)
    .gte("created_at", from)
    .lt("created_at", to)
    .order("created_at", { ascending: false })
    .limit(20)

  const jobIds = (recentJobs ?? []).map((j: any) => j.id)
  const applicationCounts = await Promise.all(
    jobIds.map(async jobId => {
      const { count } = await supabaseAdmin.from("applications").select("id", { count: "exact", head: true }).eq("job_id", jobId)
      return [jobId, count ?? 0] as const
    })
  )

  return NextResponse.json({
    range: { from, to },
    userId,
    totals: {
      candidates_uploaded: uploads,
      jobs_created: jobs,
      outreach_messages: outreach,
      applications_created: applicationsCreated,
    },
    recentJobs: (recentJobs ?? []).map((j: any) => ({
      ...j,
      applications_count: Object.fromEntries(applicationCounts)[j.id] ?? 0,
    })),
  })
}
