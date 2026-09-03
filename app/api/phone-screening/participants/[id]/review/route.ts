import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { invalidateSessionCache } from "@/lib/utils"

export const runtime = "nodejs"

const NEXT_STATUSES = new Set(["interview", "shortlist", "rejected"])

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const { decision, nextStatus, note } = body

    if (decision !== "approve" && decision !== "reject") {
      return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 })
    }
    if (decision === "approve" && !NEXT_STATUSES.has(nextStatus)) {
      return NextResponse.json({ error: `nextStatus must be one of: ${[...NEXT_STATUSES].join(", ")}` }, { status: 400 })
    }
    if (decision === "reject") {
      // Rejecting a call result always moves the candidate out of the pipeline.
    }

    const { data: participant, error: pErr } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, job_id, candidate_id, status, review_status")
      .eq("id", id)
      .single()

    if (pErr || !participant) {
      return NextResponse.json({ error: "Participant not found" }, { status: 404 })
    }

    const now = new Date().toISOString()
    const reviewPatch: any = {
      review_status: decision,
      reviewed_by: ctx.authUser.id,
      reviewed_at: now,
      updated_at: now,
    }
    if (typeof note === "string" && note.trim()) reviewPatch.review_note = note.trim()

    const { error: updateErr } = await supabaseAdmin
      .from("phone_screening_participants")
      .update(reviewPatch)
      .eq("id", id)

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    // Move the linked application to the target pipeline stage.
    const targetStatus = decision === "reject" ? "rejected" : nextStatus
    const { data: app } = await supabaseAdmin
      .from("applications")
      .select("id")
      .eq("job_id", participant.job_id)
      .eq("candidate_id", participant.candidate_id)
      .maybeSingle()

    if (app?.id) {
      await supabaseAdmin
        .from("applications")
        .update({ status: targetStatus, updated_at: now })
        .eq("id", app.id)
    }

    invalidateSessionCache("internal:applications:", { prefix: true })

    return NextResponse.json({ success: true, decision, targetStatus })
  } catch (error: any) {
    logger.error("Participant review failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
