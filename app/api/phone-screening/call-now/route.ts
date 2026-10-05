import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { placeCallImmediately, MAX_TOTAL_CALL_ATTEMPTS } from "@/lib/scheduled-call"
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

    // HR clicked "Call now": an explicit human override of the accidental
    // double-dial guard (it still applies to the WhatsApp and automated paths).
    // It is NOT an override of the hard attempt budget — placeCallForParticipant
    // refuses to dial past MAX_TOTAL_CALL_ATTEMPTS even with force, and flags the
    // row for manual followup when it does.
    const result = await placeCallImmediately(participantId, { force: true })

    if (!result.success) {
      // Distinguish "you already used all your attempts" from "the provider
      // refused". A 409 with the cap attached is what lets the UI explain the
      // refusal instead of showing a generic failure the recruiter retries blindly.
      if (result.reason === "attempt_cap") {
        return NextResponse.json(
          {
            error: result.error || "Attempt limit reached",
            callPlaced: false,
            reason: "attempt_cap",
            maxAttempts: MAX_TOTAL_CALL_ATTEMPTS,
          },
          { status: 409 }
        )
      }
      const status = result.reason === "not_found" ? 404 : 502
      return NextResponse.json(
        { error: result.error || "Failed to place call", callPlaced: false, reason: result.reason || "provider_rejected" },
        { status }
      )
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
