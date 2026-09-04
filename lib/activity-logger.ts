import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

export type EventType =
  | "applied"
  | "ai_screen_started"
  | "whatsapp_sent"
  | "whatsapp_delivered"
  | "whatsapp_read"
  | "whatsapp_replied"
  | "call_attempted"
  | "call_in_progress"
  | "call_completed"
  | "call_failed"
  | "call_missed"
  | "callback_scheduled"
  | "screening_reviewed"
  | "stage_changed"
  | "notes_updated"
  | "interview_scheduled"
  | "interview_status_changed"
  | "shortlist_shared"
  | "client_decision"

interface LogActivityInput {
  jobId: string
  candidateId: string
  applicationId?: string | null
  participantId?: string | null
  eventType: EventType
  eventData?: Record<string, unknown>
  actor?: string
}

/**
 * Log a candidate activity event. Fire-and-forget — errors are logged but never thrown.
 */
export async function logCandidateActivity(input: LogActivityInput): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("candidate_activity").insert({
      job_id: input.jobId,
      candidate_id: input.candidateId,
      application_id: input.applicationId || null,
      participant_id: input.participantId || null,
      event_type: input.eventType,
      event_data: input.eventData || {},
      actor: input.actor || "system",
    })
    if (error) {
      logger.warn("Failed to log candidate activity", {
        eventType: input.eventType,
        candidateId: input.candidateId,
        error: error.message,
      })
    }
  } catch (err: any) {
    logger.warn("Activity logging error", { error: err?.message })
  }
}

/**
 * Batch-log multiple activity events in one insert.
 */
export async function logCandidateActivityBatch(
  inputs: LogActivityInput[]
): Promise<void> {
  if (inputs.length === 0) return
  try {
    const rows = inputs.map((input) => ({
      job_id: input.jobId,
      candidate_id: input.candidateId,
      application_id: input.applicationId || null,
      participant_id: input.participantId || null,
      event_type: input.eventType,
      event_data: input.eventData || {},
      actor: input.actor || "system",
    }))
    const { error } = await supabaseAdmin.from("candidate_activity").insert(rows)
    if (error) {
      logger.warn("Failed to batch log candidate activity", { count: rows.length, error: error.message })
    }
  } catch (err: any) {
    logger.warn("Activity batch logging error", { error: err?.message })
  }
}

/**
 * Resolve application_id from job_id + candidate_id (for logging when we only have participant context).
 */
export async function resolveApplicationId(
  jobId: string,
  candidateId: string
): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("applications")
      .select("id")
      .eq("job_id", jobId)
      .eq("candidate_id", candidateId)
      .maybeSingle()
    return data?.id || null
  } catch {
    return null
  }
}
