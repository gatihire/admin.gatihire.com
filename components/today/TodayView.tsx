"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import {
  AlarmClock,
  Building2,
  CalendarClock,
  CheckCircle2,
  Eye,
  FileText,
  Flag,
  Inbox,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Phone,
  PhoneCall,
  RefreshCw,
  Send,
  UserMinus,
  Users,
  UserX,
} from "lucide-react"
import { PhoneScreeningResultsSheet } from "@/components/phone-screening-results-sheet"
import { WhatsAppConversationModal } from "@/components/whatsapp-conversation-modal"
import { useToast } from "@/hooks/use-toast"
import { useInternalPermissions } from "@/hooks/use-internal-permissions"
import {
  formatAge,
  kindLabel,
  WORK_ITEM_KINDS,
  type WorkItem,
  type WorkItemKind,
  type DispatchStats,
  type RailInterview,
  type RailReady,
  type RailLiveCall,
} from "@/lib/dispatch/engine"

type Scope = "mine" | "team"

interface TodayResponse {
  scope: Scope
  canViewTeam: boolean
  viewer: { id: string; name: string | null; email: string | null }
  generatedAt: string
  stats: DispatchStats
  counts: Record<string, number>
  items: WorkItem[]
  rail: {
    interviews: RailInterview[]
    ready: RailReady[]
    live_calls: RailLiveCall[]
  }
}

const SNOOZE_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 4, label: "Later today" },
  { hours: 24, label: "Tomorrow" },
  { hours: 72, label: "In 3 days" },
  { hours: 168, label: "In a week" },
]

const CALL_OUTCOMES = ["connected", "no answer", "busy", "voicemail", "wrong number", "callback booked"]

const KIND_STYLE: Record<WorkItemKind, string> = {
  human: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900",
  ghosted: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900/50 dark:text-slate-300 dark:border-slate-700",
  reply: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
  declined: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  resched: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900",
  overdue: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  call: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900",
  hold: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
  client: "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-900",
  shortlist: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  offer: "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900",
}

const KIND_ICON: Record<WorkItemKind, React.ComponentType<{ className?: string }>> = {
  human: PhoneCall,
  ghosted: UserX,
  reply: MessageCircle,
  declined: UserMinus,
  hold: Flag,
  call: Eye,
  resched: CalendarClock,
  client: CheckCircle2,
  overdue: Building2,
  offer: FileText,
  shortlist: Send,
}

const PILL_STYLE: Record<string, string> = {
  default: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  hot: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  info: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  good: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
}

function slaClasses(slaState: WorkItem["slaState"]): string {
  if (slaState === "late") return "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300"
  if (slaState === "warn") return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
  return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return "Good morning"
  if (h < 17) return "Good afternoon"
  return "Good evening"
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function firstName(name: string): string {
  return name.split(" ")[0] || name
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || json?.message || "Action failed")
  return json
}

export function TodayView({ canViewTeam, defaultScope }: { canViewTeam: boolean; defaultScope: Scope }) {
  const router = useRouter()
  const { toast } = useToast()
  const { can } = useInternalPermissions()
  const canManage = can("applications.manage")

  const [data, setData] = useState<TodayResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>(defaultScope)
  const [kindFilter, setKindFilter] = useState<"all" | WorkItemKind>("all")
  const [includeSnoozed, setIncludeSnoozed] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Set<string>>(new Set())

  // Modals
  const [sheetItem, setSheetItem] = useState<WorkItem | null>(null)
  const [convoItem, setConvoItem] = useState<WorkItem | null>(null)
  const [callItem, setCallItem] = useState<WorkItem | null>(null)
  const [callOutcome, setCallOutcome] = useState(CALL_OUTCOMES[0])
  const [callNote, setCallNote] = useState("")
  const [callbackItem, setCallbackItem] = useState<WorkItem | null>(null)
  const [callbackAt, setCallbackAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)))

  const load = useCallback(
    async (opts?: { scope?: Scope; includeSnoozed?: boolean; quiet?: boolean }) => {
      const nextScope = opts?.scope ?? scope
      const nextSnoozed = opts?.includeSnoozed ?? includeSnoozed
      if (opts?.quiet) setRefreshing(true)
      else setLoading(true)
      setError(null)
      try {
        const qs = new URLSearchParams({ scope: nextScope })
        if (nextSnoozed) qs.set("includeSnoozed", "true")
        const res = await fetch(`/api/dispatch/today?${qs.toString()}`, { credentials: "include", cache: "no-store" })
        const json = await res.json().catch(() => null)
        if (!res.ok) throw new Error((json as any)?.error || "Could not load your queue")
        setData(json as TodayResponse)
        setScope((json as TodayResponse).scope)
        setSelected(new Set())
      } catch (e: any) {
        setError(e?.message || "Something went wrong")
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [scope, includeSnoozed]
  )

  useEffect(() => {
    void load({ scope: defaultScope, includeSnoozed: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const items = useMemo(() => data?.items ?? [], [data])
  const counts = useMemo(() => data?.counts ?? {}, [data])
  const rail = data?.rail

  const filtered = useMemo(
    () => (kindFilter === "all" ? items : items.filter((i) => i.kind === kindFilter)),
    [items, kindFilter]
  )

  const presentKinds = useMemo(() => WORK_ITEM_KINDS.filter((k) => (counts[k] || 0) > 0), [counts])

  // ── plumbing ────────────────────────────────────────────────────────────
  const withPending = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setPending((p) => new Set(p).add(key))
      try {
        await fn()
      } catch (e: any) {
        toast({ title: "Action failed", description: e?.message || "Something went wrong", variant: "destructive" })
      } finally {
        setPending((p) => {
          const n = new Set(p)
          n.delete(key)
          return n
        })
      }
    },
    [toast]
  )

  const applyWorkItems = useCallback(
    async (applicationIds: string[], body: Record<string, any>) => {
      if (applicationIds.length === 0) return
      if (applicationIds.length === 1) {
        await api(`/api/dispatch/work-items/${applicationIds[0]}`, { method: "PATCH", body: JSON.stringify(body) })
      } else {
        await api(`/api/dispatch/work-items`, { method: "POST", body: JSON.stringify({ ...body, applicationIds }) })
      }
      await load({ quiet: true })
    },
    [load]
  )

  const toggleSelected = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  // Only stages that exist as pipeline columns can be deep-linked; anything else
  // (legacy statuses like hr_review) would land the user on an empty board.
  const KNOWN_STAGES = new Set([
    "applied",
    "ai_screen",
    "shortlist",
    "interview",
    "offer",
    "hired",
    "rejected",
  ])
  const jobLink = (item: WorkItem, stage?: string) =>
    `/jobs/${item.jobId}?tab=pipeline${
      stage && KNOWN_STAGES.has(stage) ? `&stage=${stage}` : ""
    }`

  // ── row actions ─────────────────────────────────────────────────────────
  const openResults = (item: WorkItem) => {
    if (!item.participantId) {
      router.push(jobLink(item, item.stage))
      return
    }
    setSheetItem(item)
  }

  const openConversation = (item: WorkItem) => {
    if (!item.participantId) {
      router.push(jobLink(item, item.stage))
      return
    }
    setConvoItem(item)
  }

  const callNow = (item: WorkItem) =>
    withPending(`call:${item.key}`, async () => {
      if (!item.participantId) throw new Error("No screening participant on this application")
      const res = await api(`/api/phone-screening/call-now`, {
        method: "POST",
        body: JSON.stringify({ participantId: item.participantId }),
      })
      toast({
        title: res?.callPlaced === false ? "Call not placed" : "Calling now",
        description:
          res?.callPlaced === false
            ? res?.error || res?.reason || "The provider did not accept the call."
            : `Placing a call to ${item.candidateName}.`,
        variant: res?.callPlaced === false ? "destructive" : undefined,
      })
      await load({ quiet: true })
    })

  const nudgeText = (item: WorkItem) =>
    `Hi ${firstName(item.candidateName)}, following up on your application for ${item.jobTitle}. Do you have a few minutes to chat?`

  const nudgeOne = async (item: WorkItem) => {
    if (!item.participantId) throw new Error("No WhatsApp participant")
    await api(`/api/phone-screening/participants/${item.participantId}/send-message`, {
      method: "POST",
      body: JSON.stringify({ text: nudgeText(item) }),
    })
  }

  const remindClient = (item: WorkItem) =>
    withPending(`remind:${item.key}`, async () => {
      if (!item.shareId) {
        router.push(jobLink(item, "client_review"))
        return
      }
      await api(`/api/jobs/${item.jobId}/shortlist-share`, {
        method: "POST",
        body: JSON.stringify({ resendShareId: item.shareId }),
      })
      toast({ title: "Reminder sent", description: `The client has been nudged about ${item.jobTitle}.` })
      await load({ quiet: true })
    })

  const runPrimary = (item: WorkItem) => {
    switch (item.primaryAction) {
      case "nudge":
        return withPending(`nudge:${item.key}`, async () => {
          await nudgeOne(item)
          toast({ title: "Nudge sent", description: `WhatsApp message sent to ${item.candidateName}.` })
          await load({ quiet: true })
        })
      case "reply":
        return openConversation(item)
      case "review":
      case "decide":
        return openResults(item)
      case "call":
        return callNow(item)
      case "remind":
        return remindClient(item)
      case "schedule":
      case "resched":
        return router.push(jobLink(item, "interview"))
      case "share":
        return router.push(jobLink(item, "shortlist"))
      case "offer":
        return router.push(jobLink(item, "offer"))
      default:
        return router.push(jobLink(item, item.stage))
    }
  }

  const logCallOutcome = (item: WorkItem, outcome: string, note: string, hours?: number) =>
    withPending(`log:${item.key}`, async () => {
      await applyWorkItems([item.applicationId], { action: "log_call", outcome, note, hours })
      toast({
        title: "Call logged",
        description: hours ? `${item.candidateName} · hidden for ${hours >= 24 ? `${hours / 24}d` : `${hours}h`}.` : item.candidateName,
      })
    })

  const snoozeOne = (item: WorkItem, hours: number) =>
    withPending(`snooze:${item.key}`, async () => {
      await applyWorkItems([item.applicationId], { action: "snooze", hours })
    })

  const setCallback = (item: WorkItem, untilLocal: string) =>
    withPending(`callback:${item.key}`, async () => {
      const when = new Date(untilLocal)
      if (!Number.isFinite(when.getTime())) throw new Error("Pick a valid time")
      await applyWorkItems([item.applicationId], {
        action: "snooze",
        until: when.toISOString(),
        reason: "Callback requested",
      })
      toast({ title: "Callback scheduled", description: `${item.candidateName} · ${when.toLocaleString()}` })
    })

  const dropApplications = (applicationIds: string[], key: string) =>
    withPending(key, async () => {
      await Promise.all(
        applicationIds.map((id) =>
          api(`/api/applications/${id}`, {
            method: "PUT",
            body: JSON.stringify({ status: "rejected", notes: "Dropped from the Today queue" }),
          })
        )
      )
      toast({ title: "Dropped", description: `${applicationIds.length} application(s) rejected.` })
      await load({ quiet: true })
    })

  // ── bulk actions ────────────────────────────────────────────────────────
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.applicationId)), [items, selected])

  const bulkNudge = () =>
    withPending("bulk:nudge", async () => {
      const targets = selectedItems.filter((i) => i.participantId)
      if (targets.length === 0) throw new Error("None of the selected rows have a WhatsApp thread")
      const results = await Promise.allSettled(targets.map((i) => nudgeOne(i)))
      const ok = results.filter((r) => r.status === "fulfilled").length
      toast({
        title: `Nudged ${ok} of ${targets.length}`,
        variant: ok === 0 ? "destructive" : undefined,
      })
      await load({ quiet: true })
    })

  const stats = data?.stats
  const viewerName = data?.viewer?.name || (data?.viewer?.email ? data.viewer.email.split("@")[0] : "")

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {greeting()}
            {viewerName ? `, ${viewerName}` : ""}
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {stats?.waiting
              ? `${stats.waiting} item${stats.waiting === 1 ? "" : "s"} need you across ${stats.open_jobs} open job${stats.open_jobs === 1 ? "" : "s"}.`
              : "Nothing is waiting on you right now."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canViewTeam && (
            <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
              {(["mine", "team"] as Scope[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => load({ scope: s })}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    scope === s
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                      : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                >
                  {s === "mine" ? "My accounts" : "Team"}
                </button>
              ))}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => load({ scope, includeSnoozed, quiet: true })} disabled={loading || refreshing}>
            {loading || refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={<Inbox className="h-4 w-4" />} label="Waiting on you" value={stats?.waiting ?? 0} accent />
        <StatCard icon={<Users className="h-4 w-4" />} label="Candidates" value={stats?.candidates ?? 0} />
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="Shortlisted or later" value={stats?.shortlisted_or_later ?? 0} />
        <StatCard icon={<FileText className="h-4 w-4" />} label="Hired" value={stats?.hired ?? 0} />
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Queue */}
        <div className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Candidates waiting on you</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Every candidate the pipeline says needs a human decision, most urgent first.
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <Checkbox
                checked={includeSnoozed}
                onCheckedChange={(v) => {
                  const next = v === true
                  setIncludeSnoozed(next)
                  void load({ scope, includeSnoozed: next })
                }}
              />
              Show snoozed
            </label>
          </div>

          {/* Filter chips */}
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
            <Chip active={kindFilter === "all"} onClick={() => setKindFilter("all")} label="All" count={items.length} />
            {presentKinds.map((k) => (
              <Chip
                key={k}
                active={kindFilter === k}
                onClick={() => setKindFilter(k)}
                label={kindLabel(k)}
                count={counts[k] || 0}
              />
            ))}
          </div>

          {/* Bulk bar */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 bg-blue-50/60 px-5 py-2.5 dark:border-zinc-800 dark:bg-blue-950/20">
              <span className="text-xs font-medium text-blue-800 dark:text-blue-300">{selected.size} selected</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending.has("bulk:nudge")}
                  onClick={bulkNudge}
                >
                  <MessageCircle className="mr-1.5 h-3.5 w-3.5" /> Nudge on WhatsApp
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending.has("bulk:snooze")}
                  onClick={() =>
                    withPending("bulk:snooze", () =>
                      applyWorkItems(Array.from(selected), { action: "snooze", hours: 24 })
                    )
                  }
                >
                  Snooze 1 day
                </Button>
                {canManage && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600 hover:text-red-700 dark:text-red-400"
                    disabled={pending.has("bulk:drop")}
                    onClick={() => {
                      if (confirm(`Drop ${selected.size} application(s)? This rejects them.`)) {
                        dropApplications(Array.from(selected), "bulk:drop")
                      }
                    }}
                  >
                    Drop
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            </div>
          )}

          {/* Rows */}
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {loading && !data ? (
              <div className="flex items-center justify-center gap-2 px-5 py-16 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading your queue…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-5 py-16 text-center">
                <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-500" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                  {kindFilter === "all" ? "Nothing waiting here." : "Nothing in this filter."}
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Calls, replies and client decisions land in this list when they need you.
                </p>
              </div>
            ) : (
              filtered.map((item) => {
                const Icon = KIND_ICON[item.kind]
                const grouped = (item.groupCount ?? 0) > 1
                const busy = pending.has(`call:${item.key}`) || pending.has(`remind:${item.key}`)
                const secondary = item.actions
                  .filter((a) => a.id !== "log_call" && a.id !== "snooze")
                  .slice(1)
                return (
                  <div
                    key={item.key}
                    className="flex flex-wrap items-start gap-4 px-5 py-4 transition-colors hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30"
                  >
                    {item.selectable ? (
                      <div className="pt-1">
                        <Checkbox
                          checked={selected.has(item.applicationId)}
                          onCheckedChange={(v) => toggleSelected(item.applicationId, v === true)}
                        />
                      </div>
                    ) : (
                      <div className="w-4 pt-1" />
                    )}

                    <span
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${KIND_STYLE[item.kind]}`}
                      title={item.kindLabel}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                          {item.candidateName}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${KIND_STYLE[item.kind]}`}>
                          {item.kindLabel}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${slaClasses(item.slaState)}`}>
                          <AlarmClock className="mr-1 inline h-3 w-3 align-[-2px]" />
                          Waiting {formatAge(item.ageHours)}
                        </span>
                        {item.snoozed && (
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            Snoozed
                          </span>
                        )}
                        {item.pills.map((p) => (
                          <span
                            key={p.label}
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${PILL_STYLE[p.tone || "default"]}`}
                          >
                            {p.label}
                          </span>
                        ))}
                      </div>

                      <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-200">{item.title}</p>
                      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                        {[item.jobTitle, item.clientName, item.candidateMeta].filter(Boolean).join(" · ")}
                      </p>
                      {item.detail && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{item.detail}</p>}
                      {item.quote && (
                        <p className="mt-1.5 border-l-2 border-zinc-200 pl-2 text-xs italic text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                          “{item.quote}”
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button size="sm" onClick={() => runPrimary(item)} disabled={busy}>
                        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        {item.cta}
                      </Button>
                      {secondary.map((a) => (
                        <Button
                          key={a.id}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            a.id === "call"
                              ? callNow(item)
                              : a.id === "review"
                                ? openResults(item)
                                : runPrimary(item)
                          }
                        >
                          {a.label}
                        </Button>
                      ))}
                      {!grouped && (
                        <RowMenu
                          disabled={busy}
                          onCall={(outcome, hours) =>
                            logCallOutcome(item, outcome, `Logged from Today queue: ${outcome}`, hours)
                          }
                          onCallback={() => {
                            setCallbackItem(item)
                            setCallbackAt(toLocalInput(new Date(Date.now() + 60 * 60 * 1000)))
                          }}
                          onLogCall={() => {
                            setCallItem(item)
                            setCallOutcome(CALL_OUTCOMES[0])
                            setCallNote("")
                          }}
                          onSnooze={(hours) => snoozeOne(item, hours)}
                        />
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {(stats?.with_client ?? 0) > 0 && (
            <div className="border-t border-zinc-100 px-5 py-3 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              {stats!.with_client} candidate{stats!.with_client === 1 ? " is" : "s are"} with clients. Nothing to do until they decide.
            </div>
          )}
        </div>

        {/* Right rail */}
        <aside className="space-y-4">
          <RailCard title="Interviews this week" empty="No interviews booked in the next 7 days.">
            {(rail?.interviews ?? []).map((iv) => (
              <button
                key={iv.applicationId}
                type="button"
                onClick={() => router.push(`/jobs/${iv.jobId}?tab=pipeline&stage=interview`)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
              >
                <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">
                    {iv.candidateName}
                  </span>
                  <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {iv.scheduledAt ? new Date(iv.scheduledAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "Time TBC"}
                    {" · "}
                    {iv.jobTitle}
                  </span>
                </span>
              </button>
            ))}
          </RailCard>

          <RailCard title="Ready to send to the client" empty="Nothing waiting to go to a client.">
            {(rail?.ready ?? []).map((r) => (
              <div key={r.jobId} className="flex items-center justify-between gap-2 px-2 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">{r.jobTitle}</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                    {r.count} candidate{r.count === 1 ? "" : "s"}
                    {r.clientName ? ` · ${r.clientName}` : ""}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push(`/jobs/${r.jobId}?tab=pipeline&stage=shortlist`)}
                >
                  Send
                </Button>
              </div>
            ))}
          </RailCard>

          <RailCard title="On the line" empty="No calls in progress.">
            {(rail?.live_calls ?? []).map((c) => (
              <div key={c.applicationId} className="flex items-start gap-2 px-2 py-2">
                <PhoneCall className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">{c.candidateName}</span>
                  <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {c.callLabel} · {c.jobTitle}
                  </span>
                </span>
              </div>
            ))}
          </RailCard>
        </aside>
      </div>

      {/* Screening results / questions sheet */}
      <PhoneScreeningResultsSheet
        participantId={sheetItem?.participantId ?? null}
        open={!!sheetItem}
        onOpenChange={(open) => !open && setSheetItem(null)}
        onReviewed={() => load({ quiet: true })}
      />

      {/* WhatsApp conversation */}
      <WhatsAppConversationModal
        history={[]}
        candidateName={convoItem?.candidateName ?? null}
        participantId={convoItem?.participantId ?? null}
        roleLabel={convoItem?.jobTitle ?? null}
        open={!!convoItem}
        onOpenChange={(open) => !open && setConvoItem(null)}
        onSent={() => load({ quiet: true })}
      />

      {/* Log-call dialog */}
      <Dialog open={!!callItem} onOpenChange={(open) => !open && setCallItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log a call</DialogTitle>
            <DialogDescription>
              {callItem ? `${callItem.candidateName} · ${callItem.jobTitle}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Outcome</label>
              <select
                value={callOutcome}
                onChange={(e) => setCallOutcome(e.target.value)}
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {CALL_OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Note (optional)</label>
              <Textarea value={callNote} onChange={(e) => setCallNote(e.target.value)} rows={3} placeholder="What was said…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCallItem(null)}>
              Cancel
            </Button>
            <Button
              disabled={!!callItem && pending.has(`log:${callItem.key}`)}
              onClick={async () => {
                if (!callItem) return
                await logCallOutcome(callItem, callOutcome, callNote)
                setCallItem(null)
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Callback time dialog */}
      <Dialog open={!!callbackItem} onOpenChange={(open) => !open && setCallbackItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>They asked for a call at</DialogTitle>
            <DialogDescription>
              {callbackItem ? `${callbackItem.candidateName} · ${callbackItem.jobTitle}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Date &amp; time</label>
            <input
              type="datetime-local"
              value={callbackAt}
              onChange={(e) => setCallbackAt(e.target.value)}
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              The row is hidden until then, so it resurfaces exactly when they asked to be called.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCallbackItem(null)}>
              Cancel
            </Button>
            <Button
              disabled={!!callbackItem && pending.has(`callback:${callbackItem.key}`)}
              onClick={async () => {
                if (!callbackItem) return
                await setCallback(callbackItem, callbackAt)
                setCallbackItem(null)
              }}
            >
              Set
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: number
  accent?: boolean
}) {
  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${
        accent
          ? "border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        <span className={accent ? "text-blue-600 dark:text-blue-300" : ""}>{icon}</span>
        {label}
      </div>
      <div className={`mt-2 text-2xl font-semibold ${accent ? "text-blue-700 dark:text-blue-200" : "text-zinc-900 dark:text-zinc-50"}`}>
        {value}
      </div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
          : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }`}
    >
      {label}
      <span className="ml-1.5 text-[11px] text-zinc-400">{count}</span>
    </button>
  )
}

function RailCard({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: React.ReactNode
}) {
  const arr = Array.isArray(children) ? children.flat() : children
  const isEmpty = !arr || (Array.isArray(arr) && arr.length === 0)
  return (
    <div className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</h3>
      </div>
      <div className="p-2">
        {isEmpty ? (
          <p className="px-2 py-3 text-xs text-zinc-400 dark:text-zinc-500">{empty}</p>
        ) : (
          arr
        )}
      </div>
    </div>
  )
}

function RowMenu({
  disabled,
  onCall,
  onCallback,
  onLogCall,
  onSnooze,
}: {
  disabled?: boolean
  onCall: (outcome: string, hours: number) => void
  onCallback: () => void
  onLogCall: () => void
  onSnooze: (hours: number) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} aria-label="More actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>I called them</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onCall("no answer", 4)}>No answer · hide 4h</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCall("busy", 2)}>Line busy · hide 2h</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCall("wrong number", 168)}>Wrong number · hide 7 days</DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogCall}>
          <Phone className="mr-2 h-3.5 w-3.5" /> Log a call with a note…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>They asked for a call at</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onCallback}>Set a time…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Not now</DropdownMenuLabel>
        {SNOOZE_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.hours} onSelect={() => onSnooze(o.hours)}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
