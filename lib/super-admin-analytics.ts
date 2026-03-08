import { supabaseAdmin } from "@/lib/supabase"

export type IsoRange = { from: string; to: string }

export function parseIsoRange(url: string, defaults?: { daysBack: number }): IsoRange {
  const { searchParams } = new URL(url)
  const now = new Date()
  const toParam = searchParams.get("to")
  const fromParam = searchParams.get("from")
  const to = toParam ? new Date(toParam) : now
  const from = fromParam
    ? new Date(fromParam)
    : new Date(to.getTime() - (defaults?.daysBack ?? 30) * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

export function dayBucketsUtc(range: IsoRange): Array<{ start: string; end: string; day: string }>
{
  const start = new Date(range.from)
  const end = new Date(range.to)
  const s = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 0, 0, 0, 0))
  const e = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 0, 0, 0, 0))

  const buckets: Array<{ start: string; end: string; day: string }> = []
  for (let d = new Date(s); d <= e; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    const next = new Date(d.getTime() + 24 * 60 * 60 * 1000)
    const day = d.toISOString().slice(0, 10)
    buckets.push({ start: d.toISOString(), end: next.toISOString(), day })
  }
  return buckets
}

export function previousRange(range: IsoRange): IsoRange {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const dur = to.getTime() - from.getTime()
  const prevTo = new Date(from.getTime())
  const prevFrom = new Date(from.getTime() - dur)
  return { from: prevFrom.toISOString(), to: prevTo.toISOString() }
}

export async function countBetween(params: {
  table: string
  column: string
  range: IsoRange
  extraFilters?: (q: any) => any
}) {
  let q = supabaseAdmin
    .from(params.table)
    .select("id", { count: "exact", head: true })
    .gte(params.column, params.range.from)
    .lt(params.column, params.range.to)
  if (params.extraFilters) q = params.extraFilters(q)
  const { count } = await q
  return count ?? 0
}

export async function countAnalyticsEvents(params: {
  range: IsoRange
  eventName: string
  extraFilters?: (q: any) => any
}) {
  let q = supabaseAdmin
    .from("analytics_events")
    .select("id", { count: "exact", head: true })
    .eq("event_name", params.eventName)
    .gte("created_at", params.range.from)
    .lt("created_at", params.range.to)
  if (params.extraFilters) q = params.extraFilters(q)
  const { count } = await q
  return count ?? 0
}

export async function countAuthUsers(range: IsoRange) {
  const { data, error } = await supabaseAdmin.rpc("count_auth_users_between", {
    start_ts: range.from,
    end_ts: range.to,
  })
  if (!error && typeof data === "number") return data

  const fromMs = new Date(range.from).getTime()
  const toMs = new Date(range.to).getTime()
  let page = 1
  const perPage = 1000
  let total = 0
  for (let guard = 0; guard < 200; guard++) {
    const res = await supabaseAdmin.auth.admin.listUsers({ page, perPage })
    if ((res as any)?.error) break
    const users = (res as any)?.data?.users || []
    if (!Array.isArray(users) || users.length === 0) break

    for (const u of users) {
      const createdAt = String((u as any)?.created_at || "")
      const t = new Date(createdAt).getTime()
      if (Number.isFinite(t) && t >= fromMs && t < toMs) total += 1
    }

    const lastCreatedAt = String((users[users.length - 1] as any)?.created_at || "")
    const lastMs = new Date(lastCreatedAt).getTime()
    if (users.length < perPage) break
    if (Number.isFinite(lastMs) && lastMs < fromMs) break
    page += 1
  }

  return total
}

export async function countAuthUsersByDay(range: IsoRange) {
  const { data, error } = await supabaseAdmin.rpc("count_auth_users_by_day", {
    start_ts: range.from,
    end_ts: range.to,
  })
  if (!error && Array.isArray(data)) return data as any[]

  const fromMs = new Date(range.from).getTime()
  const toMs = new Date(range.to).getTime()
  const byDay = new Map<string, number>()
  let page = 1
  const perPage = 1000
  for (let guard = 0; guard < 200; guard++) {
    const res = await supabaseAdmin.auth.admin.listUsers({ page, perPage })
    if ((res as any)?.error) break
    const users = (res as any)?.data?.users || []
    if (!Array.isArray(users) || users.length === 0) break

    for (const u of users) {
      const createdAt = String((u as any)?.created_at || "")
      const t = new Date(createdAt).getTime()
      if (!Number.isFinite(t) || t < fromMs || t >= toMs) continue
      const day = createdAt.slice(0, 10)
      if (!day) continue
      byDay.set(day, (byDay.get(day) || 0) + 1)
    }

    const lastCreatedAt = String((users[users.length - 1] as any)?.created_at || "")
    const lastMs = new Date(lastCreatedAt).getTime()
    if (users.length < perPage) break
    if (Number.isFinite(lastMs) && lastMs < fromMs) break
    page += 1
  }

  return Array.from(byDay.entries()).map(([day, count]) => ({ day, count }))
}

export async function countDistinctInternalActors(range: IsoRange) {
  const { data } = await supabaseAdmin.rpc("count_distinct_event_actors_between", {
    start_ts: range.from,
    end_ts: range.to,
  })
  return typeof data === "number" ? data : 0
}

export function pctDelta(current: number, previous: number) {
  if (previous <= 0 && current <= 0) return 0
  if (previous <= 0) return 100
  return ((current - previous) / previous) * 100
}
