import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"
import { recordHrAction } from "@/lib/hr-action-history"
import { logCandidateActivity } from "@/lib/activity-logger"
import {
  cancelBolnaScheduledCall,
  getMaxCallAttempts,
  isLiveProviderStatus,
  scheduleBolnaCallAt,
} from "@/lib/scheduled-call"

import {
  HR_EXACT_TIME_SOURCE,
  HR_SCHEDULE_REASON_MIN,
  formatIst,
  hrSchedulingEnabled,
  validateHrSlot,
  type SlotErrorCode,
  type SlotValidation,
} from "@/lib/hr-exact-schedule-validation"

export {
  HR_EXACT_TIME_SOURCE,
  HR_SCHEDULE_REASON_MIN,
  hrSchedulingEnabled,
  validateHrSlot,
}
export type { SlotErrorCode, SlotValidation }

const LIVE_ROW_STATUSES = ["calling", "in_progress", "in-progress", "initiated", "queued", "ringing"]

export type BookResult =
  | {
      ok: true
      participantId: string
      scheduledAt: string
      scheduledAtIst: string
      bookingSource: typeof HR_EXACT_TIME_SOURCE
      messageId?: string
      attempts: number
      nextAttempt: number
    }
  | { ok: false; code: SlotErrorCode; error: string }

export type CancelResult =
  | { ok: true; participantId: string; restoredStatus: string }
  | { ok: false; code: SlotErrorCode; error: string }

type ParticipantRow = {
  id: string
  candidate_id: string
  job_id: string | null
  status: string | null
  campaign_id: string | null
  bolna_status: string | null
  bolna_execution_id: string | null
  call_attempts: number | null
  scheduled_call_at: string | null
  next_retry_at: string | null
  booking_source: string | null
  screening_context: Record<string, any> | null
  candidates: { id: string; name: string | null; phone: string | null } | Array<{ id: string; name: string | null; phone: string | null }>
  jobs: { id: string; title: string | null; client_name: string | null } | Array<{ id: string; title: string | null; client_name: string | null }>
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

async function loadParticipant(participantId: string): Promise<ParticipantRow | null> {
  const { data, error } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      id, candidate_id, job_id, status, campaign_id, bolna_status,
      bolna_execution_id, call_attempts, scheduled_call_at, next_retry_at,
      booking_source, screening_context,
      candidates: candidate_id (id, name, phone),
      jobs: job_id (id, title, client_name)
    `)
    .eq("id", participantId)
    .maybeSingle()

  if (error) {
    logger.warn("HR exact slot: could not load participant", { participantId, error: error.message })
  }
  return (data as ParticipantRow | null) ?? null
}

function hasFutureBooking(participant: ParticipantRow, now: Date): boolean {
  return [participant.scheduled_call_at, participant.next_retry_at].some((raw) => {
    if (!raw) return false
    const time = new Date(raw).getTime()
    return Number.isFinite(time) && time > now.getTime()
  })
}

function isLive(participant: ParticipantRow): boolean {
  const status = String(participant.status || "").toLowerCase()
  return (
    LIVE_ROW_STATUSES.includes(status) ||
    isLiveProviderStatus(participant.bolna_status) ||
    (!!participant.bolna_execution_id && !isLiveProviderStatus(participant.bolna_status) && status === "calling")
  )
}

export async function bookHrExactSlot(input: {
  participantId: string
  scheduledAt: unknown
  timezone: unknown
  note?: string | null
  reason: string
  actor: string | null
  actorId: string | null
  now?: Date
}): Promise<BookResult> {
  if (!hrSchedulingEnabled()) {
    return { ok: false, code: "feature_disabled", error: "HR exact-time scheduling is not enabled." }
  }

  const reason = String(input.reason || "").trim()
  if (reason.length < HR_SCHEDULE_REASON_MIN) {
    return {
      ok: false,
      code: "reason_required",
      error: `Give a reason of at least ${HR_SCHEDULE_REASON_MIN} characters so the audit trail explains the booking.`,
    }
  }

  const now = input.now ?? new Date()
  const checked = validateHrSlot(input.scheduledAt, input.timezone, now)
  if (!checked.ok) return checked

  const participant = await loadParticipant(input.participantId)
  if (!participant) {
    return { ok: false, code: "not_found", error: "Participant not found." }
  }
  const candidate = relation(participant.candidates)
  const job = relation(participant.jobs)
  if (!candidate?.phone) {
    return { ok: false, code: "no_phone", error: "Candidate has no phone number on file." }
  }
  if (isLive(participant)) {
    return {
      ok: false,
      code: "already_calling",
      error: "A call is already with the provider. Wait for its outcome before booking another slot.",
    }
  }
  if (hasFutureBooking(participant, now)) {
    return {
      ok: false,
      code: "already_scheduled",
      error: "This candidate already has a future booking. Cancel it before booking a new slot.",
    }
  }

  const maxAttempts = await getMaxCallAttempts(participant.campaign_id)
  const attempts = Number(participant.call_attempts || 0)
  if (attempts >= maxAttempts) {
    return {
      ok: false,
      code: "attempt_cap",
      error: `Attempt limit reached (${attempts} of ${maxAttempts}). This candidate needs manual follow-up.`,
    }
  }

  const timezone = String(input.timezone)
  const dueIso = checked.dueAt.toISOString()
  const scheduledAtIst = formatIst(checked.dueAt)
  const bookedAt = new Date().toISOString()
  const previousStatus = participant.status || "info_received"
  const ctx = (participant.screening_context || {}) as Record<string, any>
  const note = String(input.note || "").trim().slice(0, 500) || null

  const slot = {
    scheduledAt: dueIso,
    timezone,
    note,
    reason: reason.slice(0, 500),
    bookedBy: input.actor,
    bookedById: input.actorId,
    bookedAt,
    source: HR_EXACT_TIME_SOURCE,
    previousStatus,
    messageId: null as string | null,
  }

  const nextCtx = {
    ...ctx,
    approvalGranted: true,
    approvalSource: HR_EXACT_TIME_SOURCE,
    approvedBy: input.actor,
    approvedAt: bookedAt,
    interestNeedsApproval: false,
    awaitingScheduleDecision: false,
    hrScheduledSlot: slot,
  }

  const { error: updateError } = await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      status: "call_scheduled",
      scheduled_call_at: dueIso,
      next_retry_at: null,
      timezone,
      booking_source: HR_EXACT_TIME_SOURCE,
      screening_context: nextCtx,
      needs_manual_followup: false,
      review_status: "pending",
      placement_attempts: 0,
      next_placement_retry_at: null,
      provider_error: null,
      updated_at: bookedAt,
    })
    .eq("id", participant.id)

  if (updateError) {
    logger.error("HR exact slot: booking write failed", {
      participantId: participant.id,
      error: updateError.message,
    })
    return { ok: false, code: "publish_failed", error: `Could not save the slot: ${updateError.message}` }
  }

  // HR spoke to the candidate and has consent for this exact time, so the
  // automatic calling window is deliberately bypassed for this one message.
  const published = await scheduleBolnaCallAt(participant.id, checked.dueAt, {
    bypassCallingHours: true,
  })

  if (!published.scheduled) {
    const failCtx = {
      ...nextCtx,
      hrScheduledSlot: { ...slot, failedAt: new Date().toISOString() },
    }
    await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        status: "failed",
        scheduled_call_at: null,
        next_retry_at: null,
        provider_error: `HR-booked call could not be queued: ${published.error || "QStash publish failed"}`,
        needs_manual_followup: true,
        screening_context: failCtx,
        updated_at: new Date().toISOString(),
      })
      .eq("id", participant.id)

    await recordHrAction(participant.id, {
      action: "schedule",
      status: "failed",
      actor: input.actor,
      detail: `${scheduledAtIst} IST · ${published.error || "queue failed"}`,
    })
    return { ok: false, code: "publish_failed", error: published.error || "Could not queue the call" }
  }

  if (published.messageId) {
    const { error: messageIdError } = await supabaseAdmin
      .from("phone_screening_participants")
      .update({
        screening_context: {
          ...nextCtx,
          hrScheduledSlot: { ...slot, messageId: published.messageId },
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", participant.id)
    if (messageIdError) {
      logger.warn("HR exact slot: could not store QStash message id", {
        participantId: participant.id,
        error: messageIdError.message,
      })
    }
  }

  const detail = `${scheduledAtIst} IST${note ? ` · ${note}` : ""}`
  await recordHrAction(participant.id, {
    action: "schedule",
    status: "deferred",
    actor: input.actor,
    detail,
  })
  await logCandidateActivity({
    jobId: job?.id || "",
    candidateId: participant.candidate_id,
    participantId: participant.id,
    eventType: "hr_schedule_booked",
    eventData: {
      scheduledAt: dueIso,
      scheduledAtIst,
      timezone,
      note,
      reason,
      bookingSource: HR_EXACT_TIME_SOURCE,
      messageId: published.messageId || null,
      attemptNumber: attempts + 1,
    },
    actor: input.actor || "system",
    actorAuthUserId: input.actorId,
  })

  return {
    ok: true,
    participantId: participant.id,
    scheduledAt: dueIso,
    scheduledAtIst,
    bookingSource: HR_EXACT_TIME_SOURCE,
    messageId: published.messageId,
    attempts,
    nextAttempt: attempts + 1,
  }
}

export async function cancelHrExactSlot(input: {
  participantId: string
  actor: string | null
  actorId: string | null
}): Promise<CancelResult> {
  if (!hrSchedulingEnabled()) {
    return { ok: false, code: "feature_disabled", error: "HR exact-time scheduling is not enabled." }
  }

  const participant = await loadParticipant(input.participantId)
  if (!participant) {
    return { ok: false, code: "not_found", error: "Participant not found." }
  }

  const ctx = (participant.screening_context || {}) as Record<string, any>
  const slot = ctx.hrScheduledSlot as { scheduledAt?: string; messageId?: string | null; previousStatus?: string } | undefined
  if (!slot?.scheduledAt || participant.booking_source !== HR_EXACT_TIME_SOURCE) {
    return { ok: false, code: "not_hr_slot", error: "There is no HR-booked exact slot to cancel." }
  }
  if (isLive(participant)) {
    return {
      ok: false,
      code: "already_calling",
      error: "The call is already with the provider and cannot be cancelled here.",
    }
  }
  if (participant.status !== "call_scheduled") {
    return { ok: false, code: "not_scheduled", error: "This slot is no longer active." }
  }
  if (new Date(slot.scheduledAt).getTime() <= Date.now()) {
    return {
      ok: false,
      code: "already_due",
      error: "The slot time has already passed. Check the call outcome before cancelling.",
    }
  }

  const cancelled = await cancelBolnaScheduledCall(slot.messageId)
  const nowIso = new Date().toISOString()
  const restoredStatus = slot.previousStatus || "failed"
  const needsManualFollowup = ["failed", "unreachable", "needs_manual_followup"].includes(restoredStatus)

  const { error } = await supabaseAdmin
    .from("phone_screening_participants")
    .update({
      status: restoredStatus,
      scheduled_call_at: null,
      next_retry_at: null,
      booking_source: null,
      needs_manual_followup: needsManualFollowup,
      screening_context: {
        ...ctx,
        hrScheduledSlot: {
          ...slot,
          messageId: null,
          cancelledAt: nowIso,
          cancelledBy: input.actor,
        },
      },
      updated_at: nowIso,
    })
    .eq("id", participant.id)

  if (error) {
    logger.error("HR exact slot: cancellation write failed", {
      participantId: participant.id,
      error: error.message,
    })
    return { ok: false, code: "not_scheduled", error: `Could not cancel the slot: ${error.message}` }
  }

  const scheduledAtIst = formatIst(new Date(slot.scheduledAt))
  await recordHrAction(participant.id, {
    action: "cancel_schedule",
    status: "cancelled",
    actor: input.actor,
    detail: `${scheduledAtIst} IST${cancelled ? "" : " · queued message could not be cancelled; row guard will refuse it"}`,
  })
  await logCandidateActivity({
    jobId: participant.job_id || "",
    candidateId: participant.candidate_id,
    participantId: participant.id,
    eventType: "hr_schedule_cancelled",
    eventData: {
      scheduledAt: slot.scheduledAt,
      scheduledAtIst,
      restoredStatus,
      bookingSource: HR_EXACT_TIME_SOURCE,
      actor: input.actorId,
    },
    actor: input.actor || "system",
    actorAuthUserId: input.actorId,
  })

  return { ok: true, participantId: participant.id, restoredStatus }
}
