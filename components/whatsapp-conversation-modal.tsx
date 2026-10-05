"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  Check,
  CheckCheck,
  ChevronDown,
  ClipboardList,
  Clock,
  MessageCircle,
  MousePointerClick,
  PhoneCall,
  XCircle,
} from "lucide-react"
import { CollectedInfoView, PreScreenVerdict } from "@/components/candidate-collected-info"
/** How often an open thread refetches. */
const LIVE_POLL_INTERVAL_MS = 5000

import type { ThreadEntry } from "@/lib/whatsapp-thread-shared"
import { describeTemplate, entryTime } from "@/lib/whatsapp-thread-shared"

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

  // Entries are sorted by time, so one without a usable timestamp used to be
  // filtered out here and simply never rendered. A job-link message written by
  // an older appendThreadEntry call had no at/sentAt, so the candidate received
  // it and the recruiter's thread showed nothing — the thread looked broken with
  // no indication anything was missing.
  //
  // Keep untimestamped entries, park them at the end in their original relative
  // order, and mark them so the gap is visible instead of silent.
  const withTime: { e: ThreadEntry; t: Date; i: number }[] = []
  const withoutTime: { e: ThreadEntry; i: number }[] = []
  entries.forEach((e, i) => {
    const t = entryTime(e)
    if (t) withTime.push({ e, t, i })
    else withoutTime.push({ e, i })
  })
  withTime.sort((a, b) => a.t.getTime() - b.t.getTime() || a.i - b.i)

  const ordered = [
    ...withTime.map((x) => ({ ...x, undated: false })),
    ...withoutTime
      .sort((a, b) => a.i - b.i)
      .map((x) => ({ e: x.e, t: null as Date | null, i: x.i, undated: true })),
  ]

  for (const { e, t, i, undated } of ordered) {
    // Undated entries carry no "at" for the bubble; renderTime handles null.
    const time = (t ?? null) as Date | null

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
  // Undated entries must land at the END. `a.at?.getTime() || 0` would rank them
  // as timestamp 0 and float them to the top of the thread, which is worse than
  // the original bug — an undated message would appear before the message that
  // introduced it.
  return [...messages, ...extras].sort((a, b) => {
    const at = a.at?.getTime()
    const bt = b.at?.getTime()
    if (at == null && bt == null) return 0
    if (at == null) return 1
    if (bt == null) return -1
    return at - bt
  })
}

function Ticks({ status }: { status?: string | null }) {
  if (status === "sending") {
    return (
      <span className="inline-flex items-center gap-0.5 text-zinc-400" title="Sending…">
        <Clock className="h-3 w-3" />
      </span>
    )
  }
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
  participantId,
  onSent,
  open,
  onOpenChange,
  infoData,
  infoSources,
  resumeFallback,
  preScreenResult,
  roleLabel,
}: {
  history: unknown
  candidateName?: string | null
  /** Enables the composer. Omit for a genuinely read-only view. */
  participantId?: string | null
  /** Called after a message is accepted, so the parent can refetch the row. */
  onSent?: () => void
  /**
   * What the candidate actually submitted, shown in the thread.
   *
   * Without this the conversation was messages only, so a recruiter could read
   * "Replied 31m ago" and still have to leave and find the values somewhere
   * else — and could not tell which numbers came from WhatsApp versus the resume.
   */
  infoData?: Record<string, unknown> | null
  /** Per-field provenance. Fields collected here are tagged WhatsApp, resume ones Resume. */
  infoSources?: Record<string, unknown> | null
  /** Candidate-row values, used for RESUME-sourced fields only. */
  resumeFallback?: Record<string, unknown> | null
  /** Pre-screen outcome, so the AI's read is visible next to the transcript. */
  preScreenResult?: unknown
  /** "Store Incharge · Sharepal", so the thread is not context-free. */
  roleLabel?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showSystem, setShowSystem] = useState(true)
  const [showDetails, setShowDetails] = useState(false)


  // Outbound composer. The thread used to be strictly read-only — its footer
  // said so — which meant the one moment a recruiter most needs to speak is the
  // moment they could not: after the pre-screen held a candidate and before a
  // decision was made. The only recruiter-authored message was `clarify`, which
  // could ask one question and then misfiled the answer as a screening field.
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // Messages sent in this session, shown immediately rather than after a refetch.
  const [pending, setPending] = useState<Rendered[]>([])
  // Thread as last fetched from the server. The prop is only the initial value —
  // polling updates this instead, so a reply that arrives while the modal is
  // open appears on its own.
  const [liveHistory, setLiveHistory] = useState<unknown>(history)
  const [liveInfo, setLiveInfo] = useState<{ infoData?: any; infoSources?: any; preScreenResult?: any }>({
    infoData: infoData ?? undefined,
    infoSources: infoSources ?? undefined,
    preScreenResult: preScreenResult ?? undefined,
  })

  // A new prop value (parent refetch) must win over whatever polling last saw.
  useEffect(() => {
    setLiveHistory(history)
    setLiveInfo({ infoData: infoData ?? undefined, infoSources: infoSources ?? undefined, preScreenResult: preScreenResult ?? undefined })
  }, [history, infoData, infoSources, preScreenResult])

  // Counted from info_data only. resumeFallback must not count here or the badge
  // would claim the candidate told us things they never typed on WhatsApp.
  const liveInfoData = liveInfo.infoData as Record<string, unknown> | undefined
  const collectedKeyCount = Object.keys(liveInfoData ?? {}).filter(
    (k) => liveInfoData?.[k] !== null && liveInfoData?.[k] !== undefined && liveInfoData?.[k] !== ""
  ).length
  const hasCollectedInfo = collectedKeyCount > 0

  const conversation = useMemo(() => buildConversation(parseEntries(liveHistory)), [liveHistory])

  const canSend = !!participantId

  /**
   * Live updates.
   *
   * The thread is a chat: a recruiter sitting on it needs a reply to appear
   * without re-opening anything. Polling rather than Supabase Realtime because
   * this app does not subscribe to postgres_changes anywhere, so enabling a
   * publication for this one view would be a wider change than it looks.
   *
   * Pauses when the tab is hidden, and skips when the document is not visible,
   * so a backgrounded tab is not hammering the endpoint. Interval is a
   * deliberate trade: short enough that "live" feels true, long enough that a
   * recruiter watching a handful of threads is not a meaningful load.
   */
  useEffect(() => {
    if (!open || !participantId) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      if (cancelled) return
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(poll, LIVE_POLL_INTERVAL_MS)
        return
      }
      try {
        const res = await fetch(`/api/phone-screening/participants/${participantId}/thread`, {
          cache: "no-store",
        })
        if (res.ok) {
          const data = await res.json()
          if (!cancelled) {
            // Only adopt changed slices, so an unchanged poll does not force a
            // re-render of every bubble.
            setLiveHistory((prev: unknown) => (prev === data.whatsapp_history ? prev : data.whatsapp_history))
            setLiveInfo((prev: { infoData?: any; infoSources?: any; preScreenResult?: any }) => {
              const next = {
                infoData: data.info_data ?? undefined,
                infoSources: data.info_sources ?? undefined,
                preScreenResult: data.screening_context?.preScreenResult,
              }
              const same =
                prev.infoData === next.infoData &&
                prev.infoSources === next.infoSources &&
                prev.preScreenResult === next.preScreenResult
              return same ? prev : next
            })
          }
        }
      } catch {
        // Offline or aborted: the thread keeps whatever it had. Never blank it.
      } finally {
        if (!cancelled) timer = setTimeout(poll, LIVE_POLL_INTERVAL_MS)
      }
    }

    timer = setTimeout(poll, LIVE_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [open, participantId])

  useEffect(() => {
    if (!open) return
    // Clear transient composer state when the thread is reopened for someone else.
    setDraft("")
    setSendError(null)
    setPending([])
  }, [open, participantId])

  async function send() {
    const text = draft.trim()
    if (!text || !participantId || sending) return

    setSending(true)
    setSendError(null)
    // Optimistic bubble, keyed by the local clock so ordering stays stable. If
    // the send fails it is replaced by the real failed entry from the refetch.
    const optimistic: Rendered = {
      id: `pending-${Date.now()}`,
      direction: "out",
      text,
      at: new Date(),
      status: "sending",
      kind: "hr_manual_message",
      reconstructed: false,
    }
    setPending((prev) => [...prev, optimistic])
    setDraft("")

    try {
      const res = await fetch(`/api/phone-screening/participants/${participantId}/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        setDraft(text)
        setSendError(data?.error || `Could not send (HTTP ${res.status})`)
        setPending((prev) => prev.filter((p) => p.id !== optimistic.id))
        return
      }

      onSent?.()
    } catch (err: any) {
      setDraft(text)
      setSendError(err?.message || "Network error — message not sent")
      setPending((prev) => prev.filter((p) => p.id !== optimistic.id))
    } finally {
      setSending(false)
    }
  }

  const withPending = useMemo(
    () => [...conversation, ...pending].sort((a, b) => (a.at?.getTime() || 0) - (b.at?.getTime() || 0)),
    [conversation, pending]
  )

  const visible = useMemo(
    () => (showSystem ? withPending : withPending.filter((c) => c.direction !== "system")),
    [withPending, showSystem]
  )

  const unread = withPending.some((c) => c.direction === "in")
  const systemCount = withPending.filter((c) => c.direction === "system").length

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

  // An empty thread used to mean "render nothing", which also meant a recruiter
  // could never open a conversation to start one. That is precisely the dead end
  // this composer exists to remove, so an empty history is fine as long as we
  // know who we are talking to.
  if (withPending.length === 0 && !canSend) return null

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
            {roleLabel && (
              <p className="truncate text-[11px] text-zinc-500">{roleLabel}</p>
            )}
            <p className="text-[11px] text-zinc-500">
              {withPending.length} entries
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

        {/* What they submitted, above the transcript. Collapsed by default: most
            lookups are for the message, and the thread is the reason they opened
            this. */}
        {(hasCollectedInfo || !!liveInfo.preScreenResult) && (
          <div className="border-b border-zinc-200 bg-white">
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-zinc-50"
            >
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-700">
                <ClipboardList className="h-3.5 w-3.5 text-zinc-400" />
                What they shared
                {hasCollectedInfo && (
                  <span className="rounded-full bg-zinc-100 px-1.5 py-px text-[10px] font-medium text-zinc-600">
                    {collectedKeyCount}
                  </span>
                )}
              </span>
              <ChevronDown className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${showDetails ? "" : "-rotate-90"}`} />
            </button>
            {showDetails && (
              <div className="space-y-2 border-t border-zinc-100 px-4 pb-3 pt-3">
                {liveInfo.preScreenResult ? (
                  <PreScreenVerdict result={liveInfo.preScreenResult as any} />
                ) : null}

                {hasCollectedInfo && (
                  <CollectedInfoView
                    infoData={liveInfoData ?? null}
                    infoSources={liveInfo.infoSources as any}
                    fallback={resumeFallback ?? null}
                    compact
                  />
                )}
              </div>
            )}
          </div>
        )}

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

        {canSend ? (
          <div className="border-t border-zinc-200 bg-white px-3 py-2">
            {sendError && (
              <p className="mb-1.5 flex items-start gap-1 rounded-md bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700">
                <AlertCircle className="mt-px h-3 w-3 shrink-0" />
                <span>{sendError}</span>
              </p>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter is a newline. Recruiters write
                  // multi-line notes here, so a bare Enter must not eat them.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={2}
                maxLength={4096}
                placeholder="Message the candidate…"
                className="min-h-[38px] flex-1 resize-none rounded-lg border border-zinc-300 px-2.5 py-2 text-[12px] leading-relaxed text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || sending}
                className="inline-flex h-[38px] shrink-0 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-[12px] font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
              Sent as you type — only inside WhatsApp&apos;s 24-hour service window.
              Enter to send, Shift+Enter for a new line.
            </p>
          </div>
        ) : (
          <footer className="border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-[10px] leading-relaxed text-zinc-500">
            Read-only. Delivery receipts are folded into the message they belong to; rows
            marked “log only” predate message-body recording, so only the event is known.
          </footer>
        )}
      </div>
    </div>
  )
}
