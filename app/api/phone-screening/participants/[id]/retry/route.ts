import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { logger } from "@/lib/logger"
import { placeCallImmediately, MAX_TOTAL_CALL_ATTEMPTS } from "@/lib/scheduled-call"
import { logCandidateActivity } from "@/lib/activity-logger"

export const runtime = "nodejs"

// A finished screening is not a failed one. Re-dialling a candidate who already
// completed their screening is a re-screen decision, not a retry, and must go
// through an explicit action so it cannot happen by accident or by a stale UI.
const RETRYABLE_STATUSES = ["failed", "unreachable", "failed_partial"]

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params

    // A reason is mandatory so the activity log explains why a human spent one of
    // a candidate's three attempts. Without it the audit trail records only that
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

    // Distinct refusal for a finished screening. This used to be silently
    // accepted because "completed" sat in the retryable list, which let anyone
    // re-call a candidate who had already given their answers.
    if (status === "completed" || participant.bolna_status === "completed") {
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
    const retryableStatuses =
      attemptsSoFar < MAX_TOTAL_CALL_ATTEMPTS
        ? [...RETRYABLE_STATUSES, "needs_manual_followup"]
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
    // reached" for a candidate whose third call is still ringing, when the
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
    const result = await placeCallImmediately(participant.id)

    if (!result.success) {
      if (result.reason === "attempt_cap") {
        return NextResponse.json(
          {
            error: result.error || "Attempt limit reached",
            reason: "attempt_cap",
            maxAttempts: MAX_TOTAL_CALL_ATTEMPTS,
          },
          { status: 409 }
        )
      }
      if (result.skipped) {
        return NextResponse.json(
          { error: result.error || "Call not placed", reason: result.reason || "skipped" },
          { status: 409 }
        )
      }
      return NextResponse.json(
        { error: result.error || "Failed to place retry call", reason: result.reason || "provider_rejected" },
        { status: 502 }
      )
    }

    const now = new Date().toISOString()

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
    })

    return NextResponse.json({
      success: true,
      executionId: fresh?.bolna_execution_id || null,
      bolnaStatus: fresh?.bolna_status || "queued",
      callAttempts: fresh?.call_attempts || attemptsSoFar + 1,
      maxAttempts: MAX_TOTAL_CALL_ATTEMPTS,
      lastAttemptAt: fresh?.last_attempt_at || now,
    })
  } catch (error: any) {
    logger.error("Retry call failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error", details: error.message }, { status: 500 })
  }
}
