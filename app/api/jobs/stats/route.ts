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

type DecisionCounts = { approved: number; rejected: number; pending: number }
type ScreeningCounts = {
  pending: number
  whatsapp_sent: number
  replied: number
  calling: number
  call_done: number
  rejected: number
}
type InterviewCounts = {
  pending: number
  invite_sent: number
  confirmed: number
  rescheduled: number
  cancelled: number
}

function screeningSubSection(p: any): string {
  const status = p?.status
  const review = p?.review_status
  const delivery = p?.whatsapp_delivery_status
  const reply = p?.whatsapp_response || p?.whatsapp_reply_text

  if (review === "approved") return "call_done"
  if (review === "rejected") return "rejected"
  if (status === "completed") return "call_done"
  if (["not_interested", "unreachable", "failed", "rejected"].includes(status)) return "rejected"
  if (status === "in_progress" || status === "calling" || status === "call_scheduled") return "calling"
  if (reply) return "replied"
  if (status === "whatsapp_sent" || delivery === "delivered" || delivery === "sent" || delivery === "read") return "whatsapp_sent"
  return "pending"
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

  const emptyScreening = (): ScreeningCounts => ({
    pending: 0, whatsapp_sent: 0, replied: 0, calling: 0, call_done: 0, rejected: 0,
  })
  const emptyInterview = (): InterviewCounts => ({
    pending: 0, invite_sent: 0, confirmed: 0, rescheduled: 0, cancelled: 0,
  })

  const appCounts: Record<string, number> = {}
  const pendingCounts: Record<string, number> = {}
  const reviewCounts: Record<string, number> = {}
  const shortlistCounts: Record<string, number> = {}
  const clientDecisions: Record<string, DecisionCounts> = {}
  const screeningStats: Record<string, ScreeningCounts> = {}
  const interviewStats: Record<string, InterviewCounts> = {}

  ids.forEach((id) => {
    appCounts[id] = 0
    pendingCounts[id] = 0
    reviewCounts[id] = 0
    shortlistCounts[id] = 0
    clientDecisions[id] = { approved: 0, rejected: 0, pending: 0 }
    screeningStats[id] = emptyScreening()
    interviewStats[id] = emptyInterview()
  })

  const [campaignsRes, appsRes, sharesRes, interviewsRes] = await Promise.all([
    supabaseAdmin.from("phone_screening_campaigns").select("id, job_id").in("job_id", ids),
    supabaseAdmin.from("applications").select("job_id, candidate_id, status").in("job_id", ids),
    supabaseAdmin.from("shortlist_shares").select("id, job_id").in("job_id", ids),
    supabaseAdmin.from("job_interview_rounds").select("id, job_id").in("job_id", ids),
  ])

  if (appsRes.error) {
    return NextResponse.json({ error: appsRes.error.message || "Failed to load applications" }, { status: 500 })
  }

  // Application-derived counts (total / new / shortlist)
  ;(appsRes.data || []).forEach((row: any) => {
    const jobId = String(row?.job_id || "")
    if (!jobId || !(jobId in appCounts)) return
    appCounts[jobId]++
    if (row.status === "applied") pendingCounts[jobId]++
    if (row.status === "shortlist") shortlistCounts[jobId]++
  })

  // Screening participant counts per job
  const campToJob = new Map<string, string>()
  for (const c of campaignsRes.data || []) {
    if (c?.id && c?.job_id) campToJob.set(String(c.id), String(c.job_id))
  }
  const campaignIds = [...campToJob.keys()]
  if (campaignIds.length > 0) {
    const { data: participants, error: partErr } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("campaign_id, status, review_status, whatsapp_delivery_status, whatsapp_response, whatsapp_reply_text")
      .in("campaign_id", campaignIds)
    if (!partErr && Array.isArray(participants)) {
      participants.forEach((p: any) => {
        const jobId = campToJob.get(String(p?.campaign_id || ""))
        if (!jobId || !(jobId in screeningStats)) return
        const sub = screeningSubSection(p)
        screeningStats[jobId][sub as keyof ScreeningCounts]++
        // call_done also counts as review awaiting HR
        if (sub === "call_done") reviewCounts[jobId]++
      })
    }
  }

  // Client decisions from shortlist shares
  const shareToJob = new Map<string, string>()
  for (const s of sharesRes.data || []) {
    if (s?.id && s?.job_id) shareToJob.set(String(s.id), String(s.job_id))
  }
  const shareIds = [...shareToJob.keys()]
  if (shareIds.length > 0) {
    const { data: scRows, error: scErr } = await supabaseAdmin
      .from("shortlist_share_candidates")
      .select("share_id, status")
      .in("share_id", shareIds)
    if (!scErr && Array.isArray(scRows)) {
      scRows.forEach((row: any) => {
        const jobId = shareToJob.get(String(row?.share_id || ""))
        if (!jobId || !(jobId in clientDecisions)) return
        const target = clientDecisions[jobId]
        if (row?.status === "approved") target.approved++
        else if (row?.status === "rejected") target.rejected++
        else target.pending++
      })
    }
  }

  // Interview stats per job
  const roundToJob = new Map<string, string>()
  for (const r of interviewsRes.data || []) {
    if (r?.id && r?.job_id) roundToJob.set(String(r.id), String(r.job_id))
  }
  const roundIds = [...roundToJob.keys()]
  if (roundIds.length > 0) {
    const { data: entries, error: intErr } = await supabaseAdmin
      .from("job_interviews")
      .select("round_id, status")
      .in("round_id", roundIds)
    if (!intErr && Array.isArray(entries)) {
      entries.forEach((e: any) => {
        const jobId = roundToJob.get(String(e?.round_id || ""))
        if (!jobId || !(jobId in interviewStats)) return
        const s = e?.status
        if (s === "pending" || s === "scheduled") interviewStats[jobId].pending++
        else if (s === "invite_sent") interviewStats[jobId].invite_sent++
        else if (s === "confirmed") interviewStats[jobId].confirmed++
        else if (s === "rescheduled") interviewStats[jobId].rescheduled++
        else if (s === "cancelled" || s === "rejected" || s === "no_show" || s === "failed") interviewStats[jobId].cancelled++
      })
    }
  }

  return NextResponse.json({
    appCounts,
    pendingCounts,
    reviewCounts,
    shortlistCounts,
    clientDecisions,
    screeningStats,
    interviewStats,
  })
}
