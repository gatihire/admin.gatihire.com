import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const callUuid = body.CallUUID
    const callDuration = body.CallDuration ? parseInt(body.CallDuration) : null

    if (callUuid) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "completed",
          call_ended_at: new Date().toISOString(),
          call_duration_seconds: callDuration,
          updated_at: new Date().toISOString(),
        })
        .eq("plivo_call_uuid", callUuid)
    }

    return NextResponse.json({ status: "ok" })
  } catch (error: any) {
    logger.error("Hangup webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}
