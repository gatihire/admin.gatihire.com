import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { placeCallForParticipant } from "@/lib/scheduled-call"
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

    const result = await placeCallForParticipant(participantId, { guard: false })

    if (!result.success) {
      const status = result.error === "Participant not found" ? 404 : 502
      return NextResponse.json({ error: result.error || "Failed to place call" }, { status })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    logger.error("Call-now failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
