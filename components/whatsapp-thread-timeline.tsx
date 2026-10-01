"use client"

import { useState } from "react"
import { Check, CheckCheck, PhoneCall, MessageCircle, MousePointerClick, ChevronDown, XCircle, Clock } from "lucide-react"

/**
 * Compact timeline of a candidate's WhatsApp thread.
 *
 * The thread used to be write-only from the UI's point of view: delivery
 * receipts and outbound sends existed in whatsapp_history but nothing rendered
 * them, and inbound button taps were never recorded at all. A recruiter looking
 * at a stalled candidate saw only "read" and had no way to tell whether the
 * candidate had tapped "Call Now", never replied, or tapped and had the tap
 * silently dropped.
 */

type Entry = {
  at?: string
  kind?: string
  status?: string
  buttonId?: string
  buttonTitle?: string
  scheduledFor?: string
  error?: string
  messageId?: string
  mode?: string
  [key: string]: unknown
}

function parseEntries(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is Entry => !!e && typeof e === "object")
}

function fmt(iso?: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  const now = Date.now()
  const diffMin = Math.round((now - d.getTime()) / 60000)
  if (diffMin < 1) return "just now"
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

type Tone = "in" | "out" | "good" | "bad"

function describe(entry: Entry): { label: string; detail: string; tone: Tone; icon: any } {
  const kind = String(entry.kind || "")
  const status = String(entry.status || "")

  if (kind === "button_tap") {
    return {
      label: `Candidate tapped "${entry.buttonTitle || entry.buttonId || "a button"}"`,
      detail: fmt(entry.at),
      tone: "in",
      icon: MousePointerClick,
    }
  }

  if (kind === "call_booked") {
    const when = entry.scheduledFor ? new Date(String(entry.scheduledFor)) : null
    const at = when && !isNaN(when.getTime())
      ? when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "a chosen slot"
    return {
      label: entry.mode === "already_placed" ? "Call already placed" : `Call booked for ${at}`,
      detail: fmt(entry.at),
      tone: "good",
      icon: PhoneCall,
    }
  }

  if (kind === "call_booking_failed") {
    return {
      label: `Call booking failed${entry.error ? ` — ${entry.error}` : ""}`,
      detail: fmt(entry.at),
      tone: "bad",
      icon: XCircle,
    }
  }

  if (kind === "schedule_buttons") {
    return {
      label: status === "failed" ? "Could not send time-slot buttons" : "Sent time-slot buttons",
      detail: fmt(entry.at),
      tone: status === "failed" ? "bad" : "out",
      icon: MessageCircle,
    }
  }

  if (kind === "pre_screen_review") {
    return { label: "Pre-screen flagged for HR review", detail: fmt(entry.at), tone: "out", icon: Clock }
  }

  if (status === "read") return { label: "Candidate read the message", detail: fmt(entry.at), tone: "in", icon: CheckCheck }
  if (status === "delivered") return { label: "Message delivered", detail: fmt(entry.at), tone: "out", icon: CheckCheck }
  if (status === "sent") return { label: "Message sent", detail: fmt(entry.at), tone: "out", icon: Check }
  if (status === "failed") return { label: `Message failed${entry.error ? ` — ${entry.error}` : ""}`, detail: fmt(entry.at), tone: "bad", icon: XCircle }

  // Unknown kinds are still shown, never silently dropped — an unlabelled line
  // is far more useful than a missing one.
  return { label: kind || status || "Activity", detail: fmt(entry.at), tone: "out", icon: MessageCircle }
}

const TONE_CLASS: Record<Tone, string> = {
  in: "text-green-700 bg-green-50 border-green-200",
  out: "text-zinc-500 bg-zinc-50 border-zinc-200",
  good: "text-blue-700 bg-blue-50 border-blue-200",
  bad: "text-red-700 bg-red-50 border-red-200",
}

export function WhatsAppThreadTimeline({ history }: { history: unknown }) {
  const [open, setOpen] = useState(false)
  const entries = parseEntries(history)
  if (entries.length === 0) return null

  // Newest first, collapsed to the three most recent until expanded.
  const ordered = [...entries].reverse()
  const shown = open ? ordered : ordered.slice(0, 3)
  const hidden = ordered.length - shown.length

  return (
    <div className="mt-2 rounded-lg border border-zinc-100 bg-zinc-50/60 p-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-400">
          WhatsApp thread
        </span>
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-[10px] font-semibold text-zinc-500 hover:text-zinc-800"
          >
            +{hidden} earlier
          </button>
        )}
        {open && ordered.length > 3 && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="inline-flex items-center text-[10px] font-semibold text-zinc-500 hover:text-zinc-800"
          >
            <ChevronDown className="h-3 w-3 rotate-180" /> collapse
          </button>
        )}
      </div>
      <ul className="mt-1.5 space-y-1">
        {shown.map((entry, i) => {
          const d = describe(entry)
          const Icon = d.icon
          return (
            <li key={`${entry.at || i}-${i}`} className="flex items-start gap-2">
              <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${TONE_CLASS[d.tone]}`}>
                <Icon className="h-2.5 w-2.5" />
              </span>
              <span className="min-w-0 flex-1 text-[11px] leading-snug text-zinc-700">
                {d.label}
              </span>
              {d.detail && <span className="shrink-0 text-[10px] text-zinc-400">{d.detail}</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
