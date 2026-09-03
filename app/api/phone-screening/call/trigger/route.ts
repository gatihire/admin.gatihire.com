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

    const result = await placeCallForParticipant(participantId, { guard: true })

    if (result.skipped) {
      // Participant already advanced (called manually, completed, out of retries).
      // Treated as a success so QStash does not retry a no-op message.
      return NextResponse.json({ success: false, skipped: true, reason: result.error })
    }

    if (!result.success) {
      // Placement failed and the participant was left untouched — return an error
      // so QStash's built-in retries re-attempt the placement.
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    logger.error("Scheduled call trigger failed", { error: error?.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export const POST = verifySignatureAppRouter(handler)