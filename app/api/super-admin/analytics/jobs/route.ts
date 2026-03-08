import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { countAnalyticsEvents, countBetween, dayBucketsUtc, parseIsoRange } from "@/lib/super-admin-analytics"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const range = parseIsoRange(request.url, { daysBack: 60 })
  const buckets = dayBucketsUtc(range)

  const [{ count: openJobs }, { count: closedJobs }] = await Promise.all([
    supabaseAdmin.from("jobs").select("id", { count: "exact", head: true }).eq("status", "open"),
    supabaseAdmin.from("jobs").select("id", { count: "exact", head: true }).neq("status", "open"),
  ])

  const [jobsCreated, applications, views, applyStarted, applySubmitted] = await Promise.all([
    countBetween({ table: "jobs", column: "created_at", range }),
    countBetween({ table: "applications", column: "applied_at", range }),
    countAnalyticsEvents({ range, eventName: "board.job.viewed" }),
    countAnalyticsEvents({ range, eventName: "board.apply.started" }),
    countAnalyticsEvents({ range, eventName: "board.apply.submitted" }),
  ])

  const applicationsPerJob = jobsCreated > 0 ? applications / jobsCreated : 0

  const series = await Promise.all(
    buckets.map(async (b) => {
      const r = { from: b.start, to: b.end }
      const [dJobs, dApps, dViews, dApplySubmitted] = await Promise.all([
        countBetween({ table: "jobs", column: "created_at", range: r }),
        countBetween({ table: "applications", column: "applied_at", range: r }),
        countAnalyticsEvents({ range: r, eventName: "board.job.viewed" }),
        countAnalyticsEvents({ range: r, eventName: "board.apply.submitted" }),
      ])
      return { day: b.day, jobs_created: dJobs, applications: dApps, job_views: dViews, applies: dApplySubmitted }
    })
  )

  const { data: recentJobs } = await supabaseAdmin
    .from("jobs")
    .select("id,title,created_at,status")
    .gte("created_at", range.from)
    .lt("created_at", range.to)
    .order("created_at", { ascending: false })
    .limit(50)

  const jobRows = await Promise.all(
    (recentJobs ?? []).map(async (j: any) => {
      const [apps, viewsCount] = await Promise.all([
        supabaseAdmin.from("applications").select("id", { count: "exact", head: true }).eq("job_id", j.id),
        supabaseAdmin
          .from("analytics_events")
          .select("id", { count: "exact", head: true })
          .eq("event_name", "board.job.viewed")
          .contains("metadata", { job_id: j.id }),
      ])
      return {
        id: j.id,
        title: j.title,
        status: j.status,
        created_at: j.created_at,
        applications: apps.count ?? 0,
        views: viewsCount.count ?? 0,
      }
    })
  )

  jobRows.sort((a, b) => b.applications - a.applications)

  return NextResponse.json({
    range,
    totals: {
      open_jobs: openJobs ?? 0,
      closed_jobs: closedJobs ?? 0,
      jobs_created: jobsCreated,
      applications,
      applications_per_job_avg: applicationsPerJob,
      conversion: {
        view_to_apply_start: views > 0 ? applyStarted / views : 0,
        apply_start_to_submit: applyStarted > 0 ? applySubmitted / applyStarted : 0,
        view_to_apply_submit: views > 0 ? applySubmitted / views : 0,
      },
    },
    series,
    top_jobs: jobRows.slice(0, 15),
  })
}

