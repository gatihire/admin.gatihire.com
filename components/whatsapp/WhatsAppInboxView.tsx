"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { formatDistanceToNow } from "date-fns"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
import { supabase } from "@/lib/supabase"
import { WhatsAppConversationModal } from "@/components/whatsapp-conversation-modal"
import {
  CATEGORY_LABELS,
  CONVERSATION_CATEGORIES,
  type ConversationCategory,
  type ConversationThread,
} from "@/lib/dispatch/conversations"
import { Loader2, MessageCircle, MoreHorizontal, PhoneCall, RefreshCw, Search, Inbox, ExternalLink } from "lucide-react"

interface InboxResponse {
  generatedAt: string
  viewer: { id: string; name: string | null; email: string | null }
  categories: ConversationCategory[]
  counts: Record<string, number>
  total: number
  items: ConversationThread[]
}

const CATEGORY_STYLE: Record<ConversationCategory, string> = {
  needs_human: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900",
  needs_reply: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
  declined: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  no_reply: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900/50 dark:text-slate-300 dark:border-slate-700",
  other: "bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700",
}

function firstName(name: string): string {
  return (name || "there").trim().split(/\s+/)[0]
}

function relative(iso: string | null): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "—"
  try {
    return formatDistanceToNow(t, { addSuffix: true })
  } catch {
    return "—"
  }
}

export function WhatsAppInboxView() {
  const router = useRouter()
  const { toast } = useToast()
  const [data, setData] = useState<InboxResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<"all" | ConversationCategory>("needs_human")
  const [search, setSearch] = useState("")
  const [convoItem, setConvoItem] = useState<ConversationThread | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const firstLoad = useRef(true)

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true)
    try {
      const res = await fetch("/api/whatsapp/inbox", { credentials: "include" })
      if (!res.ok) {
        const detail = await res.text().catch(() => "")
        throw new Error(`${res.status} ${detail}`.trim())
      }
      setData((await res.json()) as InboxResponse)
      setError(null)
    } catch (e: any) {
      setError(e?.message || "Could not load conversations")
    } finally {
      setLoading(false)
      firstLoad.current = false
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Live: a reply landing anywhere updates the inbox on its own. Mirrors the
  // screening board's pattern — coalesce bursty writes, and drop the channel
  // while the tab is hidden (a backgrounded inbox has nothing to keep fresh).
  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) return
    let cancelled = false
    let debounce: ReturnType<typeof setTimeout> | null = null

    const channel = supabase
      .channel("whatsapp-inbox")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "phone_screening_participants" },
        () => {
          if (cancelled) return
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            if (!cancelled) void load({ quiet: true })
          }, 400)
        }
      )
      .subscribe()

    const onVisible = () => {
      if (document.visibilityState === "visible" && !cancelled) void load({ quiet: true })
    }
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      cancelled = true
      if (debounce) clearTimeout(debounce)
      document.removeEventListener("visibilitychange", onVisible)
      void supabase.removeChannel(channel)
    }
  }, [load])

  const withPending = useCallback(async (key: string, fn: () => Promise<void>) => {
    setPending((prev) => new Set(prev).add(key))
    try {
      await fn()
    } catch (e: any) {
      toast({ title: "Action failed", description: e?.message || "Please try again.", variant: "destructive" })
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [toast])

  const nudgeText = (t: ConversationThread) =>
    `Hi ${firstName(t.candidateName)}, following up on your application${t.jobTitle ? ` for ${t.jobTitle}` : ""}. Do you have a few minutes to chat?`

  const nudge = (t: ConversationThread) =>
    withPending(`nudge:${t.participantId}`, async () => {
      const res = await fetch(`/api/phone-screening/participants/${t.participantId}/send-message`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: nudgeText(t) }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || `Send failed (${res.status})`)
      }
      toast({ title: "Message sent", description: `WhatsApp message sent to ${t.candidateName}.` })
      await load({ quiet: true })
    })

  const callNow = (t: ConversationThread) =>
    withPending(`call:${t.participantId}`, async () => {
      const res = await fetch(`/api/phone-screening/call-now`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId: t.participantId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `Call failed (${res.status})`)
      toast({
        title: j?.callPlaced === false ? "Call not placed" : "Calling now",
        description:
          j?.callPlaced === false
            ? j?.error || j?.reason || "The provider did not accept the call."
            : `Placing a call to ${t.candidateName}.`,
        variant: j?.callPlaced === false ? "destructive" : undefined,
      })
      await load({ quiet: true })
    })

  const items = useMemo(() => data?.items ?? [], [data])
  const counts = data?.counts ?? {}

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((t) => {
      if (activeCategory !== "all" && t.category !== activeCategory) return false
      if (!q) return true
      return (
        t.candidateName.toLowerCase().includes(q) ||
        (t.jobTitle || "").toLowerCase().includes(q) ||
        (t.clientName || "").toLowerCase().includes(q) ||
        (t.preview || "").toLowerCase().includes(q)
      )
    })
  }, [items, activeCategory, search])

  const categoryChips: Array<{ key: "all" | ConversationCategory; label: string; count: number }> = [
    { key: "all", label: "All", count: data?.total ?? 0 },
    ...CONVERSATION_CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABELS[c], count: counts[c] || 0 })),
  ]

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            <MessageCircle className="h-5 w-5 text-emerald-600" /> WhatsApp
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Every candidate thread, newest first. Replies and requests that need a person surface here whatever the pipeline stage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, job, client…"
              className="h-9 w-56 pl-8"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {categoryChips.map((c) => {
          const active = activeCategory === c.key
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setActiveCategory(c.key)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {c.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${active ? "bg-white/20" : "bg-zinc-100 dark:bg-zinc-800"}`}>
                {c.count}
              </span>
            </button>
          )
        })}
      </div>

      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {loading && !data ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-64" />
                </div>
              </div>
            ))}
          </div>
        ) : error && !data ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Could not load conversations.</p>
            <p className="mt-1 text-xs text-zinc-500">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => load()}>
              Retry
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Inbox className="mx-auto mb-2 h-8 w-8 text-zinc-300" />
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {search ? "No threads match your search." : "Nothing here right now."}
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Messages land here as candidates reply, ask for a call, or go quiet.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map((t) => {
              const busy = pending.has(`nudge:${t.participantId}`) || pending.has(`call:${t.participantId}`)
              return (
                <div
                  key={t.participantId}
                  className="flex flex-wrap items-start gap-3 px-4 py-3 transition-colors hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30 sm:px-5"
                >
                  <button
                    type="button"
                    onClick={() => setConvoItem(t)}
                    className="flex min-w-0 flex-1 items-start gap-3 text-left"
                  >
                    <span className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-sm font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      {firstName(t.candidateName).charAt(0).toUpperCase() || "?"}
                      {t.unread && (
                        <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-sky-500 ring-2 ring-white dark:ring-zinc-900" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                          {t.candidateName}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${CATEGORY_STYLE[t.category]}`}>
                          {CATEGORY_LABELS[t.category]}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {[t.jobTitle, t.clientName].filter(Boolean).join(" · ") || "No live role"}
                      </span>
                      <span
                        className={`mt-0.5 block truncate text-xs ${
                          t.preview ? "text-zinc-700 dark:text-zinc-200" : "italic text-zinc-400 dark:text-zinc-500"
                        }`}
                      >
                        {t.preview ? `“${t.preview}”` : t.statusLabel}
                      </span>
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-2">
                    <span className="hidden text-[11px] text-zinc-400 sm:block">{relative(t.lastActivityAt)}</span>
                    <Button size="sm" onClick={() => setConvoItem(t)} disabled={busy}>
                      {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                      Open
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" disabled={busy}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuItem onSelect={() => nudge(t)}>
                          <MessageCircle className="mr-2 h-4 w-4" /> Nudge on WhatsApp
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => callNow(t)} disabled={!t.participantId}>
                          <PhoneCall className="mr-2 h-4 w-4" /> Call now
                        </DropdownMenuItem>
                        {t.jobId && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => router.push(`/jobs/${t.jobId}?tab=pipeline`)}>
                              <ExternalLink className="mr-2 h-4 w-4" /> Open job
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {data && (
        <p className="mt-3 text-center text-xs text-zinc-400">
          {filtered.length} of {data.total} threads · live updates on
        </p>
      )}

      <WhatsAppConversationModal
        history={[]}
        candidateName={convoItem?.candidateName ?? null}
        participantId={convoItem?.participantId ?? null}
        roleLabel={convoItem ? [convoItem.jobTitle, convoItem.clientName].filter(Boolean).join(" · ") || null : null}
        open={!!convoItem}
        onOpenChange={(open) => !open && setConvoItem(null)}
        onSent={() => load({ quiet: true })}
      />
    </div>
  )
}
