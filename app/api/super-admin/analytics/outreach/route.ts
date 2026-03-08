import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { dayBucketsUtc, parseIsoRange } from "@/lib/super-admin-analytics"

export const runtime = "nodejs"

async function countOutreach(range: { from: string; to: string }, filters?: (q: any) => any) {
  let q = supabaseAdmin
    .from("outreach_messages")
    .select("id", { count: "exact", head: true })
    .gte("created_at", range.from)
    .lt("created_at", range.to)
  if (filters) q = filters(q)
  const { count } = await q
  return count ?? 0
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const range = parseIsoRange(request.url, { daysBack: 60 })
  const buckets = dayBucketsUtc(range)

  const statuses = ["pending", "sent", "delivered", "opened", "failed"]
  const types = ["email", "whatsapp"]

  const totalsByStatus = Object.fromEntries(
    await Promise.all(statuses.map(async (s) => [s, await countOutreach(range, (q) => q.eq("status", s))] as const))
  )

  const totalsByType = Object.fromEntries(
    await Promise.all(types.map(async (t) => [t, await countOutreach(range, (q) => q.eq("message_type", t))] as const))
  )

  const total = await countOutreach(range)
  const opened = totalsByStatus.opened ?? 0
  const delivered = totalsByStatus.delivered ?? 0
  const failed = totalsByStatus.failed ?? 0
  const openRate = delivered > 0 ? opened / delivered : 0
  const failureRate = total > 0 ? failed / total : 0

  const series = await Promise.all(
    buckets.map(async (b) => {
      const r = { from: b.start, to: b.end }
      const [sent, deliveredDay, openedDay, failedDay] = await Promise.all([
        countOutreach(r, (q) => q.eq("status", "sent")),
        countOutreach(r, (q) => q.eq("status", "delivered")),
        countOutreach(r, (q) => q.eq("status", "opened")),
        countOutreach(r, (q) => q.eq("status", "failed")),
      ])
      return { day: b.day, sent, delivered: deliveredDay, opened: openedDay, failed: failedDay }
    })
  )

  const { data: byUserRows } = await supabaseAdmin
    .from("outreach_messages")
    .select("created_by,status")
    .gte("created_at", range.from)
    .lt("created_at", range.to)
    .limit(5000)

  const byUser: Record<string, { sent: number; delivered: number; opened: number; failed: number }>
    = {}
  for (const r of byUserRows ?? []) {
    const uid = String((r as any)?.created_by || "")
    if (!uid) continue
    byUser[uid] = byUser[uid] || { sent: 0, delivered: 0, opened: 0, failed: 0 }
    const s = String((r as any)?.status || "")
    if (s === "sent") byUser[uid].sent += 1
    else if (s === "delivered") byUser[uid].delivered += 1
    else if (s === "opened") byUser[uid].opened += 1
    else if (s === "failed") byUser[uid].failed += 1
  }

  return NextResponse.json({
    range,
    totals: {
      total,
      by_status: totalsByStatus,
      by_type: totalsByType,
      open_rate: openRate,
      failure_rate: failureRate,
    },
    series,
    by_user: byUser,
  })
}

