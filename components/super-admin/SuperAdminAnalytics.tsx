"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Bar, BarChart, Line, LineChart, XAxis, YAxis } from "recharts"
import { Activity, ArrowUpRight, Briefcase, FileText, Info, Send, UserPlus } from "lucide-react"
import { cachedFetchJson } from "@/lib/utils"

type SeriesPoint = Record<string, any> & { day: string }

type OverviewResponse = {
  range: { from: string; to: string }
  kpis: Record<string, { value: number; previous?: number; delta_pct: number }>
  series: SeriesPoint[]
}

type GrowthResponse = {
  range: { from: string; to: string }
  totals: {
    total_users: number
    signups: number
    logins: number
    sessions: number
    page_views: number
    active_users: { dau: number; wau: number; mau: number }
    activation_rate: number
  }
  series: Array<{ day: string; signups: number; sessions: number; activated: number; activation_rate: number }>
}

type JobsResponse = {
  range: { from: string; to: string }
  totals: {
    open_jobs: number
    closed_jobs: number
    jobs_created: number
    applications: number
    applications_per_job_avg: number
    conversion: {
      view_to_apply_start: number
      apply_start_to_submit: number
      view_to_apply_submit: number
    }
  }
  series: Array<{ day: string; jobs_created: number; applications: number; job_views: number; applies: number }>
  top_jobs: Array<{ id: string; title: string; status: string | null; created_at: string; applications: number; views: number }>
}

type CandidatesResponse = {
  range: { from: string; to: string }
  totals: {
    candidates_added: number
    candidates_contacted: number
    opened: number
    failed: number
    response_rate: number
    avg_time_to_first_response_seconds: number
  }
  series: Array<{ day: string; candidates_added: number; contacted: number; opened: number }>
}

type OutreachResponse = {
  range: { from: string; to: string }
  totals: {
    total: number
    by_status: Record<string, number>
    by_type: Record<string, number>
    open_rate: number
    failure_rate: number
  }
  series: Array<{ day: string; sent: number; delivered: number; opened: number; failed: number }>
  by_user: Record<string, { sent: number; delivered: number; opened: number; failed: number }>
}

type TeamResponse = {
  range: { from: string; to: string }
  rows: Array<{
    user: { id: string; email: string; name: string | null; last_active_at: string | null }
    metrics: {
      jobs_posted: number
      candidates_uploaded: number
      outreach_messages: number
      applications_created: number
    }
  }>
}

type EventsResponse = {
  events: Array<{
    id: string
    created_at: string
    actor_auth_user_id: string | null
    event_name: string
    entity_type: string | null
    entity_id: string | null
    metadata: any
  }>
}

const EVENT_NAMES = [
  "session_start",
  "page_view",
  "login_succeeded",
  "board.job.viewed",
  "board.apply.dialog_opened",
  "board.apply.started",
  "board.apply.submit_clicked",
  "board.apply.submitted",
  "board.signup.oauth_clicked",
  "board.profile.updated",
  "candidate.uploaded",
  "job.created",
  "application.created",
]

const REQUIRED_EVENT_PROPERTIES: Record<string, string[]> = {
  session_start: ["session_id", "path"],
  page_view: ["session_id", "path"],
  login_succeeded: ["method"],
  "board.job.viewed": ["job_id"],
  "board.apply.dialog_opened": ["job_id"],
  "board.apply.started": ["job_id"],
  "board.apply.submit_clicked": ["job_id"],
  "board.apply.submitted": ["job_id", "candidate_id"],
  "board.signup.oauth_clicked": ["job_id", "provider"],
  "board.profile.updated": ["candidate_id"],
  "candidate.uploaded": ["file_name"],
  "job.created": ["title"],
  "application.created": ["job_id", "candidate_id"],
}

function isoDateOnly(d: Date) {
  const x = new Date(d)
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset())
  return x.toISOString().slice(0, 10)
}

function fmt(n: number) {
  return new Intl.NumberFormat().format(n)
}

function fmtPct(v: number) {
  return `${(v * 100).toFixed(1)}%`
}

function fmtDelta(v: number) {
  const sign = v > 0 ? "+" : ""
  return `${sign}${v.toFixed(1)}%`
}

function deltaDetails(current: number, previous: number, delta: number) {
  const base = `Current ${fmt(current)} · Previous ${fmt(previous)} · Change ${fmtDelta(delta)}`
  if (previous <= 0) return base
  return `${base} · (${fmt(current)} - ${fmt(previous)}) / ${fmt(previous)}`
}

function KpiCard(props: {
  title: string
  icon: React.ReactNode
  value: string
  delta?: number
  help?: string
  current?: number
  previous?: number
}) {
  const showDeltaDetails =
    typeof props.current === "number" && typeof props.previous === "number" && typeof props.delta === "number"
  const tooltipContent = props.help || showDeltaDetails ? (
    <div className="space-y-1">
      {props.help ? <div>{props.help}</div> : null}
      {showDeltaDetails ? <div>{deltaDetails(props.current!, props.previous!, props.delta!)}</div> : null}
    </div>
  ) : null

  return (
    <Card className="border-zinc-200 bg-white">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500 flex items-center gap-2">
              <span>{props.title}</span>
              {tooltipContent ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                    >
                      <Info className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{tooltipContent}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <div className="text-2xl font-semibold tracking-tight mt-1">{props.value}</div>
          </div>
          <div className="h-9 w-9 rounded-lg bg-zinc-100 flex items-center justify-center text-zinc-700">{props.icon}</div>
        </div>
        {typeof props.delta === "number" ? (
          <div className={`mt-2 text-xs ${props.delta >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtDelta(props.delta)}</div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ChartCard(props: {
  title: string
  children: React.ReactNode
  right?: React.ReactNode
}) {
  return (
    <Card className="border-zinc-200 bg-white">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm">{props.title}</CardTitle>
          {props.right}
        </div>
      </CardHeader>
      <CardContent className="pt-0">{props.children}</CardContent>
    </Card>
  )
}

export function SuperAdminAnalytics() {
  const [fromDate, setFromDate] = useState(() => isoDateOnly(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)))
  const [toDate, setToDate] = useState(() => isoDateOnly(new Date()))
  const [monthValue, setMonthValue] = useState("")
  const [fyValue, setFyValue] = useState("")
  const [tab, setTab] = useState("overview")
  const [error, setError] = useState("")

  const qs = useMemo(() => {
    return new URLSearchParams({
      from: new Date(fromDate).toISOString(),
      to: new Date(toDate).toISOString(),
    }).toString()
  }, [fromDate, toDate])

  const monthOptions = useMemo(() => {
    const now = new Date()
    const options: Array<{ value: string; label: string }> = []
    for (let i = 0; i < 24; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      const label = d.toLocaleString("en-IN", { month: "short", year: "numeric" })
      options.push({ value, label })
    }
    return options
  }, [])

  const fyOptions = useMemo(() => {
    const now = new Date()
    const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
    const options: Array<{ value: string; label: string }> = []
    for (let y = fyStartYear - 4; y <= fyStartYear + 1; y += 1) {
      const label = `FY ${y}-${String(y + 1).slice(-2)}`
      options.push({ value: String(y), label })
    }
    return options.reverse()
  }, [])

  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [growth, setGrowth] = useState<GrowthResponse | null>(null)
  const [jobs, setJobs] = useState<JobsResponse | null>(null)
  const [candidates, setCandidates] = useState<CandidatesResponse | null>(null)
  const [outreach, setOutreach] = useState<OutreachResponse | null>(null)
  const [team, setTeam] = useState<TeamResponse | null>(null)
  const [events, setEvents] = useState<EventsResponse | null>(null)
  const [eventsExplorer, setEventsExplorer] = useState<EventsResponse | null>(null)
  const [eventNameFilter, setEventNameFilter] = useState("")
  const [eventActorFilter, setEventActorFilter] = useState("")
  const [eventEntityTypeFilter, setEventEntityTypeFilter] = useState("")
  const [eventEntityIdFilter, setEventEntityIdFilter] = useState("")
  const [eventLimit, setEventLimit] = useState("200")
  const [loading, setLoading] = useState(false)

  const loadTab = useCallback(async (opts?: { force?: boolean }) => {
    setLoading(true)
    setError("")
    try {
      if (tab === "overview") {
        const [aj, ej] = await Promise.all([
          cachedFetchJson<OverviewResponse>(
            `internal:super-admin:analytics:overview:${qs}`,
            `/api/super-admin/analytics/overview?${qs}`,
            undefined,
            { ttlMs: 60_000, force: Boolean(opts?.force) },
          ),
          cachedFetchJson<EventsResponse>(
            `internal:super-admin:analytics:events:${qs}:limit:20`,
            `/api/super-admin/analytics/events?${qs}&limit=20`,
            undefined,
            { ttlMs: 60_000, force: Boolean(opts?.force) },
          ),
        ])
        setOverview(aj)
        setEvents(ej)
        return
      }
      if (tab === "growth") {
        const json = await cachedFetchJson<GrowthResponse>(
          `internal:super-admin:analytics:growth:${qs}`,
          `/api/super-admin/analytics/growth?${qs}`,
          undefined,
          { ttlMs: 60_000, force: Boolean(opts?.force) },
        )
        setGrowth(json)
        return
      }
      if (tab === "jobs") {
        const json = await cachedFetchJson<JobsResponse>(
          `internal:super-admin:analytics:jobs:${qs}`,
          `/api/super-admin/analytics/jobs?${qs}`,
          undefined,
          { ttlMs: 60_000, force: Boolean(opts?.force) },
        )
        setJobs(json)
        return
      }
      if (tab === "candidates") {
        const json = await cachedFetchJson<CandidatesResponse>(
          `internal:super-admin:analytics:candidates:${qs}`,
          `/api/super-admin/analytics/candidates?${qs}`,
          undefined,
          { ttlMs: 60_000, force: Boolean(opts?.force) },
        )
        setCandidates(json)
        return
      }
      if (tab === "outreach") {
        const json = await cachedFetchJson<OutreachResponse>(
          `internal:super-admin:analytics:outreach:${qs}`,
          `/api/super-admin/analytics/outreach?${qs}`,
          undefined,
          { ttlMs: 60_000, force: Boolean(opts?.force) },
        )
        setOutreach(json)
        return
      }
      if (tab === "team") {
        const json = await cachedFetchJson<TeamResponse>(
          `internal:super-admin:analytics:team:${qs}`,
          `/api/super-admin/analytics/team?${qs}`,
          undefined,
          { ttlMs: 60_000, force: Boolean(opts?.force) },
        )
        setTeam(json)
        return
      }
      if (tab === "events") {
        const params = new URLSearchParams({
          from: new Date(fromDate).toISOString(),
          to: new Date(toDate).toISOString(),
          limit: String(eventLimit || "200"),
        })
        if (eventNameFilter.trim()) params.set("event", eventNameFilter.trim())
        if (eventActorFilter.trim()) params.set("actor", eventActorFilter.trim())
        if (eventEntityTypeFilter.trim()) params.set("entityType", eventEntityTypeFilter.trim())
        if (eventEntityIdFilter.trim()) params.set("entityId", eventEntityIdFilter.trim())
        const json = await cachedFetchJson<EventsResponse>(
          `internal:super-admin:analytics:events:${params.toString()}`,
          `/api/super-admin/analytics/events?${params.toString()}`,
          undefined,
          { ttlMs: 60_000, force: Boolean(opts?.force) },
        )
        setEventsExplorer(json)
        return
      }
    } catch (e: any) {
      setError(String(e?.message || "Failed to load"))
    } finally {
      setLoading(false)
    }
  }, [qs, tab, fromDate, toDate, eventLimit, eventNameFilter, eventActorFilter, eventEntityTypeFilter, eventEntityIdFilter])

  const trackingQuality = useMemo(() => {
    const rows = eventsExplorer?.events ?? []
    let requiredCount = 0
    let missingCount = 0
    const missingByEvent: Record<string, number> = {}
    for (const row of rows) {
      const required = REQUIRED_EVENT_PROPERTIES[row.event_name] || []
      if (!required.length) continue
      requiredCount += required.length
      const meta = row.metadata || {}
      for (const k of required) {
        const v = (meta as any)?.[k]
        if (v === undefined || v === null || v === "") {
          missingCount += 1
          missingByEvent[row.event_name] = (missingByEvent[row.event_name] || 0) + 1
        }
      }
    }
    return { requiredCount, missingCount, missingByEvent }
  }, [eventsExplorer])

  useEffect(() => {
    loadTab()
  }, [loadTab])

  useEffect(() => {
    const id = setInterval(() => {
      loadTab({ force: true })
    }, 60_000)
    return () => clearInterval(id)
  }, [loadTab])

  return (
    <TooltipProvider>
      <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <div>
          <div className="text-xs text-zinc-500 mb-1">From</div>
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value)
              setMonthValue("")
              setFyValue("")
            }}
          />
        </div>
        <div>
          <div className="text-xs text-zinc-500 mb-1">To</div>
          <Input
            type="date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value)
              setMonthValue("")
              setFyValue("")
            }}
          />
        </div>
        <div>
          <div className="text-xs text-zinc-500 mb-1">Month</div>
          <Select
            value={monthValue || "custom"}
            onValueChange={(value) => {
              if (value === "custom") {
                setMonthValue("")
                return
              }
              setMonthValue(value)
              setFyValue("")
              const [year, month] = value.split("-").map(Number)
              const from = new Date(year, month - 1, 1)
              const to = new Date(year, month, 0)
              setFromDate(isoDateOnly(from))
              setToDate(isoDateOnly(to))
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select month" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="custom">Custom</SelectItem>
              {monthOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <div className="text-xs text-zinc-500 mb-1">FY (India)</div>
          <Select
            value={fyValue || "custom"}
            onValueChange={(value) => {
              if (value === "custom") {
                setFyValue("")
                return
              }
              setFyValue(value)
              setMonthValue("")
              const startYear = Number(value)
              const from = new Date(startYear, 3, 1)
              const to = new Date(startYear + 1, 2, 31)
              setFromDate(isoDateOnly(from))
              setToDate(isoDateOnly(to))
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select FY" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="custom">Custom</SelectItem>
              {fyOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button variant="outline" onClick={() => loadTab({ force: true })} disabled={loading} className="w-full">
            Refresh
          </Button>
        </div>
      </div>

      {error ? <div className="text-sm text-red-600">{error}</div> : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="growth">Growth</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="candidates">Candidates</TabsTrigger>
          <TabsTrigger value="outreach">Outreach</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          {!overview ? (
            <div className="text-sm text-zinc-600">No data.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <KpiCard
                  title="New signups"
                  icon={<UserPlus className="h-5 w-5" />}
                  value={fmt(overview.kpis.signups.value)}
                  delta={overview.kpis.signups.delta_pct}
                  current={overview.kpis.signups.value}
                  previous={overview.kpis.signups.previous}
                  help="Unique users created in the selected range."
                />
                <KpiCard
                  title="Jobs created"
                  icon={<Briefcase className="h-5 w-5" />}
                  value={fmt(overview.kpis.jobs_created.value)}
                  delta={overview.kpis.jobs_created.delta_pct}
                  current={overview.kpis.jobs_created.value}
                  previous={overview.kpis.jobs_created.previous}
                  help="Jobs created by internal users in the selected range."
                />
                <KpiCard
                  title="Applications"
                  icon={<FileText className="h-5 w-5" />}
                  value={fmt(overview.kpis.applications.value)}
                  delta={overview.kpis.applications.delta_pct}
                  current={overview.kpis.applications.value}
                  previous={overview.kpis.applications.previous}
                  help="Applications submitted within the selected range."
                />
                <KpiCard
                  title="Outreach messages"
                  icon={<Send className="h-5 w-5" />}
                  value={fmt(overview.kpis.outreach_messages.value)}
                  delta={overview.kpis.outreach_messages.delta_pct}
                  current={overview.kpis.outreach_messages.value}
                  previous={overview.kpis.outreach_messages.previous}
                  help="Outbound outreach messages sent in the selected range."
                />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <div className="xl:col-span-2 space-y-4">
                  <ChartCard title="Signups, job views, applies">
                    <ChartContainer
                      className="h-[280px] w-full"
                      config={{
                        signups: { label: "Signups", color: "hsl(221.2 83.2% 53.3%)" },
                        job_views: { label: "Job views", color: "hsl(262.1 83.3% 57.8%)" },
                        applies: { label: "Applies", color: "hsl(142.1 76.2% 36.3%)" },
                      }}
                    >
                      <LineChart data={overview.series} margin={{ left: 12, right: 12, top: 8, bottom: 0 }}>
                        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                        <YAxis tickLine={false} axisLine={false} width={36} />
                        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                        <Line type="monotone" dataKey="signups" stroke="var(--color-signups)" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="job_views" stroke="var(--color-job_views)" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="applies" stroke="var(--color-applies)" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ChartContainer>
                  </ChartCard>

                  <ChartCard title="Jobs and applications">
                    <ChartContainer
                      className="h-[260px] w-full"
                      config={{
                        jobs_created: { label: "Jobs", color: "hsl(221.2 83.2% 53.3%)" },
                        applications: { label: "Applications", color: "hsl(142.1 76.2% 36.3%)" },
                      }}
                    >
                      <BarChart data={overview.series} margin={{ left: 12, right: 12, top: 8, bottom: 0 }}>
                        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                        <YAxis tickLine={false} axisLine={false} width={36} />
                        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                        <Bar dataKey="jobs_created" fill="var(--color-jobs_created)" radius={[6, 6, 0, 0]} />
                        <Bar dataKey="applications" fill="var(--color-applications)" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ChartContainer>
                  </ChartCard>
                </div>

                <div className="space-y-4">
                  <ChartCard title="Conversion snapshot" right={<ArrowUpRight className="h-4 w-4 text-zinc-500" />}>
                    <div className="grid grid-cols-1 gap-3">
                      <MetricRow label="Views" value={fmt(overview.kpis.job_views.value)} />
                      <MetricRow label="Apply started" value={fmt(overview.kpis.apply_started.value)} />
                      <MetricRow label="Apply submitted" value={fmt(overview.kpis.apply_submitted.value)} />
                      <MetricRow
                        label="View → Apply submit"
                        value={overview.kpis.job_views.value > 0 ? fmtPct(overview.kpis.apply_submitted.value / overview.kpis.job_views.value) : "0.0%"}
                      />
                    </div>
                  </ChartCard>

                  <ChartCard title="Latest activity" right={<Activity className="h-4 w-4 text-zinc-500" />}>
                    <div className="max-h-[340px] overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Time</TableHead>
                            <TableHead>Event</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(events?.events ?? []).map((e) => (
                            <TableRow key={e.id}>
                              <TableCell className="text-xs text-zinc-600">{new Date(e.created_at).toLocaleString()}</TableCell>
                              <TableCell className="font-medium">{e.event_name}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </ChartCard>
                </div>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="growth" className="space-y-4">
          {!growth ? (
            <div className="text-sm text-zinc-600">No data.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <KpiCard
                  title="Total users"
                  icon={<UserPlus className="h-5 w-5" />}
                  value={fmt(growth.totals.total_users)}
                  help="All-time count of users in auth."
                />
                <KpiCard
                  title="DAU"
                  icon={<Activity className="h-5 w-5" />}
                  value={fmt(growth.totals.active_users.dau)}
                  help="Distinct users active in the last 24 hours."
                />
                <KpiCard
                  title="WAU"
                  icon={<Activity className="h-5 w-5" />}
                  value={fmt(growth.totals.active_users.wau)}
                  help="Distinct users active in the last 7 days."
                />
                <KpiCard
                  title="MAU"
                  icon={<Activity className="h-5 w-5" />}
                  value={fmt(growth.totals.active_users.mau)}
                  help="Distinct users active in the last 30 days."
                />
                <KpiCard
                  title="Signups"
                  icon={<UserPlus className="h-5 w-5" />}
                  value={fmt(growth.totals.signups)}
                  help="Users created within the selected range."
                />
                <KpiCard
                  title="Sessions"
                  icon={<Activity className="h-5 w-5" />}
                  value={fmt(growth.totals.sessions)}
                  help="Session start events in the selected range."
                />
                <KpiCard
                  title="Page views"
                  icon={<FileText className="h-5 w-5" />}
                  value={fmt(growth.totals.page_views)}
                  help="Tracked page views in the selected range."
                />
                <KpiCard
                  title="Activation rate"
                  icon={<ArrowUpRight className="h-5 w-5" />}
                  value={fmtPct(growth.totals.activation_rate)}
                  help="Apply submissions divided by signups in the selected range."
                />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartCard title="Signups per day">
                  <ChartContainer className="h-[280px] w-full" config={{ signups: { label: "Signups", color: "hsl(221.2 83.2% 53.3%)" } }}>
                    <LineChart data={growth.series} margin={{ left: 12, right: 12, top: 8, bottom: 0 }}>
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                      <YAxis tickLine={false} axisLine={false} width={36} />
                      <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                      <Line type="monotone" dataKey="signups" stroke="var(--color-signups)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ChartContainer>
                </ChartCard>

                <ChartCard title="Activation (applies / signups)">
                  <ChartContainer
                    className="h-[280px] w-full"
                    config={{ activation_rate: { label: "Activation", color: "hsl(142.1 76.2% 36.3%)" } }}
                  >
                    <LineChart data={growth.series} margin={{ left: 12, right: 12, top: 8, bottom: 0 }}>
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                      <YAxis tickLine={false} axisLine={false} width={36} tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`} />
                      <ChartTooltip
                        cursor={false}
                        content={<ChartTooltipContent formatter={(value) => [fmtPct(Number(value)), "activation_rate"] as any} />}
                      />
                      <Line type="monotone" dataKey="activation_rate" stroke="var(--color-activation_rate)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ChartContainer>
                </ChartCard>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="jobs" className="space-y-4">
          {!jobs ? (
            <div className="text-sm text-zinc-600">No data.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <KpiCard title="Open jobs" icon={<Briefcase className="h-5 w-5" />} value={fmt(jobs.totals.open_jobs)} help="Jobs currently open." />
                <KpiCard title="Closed jobs" icon={<Briefcase className="h-5 w-5" />} value={fmt(jobs.totals.closed_jobs)} help="Jobs currently closed." />
                <KpiCard title="Applications" icon={<FileText className="h-5 w-5" />} value={fmt(jobs.totals.applications)} help="Applications submitted within the selected range." />
                <KpiCard
                  title="Apps per job"
                  icon={<ArrowUpRight className="h-5 w-5" />}
                  value={jobs.totals.applications_per_job_avg.toFixed(2)}
                  help="Average applications per job in the selected range."
                />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartCard title="Jobs, applications, applies">
                  <ChartContainer
                    className="h-[280px] w-full"
                    config={{
                      jobs_created: { label: "Jobs", color: "hsl(221.2 83.2% 53.3%)" },
                      applications: { label: "Applications", color: "hsl(142.1 76.2% 36.3%)" },
                      applies: { label: "Applies", color: "hsl(262.1 83.3% 57.8%)" },
                    }}
                  >
                    <LineChart data={jobs.series} margin={{ left: 12, right: 12, top: 8, bottom: 0 }}>
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                      <YAxis tickLine={false} axisLine={false} width={36} />
                      <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                      <Line type="monotone" dataKey="jobs_created" stroke="var(--color-jobs_created)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="applications" stroke="var(--color-applications)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="applies" stroke="var(--color-applies)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ChartContainer>
                </ChartCard>

                <ChartCard title="Top jobs (applications)">
                  <div className="max-h-[280px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Job</TableHead>
                          <TableHead className="text-right">Apps</TableHead>
                          <TableHead className="text-right">Views</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {jobs.top_jobs.map((j) => (
                          <TableRow key={j.id}>
                            <TableCell className="font-medium">{j.title}</TableCell>
                            <TableCell className="text-right">{fmt(j.applications)}</TableCell>
                            <TableCell className="text-right">{fmt(j.views)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </ChartCard>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="candidates" className="space-y-4">
          {!candidates ? (
            <div className="text-sm text-zinc-600">No data.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <KpiCard
                  title="Candidates added"
                  icon={<UserPlus className="h-5 w-5" />}
                  value={fmt(candidates.totals.candidates_added)}
                  help="Candidates added within the selected range."
                />
                <KpiCard
                  title="Candidates contacted"
                  icon={<Send className="h-5 w-5" />}
                  value={fmt(candidates.totals.candidates_contacted)}
                  help="Candidates who received outreach in the selected range."
                />
                <KpiCard
                  title="Response rate (opened)"
                  icon={<Activity className="h-5 w-5" />}
                  value={fmtPct(candidates.totals.response_rate)}
                  help="Opened messages divided by total outreach."
                />
                <KpiCard
                  title="Avg time-to-first-response"
                  icon={<ArrowUpRight className="h-5 w-5" />}
                  value={`${Math.round(candidates.totals.avg_time_to_first_response_seconds)}s`}
                  help="Average seconds until first response."
                />
              </div>

              <ChartCard title="Added vs contacted vs opened">
                <ChartContainer
                  className="h-[320px] w-full"
                  config={{
                    candidates_added: { label: "Added", color: "hsl(221.2 83.2% 53.3%)" },
                    contacted: { label: "Contacted", color: "hsl(262.1 83.3% 57.8%)" },
                    opened: { label: "Opened", color: "hsl(142.1 76.2% 36.3%)" },
                  }}
                >
                  <LineChart data={candidates.series} margin={{ left: 12, right: 12, top: 8, bottom: 0 }}>
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                    <YAxis tickLine={false} axisLine={false} width={36} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                    <Line type="monotone" dataKey="candidates_added" stroke="var(--color-candidates_added)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="contacted" stroke="var(--color-contacted)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="opened" stroke="var(--color-opened)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ChartContainer>
              </ChartCard>
            </>
          )}
        </TabsContent>

        <TabsContent value="outreach" className="space-y-4">
          {!outreach ? (
            <div className="text-sm text-zinc-600">No data.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <KpiCard title="Total messages" icon={<Send className="h-5 w-5" />} value={fmt(outreach.totals.total)} help="Total outreach messages sent in range." />
                <KpiCard title="Open rate" icon={<Activity className="h-5 w-5" />} value={fmtPct(outreach.totals.open_rate)} help="Opened messages divided by sent messages." />
                <KpiCard title="Failure rate" icon={<Activity className="h-5 w-5" />} value={fmtPct(outreach.totals.failure_rate)} help="Failed messages divided by sent messages." />
                <KpiCard
                  title="Email vs WhatsApp"
                  icon={<Send className="h-5 w-5" />}
                  value={`${fmt(outreach.totals.by_type.email ?? 0)} / ${fmt(outreach.totals.by_type.whatsapp ?? 0)}`}
                  help="Message volume split by channel."
                />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartCard title="Delivery funnel">
                  <ChartContainer
                    className="h-[280px] w-full"
                    config={{
                      sent: { label: "Sent", color: "hsl(221.2 83.2% 53.3%)" },
                      delivered: { label: "Delivered", color: "hsl(262.1 83.3% 57.8%)" },
                      opened: { label: "Opened", color: "hsl(142.1 76.2% 36.3%)" },
                      failed: { label: "Failed", color: "hsl(0 84.2% 60.2%)" },
                    }}
                  >
                    <LineChart data={outreach.series} margin={{ left: 12, right: 12, top: 8, bottom: 0 }}>
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} />
                      <YAxis tickLine={false} axisLine={false} width={36} />
                      <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                      <Line type="monotone" dataKey="sent" stroke="var(--color-sent)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="delivered" stroke="var(--color-delivered)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="opened" stroke="var(--color-opened)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="failed" stroke="var(--color-failed)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ChartContainer>
                </ChartCard>

                <ChartCard title="Per-user outreach (opened)">
                  <div className="max-h-[280px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>User</TableHead>
                          <TableHead className="text-right">Sent</TableHead>
                          <TableHead className="text-right">Opened</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {Object.entries(outreach.by_user)
                          .sort((a, b) => b[1].opened - a[1].opened)
                          .slice(0, 20)
                          .map(([userId, m]) => (
                            <TableRow key={userId}>
                              <TableCell className="font-medium">{userId.slice(0, 8)}…</TableCell>
                              <TableCell className="text-right">{fmt(m.sent)}</TableCell>
                              <TableCell className="text-right">{fmt(m.opened)}</TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  </div>
                </ChartCard>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="team" className="space-y-4">
          {!team ? (
            <div className="text-sm text-zinc-600">No data.</div>
          ) : (
            <>
              <ChartCard title="Leaderboard">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead className="text-right">Jobs</TableHead>
                      <TableHead className="text-right">Uploads</TableHead>
                      <TableHead className="text-right">Outreach</TableHead>
                      <TableHead className="text-right">Apps</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {team.rows.map((r) => (
                      <TableRow key={r.user.id}>
                        <TableCell className="font-medium">{r.user.name ? `${r.user.name} (${r.user.email})` : r.user.email}</TableCell>
                        <TableCell className="text-right">{fmt(r.metrics.jobs_posted)}</TableCell>
                        <TableCell className="text-right">{fmt(r.metrics.candidates_uploaded)}</TableCell>
                        <TableCell className="text-right">{fmt(r.metrics.outreach_messages)}</TableCell>
                        <TableCell className="text-right">{fmt(r.metrics.applications_created)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ChartCard>
            </>
          )}
        </TabsContent>

        <TabsContent value="events" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
            <div>
              <div className="text-xs text-zinc-500 mb-1">Event</div>
              <Input list="event-names" value={eventNameFilter} onChange={(e) => setEventNameFilter(e.target.value)} placeholder="event name" />
              <datalist id="event-names">
                {EVENT_NAMES.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">Actor</div>
              <Input value={eventActorFilter} onChange={(e) => setEventActorFilter(e.target.value)} placeholder="auth user id" />
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">Entity type</div>
              <Input value={eventEntityTypeFilter} onChange={(e) => setEventEntityTypeFilter(e.target.value)} placeholder="jobs, candidates" />
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">Entity id</div>
              <Input value={eventEntityIdFilter} onChange={(e) => setEventEntityIdFilter(e.target.value)} placeholder="uuid" />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <div className="text-xs text-zinc-500 mb-1">Limit</div>
                <Input type="number" value={eventLimit} onChange={(e) => setEventLimit(e.target.value)} />
              </div>
              <Button variant="outline" onClick={() => loadTab({ force: true })} disabled={loading} className="h-10">
                Search
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <ChartCard title="Tracking quality">
              <div className="grid grid-cols-1 gap-3">
                <MetricRow label="Required props checked" value={fmt(trackingQuality.requiredCount)} />
                <MetricRow label="Missing props" value={fmt(trackingQuality.missingCount)} />
                <MetricRow
                  label="Missing %"
                  value={trackingQuality.requiredCount > 0 ? fmtPct(trackingQuality.missingCount / trackingQuality.requiredCount) : "0.0%"}
                />
              </div>
            </ChartCard>
            <ChartCard title="Missing by event">
              <div className="max-h-[240px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead className="text-right">Missing</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(trackingQuality.missingByEvent)
                      .sort((a, b) => b[1] - a[1])
                      .map(([name, count]) => (
                        <TableRow key={name}>
                          <TableCell className="font-medium">{name}</TableCell>
                          <TableCell className="text-right">{fmt(count)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </ChartCard>
            <ChartCard title="Events (sample)">
              <div className="text-xs text-zinc-500">
                Showing {eventsExplorer?.events?.length ?? 0} events
              </div>
            </ChartCard>
          </div>

          {!eventsExplorer ? (
            <div className="text-sm text-zinc-600">No data.</div>
          ) : (
            <ChartCard title="Event explorer">
              <div className="max-h-[520px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Metadata</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {eventsExplorer.events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-xs text-zinc-600">{new Date(e.created_at).toLocaleString()}</TableCell>
                        <TableCell className="font-medium">{e.event_name}</TableCell>
                        <TableCell className="text-xs text-zinc-600">{e.actor_auth_user_id ? `${e.actor_auth_user_id.slice(0, 8)}…` : "—"}</TableCell>
                        <TableCell className="text-xs text-zinc-600">
                          {e.entity_type || "—"}
                          {e.entity_id ? `:${String(e.entity_id).slice(0, 6)}…` : ""}
                        </TableCell>
                        <TableCell className="text-xs text-zinc-600 max-w-[420px]">
                          <pre className="whitespace-pre-wrap">{JSON.stringify(e.metadata || {}, null, 2)}</pre>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </ChartCard>
          )}
        </TabsContent>
      </Tabs>
    </div>
    </TooltipProvider>
  )
}

function MetricRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
      <div className="text-xs text-zinc-600">{props.label}</div>
      <div className="text-sm font-semibold">{props.value}</div>
    </div>
  )
}
