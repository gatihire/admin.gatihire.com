import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export const runtime = "nodejs"

type SourcingRow = {
  source: string
  job_category: string
  applied: number
  shortlisted: number
  interviewed: number
  hired: number
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const fromParam = request.nextUrl.searchParams.get("from")
  const fromTs = fromParam && !Number.isNaN(Date.parse(fromParam)) ? new Date(fromParam).toISOString() : null

  const { data, error } = await supabaseAdmin.rpc("sourcing_analytics", fromTs ? { from_ts: fromTs } : {})

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data || []) as SourcingRow[]

  const bySource: Record<string, { applied: number; shortlisted: number; interviewed: number; hired: number }> = {}
  for (const r of rows) {
    const cur = (bySource[r.source] ||= { applied: 0, shortlisted: 0, interviewed: 0, hired: 0 })
    cur.applied += r.applied
    cur.shortlisted += r.shortlisted
    cur.interviewed += r.interviewed
    cur.hired += r.hired
  }

  return NextResponse.json({ range: { from: fromTs || null }, rows, by_source: bySource })
}
