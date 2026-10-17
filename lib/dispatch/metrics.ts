/**
 * Super-admin "who did what" metrics.
 *
 * The source of truth is `candidate_activity` — every human action now carries
 * `actor_auth_user_id` (see `lib/activity-logger.ts`). This module is pure: it
 * turns a flat list of activity rows into per-action counts, so the same logic
 * backs the API and any tests without touching the database.
 */

/** One measurable action a staff member can take. */
export interface ActionMetricDef {
  key: ActionMetricKey
  label: string
  /** Short helper text for the UI column header. */
  hint?: string
}

export type ActionMetricKey =
  | "screenings_reviewed"
  | "shortlisted"
  | "rejected"
  | "hired"
  | "calls_logged"
  | "shortlists_shared"
  | "interviews_scheduled"
  | "outreach_started"
  | "queue_actions"
  | "notes_updated"
  | "client_decisions"

export const ACTION_METRICS: ActionMetricDef[] = [
  { key: "screenings_reviewed", label: "Screenings reviewed", hint: "AI screening results cleared" },
  { key: "shortlisted", label: "Shortlisted", hint: "Moved to the client shortlist" },
  { key: "shortlists_shared", label: "Shares sent", hint: "Shortlists shared with a client" },
  { key: "interviews_scheduled", label: "Interviews", hint: "Interview scheduled / updated" },
  { key: "calls_logged", label: "Calls logged", hint: "Manual calls logged from the queue" },
  { key: "queue_actions", label: "Queue snoozes", hint: "Items snoozed from Today" },
  { key: "outreach_started", label: "Outreach started", hint: "Candidates sent to screening" },
  { key: "hired", label: "Hired", hint: "Moved to hired" },
  { key: "rejected", label: "Rejected", hint: "Moved to rejected" },
  { key: "notes_updated", label: "Notes", hint: "Candidate notes updated" },
  { key: "client_decisions", label: "Client decisions", hint: "Client approve/reject recorded" },
]

/** The subset of a `candidate_activity` row these metrics read. */
export interface ActionActivityRow {
  event_type?: string | null
  event_data?: Record<string, any> | null
  actor_auth_user_id?: string | null
  created_at?: string | null
}

export type ActionCounts = Record<ActionMetricKey, number>

export function emptyActionCounts(): ActionCounts {
  return {
    screenings_reviewed: 0,
    shortlisted: 0,
    rejected: 0,
    hired: 0,
    calls_logged: 0,
    shortlists_shared: 0,
    interviews_scheduled: 0,
    outreach_started: 0,
    queue_actions: 0,
    notes_updated: 0,
    client_decisions: 0,
  }
}

export function totalActions(counts: ActionCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0)
}

/** Classify a single activity row into zero or one metric bucket. */
export function classifyActivity(row: ActionActivityRow): ActionMetricKey | null {
  const type = String(row.event_type || "")
  const to = row.event_data?.to
  switch (type) {
    case "screening_reviewed":
      return "screenings_reviewed"
    case "stage_changed":
      if (to === "shortlist") return "shortlisted"
      if (to === "hired") return "hired"
      if (to === "rejected") return "rejected"
      return null
    case "manual_call_logged":
      return "calls_logged"
    case "shortlist_shared":
      return "shortlists_shared"
    case "interview_scheduled":
    case "interview_status_changed":
      return "interviews_scheduled"
    case "ai_screen_started":
      return "outreach_started"
    case "queue_snoozed":
    case "queue_done":
    case "queue_undone":
      return "queue_actions"
    case "notes_updated":
      return "notes_updated"
    case "client_decision":
      return "client_decisions"
    default:
      return null
  }
}

/** Fold activity rows into per-actor counts, keyed by auth user id. */
export function aggregateActions(rows: ActionActivityRow[]): Map<string, ActionCounts> {
  const byActor = new Map<string, ActionCounts>()
  for (const row of rows) {
    const actor = row.actor_auth_user_id
    if (!actor) continue
    const bucket = classifyActivity(row)
    if (!bucket) continue
    let counts = byActor.get(actor)
    if (!counts) {
      counts = emptyActionCounts()
      byActor.set(actor, counts)
    }
    counts[bucket] += 1
  }
  return byActor
}
