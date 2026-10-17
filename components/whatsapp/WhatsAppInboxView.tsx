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
  source?: "view" | "fallback"
  // null on append responses — counts only ride along on the first page.
  counts: Record<string, number> | null
  filteredTotal: number
  offset: number
  limit: number
  categories: ConversationCategory[]
  items: ConversationThread[]
}

const PAGE_LIMIT = 50
// Matches the API's MAX_LIMIT — a "refresh what's on screen" read must not exceed it.
const MAX_LIMIT = 200

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

  const [items, setItems] = useState<ConversationThread[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [filteredTotal, setFilteredTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<"all" | ConversationCategory>("needs_human")
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [convoItem, setConvoItem] = useState<ConversationThread | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())

  // Debounce the search box so each keystroke isn't its own server query.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  /**
   * One server read. `offset` 0 + `append:false` replaces the list; anything else
   * appends. `size` lets a post-action refresh reload exactly what's on screen.
   */
  // Monotonic id so a slow response can't overwrite a newer one (typing fast in
  // search, or a realtime refresh racing the initial load).
  const reqIdRef = useRef(0)

  const fetchPage = useCallback(
    async (opts: { offset: number; append: boolean; quiet?: boolean; size?: number }) => {
      const reqId = ++reqIdRef.current
      const size = Math.min(opts.size ?? PAGE_LIMIT, MAX_LIMIT)
      if (opts.append) setLoadingMore(true)
      else if (!opts.quiet) setLoading(true)
      try {
        const params = new URLSearchParams({
          category,
          offset: String(opts.offset),
          limit: String(size),
        })
        if (debounced) params.set("q", debounced)
        const res = await fetch(`/api/whatsapp/inbox?${params.toString()}`, { credentials: "include" })
        if (reqId !== reqIdRef.current) return
        if (!res.ok) {
          const detail = await res.text().catch(() => "")
          throw new Error(`${res.status} ${detail}`.trim())
        }
        const data = (await res.json()) as InboxResponse
        if (reqId !== reqIdRef.current) return
        if (data.counts) setCounts(data.counts)
        setFilteredTotal(data.filteredTotal ?? (data.items?.length || 0))
        setItems((prev) => (opts.append ? [...prev, ...(data.items || [])] : data.items || []))
        setError(null)
      } catch (e: any) {
        if (reqId === reqIdRef.current) setError(e?.message || "Could not load conversations")
      } finally {
        if (reqId === reqIdRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [category, debounced]
  )

  // Reload from the top whenever the filter/search changes.
  useEffect(() => {
    void fetchPage({ offset: 0, append: false })
  }, [fetchPage])

  // The realtime handler must not resubscribe on every filter change, so it reads
  // the latest loader through a ref (same pattern as the screening board).
  const fetchRef = useRef(fetchPage)
  // How many rows are on screen, for a bounded post-change refresh.
  const shownRef = useRef(PAGE_LIMIT)

  useEffect(() => {
    fetchRef.current = fetchPage
  }, [fetchPage])

  useEffect(() => {
    shownRef.current = Math.max(PAGE_LIMIT, items.length)
  }, [items.length])

  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) return
    let cancelled = false
    let debounce: ReturnType<typeof setTimeout> | null = null

    const refresh = () => {
      if (cancelled) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (cancelled) return
        // Reload whatever is on screen (bounded) so a new reply appears without
        // resetting the reader to page one.
        void fetchRef.current({ offset: 0, append: false, quiet: true, size: shownRef.current })
      }, 400)
    }

    const channel = supabase
      .channel("whatsapp-inbox")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "phone_screening_participants" },
        refresh
      )
      .subscribe()

    const onVisible = () => {
      if (document.visibilityState === "visible" && !cancelled) refresh()
    }
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      cancelled = true
      if (debounce) clearTimeout(debounce)
      document.removeEventListener("visibilitychange", onVisible)
      void supabase.removeChannel(channel)
    }
  }, [])

  const withPending = useCallback(
    async (key: string, fn: () => Promise<void>) => {
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
    },
    [toast]
  )

  const nudgeText = (t: ConversationThread) =>
    `Hi ${firstName(t.candidateName)}, following up on your application${t.jobTitle ? ` for ${t.jobTitle}` : ""}. Do you have a few minutes to chat?`

  const refreshOnScreen = () =>
    fetchPage({ offset: 0, append: false, quiet: true, size: Math.max(PAGE_LIMIT, items.length) })

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
      await refreshOnScreen()
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
      await refreshOnScreen()
    })

  const categoryChips: Array<{ key: "all" | ConversationCategory; label: string; count: number }> = useMemo(
    () => [
      { key: "all", label: "All", count: counts.total || 0 },
      ...CONVERSATION_CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABELS[c], count: counts[c] || 0 })),
    ],
    [counts]
  )

  const hasMore = items.length < filteredTotal

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            <MessageCircle className="h-5 w-5 text-emerald-600" /> WhatsApp
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Every candidate thread, newest first. Replies and requests that need a person surface here whatever the
            pipeline stage.
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
          <Button variant="outline" size="sm" onClick={() => refreshOnScreen()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {categoryChips.map((c) => {
          const active = category === c.key
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(c.key)}
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
        {loading && items.length === 0 ? (
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
        ) : error && items.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Could not load conversations.</p>
            <p className="mt-1 text-xs text-zinc-500">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => fetchPage({ offset: 0, append: false })}>
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Inbox className="mx-auto mb-2 h-8 w-8 text-zinc-300" />
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {debounced ? "No threads match your search." : "Nothing here right now."}
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Messages land here as candidates reply, ask for a call, or go quiet.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {items.map((t) => {
              const busy = pending.has(`nudge:${t.participantId}`) || pending.has(`call:${t.participantId}`)
              return (
                <div
                  key={t.participantId}
                  className="flex flex-wrap items-start gap-3 px-4 py-3 transition-colors hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30 sm:px-5"
                >
                  <button type="button" onClick={() => setConvoItem(t)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
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

      <div className="mt-3 flex flex-col items-center gap-2">
        {hasMore && (
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={() => fetchPage({ offset: items.length, append: true })}
          >
            {loadingMore ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Load more
          </Button>
        )}
        {!loading && (
          <p className="text-center text-xs text-zinc-400">
            {items.length} of {filteredTotal} threads · live updates on
          </p>
        )}
      </div>

      <WhatsAppConversationModal
        history={[]}
        candidateName={convoItem?.candidateName ?? null}
        participantId={convoItem?.participantId ?? null}
        roleLabel={convoItem ? [convoItem.jobTitle, convoItem.clientName].filter(Boolean).join(" · ") || null : null}
        open={!!convoItem}
        onOpenChange={(open) => !open && setConvoItem(null)}
        onSent={() => refreshOnScreen()}
      />
    </div>
  )
}
