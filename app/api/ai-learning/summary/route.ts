import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { data: playbook } = await supabaseAdmin
    .from("ai_playbook_versions")
    .select("*")
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [{ data: events }, { data: metrics }] = await Promise.all([
    supabaseAdmin
      .from("ai_learning_events")
      .select("id, event_type, issue_category, severity, lesson, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("call_quality_metrics")
      .select("id, quality_score, aborted, issues_count, missing_answers, duration_seconds, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100),
  ])

  const issueCount = (events || []).filter((e: any) => e.event_type === "quality_issue").length
  const avgQuality = metrics && metrics.length > 0
    ? Number((metrics.reduce((s: number, m: any) => s + (m.quality_score || 0), 0) / metrics.length).toFixed(2))
    : null

  return NextResponse.json({
    playbook,
    last7Days: {
      callsReviewed: metrics?.length || 0,
      issuesFound: issueCount,
      avgQualityScore: avgQuality,
      events: events || [],
      metrics: metrics || [],
    },
  })
}
