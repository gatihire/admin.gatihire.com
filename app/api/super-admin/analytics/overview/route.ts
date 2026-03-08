import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import {
  countAnalyticsEvents,
  countAuthUsers,
  countBetween,
  countAuthUsersByDay,
  dayBucketsUtc,
  parseIsoRange,
  pctDelta,
  previousRange,
} from "@/lib/super-admin-analytics"

export const runtime = "nodejs"

function toDayMap(rows: any[] | null | undefined) {
  const map = new Map<string, number>()
  for (const row of rows ?? []) {
    const rawDay = String((row as any)?.day || "")
    const day = rawDay.includes("T") ? rawDay.slice(0, 10) : rawDay.split(" ")[0]
    if (!day) continue
    map.set(day, Number((row as any)?.count || 0))
  }
  return map
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const range = parseIsoRange(request.url, { daysBack: 30 })
  const prev = previousRange(range)
  const buckets = dayBucketsUtc(range)

  const [signups, signupsPrev] = await Promise.all([countAuthUsers(range), countAuthUsers(prev)])

  const [jobsCreated, jobsCreatedPrev] = await Promise.all([
    countBetween({ table: "jobs", column: "created_at", range }),
    countBetween({ table: "jobs", column: "created_at", range: prev }),
  ])

  const [applications, applicationsPrev] = await Promise.all([
    countBetween({ table: "applications", column: "applied_at", range }),
    countBetween({ table: "applications", column: "applied_at", range: prev }),
  ])

  const [candidatesAdded, candidatesAddedPrev] = await Promise.all([
    countBetween({ table: "candidates", column: "uploaded_at", range }),
    countBetween({ table: "candidates", column: "uploaded_at", range: prev }),
  ])

  const [outreachSent, outreachSentPrev] = await Promise.all([
    countBetween({ table: "outreach_messages", column: "created_at", range }),
    countBetween({ table: "outreach_messages", column: "created_at", range: prev }),
  ])

  const [jobViews, jobViewsPrev] = await Promise.all([
    countAnalyticsEvents({ range, eventName: "board.job.viewed" }),
    countAnalyticsEvents({ range: prev, eventName: "board.job.viewed" }),
  ])

  const [applyStarted, applyStartedPrev] = await Promise.all([
    countAnalyticsEvents({ range, eventName: "board.apply.started" }),
    countAnalyticsEvents({ range: prev, eventName: "board.apply.started" }),
  ])

  const [applySubmitted, applySubmittedPrev] = await Promise.all([
    countAnalyticsEvents({ range, eventName: "board.apply.submitted" }),
    countAnalyticsEvents({ range: prev, eventName: "board.apply.submitted" }),
  ])

  const [signupsByDayRows, jobsByDay, applicationsByDay, candidatesByDay, outreachByDay, jobViewsByDay, applySubmittedByDay] = await Promise.all([
    countAuthUsersByDay(range),
    supabaseAdmin.rpc("count_rows_by_day", { table_name: "jobs", ts_column: "created_at", start_ts: range.from, end_ts: range.to }),
    supabaseAdmin.rpc("count_rows_by_day", { table_name: "applications", ts_column: "applied_at", start_ts: range.from, end_ts: range.to }),
    supabaseAdmin.rpc("count_rows_by_day", { table_name: "candidates", ts_column: "uploaded_at", start_ts: range.from, end_ts: range.to }),
    supabaseAdmin.rpc("count_rows_by_day", { table_name: "outreach_messages", ts_column: "created_at", start_ts: range.from, end_ts: range.to }),
    supabaseAdmin.rpc("count_events_by_day", { event_name: "board.job.viewed", start_ts: range.from, end_ts: range.to }),
    supabaseAdmin.rpc("count_events_by_day", { event_name: "board.apply.submitted", start_ts: range.from, end_ts: range.to }),
  ])

  const jobsMap = !jobsByDay.error ? toDayMap(jobsByDay.data as any) : new Map<string, number>()
  const applicationsMap = !applicationsByDay.error ? toDayMap(applicationsByDay.data as any) : new Map<string, number>()
  const candidatesMap = !candidatesByDay.error ? toDayMap(candidatesByDay.data as any) : new Map<string, number>()
  const outreachMap = !outreachByDay.error ? toDayMap(outreachByDay.data as any) : new Map<string, number>()
  const jobViewsMap = !jobViewsByDay.error ? toDayMap(jobViewsByDay.data as any) : new Map<string, number>()
  const applySubmittedMap = !applySubmittedByDay.error ? toDayMap(applySubmittedByDay.data as any) : new Map<string, number>()
  const signupsMap = toDayMap(signupsByDayRows)

  const needFallbackRows = jobsByDay.error || applicationsByDay.error || candidatesByDay.error || outreachByDay.error
  const needFallbackEvents = jobViewsByDay.error || applySubmittedByDay.error

  const series = await Promise.all(
    buckets.map(async (b) => {
      const rowRange = { from: b.start, to: b.end }
      const jobs_created = needFallbackRows ? await countBetween({ table: "jobs", column: "created_at", range: rowRange }) : jobsMap.get(b.day) ?? 0
      const applications = needFallbackRows ? await countBetween({ table: "applications", column: "applied_at", range: rowRange }) : applicationsMap.get(b.day) ?? 0
      const candidates_added = needFallbackRows ? await countBetween({ table: "candidates", column: "uploaded_at", range: rowRange }) : candidatesMap.get(b.day) ?? 0
      const outreach_messages = needFallbackRows ? await countBetween({ table: "outreach_messages", column: "created_at", range: rowRange }) : outreachMap.get(b.day) ?? 0
      const job_views = needFallbackEvents ? await countAnalyticsEvents({ range: rowRange, eventName: "board.job.viewed" }) : jobViewsMap.get(b.day) ?? 0
      const applies = needFallbackEvents ? await countAnalyticsEvents({ range: rowRange, eventName: "board.apply.submitted" }) : applySubmittedMap.get(b.day) ?? 0
      return {
        day: b.day,
        signups: signupsMap.get(b.day) ?? 0,
        jobs_created,
        applications,
        candidates_added,
        outreach_messages,
        job_views,
        applies,
      }
    })
  )

  return NextResponse.json({
    range,
    kpis: {
      signups: { value: signups, previous: signupsPrev, delta_pct: pctDelta(signups, signupsPrev) },
      jobs_created: { value: jobsCreated, previous: jobsCreatedPrev, delta_pct: pctDelta(jobsCreated, jobsCreatedPrev) },
      applications: { value: applications, previous: applicationsPrev, delta_pct: pctDelta(applications, applicationsPrev) },
      candidates_added: { value: candidatesAdded, previous: candidatesAddedPrev, delta_pct: pctDelta(candidatesAdded, candidatesAddedPrev) },
      outreach_messages: { value: outreachSent, previous: outreachSentPrev, delta_pct: pctDelta(outreachSent, outreachSentPrev) },
      job_views: { value: jobViews, previous: jobViewsPrev, delta_pct: pctDelta(jobViews, jobViewsPrev) },
      apply_started: { value: applyStarted, previous: applyStartedPrev, delta_pct: pctDelta(applyStarted, applyStartedPrev) },
      apply_submitted: { value: applySubmitted, previous: applySubmittedPrev, delta_pct: pctDelta(applySubmitted, applySubmittedPrev) },
    },
    series,
  })
}
