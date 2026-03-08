import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

function parseIdsParam(raw: string | null) {
  const items = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return Array.from(new Set(items)).slice(0, 200)
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const ids = parseIdsParam(searchParams.get("ids"))
  if (!ids.length) {
    return NextResponse.json({ error: "Missing ids" }, { status: 400 })
  }

  const appCounts: Record<string, number> = {}
  const pendingCounts: Record<string, number> = {}
  const dbMatchCounts: Record<string, number> = {}

  ids.forEach((id) => {
    appCounts[id] = 0
    pendingCounts[id] = 0
    dbMatchCounts[id] = 0
  })

  const [rpcRes, matchRunsRes] = await Promise.all([
    supabaseAdmin.rpc("jobs_dashboard_stats", { job_ids: ids }),
    supabaseAdmin.from("job_match_runs").select("job_id,total_matches").in("job_id", ids),
  ])

  if (!rpcRes.error && Array.isArray(rpcRes.data)) {
    rpcRes.data.forEach((row: any) => {
      const jobId = String(row.job_id || "")
      if (!jobId) return
      appCounts[jobId] = Number(row.applications_total || 0)
      pendingCounts[jobId] = Number(row.applications_pending || 0)
      dbMatchCounts[jobId] = Number(row.matches_total || 0)
    })

    if (!matchRunsRes.error && Array.isArray(matchRunsRes.data)) {
      matchRunsRes.data.forEach((row: any) => {
        const jobId = String(row.job_id || "")
        if (!jobId || !(jobId in dbMatchCounts)) return
        dbMatchCounts[jobId] = Number(row.total_matches || 0)
      })
    }

    return NextResponse.json({ appCounts, pendingCounts, dbMatchCounts })
  }

  const [appsRes, matchesRes, matchRunsRes2] = await Promise.all([
    supabaseAdmin.from("applications").select("job_id,status").in("job_id", ids),
    supabaseAdmin.from("job_matches").select("job_id").in("job_id", ids),
    supabaseAdmin.from("job_match_runs").select("job_id,total_matches").in("job_id", ids),
  ])

  if (appsRes.error) {
    return NextResponse.json({ error: appsRes.error.message || "Failed to load applications" }, { status: 500 })
  }
  if (matchesRes.error) {
    return NextResponse.json({ error: matchesRes.error.message || "Failed to load matches" }, { status: 500 })
  }
  const matchTotalsByJobId = new Map<string, number>()
  if (!matchRunsRes2.error && Array.isArray(matchRunsRes2.data)) {
    matchRunsRes2.data.forEach((row: any) => {
      const jobId = String(row.job_id || "")
      if (!jobId) return
      matchTotalsByJobId.set(jobId, Number(row.total_matches || 0))
    })
  }

  ;(appsRes.data || []).forEach((row: any) => {
    const jobId = String(row.job_id || "")
    if (!jobId || !(jobId in appCounts)) return
    appCounts[jobId] = (appCounts[jobId] || 0) + 1
    if (row.status === "applied") pendingCounts[jobId] = (pendingCounts[jobId] || 0) + 1
  })

  ;(matchesRes.data || []).forEach((row: any) => {
    const jobId = String(row.job_id || "")
    if (!jobId || !(jobId in dbMatchCounts)) return
    dbMatchCounts[jobId] = (dbMatchCounts[jobId] || 0) + 1
  })

  ids.forEach((jobId) => {
    const override = matchTotalsByJobId.get(jobId)
    if (typeof override === "number" && override > 0) dbMatchCounts[jobId] = override
  })

  return NextResponse.json({ appCounts, pendingCounts, dbMatchCounts })
}
