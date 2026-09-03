import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { participantId, scheduledAt, timezone } = body

    if (!participantId || !scheduledAt) {
      return NextResponse.json({ error: "participantId and scheduledAt are required" }, { status: 400 })
    }

    const scheduledAtISO = new Date(scheduledAt).toISOString()
    const delaySec = Math.max(
      0,
      Math.round((new Date(scheduledAtISO).getTime() - Date.now()) / 1000)
    )

    const { error } = await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "call_scheduled",
        scheduled_call_at: scheduledAtISO,
        timezone: timezone || "UTC",
        updated_at: new Date().toISOString(),
      })
      .eq("id", participantId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const scheduled = await scheduleBolnaCall(participantId, delaySec)
    if (!scheduled.scheduled) {
      logger.error("Failed to schedule call for participant", { participantId, error: scheduled.error })
    }

    return NextResponse.json({ success: true, scheduledAt: scheduledAtISO })
  } catch (error: any) {
    logger.error("Schedule screening failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
