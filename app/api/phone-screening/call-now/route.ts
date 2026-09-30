import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { placeCallImmediately } from "@/lib/scheduled-call"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

// Manually place the AI call for a single participant, skipping/overriding a
// WhatsApp-first nudge (used by the per-row "Call Now" action in the pipeline).
export async function POST(request: NextRequest) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const participantId = String(body?.participantId || "")
    if (!participantId) return NextResponse.json({ error: "participantId required" }, { status: 400 })

    // HR clicked "Call now": an explicit human override, so the automatic
    // duplicate-protection is bypassed here (it still applies to the WhatsApp and
    // automated paths). If the provider still rejects it we say so rather than
    // implying a call was placed.
    const result = await placeCallImmediately(participantId, { force: true })

    if (!result.success) {
      const status = result.error === "Participant not found" ? 404 : 502
      return NextResponse.json({ error: result.error || "Failed to place call", callPlaced: false }, { status })
    }

    // Return the execution id so the UI can show a verifiable reference instead of
    // a generic "call triggered" claim.
    const { data: row } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("bolna_execution_id, bolna_status, call_attempts, last_attempt_at")
      .eq("id", participantId)
      .maybeSingle()

    return NextResponse.json({
      success: true,
      callPlaced: !!row?.bolna_execution_id,
      executionId: row?.bolna_execution_id || null,
      bolnaStatus: row?.bolna_status || "queued",
      callAttempts: row?.call_attempts || 1,
      placedAt: row?.last_attempt_at || new Date().toISOString(),
    })
  } catch (error: any) {
    logger.error("Call-now failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
