"use client"

/**
 * The pipeline stage model — ONE definition, shared by the kanban, the
 * list view and the stage menus.
 *
 * Before this there were four different stage lists in the codebase:
 *
 *   STATUS_COLUMNS (job-candidates-tab)  7 stages, no hr_review, no client_review
 *   STAGE_ORDER     (dispatch/engine)    7 stages, no hr_review, no rejected
 *   STAGE_LABELS    (dispatch/engine)    9 stages including hr_review + rejected
 *   the card <Select>                     7 stages
 *   the bulk <Select>                     4 stages
 *
 * A candidate in `hr_review` or `client_review` had NO column to sit in —
 * they were invisible on the pipeline even though the data existed and the
 * Today board counted them. That is the bug this file fixes.
 */

export type PipelineStageId =
  | "applied"
  | "ai_screen"
  | "hr_review"
  | "shortlist"
  | "client_review"
  | "interview"
  | "offer"
  | "hired"

export interface PipelineColumn {
  id: PipelineStageId
  label: string
  /** Short label for the column header when space is tight. */
  short: string
  /** Tailwind bg class for the column accent. */
  accent: string
  /** Tailwind classes for the accent dot / count pill. */
  dot: string
  /** What the recruiter is doing in this column, in plain words. */
  hint: string
  /** Terminal columns are collapsed by default — they are history, not work. */
  terminal?: boolean
}

/**
 * The columns, in pipeline order.
 *
 * `hired` is the only terminal column shown as a column; `rejected` is
 * deliberately NOT a column — it is a destination you can drag TO (with a
 * reason), not a place to work. Putting Rejected next to Hired as a peer
 * column made the board look like a filing cabinet.
 */
export const PIPELINE_COLUMNS: PipelineColumn[] = [
  {
    id: "applied",
    label: "Applied",
    short: "Applied",
    accent: "bg-blue-500",
    dot: "bg-blue-500",
    hint: "New applications. Start the AI screen or move them on.",
  },
  {
    id: "ai_screen",
    label: "AI Screen",
    short: "AI Screen",
    accent: "bg-indigo-500",
    dot: "bg-indigo-500",
    hint: "Screening calls. Watch for calls that need another attempt.",
  },
  {
    id: "hr_review",
    label: "HR Review",
    short: "HR Review",
    accent: "bg-violet-500",
    dot: "bg-violet-500",
    hint: "A human has taken over. Decide: shortlist or not.",
  },
  {
    id: "shortlist",
    label: "Shortlist",
    short: "Shortlist",
    accent: "bg-purple-500",
    dot: "bg-purple-500",
    hint: "Ready to send to the client.",
  },
  {
    id: "client_review",
    label: "Client Review",
    short: "Client",
    accent: "bg-cyan-500",
    dot: "bg-cyan-500",
    hint: "Sent to the client. Waiting on their decision.",
  },
  {
    id: "interview",
    label: "Interview",
    short: "Interview",
    accent: "bg-teal-500",
    dot: "bg-teal-500",
    hint: "Interviewing. Track rounds and outcomes.",
  },
  {
    id: "offer",
    label: "Offer",
    short: "Offer",
    accent: "bg-green-500",
    dot: "bg-green-500",
    hint: "Offer out. Confirm or close.",
  },
  {
    id: "hired",
    label: "Hired",
    short: "Hired",
    accent: "bg-emerald-600",
    dot: "bg-emerald-600",
    hint: "Won.",
    terminal: true,
  },
]

export const COLUMN_BY_ID: Record<string, PipelineColumn> = Object.fromEntries(
  PIPELINE_COLUMNS.map((c) => [c.id, c]),
)

/** Stages that are shown as columns when the recruiter expands "history". */
export const TERMINAL_STAGE_IDS = ["rejected"]

/**
 * Legacy stage names, mapped onto the current model.
 *
 * The pipeline used to have different names for the same step. A migration
 * renamed them (`phone_call` -> `ai_screen`, `screening`/`human_review` ->
 * `hr_review`) but the old values are still sitting in the applications
 * table — 13 rows are still on `screening` today. Left unmapped they fell
 * through to the default column, which put a candidate who had already
 * been screened back in with the new applications.
 */
export const LEGACY_STAGE_ALIASES: Record<string, PipelineStageId> = {
  phone_call: "ai_screen",
  screening: "hr_review",
  human_review: "hr_review",
  hold: "hr_review",
  in_pipeline: "applied",
  pipeline: "applied",
  new: "applied",
}

/**
 * The stage a raw application status maps onto.
 *
 * Returns null for `rejected` — a rejected candidate is not "somewhere in
 * the pipeline", they are out of it. The board keeps them in a collapsed
 * history section instead of dumping 1,111 of them into Applied.
 */
export function resolveStage(rawStatus: string): PipelineStageId | null {
  const s = String(rawStatus || "").trim()
  if (!s) return "applied"
  if (s === "rejected") return null
  if (PIPELINE_COLUMNS.some((c) => c.id === s)) return s as PipelineStageId
  const alias = LEGACY_STAGE_ALIASES[s]
  if (alias) return alias
  return "applied"
}

export function stageLabelSafe(status: string): string {
  const col = COLUMN_BY_ID[status]
  if (col) return col.label
  if (status === "rejected") return "Rejected"
  return (status || "").replace(/_/g, " ") || "Unknown"
}

/**
 * Where a candidate goes when moved forward one step.
 *
 * `hr_review` sits between AI Screen and Shortlist, so moving forward from
 * it lands on Shortlist — a human who has taken over a screening row is
 * deciding "shortlist or not".
 */
export function nextStage(stage: string): PipelineStageId | null {
  const idx = PIPELINE_COLUMNS.findIndex((c) => c.id === stage)
  if (idx === -1) return null
  if (idx === PIPELINE_COLUMNS.length - 1) return null
  return PIPELINE_COLUMNS[idx + 1].id
}

/**
 * Stages that need a confirmation before the move is applied.
 *
 * Moving to `rejected` needs a reason. Moving to `shortlist` warns that
 * the candidate goes in front of the client. Everything else (applied ->
 * ai_screen) is reversible and silent.
 */
export function stageNeedsConfirmation(to: string): boolean {
  return ["interview", "offer", "hired", "rejected", "shortlist", "client_review"].includes(to)
}
