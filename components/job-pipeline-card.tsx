"use client"

import { memo } from "react"
import { useDraggable } from "@dnd-kit/core"
import { Check, Clock, PhoneCall, PhoneOff, Sparkles, UserCheck, AlertCircle, Loader2 } from "lucide-react"
import { getCallTruth, type CallTruth } from "@/lib/call-truth"

/**
 * The compact pipeline card.
 *
 * THE DATAPOINT RULE
 *
 * A recruiter scanning a column needs to answer three questions fast:
 *
 *   1. Who is this?          → name + current role
 *   2. How good a match?     → fit score (0-100, JD match)
 *   3. What needs my attention? → ONE status pill saying the most
 *      urgent thing about this candidate right now
 *
 * Everything else — transcript, WhatsApp thread, collected info, salary,
 * notes, timeline, the 9-button action strip — lives in the detail modal.
 * The old card rendered 12-20 lines including the fit score TWICE and the
 * call state THREE times, which meant nothing stood out.
 *
 * The card is memoised because a kanban renders every card of every column
 * on each drag frame.
 */

export interface PipelineCardData {
  applicationId: string
  candidateId: string
  name: string
  role: string
  company: string
  location: string
  experience: string
  fitScore: number | null
  /** The single most important thing about this candidate right now. */
  status: PipelineCardStatus
  /** "3d" — how long they have been waiting in this stage. */
  ageLabel: string
  selected: boolean
  isNew: boolean
  /** Client's verdict on a shared shortlist. */
  clientDecision: string | null
  /** Which pipeline column this card belongs in. */
  stage: string
}

export type PipelineCardStatus = {
  id: string
  label: string
  tone: "neutral" | "info" | "good" | "warn" | "bad"
  /** Optional icon key so the card does not import 8 lucide icons. */
  icon?: "call" | "nocall" | "spark" | "check" | "clock" | "alert" | "loader"
}

const TONE: Record<PipelineCardStatus["tone"], string> = {
  neutral: "bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700",
  info: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
  good: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  warn: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  bad: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900",
}

function StatusIcon({ icon }: { icon?: PipelineCardStatus["icon"] }) {
  const cls = "h-3 w-3"
  switch (icon) {
    case "call": return <PhoneCall className={cls} />
    case "nocall": return <PhoneOff className={cls} />
    case "spark": return <Sparkles className={cls} />
    case "check": return <UserCheck className={cls} />
    case "clock": return <Clock className={cls} />
    case "alert": return <AlertCircle className={cls} />
    case "loader": return <Loader2 className={cls} />
    default: return null
  }
}

function fitTone(score: number): string {
  if (score >= 70) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  if (score >= 40) return "bg-amber-500/10 text-amber-700 dark:text-amber-300"
  return "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300"
}

export const PipelineCard = memo(function PipelineCard({
  data,
  onOpen,
  onToggleSelect,
  dragging,
}: {
  data: PipelineCardData
  onOpen: (applicationId: string) => void
  onToggleSelect?: (applicationId: string) => void
  dragging?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: data.applicationId,
    data: { applicationId: data.applicationId, candidateId: data.candidateId },
    disabled: dragging,
  })

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined

  const initials = (data.name || "?").trim().slice(0, 2).toUpperCase()

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-xl border bg-white p-2.5 text-left shadow-sm transition-shadow dark:bg-zinc-900 ${
        isDragging
          ? "z-50 opacity-90 shadow-xl ring-2 ring-blue-400"
          : "border-zinc-200 hover:border-zinc-300 hover:shadow dark:border-zinc-800 dark:hover:border-zinc-700"
      }`}
    >
      {/* Drag handle + select share the top-left corner so the card stays clean. */}
      <div className="flex items-start gap-2">
        {onToggleSelect && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleSelect(data.applicationId)
            }}
            aria-label={data.selected ? `Deselect ${data.name}` : `Select ${data.name}`}
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
              data.selected
                ? "border-blue-500 bg-blue-500 text-white"
                : "border-zinc-300 bg-white opacity-0 group-hover:opacity-100 focus:opacity-100 dark:border-zinc-600 dark:bg-zinc-800"
            }`}
          >
            {data.selected && <Check className="h-3 w-3" strokeWidth={3} />}
          </button>
        )}

        <button
          type="button"
          onClick={() => onOpen(data.applicationId)}
          className="min-w-0 flex-1 text-left"
        >
          {/* Row 1: name + fit score */}
          <div className="flex items-center gap-1.5">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[10px] font-bold text-white dark:bg-zinc-700"
              aria-hidden
            >
              {initials}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
              {data.name}
            </span>
            {data.isNew && (
              <span className="shrink-0 rounded bg-amber-100 px-1 py-px text-[9px] font-bold uppercase text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                New
              </span>
            )}
            {data.fitScore != null && (
              <span
                className={`shrink-0 rounded px-1.5 py-px text-[10px] font-bold tabular-nums ${fitTone(data.fitScore)}`}
                title={`Fit score ${data.fitScore}/100 — how well this resume matches the job description`}
              >
                {data.fitScore}
              </span>
            )}
          </div>

          {/* Row 2: role — the one line that says what they do */}
          <p className="mt-1 truncate pl-[30px] text-[11px] text-zinc-500 dark:text-zinc-400">
            {data.role || "—"}
            {data.company ? ` · ${data.company}` : ""}
          </p>

          {/* Row 3: the ONE status pill */}
          <div className="mt-1.5 flex items-center gap-1.5 pl-[30px]">
            <span
              className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${TONE[data.status.tone]}`}
              title={data.status.label}
            >
              <StatusIcon icon={data.status.icon} />
              <span className="truncate">{data.status.label}</span>
            </span>
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-400" title="Time in this stage">
              {data.ageLabel}
            </span>
          </div>
        </button>
      </div>

      {/* Drag handle — a small grip in the corner, so the card body stays clickable. */}
      <button
        type="button"
        {...listeners}
        {...attributes}
        aria-label={`Drag ${data.name} to another stage`}
        className="absolute right-1 top-1 cursor-grab rounded p-0.5 text-zinc-300 opacity-0 transition-opacity hover:text-zinc-500 focus:opacity-100 group-hover:opacity-100 active:cursor-grabbing dark:text-zinc-700 dark:hover:text-zinc-500"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="fill-current">
          <circle cx="3" cy="2" r="1.2" /><circle cx="7" cy="2" r="1.2" />
          <circle cx="3" cy="5" r="1.2" /><circle cx="7" cy="5" r="1.2" />
          <circle cx="3" cy="8" r="1.2" /><circle cx="7" cy="8" r="1.2" />
        </svg>
      </button>
    </div>
  )
})

/**
 * Derive the single most important status for a candidate.
 *
 * Priority, highest first:
 *   1. The client rejected — nothing you do can fix it, but you must see it.
 *   2. The call failed on our side — a retry is needed.
 *   3. The screening needs a human decision.
 *   4. The candidate replied and is waiting on us.
 *   5. The call is booked / in progress.
 *   6. The screening scored and recommended.
 *   7. Nothing has happened yet.
 */
export function deriveCardStatus(args: {
  clientDecision: string | null
  callTruth: CallTruth | null
  aiRecommendation?: string | null
  aiScore?: number | null
  hasParticipant: boolean
}): PipelineCardStatus {
  const { clientDecision, callTruth, aiRecommendation, aiScore, hasParticipant } = args

  if (clientDecision === "rejected") {
    return { id: "client_rejected", label: "Client said no", tone: "bad", icon: "alert" }
  }
  if (clientDecision === "approved") {
    return { id: "client_approved", label: "Client approved", tone: "good", icon: "check" }
  }
  if (clientDecision === "pending") {
    return { id: "client_pending", label: "Client deciding", tone: "info", icon: "clock" }
  }

  if (callTruth) {
    switch (callTruth.state) {
      case "our_side_failed":
        return { id: "call_failed", label: "Call failed — retry", tone: "bad", icon: "alert" }
      case "partial":
        return { id: "call_partial", label: "Call incomplete", tone: "warn", icon: "alert" }
      case "no_answer":
      case "busy":
      case "voicemail":
        return { id: "no_answer", label: "No answer", tone: "warn", icon: "nocall" }
      case "not_placed":
        return { id: "not_placed", label: "No call yet", tone: "neutral", icon: "nocall" }
      case "scheduled":
        return { id: "scheduled", label: "Call booked", tone: "info", icon: "clock" }
      case "awaiting_provider":
      case "ringing":
      case "answered":
        return { id: "on_call", label: "On call", tone: "info", icon: "call" }
      case "retry_pending":
        return { id: "retry", label: "Retry booked", tone: "info", icon: "clock" }
      case "needs_review":
        return { id: "needs_review", label: "Needs decision", tone: "warn", icon: "alert" }
      case "completed":
        if (aiRecommendation === "not_a_fit") {
          return { id: "not_a_fit", label: "AI says no", tone: "warn", icon: "spark" }
        }
        if (aiScore != null) {
          return { id: "screened", label: `Screened ${aiScore}/10`, tone: "good", icon: "check" }
        }
        return { id: "screened", label: "Screened", tone: "good", icon: "check" }
      case "rejected":
        return { id: "call_rejected", label: "Call rejected", tone: "bad", icon: "alert" }
    }
  }

  if (!hasParticipant) {
    return { id: "no_screening", label: "Not screened", tone: "neutral", icon: "nocall" }
  }
  return { id: "unknown", label: "—", tone: "neutral" }
}
