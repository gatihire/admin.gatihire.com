import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { parseIsoRange } from "@/lib/super-admin-analytics"

export const runtime = "nodejs"

async function count(params: { table: string; column: string; range: { from: string; to: string }; filters: (q: any) => any }) {
  let q = supabaseAdmin.from(params.table).select("id", { count: "exact", head: true }).gte(params.column, params.range.from).lt(params.column, params.range.to)
  q = params.filters(q)
  const { count } = await q
  return count ?? 0
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const range = parseIsoRange(request.url, { daysBack: 30 })

  const { data: users } = await supabaseAdmin
    .from("internal_users")
    .select("auth_user_id,email,name,last_active_at")
    .order("created_at", { ascending: false })

  const rows = await Promise.all(
    (users ?? []).map(async (u: any) => {
      const userId = String(u.auth_user_id)
      const [jobsPosted, candidatesUploaded, outreachMessages, applicationsCreated] = await Promise.all([
        count({ table: "jobs", column: "created_at", range, filters: (q) => q.eq("created_by", userId) }),
        count({ table: "candidates", column: "uploaded_at", range, filters: (q) => q.eq("uploaded_by_auth_user_id", userId) }),
        count({ table: "outreach_messages", column: "created_at", range, filters: (q) => q.eq("created_by", userId) }),
        count({ table: "applications", column: "applied_at", range, filters: (q) => q.eq("created_by", userId) }),
      ])
      return {
        user: {
          id: userId,
          email: u.email,
          name: u.name,
          last_active_at: u.last_active_at,
        },
        metrics: {
          jobs_posted: jobsPosted,
          candidates_uploaded: candidatesUploaded,
          outreach_messages: outreachMessages,
          applications_created: applicationsCreated,
        },
      }
    })
  )

  rows.sort((a, b) => b.metrics.jobs_posted + b.metrics.outreach_messages - (a.metrics.jobs_posted + a.metrics.outreach_messages))

  return NextResponse.json({ range, rows })
}
