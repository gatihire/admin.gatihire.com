import { NextRequest, NextResponse } from "next/server"
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs"
import { placeCallForParticipant } from "@/lib/scheduled-call"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

// Fired by QStash when a delayed call is due (nudge timeout, retry backoff,
// scheduled callback). Request signature is verified by QStash.
async function handler(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const participantId = String(body?.participantId || "")
    if (!participantId) {
      return NextResponse.json({ error: "participantId required" }, { status: 400 })
    }

    logger.info("QStash trigger received", { participantId, body })

    // A candidate who picked "Call Now" gets a flag on the queued message, so
    // their explicit request can fire outside the automatic calling window.
    // Watchdog/outreach retries publish no flag and stay deferred at night.
    const bypassCallingHours = body?.bypassCallingHours === true

    const result = await placeCallForParticipant(participantId, {
      guard: true,
      bypassCallingHours,
    })

    if (result.skipped) {
      logger.info("Call placement skipped", { participantId, reason: result.error })
      return NextResponse.json({ success: false, skipped: true, reason: result.error })
    }

    if (!result.success) {
      logger.error("Call placement failed", { participantId, error: result.error })
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    logger.info("Call placed successfully", { participantId })
    return NextResponse.json({ success: true })
  } catch (error: any) {
    logger.error("Scheduled call trigger failed", { error: error?.message, stack: error?.stack })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export const POST = verifySignatureAppRouter(handler)