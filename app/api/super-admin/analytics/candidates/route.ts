import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { countBetween, dayBucketsUtc, parseIsoRange } from "@/lib/super-admin-analytics"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const range = parseIsoRange(request.url, { daysBack: 60 })
  const buckets = dayBucketsUtc(range)

  const [candidatesAdded, contacted, opened, failed] = await Promise.all([
    countBetween({ table: "candidates", column: "uploaded_at", range }),
    countBetween({ table: "outreach_messages", column: "created_at", range }),
    countBetween({
      table: "outreach_messages",
      column: "created_at",
      range,
      extraFilters: (q) => q.eq("status", "opened"),
    }),
    countBetween({
      table: "outreach_messages",
      column: "created_at",
      range,
      extraFilters: (q) => q.eq("status", "failed"),
    }),
  ])

  const responseRate = contacted > 0 ? opened / contacted : 0

  const { data: openedRows } = await supabaseAdmin
    .from("outreach_messages")
    .select("sent_at,opened_at")
    .eq("status", "opened")
    .gte("created_at", range.from)
    .lt("created_at", range.to)
    .limit(2000)

  const ttfrMs = (openedRows ?? [])
    .map((r: any) => {
      const sent = r?.sent_at ? new Date(r.sent_at).getTime() : null
      const openedAt = r?.opened_at ? new Date(r.opened_at).getTime() : null
      if (!sent || !openedAt) return null
      const d = openedAt - sent
      return d >= 0 ? d : null
    })
    .filter((x: any) => typeof x === "number") as number[]

  const avgTimeToFirstResponseSec = ttfrMs.length ? ttfrMs.reduce((a, b) => a + b, 0) / ttfrMs.length / 1000 : 0

  const series = await Promise.all(
    buckets.map(async (b) => {
      const r = { from: b.start, to: b.end }
      const [added, contactedDay, openedDay] = await Promise.all([
        countBetween({ table: "candidates", column: "uploaded_at", range: r }),
        countBetween({ table: "outreach_messages", column: "created_at", range: r }),
        countBetween({
          table: "outreach_messages",
          column: "created_at",
          range: r,
          extraFilters: (q) => q.eq("status", "opened"),
        }),
      ])
      return {
        day: b.day,
        candidates_added: added,
        contacted: contactedDay,
        opened: openedDay,
      }
    })
  )

  return NextResponse.json({
    range,
    totals: {
      candidates_added: candidatesAdded,
      candidates_contacted: contacted,
      opened,
      failed,
      response_rate: responseRate,
      avg_time_to_first_response_seconds: avgTimeToFirstResponseSec,
    },
    series,
  })
}

