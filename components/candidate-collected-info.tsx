"use client"

import { Badge } from "@/components/ui/badge"
import {
  Briefcase, Clock, FileText, IndianRupee, MapPin, MessageSquare, Move, Target,
  UserCheck, AlertTriangle, HelpCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  buildInfoFieldList,
  summariseCoverage,
  describeCoverage,
  formatRelocation,
  isMeaningfulValue,
  SOURCE_LABEL,
  SOURCE_SHORT,
  WHATSAPP_INFO_KEYS,
  RESUME_INFO_KEYS,
  type InfoFieldDisplay,
  type InfoSource,
} from "@/lib/info-provenance"

export interface CollectedInfoField {
  key: string
  label: string
  icon: React.ElementType
}

/** The five fields we ask the candidate to confirm on WhatsApp. */
export const WHATSAPP_INFO_FIELDS: CollectedInfoField[] = [
  { key: "current_ctc", label: "Current CTC", icon: IndianRupee },
  { key: "expected_ctc", label: "Expected CTC", icon: IndianRupee },
  { key: "notice_period", label: "Notice Period", icon: Clock },
  { key: "willing_to_relocate", label: "Willing to Relocate", icon: Move },
  { key: "reason_for_switching", label: "Reason for Switching", icon: MessageSquare },
]

/** From the resume. We never ask for these, so we never call them "collected". */
export const RESUME_INFO_FIELDS: CollectedInfoField[] = [
  { key: "total_experience", label: "Total Experience", icon: Briefcase },
  { key: "location", label: "Current Location", icon: MapPin },
]

/** Kept for callers that need the full union of every displayed field. */
export const COLLECTED_INFO_FIELDS: CollectedInfoField[] = [
  ...WHATSAPP_INFO_FIELDS,
  ...RESUME_INFO_FIELDS,
]

const FIELD_META: Record<string, CollectedInfoField> = Object.fromEntries(
  COLLECTED_INFO_FIELDS.map((f) => [f.key, f])
)

/** Per-source chip styling. Each row states where ITS OWN value came from. */
const SOURCE_CHIP: Record<InfoSource, { className: string; Icon: React.ElementType }> = {
  application: {
    className: "bg-blue-50 text-blue-700 border-blue-200",
    Icon: FileText,
  },
  whatsapp: {
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
    Icon: MessageSquare,
  },
  resume: {
    className: "bg-slate-100 text-slate-600 border-slate-200",
    Icon: FileText,
  },
}

function SourceChip({ source, short }: { source: InfoSource; short?: boolean }) {
  const cfg = SOURCE_CHIP[source]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap",
        cfg.className
      )}
    >
      <cfg.Icon className="h-2.5 w-2.5" />
      {short ? SOURCE_SHORT[source] : SOURCE_LABEL[source]}
    </span>
  )
}

/** Render a raw stored value without inventing a number we could not parse. */
function renderValue(field: InfoFieldDisplay): string {
  if (!field.filled) return "Not provided"
  if (field.key === "willing_to_relocate") return formatRelocation(field.value)
  if (typeof field.value === "boolean") return field.value ? "Yes" : "No"
  const s = String(field.value).trim()
  // The raw text is shown verbatim. Normalised LPA is available via
  // formatLpaForDisplay() where a comparison needs it — but a card should show
  // what the candidate actually typed, not our reinterpretation of it.
  return s
}

function FieldRow({ field, compact }: { field: InfoFieldDisplay; compact?: boolean }) {
  const meta = FIELD_META[field.key]
  const Icon = meta?.icon || HelpCircle
  const filled = field.filled

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-2 rounded-lg border px-2.5 py-2 min-w-0",
        filled ? "border-zinc-200 bg-white" : "border-dashed border-zinc-200 bg-zinc-50/50"
      )}
    >
      <div className="flex items-start gap-2 min-w-0">
        <div
          className={cn(
            "h-6 w-6 rounded flex items-center justify-center shrink-0 mt-0.5",
            filled ? "bg-zinc-100 text-zinc-600" : "bg-white text-zinc-300"
          )}
        >
          <Icon className="h-3 w-3" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-400">
            {meta?.label || field.key}
          </p>
          <p
            className={cn(
              "text-sm leading-snug break-words",
              filled ? "text-zinc-900 font-semibold" : "text-zinc-400 font-medium"
            )}
          >
            {renderValue(field)}
          </p>
          {field.needsAttention && (
            <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              Couldn&apos;t read this value — treat with caution
            </p>
          )}
        </div>
      </div>

      {/* A missing field has no source, so we do not label one. */}
      {filled && (
        <div className="shrink-0 pt-0.5">
          <SourceChip source={field.source} short={compact} />
        </div>
      )}
    </div>
  )
}

/**
 * The candidate's screening information, with every value labelled by where it
 * actually came from.
 *
 * ── Why this no longer says "Confirmed by the candidate on WhatsApp" ───────
 * Portal applicants answer these same questions in the talent-portal apply
 * form. That data is seeded into info_data when the campaign is created, and the
 * old view rendered every non-empty key under a WhatsApp heading with a green
 * "Collected" badge and a "3/5 fields" counter. So a candidate who applied
 * without us ever messaging them was shown to the hiring team as having
 * confirmed their details over WhatsApp.
 *
 * For a screening call that distinction is the entire point — an answer the
 * candidate gave themselves carries different weight from one they typed into
 * your form — so it is tracked per field (lib/info-provenance) and rendered
 * per row instead of being asserted for the whole panel.
 *
 * The "3/5 collected" counter is gone on purpose: a denominator implies a goal,
 * and portal applicants legitimately have zero WhatsApp fields because we skip
 * the form for them.
 */
export function CollectedInfoView({
  infoData,
  infoSources,
  fallback,
  className,
  compact,
  /** Keys whose raw value could not be parsed, flagged inline. */
  unparsedKeys,
}: {
  infoData: Record<string, unknown> | null | undefined
  /** Per-field provenance written by lib/units-aware seeding and the webhook. */
  infoSources?: Record<string, unknown> | null
  /**
   * Candidate-row values. Used for RESUME fields only. WhatsApp fields are read
   * exclusively from `infoData`, so an apply-form value can never be displayed
   * as if the candidate had confirmed it on WhatsApp.
   */
  fallback?: Record<string, unknown> | null | undefined
  className?: string
  compact?: boolean
  unparsedKeys?: readonly string[]
}) {
  const fields = buildInfoFieldList({ infoData, infoSources, fallback, unparsedKeys })
  const whatsappFields = fields.filter((f) => (WHATSAPP_INFO_KEYS as readonly string[]).includes(f.key))
  const resumeFields = fields.filter((f) => (RESUME_INFO_KEYS as readonly string[]).includes(f.key))
  const coverage = summariseCoverage(fields)

  const whatsappConfirmed = whatsappFields.filter((f) => f.filled && f.source === "whatsapp")
  const headerNote =
    whatsappConfirmed.length > 0
      ? `${whatsappConfirmed.length} field${whatsappConfirmed.length === 1 ? "" : "s"} confirmed on WhatsApp`
      : "Not yet confirmed on WhatsApp"

  return (
    <div className={cn("rounded-xl border border-zinc-200 bg-white", className)}>
      <div className="flex items-start justify-between gap-3 px-3 py-2 border-b border-zinc-100 bg-zinc-50/60 rounded-t-xl">
        <div className="flex items-center gap-1.5 min-w-0">
          <Target className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
          <span className="text-xs font-bold text-zinc-700">Screening details</span>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] font-semibold text-zinc-500">{headerNote}</span>
          <span className="text-[10px] text-zinc-400">{describeCoverage(coverage)}</span>
        </div>
      </div>

      <div className={cn("grid gap-2 p-3", compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2")}>
        {whatsappFields.map((field) => (
          <FieldRow key={field.key} field={field} compact={compact} />
        ))}
      </div>

      {resumeFields.some((f) => f.filled) && (
        <div className="border-t border-zinc-100 bg-slate-50/50 px-3 py-2.5 rounded-b-xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-slate-500" />
              <span className="text-[11px] font-bold text-zinc-600">From the resume</span>
            </div>
            <span className="text-[10px] text-zinc-400">We never ask for these</span>
          </div>
          <div className={cn("grid gap-2", compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2")}>
            {resumeFields.map((field) => (
              <FieldRow key={field.key} field={field} compact={compact} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The AI's pre-screen opinion.
 *
 * Note the wording: "AI suggests". This is a recommendation, not a decision.
 * Nothing is communicated to the candidate off the back of it — a recruiter has
 * to act first (see the filtered_out branch in the Meta webhook). We show the
 * reasons because the recommendations are only as trustworthy as the data behind
 * them, and the data is parsed from free text.
 */
export function PreScreenVerdict({
  result,
  className,
}: {
  result?:
    | {
        decision?: string
        reasons?: string[]
        summary?: string
        evaluatedAt?: string
        skippedChecks?: string[]
      }
    | null
  className?: string
}) {
  if (!result || !result.decision) return null

  const config: Record<string, { label: string; color: string; icon: React.ElementType }> = {
    proceed: { label: "Good Fit", color: "bg-green-100 text-green-700 border-green-200", icon: Target },
    needs_review: { label: "Needs Review", color: "bg-amber-100 text-amber-700 border-amber-200", icon: UserCheck },
    filtered_out: { label: "AI Suggests Not Suitable", color: "bg-red-100 text-red-700 border-red-200", icon: UserCheck },
  }
  const c = config[result.decision] || {
    label: result.decision,
    color: "bg-zinc-100 text-zinc-600 border-zinc-200",
    icon: UserCheck,
  }
  const reasons = result.reasons || []
  const skipped = result.skippedChecks || []

  return (
    <div
      className={cn(
        "rounded-xl border p-3 space-y-2",
        {
          "border-green-200 bg-green-50/50": result.decision === "proceed",
          "border-amber-200 bg-amber-50/50": result.decision === "needs_review",
          "border-red-200 bg-red-50/50": result.decision === "filtered_out",
          "border-zinc-200 bg-zinc-50": !config[result.decision],
        },
        className
      )}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className={`gap-1.5 px-2.5 py-1 text-xs font-bold ${c.color}`}>
          <c.icon className="h-3.5 w-3.5" />
          {result.decision === "filtered_out" ? "AI Suggests Not Suitable" : `AI Pre-screen: ${c.label}`}
        </Badge>
        {result.evaluatedAt && (
          <span className="text-[10px] text-zinc-400">
            {new Date(result.evaluatedAt).toLocaleString("en-IN", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>

      {result.decision === "filtered_out" && (
        <p className="rounded border border-red-200 bg-white/70 px-2 py-1.5 text-[11px] font-medium text-red-800">
          This is the AI&apos;s opinion only — the candidate has not been told anything.
          Confirm below before rejecting.
        </p>
      )}

      {result.summary && <p className="text-xs text-zinc-700 leading-relaxed">{result.summary}</p>}

      {reasons.length > 0 && (
        <ul className="space-y-1">
          {reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-600">
              <span className="mt-1.5 h-1 w-1 rounded-full bg-current shrink-0" />
              {r}
            </li>
          ))}
        </ul>
      )}

      {skipped.length > 0 && (
        <p className="flex items-start gap-1.5 rounded border border-amber-200 bg-amber-50/60 px-2 py-1.5 text-[11px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Could not check: {skipped.join(", ")} — the value was missing or unreadable, so the
            candidate was not judged on it.
          </span>
        </p>
      )}
    </div>
  )
}

/** Re-exported so callers can render a source chip without duplicating styling. */
export { SourceChip, isMeaningfulValue }
