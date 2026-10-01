"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  MessageCircle,
  MousePointerClick,
  PhoneCall,
  XCircle,
} from "lucide-react"
import type { ThreadEntry } from "@/lib/whatsapp-thread"
import { describeTemplate, entryTime } from "@/lib/whatsapp-thread"

/**
 * WhatsApp-style conversation view for a candidate's screening thread.
 *
 * Replaces the flat "Message sent / Message delivered / Message sent" list.
 * That list was unreadable for two reasons: every row looked identical, and —
 * until message bodies started being persisted — most rows had no body at all.
 *
 * Delivery receipts are folded into the message they belong to instead of
 * taking their own line, because a recruiter reads "sent → delivered → read"
 * as three events when it is really one message changing state. A message whose
 * only record is a `messageId` (an older row that never captured text) is
 * matched to the most recent send with the same id, which is what lets Meta's
 * later receipts upgrade the bubble that produced them.
 */

type Rendered = {
  id: string
  direction: "in" | "out" | "system"
  text: string
  at: Date | null
  status?: string | null
  messageId?: string | null
  kind?: string | null
  error?: string | null
  scheduledFor?: string | null
  buttonTitle?: string | null
  /** True when the body was reconstructed from a template name, not stored. */
  reconstructed: boolean
}

function parseEntries(raw: unknown): ThreadEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is ThreadEntry => !!e && typeof e === "object")
}

function clockTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

function dayLabel(d: Date): string {
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const yesterday = new Date(today.getTime() - 86400000)
  if (isToday) return "Today"
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday"
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
}

/** Delivery status of a message, ranked so the strongest state wins. */
const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 }

function strongerStatus(a?: string | null, b?: string | null): string | null {
  if (a === "failed") return "failed"
  if (b === "failed") return "failed"
  const ra = STATUS_RANK[String(a)] || 0
  const rb = STATUS_RANK[String(b)] || 0
  return rb > ra ? (b as string) : ((a as string) ?? null)
}

function isDeliveryOnly(e: ThreadEntry): boolean {
  if (e.text) return false
  if (e.direction) return false
  if (e.kind && e.kind !== "re-nudge") return false
  return !!(e.status && ["sent", "delivered", "read", "failed"].includes(String(e.status)))
}

function isTap(e: ThreadEntry): boolean {
  return e.kind === "button_tap" || !!e.buttonId
}

function buildConversation(entries: ThreadEntry[]): Rendered[] {
  const messages: Rendered[] = []
  const byMessageId = new Map<string, Rendered>()
  const extras: Rendered[] = []

  const ordered = entries
    .map((e, i) => ({ e, t: entryTime(e), i }))
    .filter((x) => x.t)
    .sort((a, b) => a.t!.getTime() - b.t!.getTime() || a.i - b.i)

  for (const { e, t, i } of ordered) {
    const time = t as Date

    // Delivery receipt — attach to the message it describes.
    if (isDeliveryOnly(e)) {
      const target = e.messageId ? byMessageId.get(String(e.messageId)) : undefined
      if (target) {
        target.status = strongerStatus(target.status, e.status)
        if (e.status === "failed" && e.error) target.error = e.error
      } else {
        // No matching send (history trimmed, or the row predates recording).
        // Keep it visible rather than dropping evidence.
        extras.push({
          id: `orphan-${i}`,
          direction: "system",
          text: describeTemplate(e.template),
          at: time,
          status: e.status,
          messageId: e.messageId,
          kind: e.status === "failed" ? "failed" : "receipt",
          error: e.error ?? null,
          reconstructed: true,
        })
      }
      continue
    }

    if (isTap(e)) {
      extras.push({
        id: `tap-${i}`,
        direction: "system",
        text: `Tapped “${e.buttonTitle || e.buttonId || "a button"}”`,
        at: time,
        kind: "button_tap",
        reconstructed: false,
      })
      continue
    }

    const kind = String(e.kind || "")
    const isSystem =
      e.direction === "system" ||
      ["call_booked", "call_booking_failed", "pre_screen_review", "form_submit_failed", "not_interested_closing"].includes(kind) ||
      kind.startsWith("form_") ||
      kind.startsWith("call_")

    // Outbound row: show the stored body, else describe what the template was.
    const text =
      (e.text && String(e.text).trim()) ||
      (e.direction === "in" ? "" : describeTemplate(e.template)) ||
      (e.template ? describeTemplate(e.template) : "")

    const rendered: Rendered = {
      id: `m-${i}`,
      direction: e.direction === "in" ? "in" : isSystem ? "system" : "out",
      text: text || "Activity recorded",
      at: time,
      status: e.status ?? null,
      messageId: e.messageId ?? null,
      kind: e.kind ?? null,
      error: e.error ?? null,
      scheduledFor: e.scheduledFor ?? null,
      buttonTitle: e.buttonTitle ?? null,
      reconstructed: !e.text,
    }

    messages.push(rendered)
    if (rendered.messageId) byMessageId.set(String(rendered.messageId), rendered)
  }

  // System events and taps are merged back in by time so the whole conversation
  // reads top to bottom in one stream.
  return [...messages, ...extras].sort((a, b) => (a.at?.getTime() || 0) - (b.at?.getTime() || 0))
}

function Ticks({ status }: { status?: string | null }) {
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-0.5 text-red-500" title="Failed">
        <XCircle className="h-3 w-3" />
      </span>
    )
  }
  if (status === "read") {
    return (
      <span className="inline-flex items-center gap-0.5 text-sky-600" title="Read by candidate">
        <CheckCheck className="h-3 w-3" />
      </span>
    )
  }
  if (status === "delivered") {
    return (
      <span className="inline-flex items-center gap-0.5 text-zinc-400" title="Delivered">
        <CheckCheck className="h-3 w-3" />
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-zinc-400" title="Sent">
      <Check className="h-3 w-3" />
    </span>
  )
}

function Bubble({ item }: { item: Rendered }) {
  if (item.direction === "system") {
    const tone =
      item.kind === "call_booked"
        ? "text-blue-700 bg-blue-50 border-blue-200"
        : item.kind === "call_booking_failed" || item.status === "failed"
          ? "text-red-700 bg-red-50 border-red-200"
          : "text-zinc-600 bg-zinc-50 border-zinc-200"
    const Icon = item.kind === "call_booked" ? PhoneCall : item.kind === "button_tap" ? MousePointerClick : item.status === "failed" ? XCircle : item.kind === "pre_screen_review" ? Clock : MessageCircle
    const label =
      item.kind === "call_booked" && item.scheduledFor
        ? `Call booked for ${new Date(item.scheduledFor).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
        : item.text

    return (
      <div className="flex justify-center py-0.5">
        <span className={`inline-flex max-w-[85%] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${tone}`}>
          <Icon className="h-3 w-3 shrink-0" />
          <span className="truncate">{label}</span>
          {item.at && <span className="shrink-0 text-[10px] opacity-60">{clockTime(item.at)}</span>}
        </span>
      </div>
    )
  }

  const outbound = item.direction === "out"

  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"} py-0.5`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-[12px] leading-relaxed shadow-sm ${
          outbound
            ? "rounded-br-md bg-emerald-600 text-white"
            : "rounded-bl-md border border-zinc-200 bg-white text-zinc-800"
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
        {item.error && (
          <p className="mt-1 flex items-start gap-1 text-[10px] font-medium text-red-600">
            <AlertCircle className="mt-px h-3 w-3 shrink-0" />
            {item.error}
          </p>
        )}
        <div className={`mt-1 flex items-center justify-end gap-1 ${outbound ? "text-emerald-100" : "text-zinc-400"}`}>
          {item.reconstructed && (
            <span className="mr-0.5 text-[9px] uppercase tracking-wide opacity-70" title="Body was not stored for this message">
              log only
            </span>
          )}
          {item.at && <span className="text-[10px] tabular-nums">{clockTime(item.at)}</span>}
          {outbound && <Ticks status={item.status} />}
        </div>
      </div>
    </div>
  )
}

export function WhatsAppConversationModal({
  history,
  candidateName,
  open,
  onOpenChange,
}: {
  history: unknown
  candidateName?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const conversation = useMemo(() => buildConversation(parseEntries(history)), [history])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showSystem, setShowSystem] = useState(true)

  const visible = useMemo(
    () => (showSystem ? conversation : conversation.filter((c) => c.direction !== "system")),
    [conversation, showSystem]
  )

  const unread = conversation.some((c) => c.direction === "in")
  const systemCount = conversation.filter((c) => c.direction === "system").length

  useEffect(() => {
    if (!open) return
    // Open on the most recent message, the way a chat app does.
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [open, visible.length])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onOpenChange])

  if (conversation.length === 0) return null

  // Group by calendar day so long threads stay readable.
  let lastDay = ""

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-zinc-900/40 backdrop-blur-[2px]"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`WhatsApp conversation with ${candidateName || "candidate"}`}
        className="relative flex max-h-[86vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-w-[520px] sm:rounded-2xl"
      >
        <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-900">
              {candidateName || "Candidate"}
            </p>
            <p className="text-[11px] text-zinc-500">
              {conversation.length} entries
              {systemCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowSystem((v) => !v)}
                  className="ml-2 inline-flex items-center gap-0.5 rounded-full border border-zinc-200 bg-white px-1.5 py-px text-[10px] font-medium text-zinc-600 hover:bg-zinc-100"
                >
                  {showSystem ? "Hide" : "Show"} receipts & events
                  <ChevronDown className={`h-3 w-3 transition-transform ${showSystem ? "" : "-rotate-90"}`} />
                </button>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {unread && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                Candidate replied
              </span>
            )}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
            >
              Close
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          className="flex-1 space-y-1 overflow-y-auto bg-[#ece5dd] px-3 py-3"
        >
          {visible.map((item) => {
            const day = item.at ? dayLabel(item.at) : ""
            const showDay = day !== lastDay
            lastDay = day
            return (
              <div key={item.id}>
                {showDay && (
                  <div className="flex justify-center py-2">
                    <span className="rounded-full bg-white/70 px-2.5 py-0.5 text-[10px] font-semibold text-zinc-500 shadow-sm">
                      {day}
                    </span>
                  </div>
                )}
                <Bubble item={item} />
              </div>
            )
          })}
        </div>

        <footer className="border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-[10px] leading-relaxed text-zinc-500">
          Read-only. Delivery receipts are folded into the message they belong to; rows
          marked “log only” predate message-body recording, so only the event is known.
        </footer>
      </div>
    </div>
  )
}
