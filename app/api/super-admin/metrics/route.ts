import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

function toIso(d: Date) {
  return d.toISOString()
}

function startOfUtcDay(d: Date) {
  const x = new Date(d)
  x.setUTCHours(0, 0, 0, 0)
  return x
}

function startOfUtcWeek(d: Date) {
  const x = startOfUtcDay(d)
  const day = x.getUTCDay()
  const diffFromMonday = (day + 6) % 7
  x.setUTCDate(x.getUTCDate() - diffFromMonday)
  return x
}

function startOfUtcMonth(d: Date) {
  const x = startOfUtcDay(d)
  x.setUTCDate(1)
  return x
}

function startOfUtcYear(d: Date) {
  const x = startOfUtcDay(d)
  x.setUTCMonth(0, 1)
  return x
}

async function countTableBetween(params: { table: string; column: string; start: string; end: string; extraFilters?: (q: any) => any }) {
  let q = supabaseAdmin.from(params.table).select("id", { count: "exact", head: true }).gte(params.column, params.start).lt(params.column, params.end)
  if (params.extraFilters) q = params.extraFilters(q)
  const { count } = await q
  return count ?? 0
}

async function countAuthUsersBetween(start: string, end: string) {
  const { data } = await supabaseAdmin.rpc("count_auth_users_between", {
    start_ts: start,
    end_ts: end,
  })
  return typeof data === "number" ? data : 0
}

async function countDistinctEventActorsBetween(start: string, end: string) {
  const { data } = await supabaseAdmin.rpc("count_distinct_event_actors_between", {
    start_ts: start,
    end_ts: end,
  })
  return typeof data === "number" ? data : 0
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const now = new Date()
  const ranges = {
    day: { start: startOfUtcDay(now), end: now },
    week: { start: startOfUtcWeek(now), end: now },
    month: { start: startOfUtcMonth(now), end: now },
    year: { start: startOfUtcYear(now), end: now },
  }

  const [authUsers, internalUsers, jobs, applications, candidatesUploaded, outreachTotal, outreachByStatus, activeUsers] =
    await Promise.all([
      Promise.all(
        Object.entries(ranges).map(async ([k, r]) => [k, await countAuthUsersBetween(toIso(r.start), toIso(r.end))] as const)
      ),
      Promise.all(
        Object.entries(ranges).map(async ([k, r]) => [k, await countTableBetween({ table: "internal_users", column: "created_at", start: toIso(r.start), end: toIso(r.end) })] as const)
      ),
      Promise.all(
        Object.entries(ranges).map(async ([k, r]) => [k, await countTableBetween({ table: "jobs", column: "created_at", start: toIso(r.start), end: toIso(r.end) })] as const)
      ),
      Promise.all(
        Object.entries(ranges).map(async ([k, r]) => [k, await countTableBetween({ table: "applications", column: "applied_at", start: toIso(r.start), end: toIso(r.end) })] as const)
      ),
      Promise.all(
        Object.entries(ranges).map(async ([k, r]) => [k, await countTableBetween({ table: "candidates", column: "uploaded_at", start: toIso(r.start), end: toIso(r.end) })] as const)
      ),
      Promise.all(
        Object.entries(ranges).map(async ([k, r]) => [k, await countTableBetween({ table: "outreach_messages", column: "created_at", start: toIso(r.start), end: toIso(r.end) })] as const)
      ),
      Promise.all(
        ["pending", "sent", "delivered", "opened", "failed"].map(async status => {
          const counts = await Promise.all(
            Object.entries(ranges).map(async ([k, r]) => [
              k,
              await countTableBetween({
                table: "outreach_messages",
                column: "created_at",
                start: toIso(r.start),
                end: toIso(r.end),
                extraFilters: q => q.eq("status", status),
              }),
            ] as const)
          )
          return [status, Object.fromEntries(counts)] as const
        })
      ),
      Promise.all(
        Object.entries(ranges).map(async ([k, r]) => [k, await countDistinctEventActorsBetween(toIso(r.start), toIso(r.end))] as const)
      ),
    ])

  return NextResponse.json({
    ranges: Object.fromEntries(
      Object.entries(ranges).map(([k, r]) => [k, { start: toIso(r.start), end: toIso(r.end) }])
    ),
    signups: {
      auth_users: Object.fromEntries(authUsers),
      internal_users: Object.fromEntries(internalUsers),
    },
    activity: {
      active_internal_users: Object.fromEntries(activeUsers),
    },
    recruiting: {
      jobs_created: Object.fromEntries(jobs),
      applications_created: Object.fromEntries(applications),
      candidates_uploaded: Object.fromEntries(candidatesUploaded),
      outreach_messages: {
        total: Object.fromEntries(outreachTotal),
        by_status: Object.fromEntries(outreachByStatus),
      },
    },
  })
}

