import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getWhatsAppService } from "@/lib/whatsapp"
import { sendSessionMessage } from "@/lib/info-collector-v2/sender"
import { scheduleBolnaCall } from "@/lib/scheduled-call"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logCandidateActivity } from "@/lib/activity-logger"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

const VALID_DECISIONS = ["approved", "rejected", "clarify"] as const

/**
 * POST /api/phone-screening/review
 *
 * The single endpoint for a human decision on an AI-flagged candidate. The AI
 * pre-screen is advisory: it can recommend rejection, but only a person can act
 * on that, and nothing is sent to the candidate until they do.
 *
 * Decisions:
 *   approved  tell the candidate they're through and book the screening call
 *   rejected  tell the candidate the role isn't a fit — `note` is REQUIRED, it is
 *             what goes into the audit trail and what HR reads later
 *   clarify   ask the candidate a question and WAIT. No call is booked and the
 *             candidate is not told anything about fit.
 *
 * Every outcome writes review_status / reviewed_by / reviewed_at / review_note.
 * Those columns already existed (20260802_call_pipeline.sql) but this route
 * never wrote them, so there was no record of who decided anything.
 *
 * Auth: sends outbound WhatsApp and books real phone calls, so it requires the
 * same applications.manage permission as every other mutating screening route.
 * It previously had NO auth check at all.
 *
 * Body: { participantId, decision, note? }  |  { actions: [same] } for bulk.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const reviewerId = ctx.authUser.id
    const reviewerLabel = ctx.authUser.email || reviewerId

    const body = await request.json().catch(() => ({}))

    // Support both single and bulk
    const actions = Array.isArray(body.actions)
      ? body.actions
      : [{ participantId: body.participantId, decision: body.decision, note: body.note }]

    if (!actions.length || !actions[0].participantId) {
      return NextResponse.json({ error: "Missing participantId" }, { status: 400 })
    }

    const results: Array<{ participantId: string; success: boolean; error?: string }> = []
    const whatsapp = getWhatsAppService()

    for (const action of actions) {
      const { participantId, decision, note } = action
      const trimmedNote = typeof note === "string" ? note.trim() : ""

      if (!participantId || !VALID_DECISIONS.includes(decision)) {
        results.push({ participantId, success: false, error: "Invalid participantId or decision" })
        continue
      }

      // A rejection with no recorded reason is exactly the failure this gate
      // exists to prevent: the candidate is told it isn't a fit and nobody can
      // later say why. The UI requires it too; enforce it here as well.
      if (decision === "rejected" && !trimmedNote) {
        results.push({ participantId, success: false, error: "A reason is required to reject a candidate" })
        continue
      }
      if (decision === "clarify" && !trimmedNote) {
        results.push({ participantId, success: false, error: "A question is required to ask the candidate for clarification" })
        continue
      }

      try {
        const { data: participant, error: fetchError } = await supabaseAdmin
          .from("phone_screening_participants")
          .select(`
            id, status, job_id, candidate_id, origin, info_data, screening_context,
            candidates: candidate_id (id, name, phone, current_ctc, expected_ctc, notice_period,
                                      total_experience_years, location_preference, willing_to_relocate, reason_for_switching),
            jobs: job_id (id, title, client_name)
          `)
          .eq("id", participantId)
          .single()

        if (fetchError || !participant) {
          results.push({ participantId, success: false, error: "Participant not found" })
          continue
        }

        // Idempotency guard. Without it a double-click, or a retry after a
        // partially-applied bulk action, re-sends the rejection template to a
        // candidate who was already told.
        if (participant.status !== "needs_review") {
          results.push({
            participantId,
            success: false,
            error: `Participant status is "${participant.status}", not "needs_review" — already handled`,
          })
          continue
        }

        const candidate = participant.candidates as any
        const now = new Date().toISOString()

        // Common audit write. Deliberately NOT bundled with the status change:
        // see the reject branch, where a failed WhatsApp send must not leave the
        // row claiming a decision that never reached the candidate.
        const audit = {
          review_status: decision === "approved" ? "approved" : decision === "rejected" ? "rejected" : "pending",
          reviewed_by: reviewerId,
          reviewed_at: now,
          review_note: trimmedNote || null,
          updated_at: now,
        }

        if (decision === "clarify") {
          // Ask, then wait. Deliberately does NOT book a call and does NOT set a
          // terminal status: the candidate has not been screened yet, so calling
          // them would contradict the question we just sent.
          //
          // The wording used to open "one quick thing before we call you:". On
          // this branch no call is approved — that is the entire reason the
          // candidate is in front of a recruiter. So the message told the
          // candidate a call was imminent that nobody had authorised, and then
          // went quiet while they waited for it.
          const firstName = (candidate?.name || "").split(" ")[0]
          const question = `${firstName ? `Hi ${firstName}, ` : ""}one quick question about your application:\n\n${trimmedNote}\n\nReply here and we'll take it from there.`

          // Free text rather than a template: the whole point of clarifying is to
          // ask something specific that no pre-approved template can anticipate.
          // This only reaches the candidate inside the 24h service window, which
          // is exactly the population that just sent us their details.
          const sent = await sendSessionMessage(candidate?.phone || "", question)

          if (!sent?.success) {
            logger.error("Failed to send clarification question", {
              participantId,
              candidateId: participant.candidate_id,
              error: sent?.error,
            })
            results.push({
              participantId,
              success: false,
              error: `Could not send the question (${sent?.error || "unknown error"}). Nothing was recorded.`,
            })
            continue
          }

          await supabaseAdmin
            .from("phone_screening_participants")
            .update({
              ...audit,
                  status: "info_requested",
                  clarification_question: trimmedNote,
                  clarification_asked_at: now,
                  clarification_answered_at: null,
                  // Clear any previous answer so a second clarify does not render
                  // alongside the first one's answer. screening_context is the
                  // only safe place for the body — there is no
                  // `clarification_answer` column.
                  screening_context: {
                    ...(participant.screening_context || {}),
                    clarification_answer: null,
                  },
              // No `info_step: "clarify"`. "clarify" is not a member of
              // INFO_STEPS, so writing it parked the participant on a step that
              // does not exist: the next reply had no step to extract against and
              // the answer was stored in info_data under a literal `clarify` key,
              // which then surfaced in the candidate-facing summary as
              // "• clarify: yes". The clarification state already has real columns
              // and lives in screening_context; the screening step is untouched.
            })
            .eq("id", participantId)

          await logCandidateActivity({
            jobId: participant.job_id || "",
            candidateId: participant.candidate_id,
            participantId,
            eventType: "screening_reviewed",
            eventData: { decision: "clarify", question: trimmedNote, reviewer: reviewerLabel },
            actor: reviewerLabel,
          })

          logger.info("HR asked candidate for clarification", {
            participantId,
            candidateId: participant.candidate_id,
            question: trimmedNote,
          })
          results.push({ participantId, success: true })
          continue
        }

        if (decision === "approved") {
          // Clear the hold the pre-screen set. Leaving awaitingReviewApproval in
          // place would make the next inbound reply believe the candidate is
          // still ungated and go quiet on them after HR already approved.
          const prevContext = (participant as any).screening_context || {}
          await supabaseAdmin
            .from("phone_screening_participants")
            .update({
              ...audit,
              status: "info_received",
              prescreen_decision: "approved",
              screening_context: {
                ...prevContext,
                awaitingReviewApproval: false,
                approvedAt: now,
              },
            })
            .eq("id", participantId)

          await supabaseAdmin
            .from("candidates")
            .update({
              ai_prescreen_decision: "approved",
              ai_prescreen_reason: trimmedNote || "Approved by HR after review",
              updated_at: now,
            })
            .eq("id", participant.candidate_id)

          // Send template 11 (info_received_confirm) with schedule buttons
          await whatsapp.sendInfoReceivedConfirm({
            phoneNumber: candidate?.phone || "",
            candidateName: candidate?.name || "",
            currentCtc: candidate?.current_ctc || "Not provided",
            expectedCtc: candidate?.expected_ctc || "Not provided",
            noticePeriod: candidate?.notice_period || "Not provided",
          })

          // Auto-schedule AI call (1 minute delay so candidate sees confirmation first)
          const callDelaySec = 60
          const scheduled = await scheduleBolnaCall(participantId, callDelaySec)
          if (scheduled.scheduled) {
            // scheduled_call_at is the column that actually exists on
            // phone_screening_participants. This used to write scheduled_at,
            // which the schema rejects — the update failed silently, leaving the
            // QStash message pointing at a row its own guard would refuse.
            const { error: bookErr } = await supabaseAdmin
              .from("phone_screening_participants")
              .update({
                status: "call_scheduled",
                scheduled_call_at: new Date(Date.now() + callDelaySec * 1000).toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", participantId)
            if (bookErr) {
              logger.error("Booked the callback but could not persist scheduled_call_at", {
                participantId,
                candidateId: participant.candidate_id,
                error: bookErr.message,
              })
              results.push({ participantId, success: false, error: `Call booked but not recorded: ${bookErr.message}` })
              continue
            }
          } else {
            logger.error("Failed to auto-schedule call after HR approve", {
              participantId, candidateId: participant.candidate_id, error: scheduled.error
            })
            results.push({ participantId, success: false, error: scheduled.error || "Could not schedule call" })
            continue
          }

          await logCandidateActivity({
            jobId: participant.job_id || "",
            candidateId: participant.candidate_id,
            participantId,
            eventType: "screening_reviewed",
            eventData: {
              decision: "approved",
              note: trimmedNote || null,
              reviewer: reviewerLabel,
              // Kept so an override of the AI is visible later: HR saw the AI
              // recommend rejection and proceeded anyway.
              overrodeAiSuggestion: participant.screening_context?.aiSuggestsRejection === true,
            },
            actor: reviewerLabel,
          })

          logger.info("HR approved candidate after prescreen review", {
            participantId, candidateId: participant.candidate_id, reviewer: reviewerLabel,
          })
          results.push({ participantId, success: true })
          continue
        }

        // ── rejected ──
        // Send FIRST. If the candidate was not actually told, we must not record
        // a completed decision — otherwise the row says "rejected" while the
        // candidate is still waiting, and nobody retries the send.
        const rejectionReason = trimmedNote || "After review, this role may not be the best fit at this time"
        const rejectSent = await whatsapp.sendScreeningFilteredOut({
          phoneNumber: candidate?.phone || "",
          candidateName: candidate?.name || "",
          reason: rejectionReason,
        })

        if (!rejectSent?.success) {
          logger.error("Rejection message failed — not marking the candidate rejected", {
            participantId,
            candidateId: participant.candidate_id,
            error: rejectSent?.error,
          })
          results.push({
            participantId,
            success: false,
            error: `Could not notify the candidate (${rejectSent?.error || "unknown error"}). Nothing was recorded — try again.`,
          })
          continue
        }

        await supabaseAdmin
          .from("phone_screening_participants")
          .update({ ...audit, status: "filtered_out", prescreen_decision: "rejected", rejection_reason: rejectionReason })
          .eq("id", participantId)

        await supabaseAdmin
          .from("candidates")
          .update({
            ai_prescreen_decision: "rejected",
            ai_prescreen_reason: rejectionReason,
            updated_at: now,
          })
          .eq("id", participant.candidate_id)

        await logCandidateActivity({
          jobId: participant.job_id || "",
          candidateId: participant.candidate_id,
          participantId,
          eventType: "screening_reviewed",
          eventData: {
            decision: "rejected",
            reason: rejectionReason,
            reviewer: reviewerLabel,
            // Kept so an override of the AI is visible later.
            overrodeAiSuggestion: participant.screening_context?.aiSuggestsRejection === true,
          },
          actor: reviewerLabel,
        })

        logger.info("HR rejected candidate after prescreen review", {
          participantId, candidateId: participant.candidate_id, note: rejectionReason, reviewer: reviewerLabel,
        })
        results.push({ participantId, success: true })
      } catch (err: any) {
        logger.error("Error processing review action", { participantId, error: err.message })
        results.push({ participantId, success: false, error: err.message })
      }
    }

    const allSuccess = results.every(r => r.success)
    const succeeded = results.filter(r => r.success).length
    return NextResponse.json({
      success: allSuccess,
      results,
      message: allSuccess
        ? `${results.length} candidate(s) reviewed successfully`
        : `${succeeded} reviewed, ${results.length - succeeded} failed`,
    })
  } catch (error: any) {
    logger.error("Error in review endpoint", { error: error?.message })
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
