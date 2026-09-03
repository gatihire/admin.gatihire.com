import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const callUuid = body.CallUUID

    if (callUuid) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({ status: "calling", updated_at: new Date().toISOString() })
        .eq("plivo_call_uuid", callUuid)
    }

    return NextResponse.json({ status: "ok" })
  } catch (error: any) {
    logger.error("Ring webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}
