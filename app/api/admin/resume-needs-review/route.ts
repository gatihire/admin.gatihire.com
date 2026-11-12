import { type NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

/**
 * Resumes that need a human.
 *
 * A candidate whose resume could not be read is NOT a failed application —
 * the file is sitting in storage waiting to be parsed. Before this endpoint
 * existed, that candidate was indistinguishable from someone who never
 * uploaded anything, and the recruiter had no way to find them.
 *
 * GET returns the candidates in `needs_review`:
 *   - who they are
 *   - what went wrong (resume_parse_error)
 *   - whether the resume text was salvaged anyway
 *   - a direct link to retry the parse
 *
 * POST retries one (or all) of them.
 */
export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.view") && !hasPermission(ctx, "candidates.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 50) || 50, 1), 200)

  const { data, error } = await supabaseAdmin
    .from("candidates")
    .select(
      "id,name,email,phone,current_role,current_company,location,total_experience,summary," +
        "file_name,file_url,file_type,file_size,resume_text,resume_parse_state,resume_parse_error," +
        "parsing_method,uploaded_at,updated_at",
    )
    .eq("resume_parse_state", "needs_review")
    .order("updated_at", { ascending: false })
    .limit(limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const items = (data || []).map((c: any) => ({
    ...c,
    // Text was salvaged even though the structured parse failed — the
    // recruiter can read it and decide.
    hasResumeText: !!(c.resume_text && c.resume_text.length > 50),
    // How long has this been sitting here?
    waitingDays: c.updated_at
      ? Math.floor((Date.now() - new Date(c.updated_at).getTime()) / 86_400_000)
      : null,
  }))

  return NextResponse.json({ ok: true, count: items.length, items })
}

/**
 * Re-queue the parse for a candidate whose resume could not be read.
 *
 * The job goes onto the same queue the worker drains, so it is retried with
 * backoff like any other parse — and the candidate row stays visible to the
 * recruiter in the meantime.
 */
export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const candidateId = typeof body.candidateId === "string" ? body.candidateId : null
  const all = body.all === true

  if (!candidateId && !all) {
    return NextResponse.json(
      { error: "Provide candidateId, or { all: true } to re-queue every resume that needs review" },
      { status: 400 },
    )
  }

  let query = supabaseAdmin
    .from("candidates")
    .select("id,file_name,file_url,resume_parse_state")
    .eq("resume_parse_state", "needs_review")

  if (!all && candidateId) query = query.eq("id", candidateId)

  const { data: candidates, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!candidates?.length) {
    return NextResponse.json({ ok: true, requeued: 0, message: "Nothing to re-queue" })
  }

  const results: Array<{ id: string; status: string; message?: string }> = []
  const nowIso = new Date().toISOString()

  for (const cand of candidates as any[]) {
    const { data: fileRow } = await supabaseAdmin
      .from("file_storage")
      .select("id,original_path")
      .eq("candidate_id", cand.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!fileRow) {
      results.push({ id: cand.id, status: "skipped", message: "no file in storage" })
      continue
    }

    // Already queued? Don't stack duplicate jobs.
    const { data: existing } = await supabaseAdmin
      .from("resume_parse_jobs")
      .select("id")
      .eq("candidate_id", cand.id)
      .in("status", ["queued", "processing"])
      .maybeSingle()

    if (existing) {
      results.push({ id: cand.id, status: "already_queued" })
      continue
    }

    const { data: parsingJob, error: pjErr } = await supabaseAdmin
      .from("parsing_jobs")
      .insert({
        candidate_id: cand.id,
        file_id: fileRow.id,
        status: "pending",
        parsing_method: process.env.GEMINI_API_KEY ? "gemini" : "basic",
        created_at: nowIso,
      })
      .select("id")
      .maybeSingle()

    if (pjErr || !parsingJob) {
      results.push({ id: cand.id, status: "failed", message: pjErr?.message || "no parsing job" })
      continue
    }

    const { error: qErr } = await supabaseAdmin.from("resume_parse_jobs").insert({
      candidate_id: cand.id,
      parsing_job_id: parsingJob.id,
      file_id: fileRow.id,
      file_path: fileRow.original_path,
      status: "queued",
      attempts: 0,
      next_run_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    })

    if (qErr) {
      results.push({ id: cand.id, status: "failed", message: qErr.message })
      continue
    }

    // Move the candidate back to "queued" so it shows as in-progress
    // rather than as a dead end.
    await supabaseAdmin
      .from("candidates")
      .update({ resume_parse_state: "queued", resume_parse_error: null })
      .eq("id", cand.id)

    results.push({ id: cand.id, status: "requeued" })
  }

  const requeued = results.filter((r) => r.status === "requeued").length
  return NextResponse.json({ ok: true, requeued, results })
}
