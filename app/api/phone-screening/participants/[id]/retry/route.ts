import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { placeCallImmediately, MAX_TOTAL_CALL_ATTEMPTS, markRecruiterApproval } from "@/lib/scheduled-call"
import { logCandidateActivity } from "@/lib/activity-logger"
import { recordHrAction } from "@/lib/hr-action-history"
import { isIncompleteScreening } from "@/lib/call-truth"

export const runtime = "nodejs"

// A finished screening is not a failed one. Re-dialling a candidate who already
// completed their screening is a re-screen decision, not a retry, and must go
// through an explicit action so it cannot happen by accident or by a stale UI.
//
// `completed` is added below ONLY when getCallTruth says the SCREENING was
// incomplete. A partial call keeps the provider status "completed" and the row
// status "completed" while the agent closed early — refusing it here was why
// HR saw "Send Call Again" and got "screening already completed" on click.
const RETRYABLE_STATUSES = ["failed", "unreachable", "failed_partial"]

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) {
      return NextResponse.json({ error: "Session expired — please log in again", code: "SESSION_EXPIRED" }, { status: 401 })
    }
    if (!hasPermission(ctx, "applications.manage") && !hasPermission(ctx, "outreach.send")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params

    // A reason is mandatory so the activity log explains why a human spent one of
    // a candidate's attempts (up to ten). Without it the audit trail records only that
    // a retry happened, which is exactly the trail needed to investigate a
    // complaint about being called repeatedly.
    const body = await request.json().catch(() => ({}))
    const reason = String(body?.reason || "").trim()
    if (reason.length < 10) {
      return NextResponse.json(
        { error: "A reason of at least 10 characters is required to retry a call" },
        { status: 400 }
      )
    }

    const { data: participant, error: pError } = await supabaseAdmin
      .from("phone_screening_participants")
      .select(`
        id, candidate_id, job_id, status, call_payload_json, bolna_execution_id,
        bolna_status, call_attempts, retry_count,
        callback_preference, call_cost_cents,
        verdict_json, call_is_partial, call_duration_seconds,
        hangup_by, call_hangup_reason, call_disconnect_reason,
        candidates: candidate_id (id, name, phone),
        jobs: job_id (id, title, client_name)
      `)
      .eq("id", id)
      .single()

    if (pError || !participant) {
      return NextResponse.json({ error: "Participant not found", reason: "not_found" }, { status: 404 })
    }

    // Handle the joined relations which come as arrays
    const candidate = Array.isArray(participant.candidates) ? participant.candidates[0] : participant.candidates
    const job = Array.isArray(participant.jobs) ? participant.jobs[0] : participant.jobs

    const status = participant.status || ""
    const screeningIncomplete = isIncompleteScreening(participant)

    // Distinct refusal for a finished SCREENING — not for a finished provider
    // call. A partial row carries status="completed" and bolna_status="completed"
    // even though the agent closed before the plan was covered; those are exactly
    // the calls HR must be able to re-dial to get proper communication.
    if (
      !screeningIncomplete &&
      (status === "completed" || participant.bolna_status === "completed")
    ) {
      return NextResponse.json(
        {
          error:
            "This screening already completed. Re-calling a completed candidate is a re-screen, not a retry.",
          reason: "already_completed",
        },
        { status: 400 }
      )
    }

    if (status === "calling" || status === "call_scheduled") {
      return NextResponse.json(
        { error: `Cannot retry a participant in status: ${status}`, reason: "already_calling" },
        { status: 409 }
      )
    }

    const attemptsSoFar = Number(participant.call_attempts || 0)

    // Exhausting the budget parks the row in needs_manual_followup. Report that
    // as the attempt cap — the accurate, actionable answer — instead of letting it
    // fall through to the generic "cannot retry status" refusal below.
    if (status === "needs_manual_followup" && attemptsSoFar >= MAX_TOTAL_CALL_ATTEMPTS) {
      return NextResponse.json(
        {
          error: `Attempt limit reached (${attemptsSoFar} of ${MAX_TOTAL_CALL_ATTEMPTS}). This candidate is flagged for manual followup.`,
          reason: "attempt_cap",
          attempts: attemptsSoFar,
          maxAttempts: MAX_TOTAL_CALL_ATTEMPTS,
        },
        { status: 409 }
      )
    }

    // needs_manual_followup is retryable only while budget remains: it is how the
    // cap and the manual-followup button both park a row, and a recruiter clearing
    // the hold should be able to spend a remaining attempt.
    // A provider-completed but screening-incomplete row is the retry case HR is
    // actually looking at when the card shows "1st screening incomplete".
    const retryableStatuses =
      attemptsSoFar < MAX_TOTAL_CALL_ATTEMPTS
        ? [
            ...RETRYABLE_STATUSES,
            "needs_manual_followup",
            ...(screeningIncomplete && status === "completed" ? ["completed"] : []),
          ]
        : RETRYABLE_STATUSES

    if (!retryableStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Cannot retry participant in status: ${status}`, reason: "not_retryable" },
        { status: 400 }
      )
    }

    if (!candidate?.phone) {
      return NextResponse.json({ error: "Candidate has no phone number", reason: "no_phone" }, { status: 400 })
    }

    // No local attempt-cap pre-check below. placeCallImmediately evaluates, in
    // order: a call already with the provider, then a call already booked, then
    // the attempt budget. Checking the cap here would tell HR "attempt limit
    // reached" for a candidate whose next call is still ringing, when the
    // accurate answer is "wait for the call in progress". The shared path also
    // owns flagging the row for manual followup when the budget really is
    // exhausted, so nothing is lost by not duplicating that check.

    // Route through the shared placement path instead of calling the provider
    // directly. This buys three things at once: the accidental double-dial guard
    // (two rapid clicks no longer produce two executions), the shared
    // call_attempts budget, and the info_data merge below.
    //
    // The previous direct placeBolnaCall also sent the RAW call_payload_json,
    // which is empty for most candidates, so every retried call screened against
    // a blank CTC and notice period.
    // HR pressed Retry: a manual push, not a sweep. It can happen at any hour
    // while the attempt cap and live-call guard remain in force.
    const actor = ctx.authUser?.email || ctx.authUser?.id || null
    const result = await placeCallImmediately(participant.id, { bypassCallingHours: true })

    if (!result.success) {
      const error = result.error || "Failed to place retry call"
      const action = await recordHrAction(participant.id, {
        action: "retry_call",
        status: "failed",
        actor,
        detail: error,
      })
      if (result.reason === "attempt_cap") {
        return NextResponse.json(
          {
            error,
            reason: "attempt_cap",
            maxAttempts: MAX_TOTAL_CALL_ATTEMPTS,
            action,
          },
          { status: 409 }
        )
      }
      if (result.skipped) {
        return NextResponse.json(
          { error, reason: result.reason || "skipped", action },
          { status: 409 }
        )
      }
      return NextResponse.json(
        { error, reason: result.reason || "provider_rejected", action },
        { status: 502 }
      )
    }

    const now = new Date().toISOString()

    // A human pressed "Retry" and gave a reason: that is the eligibility gate's
    // first door. Recording it keeps any later [Call Now] tap in this thread —
    // including the ones in the missed-call nudge — honourable by the gate.
    await markRecruiterApproval(
      participant.id,
      "recruiter_retry",
      ctx.authUser?.email ?? ctx.authUser?.id ?? null
    )

    // Read back the persisted placement rather than trusting a local value: the
    // execution id is the only verifiable reference for what was actually dialled.
    const { data: fresh } = await supabaseAdmin
      .from("phone_screening_participants")
      .select("bolna_execution_id, bolna_status, call_attempts, last_attempt_at")
      .eq("id", participant.id)
      .maybeSingle()

    // Resolve the review hold the retry was made from, and clear the manual
    // follow-up flag if this was the reason it was raised.
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        review_status: "pending",
        needs_manual_followup: false,
        updated_at: now,
      })
      .eq("id", participant.id)

    // No QStash enqueues here. This used to publish a 4h nudge and a 24h
    // escalation on EVERY retry, with no dedupe, so repeatedly retrying piled up
    // an unbounded number of queued callbacks that each fired their own
    // attempt. Retry state now advances from the provider outcome webhook and the
    // existing outreach-followup path, which are already deduped by status.
    //
    // retry_count is deliberately NOT reset: it is the automatic ladder's own
    // counter and zeroing it on a manual retry let the ladder start over.

    const action = await recordHrAction(participant.id, {
      action: "retry_call",
      status: fresh?.bolna_execution_id ? "started" : "failed",
      actor,
      at: now,
      detail: fresh?.bolna_execution_id
        ? undefined
        : "Provider accepted the request but no execution id was saved",
      executionId: fresh?.bolna_execution_id || null,
    })

    logCandidateActivity({
      jobId: job?.id || "",
      candidateId: participant.candidate_id,
      participantId: participant.id,
      eventType: "call_attempted",
      eventData: {
        bolna_execution_id: fresh?.bolna_execution_id || null,
        manual: true,
        actor: ctx.authUser.id,
        reason,
        attemptNumber: fresh?.call_attempts || attemptsSoFar + 1,
        previousStatus: status,
        previousBolnaStatus: participant.bolna_status || null,
        callbackPreference: participant.callback_preference || null,
        costCents: participant.call_cost_cents ?? null,
      },
      actor: ctx.authUser.id,
      actorAuthUserId: ctx.authUser.id,
    })

    return NextResponse.json({
      success: true,
      executionId: fresh?.bolna_execution_id || null,
      bolnaStatus: fresh?.bolna_status || "queued",
      callAttempts: fresh?.call_attempts || attemptsSoFar + 1,
      maxAttempts: MAX_TOTAL_CALL_ATTEMPTS,
      lastAttemptAt: fresh?.last_attempt_at || now,
      action,
    })
  } catch (error: any) {
    logger.error("Retry call failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error", details: error.message }, { status: 500 })
  }
}
