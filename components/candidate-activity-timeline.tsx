"use client"

import { useState, useEffect, useCallback } from "react"
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { Badge } from "@/components/ui/badge"

interface ActivityEntry {
  id: string
  event_type: string
  event_data: Record<string, any>
  actor: string
  created_at: string
}

interface CandidateActivityTimelineProps {
  jobId: string
  candidateId: string
  participantId?: string | null
  expanded?: boolean
  onToggle?: (expanded: boolean) => void
}

const EVENT_CONFIG: Record<string, { label: string; dot: string; badge: string }> = {
  applied: { label: "Applied", dot: "bg-green-500", badge: "bg-green-100 text-green-800" },
  ai_screen_started: { label: "AI Screening started", dot: "bg-indigo-500", badge: "bg-indigo-100 text-indigo-800" },
  whatsapp_sent: { label: "WhatsApp sent", dot: "bg-blue-500", badge: "bg-blue-100 text-blue-800" },
  whatsapp_delivered: { label: "WhatsApp delivered", dot: "bg-blue-400", badge: "bg-blue-50 text-blue-700" },
  whatsapp_read: { label: "WhatsApp read", dot: "bg-blue-300", badge: "bg-blue-50 text-blue-600" },
  whatsapp_replied: { label: "Replied", dot: "bg-green-500", badge: "bg-green-100 text-green-800" },
  call_attempted: { label: "AI call placed", dot: "bg-amber-500", badge: "bg-amber-100 text-amber-800" },
  call_in_progress: { label: "Call connected", dot: "bg-amber-400", badge: "bg-amber-100 text-amber-800" },
  call_completed: { label: "Call completed", dot: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-800" },
  call_failed: { label: "Call failed", dot: "bg-red-500", badge: "bg-red-100 text-red-800" },
  call_missed: { label: "No answer", dot: "bg-orange-500", badge: "bg-orange-100 text-orange-800" },
  callback_scheduled: { label: "Callback scheduled", dot: "bg-cyan-500", badge: "bg-cyan-100 text-cyan-800" },
  screening_reviewed: { label: "Reviewed", dot: "bg-purple-500", badge: "bg-purple-100 text-purple-800" },
  stage_changed: { label: "Stage changed", dot: "bg-violet-500", badge: "bg-violet-100 text-violet-800" },
  notes_updated: { label: "Notes updated", dot: "bg-zinc-400", badge: "bg-zinc-100 text-zinc-700" },
  interview_scheduled: { label: "Interview scheduled", dot: "bg-sky-500", badge: "bg-sky-100 text-sky-800" },
  interview_status_changed: { label: "Interview status", dot: "bg-sky-400", badge: "bg-sky-100 text-sky-700" },
  shortlist_shared: { label: "Shared with client", dot: "bg-pink-500", badge: "bg-pink-100 text-pink-800" },
  client_decision: { label: "Client decision", dot: "bg-pink-400", badge: "bg-pink-100 text-pink-700" },
}

function describeEvent(entry: ActivityEntry): string {
  const d: any = entry.event_data || {}
  switch (entry.event_type) {
    case "applied":
      return `via ${d.source || "pipeline"}`
    case "ai_screen_started":
      return `${d.call_mode || "call_now"} mode`
    case "whatsapp_sent":
      return d.template ? `Template: ${d.template}` : "Message sent"
    case "whatsapp_replied":
      return d.action ? `Action: ${String(d.action).replace(/_/g, " ")}` : (d.reply_text ? `"${String(d.reply_text).slice(0, 60)}${String(d.reply_text).length > 60 ? "..." : ""}"` : "Candidate responded")
    case "call_attempted":
      return d.direction === "inbound" ? "Candidate called back" : "Call placed"
    case "call_in_progress":
      return "Connected"
    case "call_completed": {
      const dur = d.duration_sec ? `${Math.round(Number(d.duration_sec))}s` : ""
      const score = d.score != null ? `Score: ${d.score}/10` : ""
      const rec = d.recommendation || ""
      return [dur, score, rec].filter(Boolean).join(", ") || "Call ended"
    }
    case "call_failed":
      return d.reason ? `Reason: ${d.reason}` : "Unknown"
    case "call_missed":
      return d.attempts ? `Attempt ${d.attempts}` : "No answer"
    case "callback_scheduled":
      return d.scheduled_at ? `At ${new Date(String(d.scheduled_at)).toLocaleString()}` : (d.preference || "Callback requested")
    case "screening_reviewed":
      return d.decision ? `${d.decision}${d.next_stage ? ` → ${d.next_stage}` : ""}` : "Review completed"
    case "stage_changed":
      return d.from && d.to ? `${d.from} → ${d.to}` : "Stage updated"
    case "interview_scheduled":
      return d.round && d.scheduled_at ? `Round ${d.round}: ${new Date(String(d.scheduled_at)).toLocaleString()}` : "Interview set"
    case "interview_status_changed":
      return d.round && d.from && d.to ? `Round ${d.round}: ${d.from} → ${d.to}` : "Status updated"
    case "shortlist_shared":
      return d.client_name ? `Shared with ${d.client_name}` : "Shared"
    case "client_decision":
      return d.decision || "Decision received"
    default:
      return ""
  }
}

export function CandidateActivityTimeline({
  jobId,
  candidateId,
  participantId,
  expanded: controlledExpanded,
  onToggle,
}: CandidateActivityTimelineProps) {
  const [expanded, setExpanded] = useState(controlledExpanded ?? false)
  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const isExpanded = controlledExpanded ?? expanded

  const fetchActivities = useCallback(async () => {
    if (loading || loaded) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ jobId, candidateId, limit: "30" })
      if (participantId) params.set("participantId", participantId)
      const res = await fetch(`/api/candidate-activity?${params}`)
      const data = await res.json()
      if (res.ok) setActivities(data.activities || [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [jobId, candidateId, participantId, loading, loaded])

  useEffect(() => {
    if (isExpanded && !loaded) fetchActivities()
  }, [isExpanded, loaded, fetchActivities])

  const toggle = () => {
    const next = !isExpanded
    setExpanded(next)
    onToggle?.(next)
    if (next && !loaded) fetchActivities()
  }

  const lastEvent = activities.length > 0 ? activities[0] : null
  const lastConfig = lastEvent ? EVENT_CONFIG[lastEvent.event_type] : null

  return (
    <div className="border-t border-zinc-100">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
      >
        <span className="flex items-center gap-2">
          {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Activity
          {activities.length > 0 && (
            <span className="text-zinc-400 font-normal">{activities.length} event{activities.length !== 1 ? "s" : ""}</span>
          )}
        </span>
        {lastEvent && !isExpanded && (
          <span className="flex items-center gap-1.5 text-zinc-400 font-normal">
            {lastConfig && <span className={`h-1.5 w-1.5 rounded-full ${lastConfig.dot}`} />}
            {formatDistanceToNow(new Date(lastEvent.created_at), { addSuffix: true })}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="px-4 pb-3">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            </div>
          ) : activities.length === 0 ? (
            <p className="text-xs text-zinc-400 py-3 text-center">No activity yet</p>
          ) : (
            <div className="space-y-0">
              {activities.map((entry, i) => {
                const config = EVENT_CONFIG[entry.event_type] || { label: entry.event_type, dot: "bg-zinc-400", badge: "bg-zinc-100 text-zinc-700" }
                const description = describeEvent(entry)
                return (
                  <div key={entry.id} className="relative flex gap-3 py-2">
                    {/* Timeline line */}
                    {i < activities.length - 1 && (
                      <div className="absolute left-[5px] top-[18px] bottom-0 w-px bg-zinc-200" />
                    )}
                    {/* Dot */}
                    <div className={`mt-0.5 h-[11px] w-[11px] rounded-full ${config.dot} shrink-0 ring-2 ring-white`} />
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-zinc-800">{config.label}</span>
                        {entry.event_type === "stage_changed" && entry.event_data.to && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {String(entry.event_data.to)}
                          </Badge>
                        )}
                        {description && (
                          <span className="text-[11px] text-zinc-500">{description}</span>
                        )}
                      </div>
                      <span className="text-[10px] text-zinc-400">
                        {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
