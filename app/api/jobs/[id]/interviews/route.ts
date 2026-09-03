import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

function nowIso() {
  return new Date().toISOString()
}

async function ensureDefaultRounds(jobId: string) {
  const { data } = await supabaseAdmin
    .from("job_interview_rounds")
    .select("id")
    .eq("job_id", jobId)
    .limit(1)
  if (data?.length) return

  const now = nowIso()
  await supabaseAdmin.from("job_interview_rounds").insert([
    { job_id: jobId, name: "Round 1", sort_order: 1, created_at: now, updated_at: now },
    { job_id: jobId, name: "Round 2", sort_order: 2, created_at: now, updated_at: now },
  ])
}

const ALLOWED_STATUSES = new Set([
  "pending", "waitlist", "on_hold", "passed", "move_next", "rejected",
  "scheduled", "completed", "failed", "no_show",
  "invite_sent", "confirmed", "rescheduled", "cancelled",
])

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  if (!hasPermission(ctx, "applications.view") && !hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id: jobId } = await params

  await ensureDefaultRounds(jobId)

  const { data: rounds, error: roundsErr } = await supabaseAdmin
    .from("job_interview_rounds")
    .select("id, job_id, name, sort_order")
    .eq("job_id", jobId)
    .order("sort_order", { ascending: true })

  if (roundsErr) return NextResponse.json({ error: roundsErr.message }, { status: 500 })

  const roundIds = (rounds || []).map((r) => r.id)
  if (!roundIds.length) return NextResponse.json({ rounds: [], interviews: [] })

  const firstRoundId = roundIds[0]
  if (firstRoundId) {
    const { data: apps } = await supabaseAdmin
      .from("applications")
      .select("id")
      .eq("job_id", jobId)
      .eq("status", "interview")

    const appIds = (apps || []).map((a: any) => a.id).filter(Boolean)
    if (appIds.length) {
      const { data: existing } = await supabaseAdmin
        .from("job_interviews")
        .select("application_id, round_id")
        .in("application_id", appIds)
        .in("round_id", roundIds)

      const hasAny = new Set<string>()
      for (const r of existing || []) {
        if (r?.application_id) hasAny.add(String(r.application_id))
      }

      const toSeed = appIds.filter((id: string) => !hasAny.has(String(id)))
      if (toSeed.length) {
        const now = nowIso()
        await supabaseAdmin.from("job_interviews").insert(
          toSeed.map((application_id: string) => ({
            round_id: firstRoundId,
            application_id,
            status: "pending",
            created_at: now,
            updated_at: now,
          }))
        )
      }
    }
  }

  const { data: interviews, error: interviewsErr } = await supabaseAdmin
    .from("job_interviews")
    .select("id, round_id, application_id, status, scheduled_at, notes, candidate_response, suggested_times, invite_sent_at, confirmed_at, whatsapp_message_id, created_at, updated_at")
    .in("round_id", roundIds)

  if (interviewsErr) return NextResponse.json({ error: interviewsErr.message }, { status: 500 })
  return NextResponse.json({ rounds: rounds || [], interviews: interviews || [] })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id: jobId } = await params
  const body = (await request.json().catch(() => null)) as any
  const roundId = typeof body?.roundId === "string" ? body.roundId : null
  const applicationId = typeof body?.applicationId === "string" ? body.applicationId : null
  if (!roundId || !applicationId) return NextResponse.json({ error: "Missing roundId/applicationId" }, { status: 400 })

  const { data: round } = await supabaseAdmin
    .from("job_interview_rounds")
    .select("id")
    .eq("id", roundId)
    .eq("job_id", jobId)
    .maybeSingle()
  if (!round?.id) return NextResponse.json({ error: "Invalid round" }, { status: 400 })

  const { data: app } = await supabaseAdmin
    .from("applications")
    .select("id")
    .eq("id", applicationId)
    .eq("job_id", jobId)
    .maybeSingle()
  if (!app?.id) return NextResponse.json({ error: "Invalid application" }, { status: 400 })

  const now = nowIso()
  const patch: any = { updated_at: now }
  if (typeof body?.status === "string") {
    const status = body.status.trim()
    if (!ALLOWED_STATUSES.has(status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    patch.status = status
  }
  if (typeof body?.notes === "string") patch.notes = body.notes
  if (typeof body?.scheduled_at === "string" || body?.scheduled_at === null) patch.scheduled_at = body.scheduled_at
  if (typeof body?.suggested_times !== "undefined") patch.suggested_times = body.suggested_times
  if (typeof body?.candidate_response === "string") patch.candidate_response = body.candidate_response
  if (patch.status === "invite_sent") patch.invite_sent_at = now
  if (patch.status === "confirmed") patch.confirmed_at = now

  const { data: existing } = await supabaseAdmin
    .from("job_interviews")
    .select("id")
    .eq("round_id", roundId)
    .eq("application_id", applicationId)
    .maybeSingle()

  let saved: any = null
  if (existing?.id) {
    const { data, error } = await supabaseAdmin
      .from("job_interviews")
      .update(patch)
      .eq("id", existing.id)
      .select("id, round_id, application_id, status, scheduled_at, notes, candidate_response, suggested_times, invite_sent_at, confirmed_at, created_at, updated_at")
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    saved = data
  } else {
    const { data, error } = await supabaseAdmin
      .from("job_interviews")
      .insert({ round_id: roundId, application_id: applicationId, ...patch, created_at: now })
      .select("id, round_id, application_id, status, scheduled_at, notes, candidate_response, suggested_times, invite_sent_at, confirmed_at, created_at, updated_at")
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    saved = data
  }

  if (saved?.status === "move_next") {
    const { data: rounds } = await supabaseAdmin
      .from("job_interview_rounds")
      .select("id, sort_order")
      .eq("job_id", jobId)
      .order("sort_order", { ascending: true })

    const list = rounds || []
    const currentIdx = list.findIndex((r: any) => r.id === roundId)
    const nextRoundId = currentIdx >= 0 ? list[currentIdx + 1]?.id : null
    if (nextRoundId) {
      const { data: existingNext } = await supabaseAdmin
        .from("job_interviews")
        .select("id")
        .eq("round_id", nextRoundId)
        .eq("application_id", applicationId)
        .maybeSingle()

      if (!existingNext?.id) {
        await supabaseAdmin.from("job_interviews").insert({
          round_id: nextRoundId,
          application_id: applicationId,
          status: "pending",
          created_at: now,
          updated_at: now,
        })
      }
    }
  }

  return NextResponse.json({ interview: saved })
}
