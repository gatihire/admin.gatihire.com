import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { cancelHrExactSlot, type SlotErrorCode } from "@/lib/hr-exact-schedule"

export const runtime = "nodejs"

function statusForCode(code: SlotErrorCode): number {
  switch (code) {
    case "feature_disabled":
      return 403
    case "not_found":
      return 404
    case "already_calling":
    case "already_due":
    case "not_scheduled":
      return 409
    case "publish_failed":
      return 502
    default:
      return 400
  }
}

/** Cancel an HR-booked slot. Never cuts a call already with the provider. */
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
    const result = await cancelHrExactSlot({
      participantId: id,
      actor: ctx.authUser?.email || ctx.authUser?.id || null,
      actorId: ctx.authUser?.id || null,
    })

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: statusForCode(result.code) }
      )
    }

    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    logger.error("HR exact-time cancellation failed", { error: error?.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
