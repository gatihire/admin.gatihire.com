import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

const VALID_ACTIONS = new Set(["shortlist", "reject"])

/**
 * Bulk pipeline actions from the DB Matches tab.
 * POST /api/jobs/[id]/bulk-action
 * body: { candidateIds: string[], action: "shortlist" | "reject" }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params
    const body: any = await request.json().catch(() => ({}))
    const candidateIds: string[] = Array.isArray(body?.candidateIds)
      ? body.candidateIds.map((v: unknown) => String(v)).filter(Boolean).slice(0, 200)
      : []
    const action = String(body?.action || "")

    if (candidateIds.length === 0) {
      return NextResponse.json({ error: "candidateIds are required" }, { status: 400 })
    }
    if (!VALID_ACTIONS.has(action)) {
      return NextResponse.json({ error: `action must be one of: ${[...VALID_ACTIONS].join(", ")}` }, { status: 400 })
    }

    // Reject works on existing applications only; shortlist creates them.
    if (action === "reject") {
      const { data: apps, error: appError } = await supabaseAdmin
        .from("applications")
        .select("id, candidate_id")
        .eq("job_id", id)
        .in("candidate_id", candidateIds)
      if (appError) return NextResponse.json({ error: appError.message }, { status: 500 })

      const ids = (apps || []).map((a: any) => a.id)
      let updated = 0
      if (ids.length > 0) {
        const { error: updError } = await supabaseAdmin
          .from("applications")
          .update({ status: "rejected" })
          .in("id", ids)
          .not("status", "eq", "rejected")
        if (updError) return NextResponse.json({ error: updError.message }, { status: 500 })
        updated = ids.length
      }
      return NextResponse.json({
        message: `${updated} application${updated === 1 ? "" : "s"} rejected`,
        updated,
      })
    }

    // action === "shortlist": create applications in Shortlist stage for
    // candidates that don't have one yet; refresh match_score on existing rows.
    const { data: candidates, error: candError } = await supabaseAdmin
      .from("candidates")
      .select("id, name")
      .in("id", candidateIds)
    if (candError) return NextResponse.json({ error: candError.message }, { status: 500 })
    if (!candidates || candidates.length === 0) {
      return NextResponse.json({ error: "No valid candidates found" }, { status: 400 })
    }

    // Latest match scores per candidate, so shortlisted rows stay meaningful.
    const scoreByCandidate = new Map<string, number | null>()
    try {
      const { data: jm } = await supabaseAdmin
        .from("job_matches")
        .select("candidate_id, match_score")
        .eq("job_id", id)
        .in("candidate_id", candidateIds)
        .order("created_at", { ascending: false })
      for (const row of jm || []) {
        const cid = String((row as any).candidate_id)
        if (!scoreByCandidate.has(cid)) scoreByCandidate.set(cid, (row as any).match_score ?? null)
      }
    } catch (scoreErr) {
      logger.warn("bulk-action: could not load job_matches scores", scoreErr)
    }

    const { data: existingApps } = await supabaseAdmin
      .from("applications")
      .select("id, candidate_id, status")
      .eq("job_id", id)
      .in("candidate_id", candidateIds)

    const existingByCandidate = new Map<string, any>()
    for (const a of existingApps || []) existingByCandidate.set(String(a.candidate_id), a)

    let created = 0
    let moved = 0
    const errors: string[] = []

    for (const cand of candidates) {
      const cid = String(cand.id)
      const existing = existingByCandidate.get(cid)
      const matchScore = scoreByCandidate.get(cid) ?? null

      if (existing) {
        // Already in pipeline: move to Shortlist unless it's already there or beyond.
        const terminalOrLater = ["interview", "offer", "hired"].includes(existing.status)
        if (existing.status !== "shortlist" && !terminalOrLater && existing.status !== "rejected") {
          const { error: updError } = await supabaseAdmin
            .from("applications")
            .update({ status: "shortlist", ...(matchScore != null ? { match_score: matchScore } : {}) })
            .eq("id", existing.id)
          if (updError) errors.push(updError.message)
          else moved += 1
        } else if (matchScore != null) {
          await supabaseAdmin
            .from("applications")
            .update({ match_score: matchScore })
            .eq("id", existing.id)
        }
        continue
      }

      const { error: insError } = await supabaseAdmin.from("applications").insert({
        job_id: id,
        candidate_id: cid,
        status: "shortlist",
        source: "database",
        origin: "outbound",
        ...(matchScore != null ? { match_score: matchScore } : {}),
      })
      if (insError) errors.push(insError.message)
      else created += 1
    }

    const total = created + moved
    return NextResponse.json({
      message:
        total > 0
          ? `${total} candidate${total === 1 ? "" : "s"} added to Shortlist${created && moved ? ` (${created} new, ${moved} moved)` : ""}`
          : "Candidates are already in the pipeline",
      created,
      moved,
      ...(errors.length > 0 ? { errors } : {}),
    })
  } catch (error: any) {
    logger.error("Error running bulk action", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
