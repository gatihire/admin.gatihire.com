import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { countAnalyticsEvents, countAuthUsers, countDistinctInternalActors, dayBucketsUtc, parseIsoRange } from "@/lib/super-admin-analytics"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const range = parseIsoRange(request.url, { daysBack: 60 })
  const buckets = dayBucketsUtc(range)

  const now = new Date(range.to)
  const dauRange = { from: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), to: range.to }
  const wauRange = { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to: range.to }
  const mauRange = { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), to: range.to }

  const [totalUsers, signupsRange, logins, sessions, pageViews, activeDau, activeWau, activeMau, applySubmitted] = await Promise.all([
    countAuthUsers({ from: "1970-01-01T00:00:00.000Z", to: range.to }),
    countAuthUsers(range),
    countAnalyticsEvents({ range, eventName: "login_succeeded" }),
    countAnalyticsEvents({ range, eventName: "session_start" }),
    countAnalyticsEvents({ range, eventName: "page_view" }),
    countDistinctInternalActors(dauRange),
    countDistinctInternalActors(wauRange),
    countDistinctInternalActors(mauRange),
    countAnalyticsEvents({ range, eventName: "board.apply.submitted" }),
  ])
  const activationRateTotal = signupsRange > 0 ? applySubmitted / Math.max(1, signupsRange) : 0

  const series = await Promise.all(
    buckets.map(async (b) => {
      const r = { from: b.start, to: b.end }
      const [signups, dauSessions, applies] = await Promise.all([
        countAuthUsers(r),
        countAnalyticsEvents({ range: r, eventName: "session_start" }),
        countAnalyticsEvents({ range: r, eventName: "board.apply.submitted" }),
      ])
      const activationRate = signups > 0 ? applies / Math.max(1, signups) : 0
      return { day: b.day, signups, sessions: dauSessions, activated: applies, activation_rate: activationRate }
    })
  )

  return NextResponse.json({
    range,
    totals: {
      total_users: totalUsers,
      signups: signupsRange,
      logins,
      sessions,
      page_views: pageViews,
      active_users: { dau: activeDau, wau: activeWau, mau: activeMau },
      activation_rate: activationRateTotal,
    },
    series,
  })
}
