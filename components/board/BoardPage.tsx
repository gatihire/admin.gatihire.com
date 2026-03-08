"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { SuggestionInput } from "@/components/ui/suggestion-input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ApplyFlowDialog, BoardJobLite, clearCandidateIntent, readCandidateIntent } from "@/components/board/ApplyFlowDialog"
import { ArrowRight, Briefcase, Building2, Filter, MapPin, SlidersHorizontal, UserRound } from "lucide-react"
import { ensureSessionStart, trackEvent, trackPageView } from "@/lib/analytics-client"
import { INTERNAL_SEARCH_SUGGESTIONS } from "@/lib/search-suggestions"

type Job = {
  id: string
  title: string
  location: string | null
  city: string | null
  created_at: string
  industry?: string | null
  employment_type?: string | null
  shift_type?: string | null
  salary_type?: string | null
  salary_min?: number | null
  salary_max?: number | null
  department_category?: string | null
  client_name?: string | null
  company_logo_url?: string | null
  apply_type?: string | null
  external_apply_url?: string | null
  experience_min_years?: number | null
  experience_max_years?: number | null
}

type CandidateLite = {
  id: string
  name: string
  email: string
  desired_role?: string | null
  preferred_location?: string | null
  open_job_types?: string[] | null
  preferred_roles?: string[] | null
  file_url?: string | null
  file_name?: string | null
}

function formatEnum(value: any) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatSalary(job: Job) {
  if (!job.salary_min && !job.salary_max) return "Competitive"
  const min = job.salary_min ? `₹${String(job.salary_min).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}` : ""
  const max = job.salary_max ? `₹${String(job.salary_max).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}` : ""
  const range = min && max ? `${min} - ${max}` : min || max
  const suffix = job.salary_type ? ` / ${formatEnum(job.salary_type)}` : ""
  return `${range}${suffix}`
}

const LOCATION_PRESETS = [
  "Anywhere in India",
  "Delhi NCR",
  "Mumbai",
  "Bengaluru",
  "Hyderabad",
  "Chennai",
  "Pune",
  "Ahmedabad",
  "Kolkata",
  "Jaipur",
  "Surat",
  "Indore",
  "Lucknow",
]

const PLACEHOLDERS = [
  "Search job by title",
  "Search job by skill",
  "Search job by company",
]

export function BoardPage() {
  const profileRef = useRef<HTMLDivElement | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [loadingJobs, setLoadingJobs] = useState(true)

  const [isAuthed, setIsAuthed] = useState(false)
  const [candidate, setCandidate] = useState<CandidateLite | null>(null)
  const [candidateLoading, setCandidateLoading] = useState(false)

  const [query, setQuery] = useState("")
  const [draftQuery, setDraftQuery] = useState("")
  const [experience, setExperience] = useState<string>("any")
  const [locationOpen, setLocationOpen] = useState(false)
  const [location, setLocation] = useState<string>("Anywhere in India")

  const [employmentType, setEmploymentType] = useState<string>("any")
  const [shiftType, setShiftType] = useState<string>("any")
  const [department, setDepartment] = useState<string>("any")
  const [sortBy, setSortBy] = useState<string>("recent")

  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const [applyJob, setApplyJob] = useState<BoardJobLite | null>(null)
  const [applyOpen, setApplyOpen] = useState(false)

  useEffect(() => {
    const t = setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % PLACEHOLDERS.length)
    }, 2200)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const t = setTimeout(() => {
      trackEvent({ event_name: "board.search", metadata: { query: q } })
    }, 600)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    setDraftQuery(query)
  }, [query])

  const commitSearch = () => {
    const q = draftQuery.trim()
    setQuery(q)
  }

  useEffect(() => {
    let unsub: any = null
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      setIsAuthed(!!data.session)
      const token = data.session?.access_token || null
      await ensureSessionStart(token)
      await trackPageView(token)
    })()
    const sub = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAuthed(!!session)
      const token = session?.access_token || null
      ensureSessionStart(token)
      trackPageView(token)
      if (session?.access_token) {
        trackEvent({ event_name: "login_succeeded", metadata: { method: "oauth" }, access_token: session.access_token })
      }
    })
    unsub = sub.data.subscription
    return () => {
      try {
        unsub?.unsubscribe?.()
      } catch {}
    }
  }, [])

  useEffect(() => {
    setLoadingJobs(true)
    ;(async () => {
      try {
        const { data } = await supabase
          .from("jobs")
          .select(
            "id,title,location,city,created_at,industry,employment_type,shift_type,salary_type,salary_min,salary_max,department_category,client_name,company_logo_url,apply_type,external_apply_url,experience_min_years,experience_max_years,status"
          )
          .eq("status", "open")
          .order("created_at", { ascending: false })
        setJobs(Array.isArray(data) ? (data as any) : [])
      } finally {
        setLoadingJobs(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!isAuthed) {
      setCandidate(null)
      return
    }

    setCandidateLoading(true)
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) {
        setCandidate(null)
        setCandidateLoading(false)
        return
      }
      const res = await fetch("/api/candidate/me", { headers: { authorization: `Bearer ${token}` } })
      const c = res.ok ? ((await res.json()) as CandidateLite) : null
      setCandidate(c)
      setCandidateLoading(false)
    })()
  }, [isAuthed])

  useEffect(() => {
    if (!jobs.length) return
    const intent = readCandidateIntent()
    if (!intent) return
    const j = jobs.find((x) => x.id === intent.jobId)
    if (!j) {
      clearCandidateIntent()
      return
    }
    setApplyJob({
      id: j.id,
      title: j.title,
      client_name: j.client_name,
      company_logo_url: j.company_logo_url,
      apply_type: j.apply_type,
      external_apply_url: intent.type === "external" ? intent.redirectUrl : j.external_apply_url,
    })
    setApplyOpen(true)
  }, [jobs])

  const derivedPreferredRoles = useMemo(() => {
    const roles = Array.isArray(candidate?.preferred_roles) ? candidate?.preferred_roles : []
    const desired = String(candidate?.desired_role || "").trim()
    return Array.from(new Set([...(roles || []), ...(desired ? [desired] : [])].map((r) => String(r).trim()).filter(Boolean))).slice(0, 8)
  }, [candidate])

  const derivedJobTypes = useMemo(() => {
    const v = Array.isArray(candidate?.open_job_types) ? candidate?.open_job_types : []
    return Array.from(new Set((v || []).map((x) => String(x)))).filter(Boolean)
  }, [candidate])

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase()

    const prefRoleTerms = derivedPreferredRoles.map((r) => r.toLowerCase())
    const prefLocation = String(candidate?.preferred_location || "").trim()
    const enforceLocation = prefLocation && prefLocation !== "Anywhere in India"
    const enforceJobTypes = derivedJobTypes.length > 0

    let rows = jobs
      .filter((job) => {
        if (experience !== "any") {
          const min = typeof job.experience_min_years === "number" ? job.experience_min_years : null
          const max = typeof job.experience_max_years === "number" ? job.experience_max_years : null
          if (experience === "fresher" && (min ?? 0) > 0) return false
          if (experience === "1_2" && !((max ?? 99) >= 1 && (min ?? 0) <= 2)) return false
          if (experience === "3_5" && !((max ?? 99) >= 3 && (min ?? 0) <= 5)) return false
          if (experience === "5_plus" && (max ?? 99) < 5) return false
        }
        if (employmentType !== "any" && String(job.employment_type || "") !== employmentType) return false
        if (shiftType !== "any" && String(job.shift_type || "") !== shiftType) return false
        if (department !== "any" && String(job.department_category || "") !== department) return false
        if (location && location !== "Anywhere in India") {
          const loc = `${job.city || ""} ${job.location || ""}`.toLowerCase()
          if (!loc.includes(location.toLowerCase())) return false
        }
        if (enforceLocation) {
          const loc = `${job.city || ""} ${job.location || ""}`.toLowerCase()
          if (!loc.includes(prefLocation.toLowerCase())) return false
        }
        if (enforceJobTypes) {
          if (!derivedJobTypes.includes(String(job.employment_type || ""))) return false
        }
        if (q) {
          const hay = `${job.title} ${job.client_name || ""} ${job.industry || ""} ${job.department_category || ""}`.toLowerCase()
          return hay.includes(q)
        }
        if (prefRoleTerms.length) {
          const hay = `${job.title} ${job.industry || ""} ${job.department_category || ""}`.toLowerCase()
          return prefRoleTerms.some((t) => hay.includes(t))
        }
        return true
      })

    if (sortBy === "recent") {
      rows = rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    } else if (sortBy === "salary") {
      rows = rows
        .slice()
        .sort((a, b) => (Number(b.salary_max || b.salary_min || 0) || 0) - (Number(a.salary_max || a.salary_min || 0) || 0))
    }

    return rows
  }, [jobs, query, derivedPreferredRoles, candidate, derivedJobTypes, employmentType, shiftType, department, location, sortBy, experience])

  const openApply = (job: Job) => {
    trackEvent({ event_name: "board.apply.started", entity_type: "jobs", entity_id: job.id, metadata: { job_id: job.id, surface: "job_list" } })
    setApplyJob({
      id: job.id,
      title: job.title,
      client_name: job.client_name,
      company_logo_url: job.company_logo_url,
      apply_type: job.apply_type,
      external_apply_url: job.external_apply_url,
    })
    setApplyOpen(true)
  }

  const scrollToProfile = () => {
    profileRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const FiltersContent = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold">
          <SlidersHorizontal className="h-4 w-4" />
          Filters
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setEmploymentType("any")
            setShiftType("any")
            setDepartment("any")
          }}
        >
          Clear
        </Button>
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Employment type</div>
        <Select value={employmentType} onValueChange={setEmploymentType}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="full_time">Full time</SelectItem>
            <SelectItem value="part_time">Part time</SelectItem>
            <SelectItem value="contract">Contract</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Shift</div>
        <Select value={shiftType} onValueChange={setShiftType}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="night">Night</SelectItem>
            <SelectItem value="rotational">Rotational</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Department</div>
        <Select value={department} onValueChange={setDepartment}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="operations">Operations</SelectItem>
            <SelectItem value="fleet">Fleet</SelectItem>
            <SelectItem value="dispatch">Dispatch</SelectItem>
            <SelectItem value="warehouse">Warehouse</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-white border-b sticky top-0 z-20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-lg bg-zinc-900 text-white flex items-center justify-center font-bold">Tz</div>
            {/* <div className="min-w-0">
            <div className="font-semibold leading-tight truncate">GatiHire Jobs</div>
              <div className="text-xs text-muted-foreground truncate">Logistics • Transport • Supply Chain</div>
            </div> */}
          </div>
          <div className="flex items-center gap-2">
            {isAuthed ? (
              <Button
                variant="outline"
                onClick={async () => {
                  await supabase.auth.signOut()
                  setCandidate(null)
                }}
              >
                Sign out
              </Button>
            ) : (
              <Button
                onClick={async () => {
                  try {
                    localStorage.setItem("gatihire_candidate_intent", JSON.stringify({ type: "apply", jobId: "__browse__" }))
                  } catch {}
                  await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/board` } })
                }}
              >
                Create profile
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-5">
        <Card className="shadow-sm">
          <CardContent className="p-4">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_200px_260px_140px] gap-3 items-stretch">
              <div className="relative">
                <SuggestionInput
                  value={draftQuery}
                  onValueChange={setDraftQuery}
                  suggestions={INTERNAL_SEARCH_SUGGESTIONS}
                  placeholder="job title, company, skill or department"
                  inputClassName="h-10 bg-white"
                  maxItems={8}
                  onEnter={commitSearch}
                />
                <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground hidden md:flex">
                  {PLACEHOLDERS[placeholderIndex]}
                </div>
              </div>

              <Select value={experience} onValueChange={setExperience}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Your experience" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Your experience</SelectItem>
                  <SelectItem value="fresher">Fresher</SelectItem>
                  <SelectItem value="1_2">1-2 years</SelectItem>
                  <SelectItem value="3_5">3-5 years</SelectItem>
                  <SelectItem value="5_plus">5+ years</SelectItem>
                </SelectContent>
              </Select>

              <Popover open={locationOpen} onOpenChange={setLocationOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-10 justify-start gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{location}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search location…" />
                    <CommandList>
                      <CommandEmpty>No results</CommandEmpty>
                      <CommandGroup heading="India">
                        {LOCATION_PRESETS.map((opt) => (
                          <CommandItem
                            key={opt}
                            onSelect={() => {
                              setLocation(opt)
                              setLocationOpen(false)
                            }}
                          >
                            {opt}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              <Button className="h-10" onClick={commitSearch}>
                Search jobs
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between gap-3">
          <div className="text-sm sm:text-base font-semibold">
            Showing {loadingJobs ? "…" : filteredJobs.length} jobs based on your profile
          </div>
          <div className="flex items-center gap-2">
            <div className="lg:hidden">
              <Drawer>
                <DrawerTrigger asChild>
                  <Button variant="outline" className="gap-2">
                    <Filter className="h-4 w-4" />
                    Filters
                  </Button>
                </DrawerTrigger>
                <DrawerContent className="p-0">
                  <DrawerHeader>
                    <DrawerTitle>Filters</DrawerTitle>
                  </DrawerHeader>
                  <div className="p-4">{FiltersContent}</div>
                </DrawerContent>
              </Drawer>
            </div>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Most recent</SelectItem>
                <SelectItem value="salary">Highest pay</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr_340px] gap-6 items-start">
          <div className="hidden lg:block">
            <Card className="sticky top-24">
              <CardContent className="p-4">{FiltersContent}</CardContent>
            </Card>
          </div>

          <div className="space-y-3">
            {loadingJobs ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-28 rounded-xl bg-zinc-100 animate-pulse" />
                ))}
              </div>
            ) : filteredJobs.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center text-muted-foreground">
                  No jobs match your filters.
                </CardContent>
              </Card>
            ) : (
              filteredJobs.map((job) => {
                const isExternal = String(job.apply_type || "in_platform") === "external"
                return (
                  <Card key={job.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-4">
                        <div className="shrink-0">
                          {job.company_logo_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={String(job.company_logo_url)}
                              alt="Logo"
                              className="h-12 w-12 rounded-xl border bg-white object-contain p-1"
                            />
                          ) : (
                            <div className="h-12 w-12 rounded-xl border bg-white flex items-center justify-center text-muted-foreground">
                              <Building2 className="h-5 w-5" />
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <Link
                                href={`/board/${job.id}`}
                                onClick={() =>
                                  trackEvent({
                                    event_name: "board.job.viewed",
                                    entity_type: "jobs",
                                    entity_id: job.id,
                                    metadata: { job_id: job.id, surface: "job_list" },
                                  })
                                }
                                className="block font-semibold text-base sm:text-lg leading-tight hover:underline truncate"
                              >
                                {job.title}
                              </Link>
                              <div className="mt-1 text-sm text-muted-foreground truncate">{job.client_name || "Company"}</div>
                            </div>
                            <Button variant="ghost" size="icon" asChild className="shrink-0">
                              <Link
                                href={`/board/${job.id}`}
                                aria-label="View details"
                                onClick={() =>
                                  trackEvent({
                                    event_name: "board.job.viewed",
                                    entity_type: "jobs",
                                    entity_id: job.id,
                                    metadata: { job_id: job.id, surface: "job_list" },
                                  })
                                }
                              >
                                <ArrowRight className="h-4 w-4" />
                              </Link>
                            </Button>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2 text-sm">
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              <MapPin className="h-4 w-4" />
                              {[job.city, job.location].filter(Boolean).join(", ") || "India"}
                            </span>
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              <Briefcase className="h-4 w-4" />
                              {job.employment_type ? formatEnum(job.employment_type) : "Job"}
                            </span>
                            <span className="inline-flex items-center gap-1 text-muted-foreground">{formatSalary(job)}</span>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {job.shift_type ? <Badge variant="secondary">{formatEnum(job.shift_type)}</Badge> : null}
                            {job.department_category ? <Badge variant="outline">{formatEnum(job.department_category)}</Badge> : null}
                            {isExternal ? <Badge className="bg-emerald-600">Company site</Badge> : <Badge className="bg-blue-600">Easy apply</Badge>}
                          </div>

                          <div className="mt-4 flex items-center justify-between gap-3">
                            <Button variant={isExternal ? "outline" : "default"} className="gap-2" onClick={() => openApply(job)}>
                              {isExternal ? "Apply on company site" : "Upload CV to apply"}
                            </Button>
                            <div className="text-xs text-muted-foreground">Posted {new Date(job.created_at).toLocaleDateString()}</div>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })
            )}
          </div>

          <div className="space-y-4">
            <Card className="sticky top-24">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Profile</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {isAuthed ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-zinc-900 text-white flex items-center justify-center font-semibold">
                        {String(candidate?.name || "U").slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{candidate?.name || "Your profile"}</div>
                        <div className="text-xs text-muted-foreground truncate">{candidate?.email || ""}</div>
                      </div>
                    </div>
                    <Button variant="outline" className="w-full" onClick={scrollToProfile}>
                      Update profile
                    </Button>
                    {candidateLoading ? <div className="text-xs text-muted-foreground">Loading profile…</div> : null}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-lg border bg-muted/30 p-3">
                      <div className="font-semibold">India's Fastest Growing Logistics Hiring Platform</div>
                      <div className="mt-1 text-sm text-muted-foreground">Create your profile in 60 seconds. Get hired faster.</div>
                    </div>
                    <Button
                      className="w-full gap-2"
                      onClick={async () => {
                        trackEvent({ event_name: "board.signup.started", metadata: { method: "google" } })
                        try {
                          localStorage.setItem("gatihire_candidate_intent", JSON.stringify({ type: "apply", jobId: "__browse__" }))
                        } catch {}
                        await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/board` } })
                      }}
                    >
                      <UserRound className="h-4 w-4" />
                      Create profile
                    </Button>
                  </div>
                )}

                <Separator />

                <div ref={profileRef} className="space-y-3">
                  <div>
                    <div className="font-semibold">Edit your preferences</div>
                    <div className="text-xs text-muted-foreground">Your personalised job feed is shown based on these preferences</div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">Preferred title/role</div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!candidate) return
                          const next = prompt("Add a preferred role (e.g., Fleet Manager)")
                          if (!next) return
                          const roles = Array.isArray(candidate.preferred_roles) ? candidate.preferred_roles : []
                          const updated = Array.from(new Set([...roles, next].map((x) => String(x).trim()).filter(Boolean))).slice(0, 12)
                          ;(async () => {
                            const { data } = await supabase.auth.getSession()
                            const token = data.session?.access_token
                            if (!token) return
                            const res = await fetch("/api/candidate/me", {
                              method: "PUT",
                              headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
                              body: JSON.stringify({ preferred_roles: updated }),
                            })
                            if (res.ok) setCandidate((await res.json()) as CandidateLite)
                          })()
                        }}
                        disabled={!isAuthed}
                      >
                        Add
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(derivedPreferredRoles.length ? derivedPreferredRoles : ["Logistics roles"]).map((r) => (
                        <Badge key={r} variant="secondary" className="font-normal">
                          {r}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">Job preferences</div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          if (!candidate) return
                          const current = Array.isArray(candidate.open_job_types) ? candidate.open_job_types : []
                          const next = current.includes("full_time") ? [] : ["full_time"]
                          const { data } = await supabase.auth.getSession()
                          const token = data.session?.access_token
                          if (!token) return
                          const res = await fetch("/api/candidate/me", {
                            method: "PUT",
                            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
                            body: JSON.stringify({ open_job_types: next }),
                          })
                          if (res.ok) setCandidate((await res.json()) as CandidateLite)
                        }}
                        disabled={!isAuthed}
                      >
                        Edit
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(derivedJobTypes.length ? derivedJobTypes : ["full_time", "part_time"]).slice(0, 6).map((t) => (
                        <Badge key={t} variant="outline" className="font-normal">
                          {formatEnum(t)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <ApplyFlowDialog
          job={applyJob}
          open={applyOpen}
          onOpenChange={(v) => {
            setApplyOpen(v)
            if (!v) {
              setApplyJob(null)
              clearCandidateIntent()
            }
          }}
          onCandidateUpdated={(c) => setCandidate((prev) => ({ ...(prev || ({} as any)), ...c }))}
        />
      </main>
    </div>
  )
}
