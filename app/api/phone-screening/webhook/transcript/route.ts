import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { evaluateCallQuality } from "@/lib/ai-learning"
import { scheduleBolnaCall } from "@/lib/scheduled-call"

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
      .select("id")
      .eq("plivo_call_uuid", callUuid)

    if (!participants || participants.length === 0) {
      return NextResponse.json({ status: "ok" })
    }

    const participantId = participants[0].id
    const transcript = body.transcript || body.transcription
    const structuredOutput = body.structured_output || body.ai_summary

    if (Array.isArray(transcript)) {
      const transcriptRows = transcript.map((segment: any) => ({
        participant_id: participantId,
        speaker: segment.speaker === "agent" || segment.speaker === "ai" ? "ai" : "candidate",
        text: segment.text || "",
        start_time_sec: segment.start_time || segment.start,
        end_time_sec: segment.end_time || segment.end,
      }))

      if (transcriptRows.length > 0) {
        await supabaseAdmin.from("call_transcripts").insert(transcriptRows)
      }
    }

    if (structuredOutput) {
      const parsed = typeof structuredOutput === "string" ? JSON.parse(structuredOutput) : structuredOutput

      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          ai_score: parsed.score,
          ai_summary: typeof structuredOutput === "string" ? structuredOutput : JSON.stringify(structuredOutput),
          ai_recommendation: parsed.recommendation || "further_review",
          transcript_json: transcript ? (Array.isArray(transcript) ? JSON.stringify(transcript) : transcript) : null,
          callback_preference: parsed.callback_preference || null,
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", participantId)

      const keyAnswers = parsed.key_answers || {}
      const answerRows = Object.entries(keyAnswers).map(([key, value]) => ({
        participant_id: participantId,
        question_key: key,
        question_text: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        answer_text: String(value || ""),
      }))

      const questionAnswerMap: Record<string, string> = {
        current_salary: "What is your current monthly/annual salary?",
        expected_salary: "What is your expected salary for this role?",
        reason_for_switching: "What is your primary reason for looking to switch?",
        notice_period: "What is your notice period?",
        current_role_summary: "Can you walk me through your current role?",
      }

      const enrichedRows = Object.entries(keyAnswers).map(([key, value]) => ({
        participant_id: participantId,
        question_key: key,
        question_text: questionAnswerMap[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        answer_text: String(value || ""),
      }))

      if (enrichedRows.length > 0) {
        await supabaseAdmin.from("screening_answers").insert(enrichedRows)
      }

      // Write collected info back to the candidate profile (only non-empty values).
      try {
        const { data: participantRow } = await supabaseAdmin
          .from("phone_screening_participants")
          .select("candidate_id")
          .eq("id", participantId)
          .single()

        if (participantRow?.candidate_id) {
          const candidatePatch: any = {}
          if (keyAnswers.current_salary) candidatePatch.current_salary = String(keyAnswers.current_salary)
          if (keyAnswers.expected_salary) candidatePatch.expected_salary = String(keyAnswers.expected_salary)
          if (keyAnswers.notice_period) candidatePatch.notice_period = String(keyAnswers.notice_period)
          if (keyAnswers.current_role_summary && !candidatePatch.summary) {
            // Keep existing summary; do not clobber with a single answer.
          }
          if (Object.keys(candidatePatch).length > 0) {
            await supabaseAdmin
              .from("candidates")
              .update({ ...candidatePatch, updated_at: new Date().toISOString() })
              .eq("id", participantRow.candidate_id)
          }
        }
      } catch (err: any) {
        logger.warn("Candidate info write-back failed", { participantId, error: err?.message })
      }

      // If the candidate asked to be called back later, queue an automatic retry
      // so the delayed trigger places the next call on its own.
      if (parsed.callback_requested || parsed.callback_preference) {
        try {
          await supabaseAdmin
            .from("phone_screening_participants")
            .update({
              status: "failed",
              call_attempts: 1,
              next_retry_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", participantId)
          await scheduleBolnaCall(participantId, 15 * 60).catch(() => {})
        } catch (err: any) {
          logger.warn("Callback queue failed", { participantId, error: err?.message })
        }
      }
    } else if (Array.isArray(transcript)) {
      await supabaseAdmin
        .from("phone_screening_participants")
        .update({
          transcript_json: JSON.stringify(transcript),
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", participantId)
    }

    evaluateCallQuality(participantId).then(() => {}).catch((err: any) => {
      logger.error("Async call quality evaluation failed", { participantId, error: err?.message })
    })

    return NextResponse.json({ status: "ok" })
  } catch (error: any) {
    logger.error("Transcript webhook error", { error: error.message })
    return NextResponse.json({ status: "ok" })
  }
}
