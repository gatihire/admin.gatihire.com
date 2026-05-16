"use client"

import { useMemo, useState, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Plus, Search, MapPin, Briefcase, Clock, MoreHorizontal } from "lucide-react"
import { CreateJobDialog } from "./create-job-dialog"
import { formatDistanceToNow } from "date-fns"
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
  outreach_sent_count?: number | null
  outreach_responded_count?: number | null
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
  const [sortFilter, setSortFilter] = useState<string>(() => searchParams.get("sort") || "newest")
  const [page, setPage] = useState<number>(() => Number(searchParams.get("page")) || 1)
  const perPage = 50
  const [total, setTotal] = useState<number>(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<Job | null>(null)
  const [appCounts, setAppCounts] = useState<Record<string, number>>({})
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({})
  const [dbMatchCounts, setDbMatchCounts] = useState<Record<string, number>>({})
  
  const jobsCacheKey = "internal:jobs:/api/jobs"
  const jobCountsCacheKey = "internal:jobs:counts"

  // Sync state to URL
  const updateUrl = useCallback(() => {
    const params = new URLSearchParams()
    if (searchQuery) params.set("search", searchQuery)
    if (statusFilter !== "all") params.set("status", statusFilter)
    if (clientFilter !== "all") params.set("clientId", clientFilter)
    if (sourceFilter !== "all") params.set("source", sourceFilter)
    if (sortFilter !== "newest") params.set("sort", sortFilter)
    if (page > 1) params.set("page", String(page))
    
    const qs = params.toString()
    router.replace(`/jobs${qs ? `?${qs}` : ""}`, { scroll: false })
  }, [router, searchQuery, statusFilter, clientFilter, sourceFilter, sortFilter, page])

  useEffect(() => {
    updateUrl()
  }, [updateUrl])

  useEffect(() => {
    fetchClients()
  }, [])

  const fetchClients = async (opts?: { force?: boolean }) => {
    try {
      const data = await cachedFetchJson<any[]>(`internal:jobs:/api/clients`, "/api/clients", undefined, {
        ttlMs: 10 * 60_000,
        force: Boolean(opts?.force),
      })
      setClients(Array.isArray(data) ? data.map((c: any) => ({ id: c.id, name: c.name, slug: c.slug, logo_url: c.logo_url })) : [])
    } catch {
      setClients([])
    }
  }

  const applyCounts = (payload: { appCounts: Record<string, number>; pendingCounts: Record<string, number>; dbMatchCounts: Record<string, number> }) => {
    setAppCounts(payload.appCounts || {})
    setPendingCounts(payload.pendingCounts || {})
    setDbMatchCounts(payload.dbMatchCounts || {})
  }

  const fetchJobCounts = async (data: Job[], opts?: { force?: boolean }) => {
    if (!Array.isArray(data) || data.length === 0) {
      applyCounts({ appCounts: {}, pendingCounts: {}, dbMatchCounts: {} })
      return
    }
    const payload = await getSessionCached(
      jobCountsCacheKey,
      async () => {
        const ids = (data || []).map((j) => j.id).filter(Boolean)
        const idsKey = ids.slice().sort().join(",")
        const out = await cachedFetchJson<{
          appCounts: Record<string, number>
          pendingCounts: Record<string, number>
          dbMatchCounts: Record<string, number>
        }>(
          `internal:jobs:/api/jobs/stats?ids=${idsKey}`,
          `/api/jobs/stats?ids=${encodeURIComponent(idsKey)}`,
          undefined,
          { ttlMs: 60_000 },
        )
        return out
      },
      { ttlMs: 60_000, force: Boolean(opts?.force), swr: true, onData: applyCounts as any },
    )
    applyCounts(payload as { appCounts: Record<string, number>; pendingCounts: Record<string, number>; dbMatchCounts: Record<string, number> })
  }

  const fetchJobs = async (opts?: { force?: boolean; page?: number }) => {
    const force = Boolean(opts?.force)
    const targetPage = Math.max(1, Number(opts?.page ?? page) || 1)
    const url = `/api/jobs?paginate=true&page=${targetPage}&perPage=${perPage}&status=${encodeURIComponent(statusFilter)}&source=${encodeURIComponent(sourceFilter)}&clientId=${encodeURIComponent(clientFilter)}&search=${encodeURIComponent(searchQuery)}`
    const cacheKey = `${jobsCacheKey}:${url}`

    // Show cached data instantly if not forcing a hard refresh
    const cachedPage = !force ? peekSessionCache<{ items: Job[]; total: number }>(cacheKey) : null
    const cachedCounts = !force
      ? peekSessionCache<{ appCounts: Record<string, number>; pendingCounts: Record<string, number>; dbMatchCounts: Record<string, number> }>(jobCountsCacheKey)
      : null

    if (cachedPage && Array.isArray(cachedPage.items)) {
      setJobs(cachedPage.items)
      setTotal(typeof cachedPage.total === "number" ? cachedPage.total : cachedPage.items.length)
      setLoading(false)
    } else {
      setLoading(true)
    }

    if (cachedCounts) applyCounts(cachedCounts)

    try {
      // Use SWR to always get real-time fresh data in the background
      const data = await cachedFetchJson<{ items: Job[]; total: number; page: number; perPage: number }>(cacheKey, url, undefined, {
        ttlMs: 60_000,
        force,
        swr: true,
        onData: (freshData) => {
          const freshItems = Array.isArray((freshData as any)?.items) ? (freshData as any).items : []
          setJobs(freshItems)
          setTotal(typeof (freshData as any)?.total === "number" ? (freshData as any).total : freshItems.length)
        }
      })
      const items = Array.isArray((data as any)?.items) ? (data as any).items : []
      setJobs(items)
      setTotal(typeof (data as any)?.total === "number" ? (data as any).total : items.length)
      
      // Also fetch counts with SWR
      await fetchJobCounts(items, { force })
    } catch (error) {
      console.error("Failed to fetch jobs", error)
    } finally {
      setLoading(false)
    }
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
  const visibleJobs = useMemo(() => {
    const list = Array.isArray(jobs) ? jobs.slice() : []
    return list.sort((a, b) => {
      if (sortFilter === "newest") {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      } else if (sortFilter === "oldest") {
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      } else if (sortFilter === "urgency") {
        const aRank = (a as any).urgency_tag === "urgently_hiring" ? 0 : a.status === "open" ? 1 : 2
        const bRank = (b as any).urgency_tag === "urgently_hiring" ? 0 : b.status === "open" ? 1 : 2
        if (aRank !== bRank) return aRank - bRank
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      }
      return 0
    })
  }, [jobs, sortFilter])

  useEffect(() => {
    const t = setTimeout(() => {
      fetchJobs({ force: false })
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          trigger={
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Post New Job
            </Button>
          }
        />
        {editingJob && (
          <CreateJobDialog
            key={editingJob.id}
            open={editOpen}
            onOpenChange={(open) => {
              setEditOpen(open)
              if (!open) setEditingJob(null)
            }}
            onJobCreated={async () => {
              invalidateSessionCache("internal:jobs:", { prefix: true })
              invalidateSessionCache(jobCountsCacheKey)
              await fetchJobs({ force: true })
            }}
            jobId={editingJob.id}
            initialValues={{
              title: editingJob.title,
              industry: (editingJob as any).industry,
              location: editingJob.location,
              employment_type: (editingJob as any).employment_type,
              shift_type: (editingJob as any).shift_type,
              urgency_tag: (editingJob as any).urgency_tag,
              city: (editingJob as any).city,
              salary_type: (editingJob as any).salary_type,
              salary_min: (editingJob as any).salary_min,
              salary_max: (editingJob as any).salary_max,
              description: editingJob.description,
              openings: (editingJob as any).openings,
              client_name: (editingJob as any).client_name,
              client_id: (editingJob as any).client_id,
              apply_type: (editingJob as any).apply_type,
              external_apply_url: (editingJob as any).external_apply_url,
              skills_must_have: (editingJob as any).skills_must_have,
              skills_good_to_have: (editingJob as any).skills_good_to_have,
              sub_category: (editingJob as any).sub_category,
              education_min: (editingJob as any).education_min,
              experience_min_years: (editingJob as any).experience_min_years,
              experience_max_years: (editingJob as any).experience_max_years,
              languages_required: (editingJob as any).languages_required,
              english_level: (editingJob as any).english_level,
              license_type: (editingJob as any).license_type,
              age_min: (editingJob as any).age_min,
              age_max: (editingJob as any).age_max,
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
              <div className="relative">
                <Input
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    setPage(1)
                  }}
                  placeholder="Search jobs..."
                />
              </div>
            </div>

            <div className="md:col-span-2">
              <div className="text-xs text-zinc-500 mb-1">Status</div>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v)
                  setPage(1)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="inactive">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="md:col-span-2">
              <div className="text-xs text-zinc-500 mb-1">Source</div>
              <Select
                value={sourceFilter}
                onValueChange={(v) => {
                  setSourceFilter(v)
                  setPage(1)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="truckinzy">Truckinzy Side</SelectItem>
                  <SelectItem value="employee">Employee Side</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="md:col-span-2">
              <div className="text-xs text-zinc-500 mb-1">Sort By</div>
              <Select
                value={sortFilter}
                onValueChange={(v) => {
                  setSortFilter(v)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Sort By" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest First</SelectItem>
                  <SelectItem value="oldest">Oldest First</SelectItem>
                  <SelectItem value="urgency">Urgency / Status</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="md:col-span-2">
              <div className="text-xs text-zinc-500 mb-1">Client</div>
              <Select
                value={clientFilter}
                onValueChange={(v) => {
                  setClientFilter(v)
                  setPage(1)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Client" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All clients</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="md:col-span-1">
              <div className="text-xs text-zinc-500 mb-1">&nbsp;</div>
              <Button variant="outline" className="w-full" onClick={refreshAll}>
                Refresh
              </Button>
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
                  <PaginationPrevious
                    href="#"
                    aria-disabled={page <= 1}
                    onClick={(e) => {
                      e.preventDefault()
                      if (page > 1) setPage(page - 1)
                    }}
                  />
                </PaginationItem>
                <PaginationItem>
                  <PaginationLink href="#" isActive>
                    {page}
                  </PaginationLink>
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    aria-disabled={page >= totalPages}
                    onClick={(e) => {
                      e.preventDefault()
                      if (page < totalPages) setPage(page + 1)
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 bg-gray-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleJobs.map((job) => {
            const clientName = (job.client_id && clientsById.get(job.client_id)?.name) || job.client_name || ""
            const clientLogo = job.client_id ? (clientsById.get(job.client_id)?.logo_url || null) : null
            const pending = pendingCounts[job.id] || 0

            return (
              <Card key={job.id} className="cursor-pointer border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition flex flex-col" onClick={() => router.push(`/jobs/${job.id}`)}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge className={job.status === "open" ? "bg-green-600" : "bg-zinc-600"}>{job.status}</Badge>
                      {pending > 0 && (
                        <Badge className="bg-orange-500 hover:bg-orange-600 border-transparent text-white">
                          {pending} New App{pending > 1 ? "s" : ""}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
                      </span>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                          }}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem
                          onClick={() => {
                            setEditingJob(job)
                            setEditOpen(true)
                          }}
                        >
                          Edit Job
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            navigator.clipboard.writeText(getBoardJobApplyUrl(job.id))
                          }}
                        >
                          Share job link
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={async () => {
                            const newStatus = job.status === "open" ? "inactive" : "open"
                            await fetch(`/api/jobs/${job.id}`, {
                              method: "PUT",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ status: newStatus })
                            })
                            invalidateSessionCache("internal:jobs:", { prefix: true })
                            invalidateSessionCache(jobCountsCacheKey)
                            fetchJobs({ force: true })
                          }}
                        >
                          Change status
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600 focus:text-red-600"
                          onClick={async () => {
                            const ok = confirm("Delete this job? This cannot be undone.")
                            if (!ok) return
                            await fetch(`/api/jobs/${job.id}`, { method: "DELETE" })
                            invalidateSessionCache("internal:jobs:", { prefix: true })
                            invalidateSessionCache(jobCountsCacheKey)
                            fetchJobs({ force: true })
                          }}
                        >
                          Delete
                        </DropdownMenuItem>
                        {!job.is_external_link && (
                          <DropdownMenuItem
                            onClick={() => {
                              window.open(`/jobs/${job.id}/outreach`, "_blank")
                            }}
                          >
                            Send Outreach Messages
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <CardTitle className="text-lg leading-snug line-clamp-1">{job.title}</CardTitle>

                  <CardDescription className="flex items-center gap-2 line-clamp-1">
                    {clientLogo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={String(clientLogo)} alt="Logo" className="h-5 w-5 rounded border bg-white object-contain p-0.5" />
                    ) : null}
                    {clientName ? <span className="font-medium text-zinc-700">{clientName}</span> : null}
                    {job.industry || job.department_category ? <span className="text-muted-foreground">•</span> : null}
                    <span>{job.industry || job.department_category || ""}</span>
                  </CardDescription>
                </CardHeader>

                <CardContent className="pb-3 flex-1">
                  <div className="grid gap-2 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-3.5 w-3.5" />
                      <span className="truncate">{job.location}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Briefcase className="h-3.5 w-3.5" />
                      <span className="truncate">{job.employment_type ? String(job.employment_type).replace(/_/g, " ") : "—"}</span>
                    </div>
                    {job.is_external_link && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">External Link</span>
                      </div>
                    )}
                    {job.outreach_sent_count && job.outreach_sent_count > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                          {job.outreach_sent_count} outreach sent • {job.outreach_responded_count || 0} responded
                        </span>
                      </div>
                    )}
                  </div>
                </CardContent>

                <CardFooter className="pt-0 grid grid-cols-2 gap-2 mt-auto">
                  <Button
                    variant={pending > 0 ? "default" : "outline"}
                    className={pending > 0 ? "w-full justify-center bg-zinc-900 hover:bg-zinc-800 text-white" : "w-full justify-center"}
                    onClick={(e) => {
                      e.stopPropagation()
                      router.push(`/jobs/${job.id}?tab=all`)
                    }}
                  >
                    Applicants ({appCounts[job.id] || 0})
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-center"
                    onClick={(e) => {
                      e.stopPropagation()
                      window.open(`/jobs/${job.id}/matches`, "_blank")
                    }}
                  >
                    Matches ({dbMatchCounts[job.id] || 0})
                  </Button>
                </CardFooter>
              </Card>
            )
          })}

          {jobs.length === 0 && <div className="col-span-full text-center py-12 text-muted-foreground">No jobs found.</div>}
        </div>
      )}
    </div>
  )
}
