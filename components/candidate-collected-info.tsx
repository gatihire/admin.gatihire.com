"use client"

import { Badge } from "@/components/ui/badge"
import {
  Briefcase, Clock, IndianRupee, MapPin, MessageSquare, Move, Target, UserCheck,
} from "lucide-react"
import { cn } from "@/lib/utils"

export interface CollectedInfoField {
  key: string
  label: string
  icon: React.ElementType
  value?: string | number | boolean | null
}

export const COLLECTED_INFO_FIELDS: CollectedInfoField[] = [
  { key: "current_ctc", label: "Current CTC", icon: IndianRupee },
  { key: "expected_ctc", label: "Expected CTC", icon: IndianRupee },
  { key: "notice_period", label: "Notice Period", icon: Clock },
  { key: "total_experience", label: "Total Experience", icon: Briefcase },
  { key: "location", label: "Current Location", icon: MapPin },
  { key: "willing_to_relocate", label: "Willing to Relocate", icon: Move },
  { key: "reason_for_switching", label: "Reason for Switching", icon: MessageSquare },
]

function formatValue(field: CollectedInfoField, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  const str = String(value).trim()
  if (!str) return "—"
  if (field.key === "willing_to_relocate") {
    return /^(yes|y|true|1)$/i.test(str) ? "Yes" : /^(no|n|false|0)$/i.test(str) ? "No" : str
  }
  return str
}

function CompleteBadge() {
  return (
    <Badge variant="outline" className="gap-1 bg-green-50 text-green-700 border-green-200 text-[10px] font-bold">
      <UserCheck className="h-3 w-3" />
      Ingested via AI
    </Badge>
  )
}

export function CollectedInfoView({
  infoData,
  className,
  compact,
}: {
  infoData: Record<string, unknown> | null | undefined
  className?: string
  compact?: boolean
}) {
  const data = infoData || {}
  const filledCount = COLLECTED_INFO_FIELDS.filter((f) => {
    const v = data[f.key]
    return v !== null && v !== undefined && v !== "" && String(v).trim() !== ""
  }).length

  return (
    <div className={cn("rounded-xl border border-zinc-200 bg-white", className)}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-100 bg-zinc-50/60 rounded-t-xl">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 text-teal-600" />
          <span className="text-xs font-bold text-zinc-700">Details Collected on WhatsApp</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-zinc-400">{filledCount}/{COLLECTED_INFO_FIELDS.length} fields</span>
          {filledCount > 0 && <CompleteBadge />}
        </div>
      </div>

      <div className={cn("grid gap-x-4 gap-y-2 p-3", compact ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2")}>
        {COLLECTED_INFO_FIELDS.map((field) => {
          const value = formatValue(field, data[field.key])
          const filled = value !== "—"
          return (
            <div key={field.key} className="flex items-start gap-2 min-w-0">
              <div className={cn(
                "h-7 w-7 rounded-md flex items-center justify-center shrink-0",
                filled ? "bg-teal-50 text-teal-600" : "bg-zinc-50 text-zinc-300",
              )}>
                <field.icon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0">
                <p className={cn("text-[10px] font-bold uppercase tracking-wide", filled ? "text-zinc-400" : "text-zinc-300")}>
                  {field.label}
                </p>
                <p className={cn("text-sm leading-snug truncate", filled ? "text-zinc-800 font-semibold" : "text-zinc-300")}>
                  {value}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function PreScreenVerdict({
  result,
  className,
}: {
  result?: { decision?: string; reasons?: string[]; summary?: string; evaluatedAt?: string } | null
  className?: string
}) {
  if (!result || !result.decision) return null

  const config: Record<string, { label: string; color: string; icon: React.ElementType }> = {
    proceed: { label: "Good Fit", color: "bg-green-100 text-green-700 border-green-200", icon: Target },
    needs_review: { label: "Needs Review", color: "bg-amber-100 text-amber-700 border-amber-200", icon: UserCheck },
    filtered_out: { label: "Filtered Out", color: "bg-red-100 text-red-700 border-red-200", icon: UserCheck },
  }
  const c = config[result.decision] || { label: result.decision, color: "bg-zinc-100 text-zinc-600 border-zinc-200", icon: UserCheck }
  const reasons = result.reasons || []

  return (
    <div className={cn("rounded-xl border p-3 space-y-2", {
      "border-green-200 bg-green-50/50": result.decision === "proceed",
      "border-amber-200 bg-amber-50/50": result.decision === "needs_review",
      "border-red-200 bg-red-50/50": result.decision === "filtered_out",
      "border-zinc-200 bg-zinc-50": !config[result.decision],
    }, className)}>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className={`gap-1.5 px-2.5 py-1 text-xs font-bold ${c.color}`}>
          <c.icon className="h-3.5 w-3.5" />
          AI Pre-screen: {c.label}
        </Badge>
        {result.evaluatedAt && (
          <span className="text-[10px] text-zinc-400">
            {new Date(result.evaluatedAt).toLocaleString("en-IN", {
              day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
            })}
          </span>
        )}
      </div>
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
    </div>
  )
}