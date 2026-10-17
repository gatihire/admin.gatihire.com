import { supabaseAdmin } from "@/lib/supabase"
import { logCandidateActivity } from "@/lib/activity-logger"

export type WorkItemAction = "snooze" | "unsnooze" | "log_call" | "done" | "undone"

export interface ApplyWorkItemActionInput {
  applicationId: string
  action: WorkItemAction
  until?: string
  hours?: number
  reason?: string
  outcome?: string
  note?: string
  actorId: string
  actorEmail?: string | null
}

export function resolveSnoozeUntil(input: { until?: string; hours?: number }): string {
  if (typeof input.until === "string" && Number.isFinite(new Date(input.until).getTime())) {
    return new Date(input.until).toISOString()
  }
  const hours = Number(input.hours)
  if (Number.isFinite(hours) && hours > 0) {
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
  }
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Apply a snooze / unsnooze / manual-call to a single work item and record who
 * did it. One code path so the single-row and bulk routes cannot drift.
 */
export async function applyWorkItemAction(input: ApplyWorkItemActionInput): Promise<{ ok: boolean; error?: string }> {
  const { data: app } = await supabaseAdmin
    .from("applications")
    .select("id, job_id, candidate_id")
    .eq("id", input.applicationId)
    .maybeSingle()
  if (!app) return { ok: false, error: "Application not found" }

  const nowIso = new Date().toISOString()
  const patch: Record<string, any> = {
    application_id: input.applicationId,
    updated_by: input.actorId,
    updated_at: nowIso,
  }

  if (input.action === "snooze") {
    patch.snoozed_until = resolveSnoozeUntil(input)
    patch.snooze_reason = input.reason ? String(input.reason).slice(0, 500) : null
  } else if (input.action === "unsnooze") {
    patch.snoozed_until = null
    patch.snooze_reason = null
  } else if (input.action === "done") {
    // Mark handled: hide until the item changes. Clear any snooze so the two
    // dispositions cannot disagree (a still-snoozed done row would be invisible
    // in both views with no way back).
    patch.done_at = nowIso
    patch.snoozed_until = null
    patch.snooze_reason = null
  } else if (input.action === "undone") {
    patch.done_at = null
  } else {
    patch.last_manual_call_at = nowIso
    patch.last_manual_call_outcome = input.outcome ? String(input.outcome).slice(0, 120) : "logged"
    patch.last_manual_call_note = input.note ? String(input.note).slice(0, 1000) : null
    // The prototype's "I called them" menu combines the outcome with a hide
    // window ("No answer · hide 4h"). When `hours` is supplied the row is parked
    // for that long; otherwise logging a call means "I handled it" — clear it.
    const hideHours = Number(input.hours)
    if (Number.isFinite(hideHours) && hideHours > 0) {
      patch.snoozed_until = new Date(Date.now() + hideHours * 60 * 60 * 1000).toISOString()
      patch.snooze_reason = input.reason
        ? String(input.reason).slice(0, 500)
        : `call: ${patch.last_manual_call_outcome}`
    } else {
      patch.snoozed_until = null
      patch.snooze_reason = null
    }
  }

  const { error } = await supabaseAdmin.from("work_item_states").upsert(patch, { onConflict: "application_id" })
  if (error) return { ok: false, error: error.message }

  const eventType =
    input.action === "snooze"
      ? "queue_snoozed"
      : input.action === "unsnooze"
        ? "queue_unsnoozed"
        : input.action === "done"
          ? "queue_done"
          : input.action === "undone"
            ? "queue_undone"
            : "manual_call_logged"

  await logCandidateActivity({
    jobId: String(app.job_id),
    candidateId: String(app.candidate_id),
    applicationId: String(app.id),
    eventType,
    eventData: {
      action: input.action,
      snoozed_until: patch.snoozed_until ?? null,
      reason: patch.snooze_reason ?? null,
      outcome: patch.last_manual_call_outcome ?? null,
      note: patch.last_manual_call_note ?? null,
      done_at: patch.done_at ?? null,
    },
    actor: input.actorEmail || "internal_user",
    actorAuthUserId: input.actorId,
  })

  return { ok: true }
}
