import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { getBolnaExecution, BOLNA_TERMINAL_STATUSES } from "@/lib/bolna"

export const runtime = "nodejs"

const STUCK_AFTER_MINUTES = 3

export async function GET(request: NextRequest) {
  try {
    const now = new Date().toISOString()
    const threshold = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000).toISOString()

    const { data: stuck } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, bolna_execution_id, status, bolna_status")
      .not("bolna_execution_id", "is", null)
      .in("status", ["calling", "in_progress"])
      .lt("last_attempt_at", threshold)

    if (!stuck || stuck.length === 0) {
      return NextResponse.json({ checked: 0, updated: 0 })
    }

    let updated = 0
    for (const participant of stuck as any[]) {
      const execution = await getBolnaExecution(participant.bolna_execution_id)
      if (!execution || !execution.status) continue

      if (BOLNA_TERMINAL_STATUSES.has(execution.status)) {
        const nextStatus = execution.status === "completed" ? "completed" : "failed"
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({
            status: nextStatus,
            bolna_status: execution.status,
            updated_at: now,
          })
          .eq("id", participant.id)
        updated++
      } else {
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ bolna_status: execution.status, updated_at: now })
          .eq("id", participant.id)
      }
    }

    return NextResponse.json({ checked: stuck.length, updated })
  } catch (error: any) {
    logger.error("Bolna reconcile failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
