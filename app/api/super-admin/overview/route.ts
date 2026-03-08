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

async function count(params: { table: string; column: string; from: string; to: string; filters?: (q: any) => any }) {
  let q = supabaseAdmin.from(params.table).select("id", { count: "exact", head: true }).gte(params.column, params.from).lt(params.column, params.to)
  if (params.filters) q = params.filters(q)
  const { count } = await q
  return count ?? 0
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const { from, to } = parseDateRange(searchParams)
  const userId = searchParams.get("userId")?.trim() || null

  const { data: users } = await supabaseAdmin
    .from("internal_users")
    .select("auth_user_id,email,name,created_at,last_active_at")
    .order("created_at", { ascending: false })

  const targetUsers = userId ? (users ?? []).filter((u: any) => u.auth_user_id === userId) : users ?? []

  const perUser = await Promise.all(
    targetUsers.map(async (u: any) => {
      const [uploads, jobs, outreach, applicationsCreated] = await Promise.all([
        count({ table: "candidates", column: "uploaded_at", from, to, filters: q => q.eq("uploaded_by_auth_user_id", u.auth_user_id) }),
        count({ table: "jobs", column: "created_at", from, to, filters: q => q.eq("created_by", u.auth_user_id) }),
        count({ table: "outreach_messages", column: "created_at", from, to, filters: q => q.eq("created_by", u.auth_user_id) }),
        count({ table: "applications", column: "applied_at", from, to, filters: q => q.eq("created_by", u.auth_user_id) }),
      ])
      return {
        user: u,
        totals: {
          candidates_uploaded: uploads,
          jobs_created: jobs,
          outreach_messages: outreach,
          applications_created: applicationsCreated,
        },
      }
    })
  )

  const totals = {
    candidates_uploaded: perUser.reduce((a, x) => a + x.totals.candidates_uploaded, 0),
    jobs_created: perUser.reduce((a, x) => a + x.totals.jobs_created, 0),
    outreach_messages: perUser.reduce((a, x) => a + x.totals.outreach_messages, 0),
    applications_created: perUser.reduce((a, x) => a + x.totals.applications_created, 0),
  }

  return NextResponse.json({ range: { from, to }, totals, perUser })
}

