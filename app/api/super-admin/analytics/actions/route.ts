import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { parseIsoRange } from "@/lib/super-admin-analytics"
import {
  ACTION_METRICS,
  aggregateActions,
  emptyActionCounts,
  totalActions,
  type ActionActivityRow,
} from "@/lib/dispatch/metrics"

export const runtime = "nodejs"

const PAGE_SIZE = 1000
const MAX_ROWS = 100000

/**
 * GET /api/super-admin/analytics/actions?from=&to=&userId=
 *
 * "Who did what" for the given window. Reads `candidate_activity` (the only
 * action log that carries `actor_auth_user_id`) and folds it per staff member.
 * Only attributed rows are read, so the payload stays small even for long ranges.
 */
export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view") && !hasPermission(ctx, "dispatch.view.team")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const range = parseIsoRange(request.url, { daysBack: 1 })
  const onlyUserId = searchParams.get("userId")

  // Attributed human actions only — automated/system writes have a null actor.
  const rows: ActionActivityRow[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    let q = supabaseAdmin
      .from("candidate_activity")
      .select("event_type, event_data, actor_auth_user_id, created_at")
      .not("actor_auth_user_id", "is", null)
      .gte("created_at", range.from)
      .lt("created_at", range.to)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (onlyUserId) q = q.eq("actor_auth_user_id", onlyUserId)
    const { data, error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const batch = (data ?? []) as ActionActivityRow[]
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }

  const byActor = aggregateActions(rows)

  // Attach identity from internal_users (source of truth for staff profiles).
  const ids = Array.from(byActor.keys())
  const profilesRes = ids.length
    ? await supabaseAdmin.from("internal_users").select("auth_user_id, email, name, last_active_at").in("auth_user_id", ids)
    : { data: [] as any[] }
  const profileById = new Map<string, any>((profilesRes.data ?? []).map((u: any) => [String(u.auth_user_id), u]))

  const totals = emptyActionCounts()
  const list = ids.map((id) => {
    const counts = byActor.get(id) || emptyActionCounts()
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += counts[key]
    const profile = profileById.get(id)
    return {
      user: {
        id,
        email: profile?.email ?? null,
        name: profile?.name ?? null,
        last_active_at: profile?.last_active_at ?? null,
      },
      counts,
      total: totalActions(counts),
    }
  })

  list.sort((a, b) => b.total - a.total)

  return NextResponse.json({
    range,
    metrics: ACTION_METRICS,
    rows: list,
    totals: { counts: totals, total: totalActions(totals), users: list.length },
    scanned: rows.length,
  })
}
