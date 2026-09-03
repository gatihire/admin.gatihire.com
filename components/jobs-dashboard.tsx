"use client"

import { useMemo, useState, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Plus, Clock, MoreHorizontal, ChevronRight, CheckCircle2, XCircle, AlertTriangle, PhoneCall, MessageCircle, Send, Eye, ExternalLink, Copy } from "lucide-react"
import { CreateJobDialog } from "./create-job-dialog"
import { formatDistanceToNow, differenceInDays } from "date-fns"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cachedFetchJson, getBoardJobApplyUrl, getSessionCached, invalidateSessionCache, peekSessionCache } from "@/lib/utils"
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination"
import { Input } from "@/components/ui/input"

interface Job {
  id: string
  title: string
  location: string
  status: string
  description: string
  created_at: string
  last_activity_at?: string | null
  apply_type?: string | null
  external_apply_url?: string | null
  client_name?: string
  client_id?: string | null
  industry?: string | null
  employment_type?: string | null
  shift_type?: string | null
  city?: string | null
  salary_type?: string | null
  salary_min?: number | null
  salary_max?: number | null
  openings?: number | null
  education_min?: string | null
  experience_min_years?: number | null
  experience_max_years?: number | null
  languages_required?: string[] | null
  english_level?: string | null
  license_type?: string | null
  age_min?: number | null
  age_max?: number | null
  gender_preference?: string | null
  role_category?: string | null
  department_category?: string | null
  skills_must_have?: string[] | null
  skills_good_to_have?: string[] | null
  sub_category?: string | null
  source?: string | null
  is_external_link?: boolean | null
  external_link?: string | null
  auto_matchmaking_enabled?: boolean | null
  messaging_preferences?: string | null
  urgency_tag?: string | null
}

type ScreeningCounts = {
  pending: number
  whatsapp_sent: number
  replied: number
  calling: number
  call_done: number
  rejected: number
}

type InterviewCounts = {
  pending: number
  invite_sent: number
  confirmed: number
  rescheduled: number
  cancelled: number
}

export function JobsDashboard() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("search") || "")
  const [clients, setClients] = useState<{ id: string; name: string; slug: string; logo_url?: string | null }[]>([])
  const [statusFilter, setStatusFilter] = useState<string>(() => searchParams.get("status") || "all")
  const [clientFilter, setClientFilter] = useState<string>(() => searchParams.get("clientId") || "all")
  const [sourceFilter, setSourceFilter] = useState<string>(() => searchParams.get("source") || "all")
  const [sortFilter, setSortFilter] = useState<string>(() => searchParams.get("sort") || "attention")
  const [page, setPage] = useState<number>(() => Number(searchParams.get("page")) || 1)
  const perPage = 15
  const [total, setTotal] = useState<number>(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<Job | null>(null)
  const [appCounts, setAppCounts] = useState<Record<string, number>>({})
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({})
  const [reviewCounts, setReviewCounts] = useState<Record<string, number>>({})
  const [shortlistCounts, setShortlistCounts] = useState<Record<string, number>>({})
  const [clientDecisions, setClientDecisions] = useState<Record<string, { approved: number; rejected: number; pending: number }>>({})
  const [screeningStats, setScreeningStats] = useState<Record<string, ScreeningCounts>>({})
  const [interviewStats, setInterviewStats] = useState<Record<string, InterviewCounts>>({})

  const jobsCacheKey = "internal:jobs:/api/jobs"
  const jobCountsCacheKey = "internal:jobs:counts"

  const EMPTY_STATS: JobStatsPayload = { appCounts: {}, pendingCounts: {}, reviewCounts: {}, shortlistCounts: {}, clientDecisions: {}, screeningStats: {}, interviewStats: {} }

  const applyCounts = (payload: JobStatsPayload) => {
    const p = payload || EMPTY_STATS
    setAppCounts(p.appCounts || {})
    setPendingCounts(p.pendingCounts || {})
    setReviewCounts(p.reviewCounts || {})
    setShortlistCounts(p.shortlistCounts || {})
    setClientDecisions(p.clientDecisions || {})
    setScreeningStats(p.screeningStats || {})
    setInterviewStats(p.interviewStats || {})
  }

  const updateUrl = useCallback(() => {
    const params = new URLSearchParams()
    if (searchQuery) params.set("search", searchQuery)
    if (statusFilter !== "all") params.set("status", statusFilter)
    if (clientFilter !== "all") params.set("clientId", clientFilter)
    if (sourceFilter !== "all") params.set("source", sourceFilter)
    if (sortFilter !== "attention") params.set("sort", sortFilter)
    if (page > 1) params.set("page", String(page))
    const qs = params.toString()
    router.replace(`/jobs${qs ? `?${qs}` : ""}`, { scroll: false })
  }, [router, searchQuery, statusFilter, clientFilter, sourceFilter, sortFilter, page])

  useEffect(() => { updateUrl() }, [updateUrl])
  useEffect(() => { fetchClients() }, [])

  const fetchClients = async (opts?: { force?: boolean }) => {
    try {
      const data = await cachedFetchJson<any[]>(`internal:jobs:/api/clients`, "/api/clients", undefined, { ttlMs: 10 * 60_000, force: Boolean(opts?.force) })
      setClients(Array.isArray(data) ? data.map((c: any) => ({ id: c.id, name: c.name, slug: c.slug, logo_url: c.logo_url })) : [])
    } catch { setClients([]) }
  }

  interface JobStatsPayload {
    appCounts: Record<string, number>
    pendingCounts: Record<string, number>
    reviewCounts: Record<string, number>
    shortlistCounts: Record<string, number>
    clientDecisions: Record<string, { approved: number; rejected: number; pending: number }>
    screeningStats: Record<string, ScreeningCounts>
    interviewStats: Record<string, InterviewCounts>
  }

  const fetchJobCounts = async (data?: Job[], opts?: { force?: boolean }) => {
    if (!Array.isArray(data) || data.length === 0) { applyCounts(EMPTY_STATS); return }
    const payload = await getSessionCached(
      jobCountsCacheKey,
      async () => {
        const ids = (data || []).map((j) => j.id).filter(Boolean)
        const idsKey = ids.slice().sort().join(",")
        return await cachedFetchJson<JobStatsPayload>(`internal:jobs:/api/jobs/stats?ids=${idsKey}`, `/api/jobs/stats?ids=${encodeURIComponent(idsKey)}`, undefined, { ttlMs: 60_000 })
      },
      { ttlMs: 60_000, force: Boolean(opts?.force), swr: true, onData: applyCounts as any },
    )
    applyCounts(payload as JobStatsPayload)
  }

  const fetchJobs = async (opts?: { force?: boolean; page?: number }) => {
    const force = Boolean(opts?.force)
    const targetPage = Math.max(1, Number(opts?.page ?? page) || 1)
    const url = `/api/jobs?paginate=true&page=${targetPage}&perPage=${perPage}&status=${encodeURIComponent(statusFilter)}&source=${encodeURIComponent(sourceFilter)}&clientId=${encodeURIComponent(clientFilter)}&search=${encodeURIComponent(searchQuery)}`
    const cacheKey = `${jobsCacheKey}:${url}`
    const cachedPage = !force ? peekSessionCache<{ items: Job[]; total: number }>(cacheKey) : null
    const cachedCounts = !force ? peekSessionCache<JobStatsPayload>(jobCountsCacheKey) : null
    if (cachedPage && Array.isArray(cachedPage.items)) {
      setJobs(cachedPage.items)
      setTotal(typeof cachedPage.total === "number" ? cachedPage.total : cachedPage.items.length)
      setLoading(false)
    } else { setLoading(true) }
    if (cachedCounts) applyCounts(cachedCounts)
    try {
      const data = await cachedFetchJson<{ items: Job[]; total: number; page: number; perPage: number }>(cacheKey, url, undefined, {
        ttlMs: 60_000, force, swr: true,
        onData: (freshData) => {
          const freshItems = Array.isArray((freshData as any)?.items) ? (freshData as any).items : []
          setJobs(freshItems)
          setTotal(typeof (freshData as any)?.total === "number" ? (freshData as any).total : freshItems.length)
        }
      })
      const items = Array.isArray((data as any)?.items) ? (data as any).items : []
      setJobs(items)
      setTotal(typeof (data as any)?.total === "number" ? (data as any).total : items.length)
      await fetchJobCounts(items, { force })
    } catch (error) { console.error("Failed to fetch jobs", error) }
    finally { setLoading(false) }
  }

  const refreshAll = async () => {
    invalidateSessionCache("internal:jobs:", { prefix: true })
    invalidateSessionCache(jobCountsCacheKey)
    setPage(1)
    await fetchJobs({ force: true, page: 1 })
    await fetchClients({ force: true })
  }

  const clientsById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])
  const totalPages = Math.max(1, Math.ceil(total / perPage))

  const jobAttentionScore = useCallback((job: Job): number => {
    const screening = screeningStats[job.id] || { pending: 0, whatsapp_sent: 0, replied: 0, calling: 0, call_done: 0, rejected: 0 }
    const interview = interviewStats[job.id] || { pending: 0, invite_sent: 0, confirmed: 0, rescheduled: 0, cancelled: 0 }
    const review = reviewCounts[job.id] || 0
    const clientPending = clientDecisions[job.id]?.pending || 0
    const newApps = pendingCounts[job.id] || 0
    const lastActivity = job.last_activity_at ? new Date(job.last_activity_at) : new Date(job.created_at)
    const daysSince = differenceInDays(new Date(), lastActivity)
    let score = 0
    if (review > 0) score += 100
    if (clientPending > 0) score += 80
    if (interview.pending > 0) score += 70
    if (interview.rescheduled > 0) score += 65
    if (screening.calling > 0) score += 60
    if (screening.replied > 0) score += 50
    if (newApps > 0) score += 40
    if (screening.whatsapp_sent > 0) score += 30
    if (daysSince > 5) score -= 20
    if (job.status !== "open") score -= 50
    return score
  }, [screeningStats, interviewStats, reviewCounts, clientDecisions, pendingCounts])

  const visibleJobs = useMemo(() => {
    const list = Array.isArray(jobs) ? jobs.slice() : []
    return list.sort((a, b) => {
      if (sortFilter === "newest") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      if (sortFilter === "oldest") return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      if (sortFilter === "urgency") {
        const aRank = a.urgency_tag === "urgently_hiring" ? 0 : a.status === "open" ? 1 : 2
        const bRank = b.urgency_tag === "urgently_hiring" ? 0 : b.status === "open" ? 1 : 2
        if (aRank !== bRank) return aRank - bRank
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      }
      const aScore = jobAttentionScore(a)
      const bScore = jobAttentionScore(b)
      if (aScore !== bScore) return bScore - aScore
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [jobs, sortFilter, jobAttentionScore])

  useEffect(() => {
    const t = setTimeout(() => { fetchJobs({ force: false }) }, 250)
    return () => clearTimeout(t)
  }, [page, statusFilter, clientFilter, sourceFilter, searchQuery])

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Jobs</h2>
          <p className="text-muted-foreground">Manage job openings and track applicants.</p>
        </div>
        <CreateJobDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onJobCreated={async () => {
            invalidateSessionCache("internal:jobs:", { prefix: true })
            invalidateSessionCache(jobCountsCacheKey)
            await fetchJobs({ force: true })
          }}
          trigger={<Button><Plus className="mr-2 h-4 w-4" />Post New Job</Button>}
        />
        {editingJob && (
          <CreateJobDialog
            key={editingJob.id}
            open={editOpen}
            onOpenChange={(open) => { setEditOpen(open); if (!open) setEditingJob(null) }}
            onJobCreated={async () => {
              invalidateSessionCache("internal:jobs:", { prefix: true })
              invalidateSessionCache(jobCountsCacheKey)
              await fetchJobs({ force: true })
            }}
            jobId={editingJob.id}
            initialValues={{
              title: editingJob.title, industry: (editingJob as any).industry, location: editingJob.location,
              employment_type: (editingJob as any).employment_type, shift_type: (editingJob as any).shift_type,
              urgency_tag: (editingJob as any).urgency_tag, city: (editingJob as any).city,
              salary_type: (editingJob as any).salary_type, salary_min: (editingJob as any).salary_min,
              salary_max: (editingJob as any).salary_max, description: editingJob.description,
              openings: (editingJob as any).openings, client_name: (editingJob as any).client_name,
              client_id: (editingJob as any).client_id, apply_type: (editingJob as any).apply_type,
              external_apply_url: (editingJob as any).external_apply_url,
              skills_must_have: (editingJob as any).skills_must_have,
              skills_good_to_have: (editingJob as any).skills_good_to_have,
              sub_category: (editingJob as any).sub_category, education_min: (editingJob as any).education_min,
              experience_min_years: (editingJob as any).experience_min_years,
              experience_max_years: (editingJob as any).experience_max_years,
              languages_required: (editingJob as any).languages_required,
              english_level: (editingJob as any).english_level, license_type: (editingJob as any).license_type,
              age_min: (editingJob as any).age_min, age_max: (editingJob as any).age_max,
              gender_preference: (editingJob as any).gender_preference,
              role_category: (editingJob as any).role_category,
              department_category: (editingJob as any).department_category,
            }}
          />
        )}
      </div>

      <Card className="border-zinc-200">
        <CardContent className="pt-4 space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-3">
              <div className="text-xs text-zinc-500 mb-1">Search</div>
              <Input value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setPage(1) }} placeholder="Search jobs..." />
            </div>
            <div className="md:col-span-2">
              <div className="text-xs text-zinc-500 mb-1">Status</div>
              <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1) }}>
                <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="inactive">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <div className="text-xs text-zinc-500 mb-1">Source</div>
              <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v); setPage(1) }}>
                <SelectTrigger><SelectValue placeholder="Source" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="truckinzy">Truckinzy Side</SelectItem>
                  <SelectItem value="employee">Employee Side</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <div className="text-xs text-zinc-500 mb-1">Sort By</div>
              <Select value={sortFilter} onValueChange={setSortFilter}>
                <SelectTrigger><SelectValue placeholder="Sort By" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="attention">Needs Attention</SelectItem>
                  <SelectItem value="newest">Newest First</SelectItem>
                  <SelectItem value="oldest">Oldest First</SelectItem>
                  <SelectItem value="urgency">Urgency Flag</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <div className="text-xs text-zinc-500 mb-1">Client</div>
              <Select value={clientFilter} onValueChange={(v) => { setClientFilter(v); setPage(1) }}>
                <SelectTrigger><SelectValue placeholder="Client" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All clients</SelectItem>
                  {clients.map((c) => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-1">
              <div className="text-xs text-zinc-500 mb-1">&nbsp;</div>
              <Button variant="outline" className="w-full" onClick={refreshAll}>Refresh</Button>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="text-sm text-gray-600">
              Page <span className="font-medium">{page}</span> of <span className="font-medium">{totalPages}</span> • Showing{" "}
              <span className="font-medium">{jobs.length}</span> of <span className="font-medium">{total}</span>
            </div>
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious href="#" aria-disabled={page <= 1} onClick={(e) => { e.preventDefault(); if (page > 1) setPage(page - 1) }} />
                </PaginationItem>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  const pageNum = page <= 3 ? i + 1 : page + i - 2
                  if (pageNum < 1 || pageNum > totalPages) return null
                  return (
                    <PaginationItem key={pageNum}>
                      <PaginationLink href="#" isActive={pageNum === page} onClick={(e) => { e.preventDefault(); setPage(pageNum) }}>{pageNum}</PaginationLink>
                    </PaginationItem>
                  )
                })}
                <PaginationItem>
                  <PaginationNext href="#" aria-disabled={page >= totalPages} onClick={(e) => { e.preventDefault(); if (page < totalPages) setPage(page + 1) }} />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (<div key={i} className="h-24 bg-gray-100 rounded-2xl animate-pulse" />))}
        </div>
      ) : (
        <div className="space-y-2">
          {visibleJobs.map((job) => {
            const clientName = (job.client_id && clientsById.get(job.client_id)?.name) || job.client_name || ""
            const clientLogo = job.client_id ? clientsById.get(job.client_id)?.logo_url || null : null
            const screening = screeningStats[job.id] || { pending: 0, whatsapp_sent: 0, replied: 0, calling: 0, call_done: 0, rejected: 0 }
            return (
              <JobCard
                key={job.id}
                job={job}
                clientName={clientName}
                clientLogo={clientLogo}
                stats={{
                  newApps: pendingCounts[job.id] || 0,
                  aiReview: reviewCounts[job.id] || 0,
                  shortlist: shortlistCounts[job.id] || 0,
                  client: clientDecisions[job.id] || { approved: 0, rejected: 0, pending: 0 },
                  screening,
                  interview: interviewStats[job.id] || { pending: 0, invite_sent: 0, confirmed: 0, rescheduled: 0, cancelled: 0 },
                }}
                onOpen={() => router.push(`/jobs/${job.id}`)}
                onOpenStage={(stage, sub) => router.push(`/jobs/${job.id}?tab=pipeline&stage=${stage}${sub ? `&callsub=${sub}` : ""}`)}
                onOpenPipeline={() => router.push(`/jobs/${job.id}?tab=pipeline`)}
                onOpenSourcing={() => router.push(`/jobs/${job.id}?tab=sourcing`)}
                onEdit={() => { setEditingJob(job); setEditOpen(true) }}
                onCopyLink={() => { navigator.clipboard.writeText(getBoardJobApplyUrl(job.id)) }}
                onToggleStatus={async () => {
                  const newStatus = job.status === "open" ? "inactive" : "open"
                  await fetch(`/api/jobs/${job.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: newStatus }) })
                  invalidateSessionCache("internal:jobs:", { prefix: true })
                  invalidateSessionCache(jobCountsCacheKey)
                  fetchJobs({ force: true })
                }}
                onDelete={async () => {
                  if (!confirm("Delete this job? This cannot be undone.")) return
                  await fetch(`/api/jobs/${job.id}`, { method: "DELETE" })
                  invalidateSessionCache("internal:jobs:", { prefix: true })
                  invalidateSessionCache(jobCountsCacheKey)
                  fetchJobs({ force: true })
                }}
              />
            )
          })}
          {jobs.length === 0 && <div className="px-4 py-12 text-center text-muted-foreground rounded-2xl border border-zinc-200 bg-white">No jobs found.</div>}
        </div>
      )}
    </div>
  )
}

interface JobRowStats {
  newApps: number
  aiReview: number
  shortlist: number
  client: { approved: number; rejected: number; pending: number }
  screening: ScreeningCounts
  interview: InterviewCounts
}

interface JobCardProps {
  job: Job
  clientName: string
  clientLogo: string | null
  stats: JobRowStats
  onOpen: () => void
  onOpenStage: (stage: string, sub?: string) => void
  onOpenPipeline: () => void
  onOpenSourcing: () => void
  onEdit: () => void
  onCopyLink: () => void
  onToggleStatus: () => void
  onDelete: () => void
}

function JobCard({
  job, clientName, clientLogo, stats, onOpen, onOpenStage, onOpenPipeline, onOpenSourcing, onEdit, onCopyLink, onToggleStatus, onDelete,
}: JobCardProps) {
  const { screening, client } = stats
  const lastActivity = job.last_activity_at ? new Date(job.last_activity_at) : new Date(job.created_at)
  const daysSinceActivity = differenceInDays(new Date(), lastActivity)
  const isStale = daysSinceActivity >= 5 && job.status === "open"

  // Determine the primary action
  const hasReview = stats.aiReview > 0
  const hasClientPending = client.pending > 0
  const hasNewApps = stats.newApps > 0
  const hasCalling = screening.calling > 0
  const hasReplied = screening.replied > 0
  const hasInterviewPending = stats.interview.pending > 0
  const hasInterviewRescheduled = stats.interview.rescheduled > 0
  const totalScreening = screening.pending + screening.whatsapp_sent + screening.replied + screening.calling + screening.call_done + screening.rejected

  let primaryAction: { label: string; icon: any; color: string; stage: string; sub?: string } | null = null
  if (hasReview) primaryAction = { label: `Review ${stats.aiReview} call${stats.aiReview > 1 ? "s" : ""}`, icon: Eye, color: "bg-amber-500 hover:bg-amber-600", stage: "ai_screen", sub: "call_done" }
  else if (hasClientPending) primaryAction = { label: `Check ${client.pending} client decision${client.pending > 1 ? "s" : ""}`, icon: ExternalLink, color: "bg-purple-500 hover:bg-purple-600", stage: "shortlist" }
  else if (hasInterviewRescheduled) primaryAction = { label: `${stats.interview.rescheduled} candidate${stats.interview.rescheduled > 1 ? "s" : ""} suggested new time`, icon: Clock, color: "bg-orange-500 hover:bg-orange-600", stage: "pipeline", sub: "interview" }
  else if (hasInterviewPending) primaryAction = { label: `Send ${stats.interview.pending} interview invite${stats.interview.pending > 1 ? "s" : ""}`, icon: Send, color: "bg-cyan-500 hover:bg-cyan-600", stage: "pipeline", sub: "interview" }
  else if (hasNewApps) primaryAction = { label: `Screen ${stats.newApps} new applicant${stats.newApps > 1 ? "s" : ""}`, icon: Send, color: "bg-blue-500 hover:bg-blue-600", stage: "applied" }
  else if (hasReplied) primaryAction = { label: `Call ${screening.replied} candidate${screening.replied > 1 ? "s" : ""}`, icon: PhoneCall, color: "bg-green-500 hover:bg-green-600", stage: "ai_screen", sub: "replied" }

  const accent = hasReview
    ? "border-l-4 border-l-amber-400 bg-amber-50/30"
    : hasClientPending
      ? "border-l-4 border-l-purple-400 bg-purple-50/30"
      : hasInterviewRescheduled
        ? "border-l-4 border-l-orange-400 bg-orange-50/30"
        : hasInterviewPending
          ? "border-l-4 border-l-cyan-400 bg-cyan-50/30"
          : hasCalling
            ? "border-l-4 border-l-blue-400 bg-blue-50/30"
            : hasNewApps
              ? "border-l-4 border-l-zinc-300"
              : "border-l-4 border-l-transparent"

  return (
    <div className={`rounded-2xl border border-zinc-200 bg-white hover:shadow-md transition-all overflow-hidden ${accent}`}>
      {/* Line 1: Job info + action button */}
      <div className="flex items-center gap-4 px-5 py-3.5">
        {/* Logo / Avatar */}
        {clientLogo ? (
          <img src={String(clientLogo)} alt="" className="h-10 w-10 rounded-xl border bg-white object-contain p-0.5 shrink-0" />
        ) : (
          <div className="h-10 w-10 rounded-xl bg-zinc-100 flex items-center justify-center text-sm font-bold text-zinc-400 shrink-0">
            {clientName ? clientName.charAt(0).toUpperCase() : job.title.charAt(0).toUpperCase()}
          </div>
        )}

        {/* Title + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onOpen} className="text-[15px] font-semibold text-zinc-900 truncate hover:text-blue-600 text-left">
              {job.title}
            </button>
            <span className={`h-2 w-2 rounded-full shrink-0 ${job.status === "open" ? "bg-emerald-500" : "bg-zinc-300"}`} />
            {job.urgency_tag === "urgently_hiring" && (
              <span className="text-[9px] font-bold uppercase tracking-wide text-red-600 bg-red-50 rounded px-1.5 py-0.5 shrink-0">Urgent</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500 mt-0.5">
            {clientName && <span className="font-medium">{clientName}</span>}
            {(job.industry || job.department_category) && <span>· {job.industry || job.department_category}</span>}
            {job.location && <span>· {job.location}</span>}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 font-medium">
              <Clock className="h-3 w-3" />
              {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
            </span>
            {job.employment_type && (
              <span className="text-[9px] font-bold uppercase tracking-wide text-zinc-400 bg-zinc-100 rounded px-1.5 py-0.5">
                {String(job.employment_type).replace(/_/g, " ")}
              </span>
            )}
            {isStale && (
              <span className="inline-flex items-center gap-1 text-[9px] font-bold text-red-500 bg-red-50 rounded px-1.5 py-0.5">
                <AlertTriangle className="h-3 w-3" />
                No activity {daysSinceActivity}d
              </span>
            )}
          </div>
        </div>

        {/* Primary action button */}
        <div className="flex items-center gap-2 shrink-0">
          {primaryAction ? (
            <button
              type="button"
              onClick={() => onOpenStage(primaryAction!.stage, primaryAction!.sub)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-white shadow-sm transition-colors ${primaryAction.color}`}
            >
              <primaryAction.icon className="h-3.5 w-3.5" />
              {primaryAction.label}
            </button>
          ) : totalScreening > 0 || stats.shortlist > 0 ? (
            <button
              type="button"
              onClick={onOpenPipeline}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-zinc-600 bg-zinc-100 hover:bg-zinc-200 transition-colors"
            >
              <Eye className="h-3.5 w-3.5" />
              View Pipeline
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpen}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-zinc-600 bg-zinc-100 hover:bg-zinc-200 transition-colors"
            >
              Open
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpenPipeline}>Pipeline</DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenSourcing}>DB Matches</DropdownMenuItem>
              <DropdownMenuItem onClick={onEdit}>Edit Job</DropdownMenuItem>
              <DropdownMenuItem onClick={onCopyLink}>Copy apply link</DropdownMenuItem>
              <DropdownMenuItem onClick={onToggleStatus}>{job.status === "open" ? "Close job" : "Reopen job"}</DropdownMenuItem>
              <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={onDelete}>Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Line 2: Metric badges */}
      <div className="flex items-center gap-2 px-5 pb-3.5 pt-0">
        <MetricBadge
          value={stats.newApps}
          label="New"
          color="bg-blue-50 text-blue-700 ring-blue-200"
          emptyColor="bg-zinc-50 text-zinc-400 ring-zinc-200"
          tooltip="Candidates who applied but haven't been screened yet"
          onClick={() => onOpenStage("applied")}
        />
        <MetricBadge
          value={screening.whatsapp_sent}
          label="WhatsApp Sent"
          color="bg-teal-50 text-teal-700 ring-teal-200"
          emptyColor="bg-zinc-50 text-zinc-400 ring-zinc-200"
          tooltip="Candidates sent a WhatsApp context message, waiting for them to respond"
          onClick={() => onOpenStage("ai_screen", "whatsapp_sent")}
        />
        <MetricBadge
          value={screening.replied}
          label="Replied"
          color="bg-green-50 text-green-700 ring-green-200"
          emptyColor="bg-zinc-50 text-zinc-400 ring-zinc-200"
          tooltip="Candidates who replied 'Yes' — ready for an AI screening call"
          onClick={() => onOpenStage("ai_screen", "replied")}
        />
        <MetricBadge
          value={stats.aiReview}
          label="To Review"
          color="bg-amber-50 text-amber-700 ring-amber-200"
          emptyColor="bg-zinc-50 text-zinc-400 ring-zinc-200"
          highlight={hasReview}
          tooltip="AI screening calls are done — review the transcript, recording, and verdict for each candidate"
          onClick={() => onOpenStage("ai_screen", "call_done")}
        />
        <MetricBadge
          value={stats.shortlist}
          label="Shortlist"
          color="bg-purple-50 text-purple-700 ring-purple-200"
          emptyColor="bg-zinc-50 text-zinc-400 ring-zinc-200"
          tooltip="Candidates you've shortlisted and shared with the client for a decision"
          onClick={() => onOpenStage("shortlist")}
        />
        {(client.approved > 0 || client.pending > 0 || client.rejected > 0) ? (
          <button type="button" onClick={() => onOpenStage("shortlist")} className="inline-flex items-center gap-1 hover:opacity-80 transition-opacity" title="Client decisions on your shared shortlist">
            {client.approved > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 rounded-lg px-2 py-1 ring-1 ring-emerald-200">
                <CheckCircle2 className="h-3 w-3" />{client.approved}
              </span>
            )}
            {client.pending > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 bg-amber-50 rounded-lg px-2 py-1 ring-1 ring-amber-200">
                <Clock className="h-3 w-3" />{client.pending}
              </span>
            )}
            {client.rejected > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-red-600 bg-red-50 rounded-lg px-2 py-1 ring-1 ring-red-200">
                <XCircle className="h-3 w-3" />{client.rejected}
              </span>
            )}
          </button>
        ) : (
          <span className="inline-flex items-center text-[11px] font-bold text-zinc-400 bg-zinc-50 rounded-lg px-2 py-1 ring-1 ring-zinc-200">—</span>
        )}
        <MetricBadge
          value={stats.interview.pending + stats.interview.invite_sent}
          label="Interview"
          sublabel={stats.interview.confirmed > 0 ? `${stats.interview.confirmed} confirmed` : undefined}
          color="bg-cyan-50 text-cyan-700 ring-cyan-200"
          emptyColor="bg-zinc-50 text-zinc-400 ring-zinc-200"
          tooltip="Candidates awaiting interview scheduling or whose interview invite is pending"
          onClick={() => onOpenStage("pipeline", "interview")}
        />
        {screening.calling > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-600 bg-blue-50 rounded-lg px-2 py-1 ring-1 ring-blue-200" title="AI call in progress right now">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
            {screening.calling} calling
          </span>
        )}
        {stats.interview.rescheduled > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-orange-600 bg-orange-50 rounded-lg px-2 py-1 ring-1 ring-orange-200" title="Candidate suggested a new interview time — review and confirm">
            <Clock className="h-3 w-3" />
            {stats.interview.rescheduled} rescheduled
          </span>
        )}
      </div>
    </div>
  )
}

function MetricBadge({
  value, label, sublabel, color, emptyColor, highlight, tooltip, onClick,
}: {
  value: number; label: string; sublabel?: string; color: string; emptyColor: string; highlight?: boolean; tooltip?: string; onClick?: () => void
}) {
  const isEmpty = value === 0 && !sublabel
  const classes = isEmpty ? emptyColor : highlight ? `${color} ring-2` : color
  const inner = (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold rounded-lg px-2 py-1 ring-1 ${classes}`}>
      <span>{value}</span>
      <span className="font-medium opacity-70">{label}</span>
      {sublabel && <span className="font-medium opacity-60 text-[10px]">· {sublabel}</span>}
    </span>
  )

  if (onClick && !isEmpty) {
    return (
      <button type="button" onClick={onClick} className="hover:opacity-80 transition-opacity" title={tooltip}>
        {inner}
      </button>
    )
  }
  if (tooltip) {
    return <span title={tooltip}>{inner}</span>
  }
  return inner
}
