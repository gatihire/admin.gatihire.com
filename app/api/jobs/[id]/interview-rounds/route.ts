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

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id: jobId } = await params

  await ensureDefaultRounds(jobId)

  const { data, error } = await supabaseAdmin
    .from("job_interview_rounds")
    .select("id, job_id, name, sort_order, created_at, updated_at")
    .eq("job_id", jobId)
    .order("sort_order", { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rounds: data || [] })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id: jobId } = await params
  const body = (await request.json().catch(() => null)) as any

  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name) return NextResponse.json({ error: "Missing name" }, { status: 400 })

  const { data: last } = await supabaseAdmin
    .from("job_interview_rounds")
    .select("sort_order")
    .eq("job_id", jobId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle()

  const nextOrder = (typeof (last as any)?.sort_order === "number" ? (last as any).sort_order : 0) + 1
  const now = nowIso()

  const { data, error } = await supabaseAdmin
    .from("job_interview_rounds")
    .insert({ job_id: jobId, name, sort_order: nextOrder, created_at: now, updated_at: now })
    .select("id, job_id, name, sort_order, created_at, updated_at")
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ round: data })
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id: jobId } = await params
  const body = (await request.json().catch(() => null)) as any
  const roundId = typeof body?.id === "string" ? body.id : null
  if (!roundId) return NextResponse.json({ error: "Missing id" }, { status: 400 })

  const patch: any = { updated_at: nowIso() }
  if (typeof body?.name === "string") {
    const n = body.name.trim()
    if (!n) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 })
    patch.name = n
  }
  if (typeof body?.sort_order === "number") patch.sort_order = body.sort_order

  const { data, error } = await supabaseAdmin
    .from("job_interview_rounds")
    .update(patch)
    .eq("id", roundId)
    .eq("job_id", jobId)
    .select("id, job_id, name, sort_order, created_at, updated_at")
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ round: data })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id: jobId } = await params
  const body = (await request.json().catch(() => null)) as any
  const roundId = typeof body?.id === "string" ? body.id : null
  if (!roundId) return NextResponse.json({ error: "Missing id" }, { status: 400 })

  const { data: round, error: roundErr } = await supabaseAdmin
    .from("job_interview_rounds")
    .select("id")
    .eq("id", roundId)
    .eq("job_id", jobId)
    .maybeSingle()

  if (roundErr) return NextResponse.json({ error: roundErr.message }, { status: 500 })
  if (!round) return NextResponse.json({ error: "Round not found" }, { status: 404 })

  const { error: delInterviewsErr } = await supabaseAdmin
    .from("job_interviews")
    .delete()
    .eq("round_id", roundId)

  if (delInterviewsErr) return NextResponse.json({ error: delInterviewsErr.message }, { status: 500 })

  const { error: delRoundErr } = await supabaseAdmin
    .from("job_interview_rounds")
    .delete()
    .eq("id", roundId)
    .eq("job_id", jobId)

  if (delRoundErr) return NextResponse.json({ error: delRoundErr.message }, { status: 500 })

  const { data: remaining, error: remainingErr } = await supabaseAdmin
    .from("job_interview_rounds")
    .select("id, sort_order")
    .eq("job_id", jobId)
    .order("sort_order", { ascending: true })

  if (remainingErr) return NextResponse.json({ deleted: true })

  const now = nowIso()
  const updates = (remaining || []).map((r: any, idx: number) => {
    const nextOrder = idx + 1
    if (r.sort_order === nextOrder) return null
    return { id: r.id, sort_order: nextOrder, updated_at: now }
  }).filter(Boolean) as any[]

  if (updates.length) {
    await supabaseAdmin.from("job_interview_rounds").upsert(updates)
  }

  return NextResponse.json({ deleted: true })
}
