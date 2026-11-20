import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const callUuid = body.CallUUID || body.call_uuid

    if (!callUuid) {
      return NextResponse.json({ status: "ok" })
    }

    const { data: participants } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("id, status, call_attempts")
      .eq("plivo_call_uuid", callUuid)

    if (!participants || participants.length === 0) {
      return NextResponse.json({ status: "ok" })
    }

    const participant = participants[0]
    const callStatus = body.CallStatus || body.status
    const callDuration = body.CallDuration ? parseInt(body.CallDuration) : null

    if (callStatus === "ringing") {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({ status: "calling", updated_at: new Date().toISOString() })
        .eq("id", participant.id)
    } else if (callStatus === "in-progress" || callStatus === "in_progress") {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "in_progress",
          call_started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)
    } else if (callStatus === "completed") {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          status: "completed",
          call_ended_at: new Date().toISOString(),
          call_duration_seconds: callDuration,
          updated_at: new Date().toISOString(),
        })
        .eq("id", participant.id)
    } else {
      // ——— call ended (no-answer / busy / failed / etc.) ————————————————
      const technicalHangupReasons =
        /synthesizer_error|inactivity_timeout|no audio|audio issue|cannot hear|can't hear|inaudible|network|provider|balance|system|error/i

      // Technical drops (synthesizer_error, network issues, etc.) must NOT count
      // against the candidate's attempt budget — they are platform failures, not
      // candidate-related. Only count genuine candidate-answered-or-not calls.
      const hangupReason =
        (body.HangupReason || body.Hangupreason || body.hangup_reason || "").toString()
      const isTechnicalDrop = technicalHangupReasons.test(hangupReason)

      if (!isTechnicalDrop &&
          (callStatus === "no-answer" ||
           callStatus === "no_answer" ||
           callStatus === "busy" ||
           callStatus === "failed")) {
        const attempts = (participant.call_attempts || 0) + 1
        const maxRetries = parseInt(process.env.SCREENING_MAX_RETRIES || "3")
        const intervals = [
          parseInt(process.env.SCREENING_RETRY_INTERVAL_1 || "60"),
          parseInt(process.env.SCREENING_RETRY_INTERVAL_2 || "120"),
          parseInt(process.env.SCREENING_RETRY_INTERVAL_3 || "240"),
        ]

        if (attempts >= maxRetries) {
          await supabaseAdmin
            .from("phone_screening_participants")
            .update({
              status: "unreachable",
              call_attempts: attempts,
              last_attempt_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", participant.id)
        } else {
          const nextRetryDelay =
            intervals[attempts - 1] || intervals[intervals.length - 1]
          const nextRetryAt = new Date(Date.now() + nextRetryDelay * 1000).toISOString()

          await supabaseAdmin
            .from("phone_screening_participants")
            .update({
              status: "failed",
              call_attempts: attempts,
              last_attempt_at: new Date().toISOString(),
              next_retry_at: nextRetryAt,
              updated_at: new Date().toISOString(),
            })
            .eq("id", participant.id)

          await scheduleBolnaCall(participant.id, nextRetryDelay).catch(() => {})
        }
      } else if (!isTechnicalDrop && (
        callStatus === "no-answer" ||
        callStatus === "no_answer" ||
        callStatus === "busy" ||
        callStatus === "failed"
      )) {
        // Non-technical call status but already handled above — keep bolna_status fresh
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ bolna_status: callStatus, updated_at: new Date().toISOString() })
          .eq("id", participant.id)
      } else if (isTechnicalDrop) {
        // Technical drop (synthesizer_error, inactivity_timeout, etc.): do NOT increment
        // call_attempts and do NOT mark unreachable. Just keep bolna_status fresh so
        // the UI shows the real hangup reason.
        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ bolna_status: callStatus, updated_at: new Date().toISOString() })
          .eq("id", participant.id)
      }
    }

    return NextResponse.json({ status: "ok" })
  } catch (error: any) {
    logger.error("Call status webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}