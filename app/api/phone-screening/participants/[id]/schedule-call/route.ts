import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { bookHrExactSlot, type SlotErrorCode } from "@/lib/hr-exact-schedule"

export const runtime = "nodejs"

function statusForCode(code: SlotErrorCode): number {
  switch (code) {
    case "feature_disabled":
      return 403
    case "not_found":
      return 404
    case "already_calling":
    case "already_scheduled":
    case "attempt_cap":
    case "already_due":
    case "not_scheduled":
      return 409
    case "publish_failed":
      return 502
    default:
      return 400
  }
}

/**
 * HR-authored exact-time call slot.
 *
 * This is a different commitment from `call-now` and from the WhatsApp slot
 * picker: HR has already spoken to the candidate and is writing down the exact
 * time the candidate proposed. The booking is the human action; QStash's
 * `notBefore` delivers the guarded trigger at that instant.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) {
      return NextResponse.json(
        { error: "Session expired — please log in again", code: "SESSION_EXPIRED" },
        { status: 401 }
      )
    }
    if (!hasPermission(ctx, "applications.manage") && !hasPermission(ctx, "outreach.send")) {
      return NextResponse.json({ error: "Forbidden", code: "FORBIDDEN" }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const actor = ctx.authUser?.email || ctx.authUser?.id || null
    const actorId = ctx.authUser?.id || null

    const result = await bookHrExactSlot({
      participantId: id,
      scheduledAt: body?.scheduledAt,
      timezone: body?.timezone || "Asia/Kolkata",
      note: body?.note,
      reason: String(body?.reason || ""),
      actor,
      actorId,
    })

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: statusForCode(result.code) }
      )
    }

    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    logger.error("HR exact-time schedule failed", { error: error?.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
