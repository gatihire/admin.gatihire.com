"use client"

import { useState } from "react"
import { MessageCircle, MousePointerClick, PhoneCall } from "lucide-react"
import type { ThreadEntry } from "@/lib/whatsapp-thread-shared"
import { describeTemplate, entryTime } from "@/lib/whatsapp-thread-shared"
import { WhatsAppConversationModal } from "./whatsapp-conversation-modal"

/**
 * Collapsed summary of a candidate's WhatsApp thread.
 *
 * The previous version inlined a flat list of every receipt, so a card grew to
 * a dozen lines of "Message sent" and pushed the real pipeline content down the
 * page. This keeps one line — last activity plus counts — and opens the full
 * conversation on click.
 */

function parseEntries(raw: unknown): ThreadEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is ThreadEntry => !!e && typeof e === "object")
}

function fmt(iso?: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000)
  if (diffMin < 1) return "just now"
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** One line describing where the conversation currently stands. */
function summarise(entries: ThreadEntry[]): string {
  const taps = entries.filter((e) => e.kind === "button_tap")
  const booked = entries.find((e) => e.kind === "call_booked")
  if (booked) return "Call booked"
  if (taps.length) {
    const last = taps[taps.length - 1]
    return `Tapped “${last.buttonTitle || last.buttonId || "a button"}”`
  }
  const inbound = entries.filter((e) => e.direction === "in" || (e as any).text)
  const lastOutbound = [...entries].reverse().find((e) => e.template || e.text)
  if (lastOutbound?.template) return describeTemplate(lastOutbound.template)
  if (inbound.length) return "Candidate replied"
  return "No activity yet"
}

export function WhatsAppThreadTimeline({
  history,
  candidateName,
  participantId,
  onSent,
  infoData,
  infoSources,
  resumeFallback,
  preScreenResult,
  roleLabel,
}: {
  history: unknown
  candidateName?: string | null
  participantId?: string | null
  onSent?: () => void
  infoData?: Record<string, unknown> | null
  infoSources?: Record<string, unknown> | null
  resumeFallback?: Record<string, unknown> | null
  preScreenResult?: unknown
  roleLabel?: string | null
}) {
  const [open, setOpen] = useState(false)
  const entries = parseEntries(history)
  if (entries.length === 0) return null

  const times = entries.map((e) => entryTime(e)).filter(Boolean) as Date[]
  const last = times.length ? times.reduce((a, b) => (b > a ? b : a)) : null

  const replies = entries.filter((e) => e.direction === "in").length
  const taps = entries.filter((e) => e.kind === "button_tap").length
  const calls = entries.filter((e) => e.kind === "call_booked").length

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50/70 px-2.5 py-1.5 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-100"
      >
        <span className="flex min-w-0 items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <span className="min-w-0">
            <span className="block text-[11px] font-semibold text-zinc-700">
              View WhatsApp conversation
            </span>
            <span className="block truncate text-[10px] text-zinc-500">{summarise(entries)}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[10px] text-zinc-400">
          {replies > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-px font-semibold text-emerald-700">
              <MousePointerClick className="h-2.5 w-2.5" />
              {replies}
            </span>
          )}
          {taps > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 px-1.5 py-px font-semibold text-zinc-600">
              <MousePointerClick className="h-2.5 w-2.5" />
              {taps}
            </span>
          )}
          {calls > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-50 px-1.5 py-px font-semibold text-blue-700">
              <PhoneCall className="h-2.5 w-2.5" />
              {calls}
            </span>
          )}
          {last && <span className="tabular-nums">{fmt(last.toISOString())}</span>}
        </span>
      </button>

      {open && (
        <WhatsAppConversationModal
          history={history}
          candidateName={candidateName}
          participantId={participantId}
          onSent={onSent}
          infoData={infoData}
          infoSources={infoSources}
          resumeFallback={resumeFallback}
          preScreenResult={preScreenResult}
          roleLabel={roleLabel}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  )
}
