"use client"

import React, { useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Loader2, Star, MapPin, Briefcase, Eye, Plus, Sparkles, Phone, RotateCw,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp, SortDesc, X, Clock,
  MessageCircle, ClipboardCheck, Archive, BrainCircuit, Filter,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface Candidate {
  id?: string
  name?: string
  currentRole?: string
  current_role?: string
  currentCompany?: string
  current_company?: string
  location?: string
  phone?: string
  total_experience?: string
  totalExperience?: string
  technical_skills?: string[]
  technicalSkills?: string[]
  soft_skills?: string[]
  softSkills?: string[]
  summary?: string
  email?: string
}

interface FitResult {
  fit_score: number | null
  pros?: string[]
  misses?: string[]
  summary?: string
}

interface DbMatchesTabProps {
  jobId: string
  onViewProfile: (candidate: any) => void
  onCandidateAdded: () => void
}

// ── Sidebar filters (client-app parity) ──
interface SidebarFilters {
  mustHaveKeywords: string[]
  excludeKeywords: string[]
  cities: string[]
  experience: { min: string; max: string }
  callableOnly: boolean
}

const EMPTY_FILTERS: SidebarFilters = {
  mustHaveKeywords: [],
  excludeKeywords: [],
  cities: [],
  experience: { min: "", max: "" },
  callableOnly: false,
}

function activeFilterCount(f: SidebarFilters): number {
  return (
    f.mustHaveKeywords.length +
    f.excludeKeywords.length +
    f.cities.length +
    ((f.experience.min || f.experience.max) ? 1 : 0) +
    (f.callableOnly ? 1 : 0)
  )
}

function FilterSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-zinc-200 pb-3.5 mb-3.5 last:border-b-0 last:mb-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full py-2.5 text-xs font-semibold text-zinc-800 cursor-pointer bg-transparent border-none"
      >
        {title}
        {open ? <ChevronUp className="h-3.5 w-3.5 text-zinc-400" /> : <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />}
      </button>
      {open && <div className="pt-1 space-y-3">{children}</div>}
    </div>
  )
}

function TagInput({ label, tags, onAdd, onRemove, placeholder }: { label?: string; tags: string[]; onAdd: (v: string) => void; onRemove: (v: string) => void; placeholder?: string }) {
  const [val, setVal] = useState("")
  const commit = () => {
    const v = val.trim()
    if (v && !tags.includes(v)) onAdd(v)
    setVal("")
  }
  return (
    <div>
      {label && <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1.5">{label}</div>}
      <div className="flex gap-1.5">
        <Input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit() } }}
          placeholder={placeholder || "Type + Enter"}
          className="h-8 text-xs flex-1"
        />
        <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={commit}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[10px] font-semibold text-amber-700">
              {t}
              <button onClick={() => onRemove(t)} className="flex hover:text-amber-900">
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function DbFilterSidebar({ filters, onApply, onClose }: { filters: SidebarFilters; onApply: (f: SidebarFilters) => void; onClose: () => void }) {
  const [local, setLocal] = useState<SidebarFilters>(filters)
  useEffect(() => { setLocal(filters) }, [filters])

  const count = activeFilterCount(local)

  return (
    <div className="w-full lg:w-[270px] shrink-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-zinc-200 bg-white flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-zinc-500" />
          <span className="text-[13px] font-bold text-zinc-900">Filters</span>
          {count > 0 && (
            <span className="px-1.5 rounded-full bg-amber-100 border border-amber-300 text-[10px] font-bold text-amber-700">
              {count}
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 p-0.5">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Sections */}
      <div className="px-4 pt-1 flex-1">
        <FilterSection title="Keywords" defaultOpen>
          <TagInput
            label="Must have"
            tags={local.mustHaveKeywords}
            onAdd={(v) => setLocal({ ...local, mustHaveKeywords: [...local.mustHaveKeywords, v] })}
            onRemove={(v) => setLocal({ ...local, mustHaveKeywords: local.mustHaveKeywords.filter((t) => t !== v) })}
            placeholder="e.g. SAP, forklift..."
          />
          <TagInput
            label="Exclude"
            tags={local.excludeKeywords}
            onAdd={(v) => setLocal({ ...local, excludeKeywords: [...local.excludeKeywords, v] })}
            onRemove={(v) => setLocal({ ...local, excludeKeywords: local.excludeKeywords.filter((t) => t !== v) })}
            placeholder="e.g. intern, fresher..."
          />
        </FilterSection>

        <FilterSection title="Location" defaultOpen>
          <TagInput
            tags={local.cities}
            onAdd={(v) => setLocal({ ...local, cities: [...local.cities, v] })}
            onRemove={(v) => setLocal({ ...local, cities: local.cities.filter((t) => t !== v) })}
            placeholder="e.g. Mumbai, Delhi NCR..."
          />
        </FilterSection>

        <FilterSection title="Experience (Years)" defaultOpen>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1.5">Experience</div>
            <div className="flex gap-2">
              <Input
                type="number"
                min="0"
                placeholder="Min"
                value={local.experience.min}
                onChange={(e) => setLocal({ ...local, experience: { ...local.experience, min: e.target.value } })}
                className="h-8 text-xs"
              />
              <Input
                type="number"
                min="0"
                placeholder="Max"
                value={local.experience.max}
                onChange={(e) => setLocal({ ...local, experience: { ...local.experience, max: e.target.value } })}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-600 cursor-pointer py-0.5">
            <Checkbox
              checked={local.callableOnly}
              onCheckedChange={(c) => setLocal({ ...local, callableOnly: c === true })}
            />
            Callable only (has phone)
          </label>
        </FilterSection>
      </div>

      {/* Actions */}
      <div className="flex gap-2 px-4 py-3 border-t border-zinc-200">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 h-8 text-xs"
          onClick={() => { setLocal(EMPTY_FILTERS); onApply(EMPTY_FILTERS) }}
        >
          Clear All
        </Button>
        <Button size="sm" className="flex-1 h-8 text-xs" onClick={() => onApply(local)}>
          Apply Filters
        </Button>
      </div>
    </div>
  )
}

// ── Main component ──

const TIERS = [
  { id: "all", label: "All Tiers" },
  { id: "excellent", label: "Excellent (85%+)" },
  { id: "perfect", label: "Perfect (75-84%)" },
  { id: "strong", label: "Strong (65-74%)" },
  { id: "good", label: "Good (55-64%)" },
  { id: "average", label: "Average (45-54%)" },
  { id: "fair", label: "Fair (26-44%)" },
  { id: "weak", label: "Weak (≤25%)" },
]

const SORT_OPTIONS = [
  { id: "relevance", label: "Match % (High to Low)" },
  { id: "relevance_asc", label: "Match % (Low to High)" },
  { id: "name", label: "Name (A-Z)" },
  { id: "name_desc", label: "Name (Z-A)" },
  { id: "experience", label: "Experience (High to Low)" },
  { id: "experience_asc", label: "Experience (Low to High)" },
]

type SortId = "relevance" | "relevance_asc" | "name" | "name_desc" | "experience" | "experience_asc"

function matchPercent(m: any): number {
  const raw = m.relevance_score ?? m.match_score ?? 0
  return Math.max(0, Math.min(100, Math.round((raw > 1 ? raw / 100 : raw) * 100)))
}

function avatarColor(pct: number) {
  if (pct >= 80) return "bg-green-500"
  if (pct >= 50) return "bg-yellow-500"
  return "bg-gray-400"
}

function scorePillClass(pct: number) {
  if (pct >= 80) return "bg-green-100 text-green-700 border-green-200"
  if (pct >= 50) return "bg-yellow-100 text-yellow-800 border-yellow-200"
  return "bg-gray-100 text-gray-600 border-gray-200"
}

function parseExperience(text: string): number {
  const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i)
  if (!m) return 0
  const v = Number(m[1])
  return Number.isFinite(v) ? v : 0
}

export function DbMatchesTab({ jobId, onViewProfile, onCandidateAdded }: DbMatchesTabProps) {
  const [matches, setMatches] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [actionableTotal, setActionableTotal] = useState(0)
  const [tier, setTier] = useState("all")
  const [tierCounts, setTierCounts] = useState<Record<string, number>>({})
  const [perPage] = useState(25)
  const [sortBy, setSortBy] = useState<SortId>("relevance")
  const [filters, setFilters] = useState<SidebarFilters>(EMPTY_FILTERS)
  const [showSidebar, setShowSidebar] = useState(true)

  const [insights, setInsights] = useState<Record<string, FitResult>>({})
  const [insightLoading, setInsightLoading] = useState<Set<string>>(new Set())
  const [outreachBusy, setOutreachBusy] = useState(false)

  const { toast } = useToast()
  const abortControllerRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  const fetchSeqRef = useRef(0)

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const fetchMatches = useCallback(async (options: { page?: number; refresh?: boolean; silent?: boolean } = {}) => {
    const { page = 1, refresh = false, silent = false } = options

    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()
    // Sequence guard: only the LATEST request may touch loading/data state.
    // Without this, an aborted older request's finally-block clears the loader
    // while the newer request is still in flight → UI flashes to "no matches".
    const seq = ++fetchSeqRef.current

    if (!silent) {
      if (refresh) setRefreshing(true)
      else setLoading(true)
    }

    try {
      const params = new URLSearchParams({
        page: String(page),
        perPage: String(perPage),
      })
      if (refresh) params.set("refresh", "1")
      if (tier !== "all") params.set("tier", tier)
      if (filters.experience.min !== "") params.set("minExp", filters.experience.min)
      if (filters.experience.max !== "") params.set("maxExp", filters.experience.max)
      if (filters.cities.length > 0) params.set("cities", filters.cities.join(","))
      if (filters.mustHaveKeywords.length > 0) params.set("mustKw", filters.mustHaveKeywords.join(","))
      if (filters.excludeKeywords.length > 0) params.set("excludeKw", filters.excludeKeywords.join(","))
      if (filters.callableOnly) params.set("hasPhone", "1")

      const res = await fetch(`/api/jobs/${jobId}/matches?${params.toString()}`, {
        headers: { "x-user-role": "recruiter" },
        signal: abortControllerRef.current?.signal,
      })
      const data = await res.json()

      if (seq !== fetchSeqRef.current) return

      setMatches(((data.items || data.matches || []) as any[]).map((m: any) => ({
        ...m,
        matchingKeywords: m.matchingKeywords || m.matching_keywords || [],
      })))
      setTotal(data.total ?? 0)
      setActionableTotal(data.actionableTotal ?? 0)
      setTierCounts(data.tierCounts ?? {})
      setPage(data.page ?? page)
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return
      console.error("Failed to fetch matches:", err)
      if (!silent) {
        toast({ title: "Error", description: "Failed to load matches", variant: "destructive" })
      }
    } finally {
      if (!silent && seq === fetchSeqRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [jobId, perPage, tier, filters, toast])

  // Initial load per job
  useEffect(() => {
    fetchMatches({ page: 1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  // Debounced refetch when filters change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchMatches({ page: 1 })
    }, 350)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, filters, perPage])

  const runFreshMatch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    fetchMatches({ page: 1, refresh: true })
  }, [fetchMatches])

  const applyFilters = useCallback((f: SidebarFilters) => {
    setFilters(f)
  }, [])

  const clearAllFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS)
    setTier("all")
  }, [])

  const toggleSelect = useCallback((candidateId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(candidateId)) next.delete(candidateId)
      else next.add(candidateId)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback((checked: boolean | "indeterminate") => {
    if (checked === true) {
      setSelectedIds(new Set(matches.map((m) => String(m.candidate_id || "")).filter(Boolean)))
    } else {
      setSelectedIds(new Set())
    }
  }, [matches])

  const sortedMatches = (() => {
    const arr = [...matches]
    switch (sortBy) {
      case "name":
        return arr.sort((a, b) => String(a.candidate?.name || "").localeCompare(String(b.candidate?.name || "")))
      case "name_desc":
        return arr.sort((a, b) => String(b.candidate?.name || "").localeCompare(String(a.candidate?.name || "")))
      case "experience":
        return arr.sort((a, b) => parseExperience(b.candidate?.total_experience || "") - parseExperience(a.candidate?.total_experience || ""))
      case "experience_asc":
        return arr.sort((a, b) => parseExperience(a.candidate?.total_experience || "") - parseExperience(b.candidate?.total_experience || ""))
      case "relevance_asc":
        return arr.sort((a, b) => matchPercent(a) - matchPercent(b))
      default:
        return arr.sort((a, b) => matchPercent(b) - matchPercent(a))
    }
  })()

  const fetchInsight = useCallback(async (candidateId: string) => {
    if (insights[candidateId] || insightLoading.has(candidateId)) return
    setInsightLoading((prev) => new Set(prev).add(candidateId))
    try {
      const res = await fetch(`/api/jobs/${jobId}/fit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: [candidateId] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Fit analysis failed")
      const fit = data.fits?.[candidateId]
      if (fit) setInsights((prev) => ({ ...prev, [candidateId]: fit }))
    } catch (err: any) {
      toast({ title: "AI Insight unavailable", description: err.message, variant: "destructive" })
    } finally {
      setInsightLoading((prev) => {
        const next = new Set(prev)
        next.delete(candidateId)
        return next
      })
    }
  }, [jobId, insights, insightLoading, toast])

  const triggerOutreach = useCallback(async (candidateIds: string[], callMode: "whatsapp_first" | "call_now") => {
    if (candidateIds.length === 0 || outreachBusy) return
    setOutreachBusy(true)
    try {
      const res = await fetch("/api/phone-screening/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          candidateIds,
          createApplication: true,
          callMode,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Outreach failed")

      const nudges = data.nudgeSent ?? 0
      const calls = data.callsTriggered ?? 0
      const skipped = Array.isArray(data.skippedNoPhone) ? data.skippedNoPhone.length : 0
      const parts: string[] = []
      if (nudges > 0) parts.push(`${nudges} WhatsApp nudge${nudges === 1 ? "" : "s"} sent`)
      if (calls > 0) parts.push(`${calls} AI call${calls === 1 ? "" : "s"} triggered`)
      if (skipped > 0) parts.push(`${skipped} skipped (no phone)`)

      toast({
        title: "Outreach started",
        description: parts.length > 0 ? parts.join(" · ") : "Candidates queued",
      })

      setSelectedIds(new Set())
      fetchMatches({ silent: true })
    } catch (err: any) {
      console.error("Outreach failed:", err)
      toast({ title: "Outreach failed", description: err.message, variant: "destructive" })
    } finally {
      setOutreachBusy(false)
    }
  }, [jobId, outreachBusy, toast, fetchMatches])

  const addToPipeline = useCallback(async (candidateIds: string[]) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/bulk-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds, action: "shortlist" }),
      })
      const data = await res.json()
      if (res.ok) {
        toast({ title: "Success", description: data.message || `${candidateIds.length} added to Shortlist` })
        setSelectedIds(new Set())
        onCandidateAdded()
        fetchMatches({ silent: true })
      } else {
        toast({ title: "Error", description: data?.error || "Failed to add to pipeline", variant: "destructive" })
      }
    } catch (err) {
      console.error("Add to pipeline failed:", err)
      toast({ title: "Error", description: "Failed to add to pipeline", variant: "destructive" })
    }
  }, [jobId, onCandidateAdded, toast, fetchMatches])

  const rejectCandidates = useCallback(async (candidateIds: string[]) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/bulk-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds, action: "reject" }),
      })
      const data = await res.json()
      if (res.ok) {
        toast({ title: "Rejected", description: data.message || `${candidateIds.length} candidate${candidateIds.length === 1 ? "" : "s"} rejected` })
        setSelectedIds(new Set())
        fetchMatches({ silent: true })
      } else {
        toast({ title: "Error", description: data?.error || "Failed to reject candidates", variant: "destructive" })
      }
    } catch (err) {
      console.error("Reject failed:", err)
      toast({ title: "Error", description: "Failed to reject candidates", variant: "destructive" })
    }
  }, [jobId, toast, fetchMatches])

  const getSkills = (c: Candidate | undefined): string[] =>
    (c?.technical_skills || c?.technicalSkills || []) as string[]

  const outreachDisabledReason = (m: any): string | null => {
    if (m.already_applied || m.already_called) return "Already in pipeline"
    if (!m.has_phone) return "No phone number"
    return null
  }

  const hasActiveFilters = activeFilterCount(filters) > 0 || tier !== "all"

  return (
    <div className="flex flex-col lg:flex-row gap-5 items-start">
      {/* Collapsed filter button (client-app style) */}
      {!showSidebar && (
        <button
          onClick={() => setShowSidebar(true)}
          className="relative shrink-0 h-11 w-11 rounded-[10px] bg-white border border-zinc-200 flex items-center justify-center hover:border-zinc-300 transition-colors"
          title="Show filters"
        >
          <Filter className="h-4 w-4 text-zinc-600" />
          {hasActiveFilters && (
            <span className="absolute -top-1 -right-1 h-4 min-w-4 px-0.5 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
              {activeFilterCount(filters) + (tier !== "all" ? 1 : 0)}
            </span>
          )}
        </button>
      )}

      {/* Sidebar */}
      {showSidebar && (
        <DbFilterSidebar
          filters={filters}
          onApply={applyFilters}
          onClose={() => setShowSidebar(false)}
        />
      )}

      {/* Results column */}
      <div className="flex-1 min-w-0 space-y-4 w-full">
        {/* Banner */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-purple-200 bg-gradient-to-r from-purple-50 to-indigo-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <Sparkles className="h-4 w-4 text-purple-600 shrink-0" />
            <span className="font-semibold text-zinc-900">{total} matched</span>
            <span className="text-zinc-400">·</span>
            <span className="text-zinc-600">
              <span className="font-semibold text-green-700">{actionableTotal} callable now</span>
            </span>
            {hasActiveFilters && (
              <>
                <span className="text-zinc-400">·</span>
                <button onClick={clearAllFilters} className="text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5">
                  <X className="h-3 w-3" /> Clear filters
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={runFreshMatch} disabled={loading || refreshing}>
              {(loading || refreshing) ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              {refreshing ? "Matching..." : "Refresh"}
            </Button>
          </div>
        </div>

        {/* Loading strip — always visible while fetching */}
        {(loading || refreshing) && (
          <div className="flex items-center gap-2 text-xs font-medium text-purple-700 bg-purple-50 border border-purple-100 rounded-lg px-3 py-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            {refreshing ? "Running fresh match against candidate database..." : "Loading matches..."}
          </div>
        )}

        {/* Top control bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={tier} onValueChange={(v) => setTier(v)}>
            <SelectTrigger className="h-8 text-xs w-[150px]">
              <SelectValue placeholder="All Tiers" />
            </SelectTrigger>
            <SelectContent>
              {TIERS.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.id !== "all" && tierCounts[t.id] !== undefined ? `${t.label} (${tierCounts[t.id]})` : t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortId)}>
            <SelectTrigger className="h-8 text-xs w-[190px]">
              <SortDesc className="h-3.5 w-3.5 mr-1.5 shrink-0" />
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

        </div>

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg p-3 flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <Checkbox
                checked={sortedMatches.length > 0 && sortedMatches.every((m) => selectedIds.has(String(m.candidate_id || "")))}
                onCheckedChange={toggleSelectAll}
              />
              <span className="text-sm font-medium text-blue-700">
                {selectedIds.size} selected ·{" "}
                {Array.from(selectedIds).filter((id) => {
                  const m = matches.find((mm) => String(mm.candidate_id) === id)
                  return m?.has_phone && !m.already_applied && !m.already_called
                }).length} callable
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-stretch">
                <Button
                  size="sm"
                  className="rounded-r-none bg-green-600 hover:bg-green-700 h-8 border-r border-green-700"
                  disabled={outreachBusy}
                  onClick={() => triggerOutreach(Array.from(selectedIds), "whatsapp_first")}
                >
                  {outreachBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5 mr-1.5" />}
                  WhatsApp Selected
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      className="rounded-l-none bg-green-600 hover:bg-green-700 h-8 w-6 p-0 px-0"
                      disabled={outreachBusy}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => triggerOutreach(Array.from(selectedIds), "whatsapp_first")}>
                      <MessageCircle className="h-3.5 w-3.5 mr-2" />
                      WhatsApp Nudge First
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => triggerOutreach(Array.from(selectedIds), "call_now")}>
                      <Phone className="h-3.5 w-3.5 mr-2" />
                      AI Call Now
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Button variant="outline" size="sm" className="h-8" onClick={() => addToPipeline(Array.from(selectedIds))}>
                <ClipboardCheck className="h-3.5 w-3.5 mr-1.5" />
                Add to Pipeline
              </Button>
              <Button variant="destructive" size="sm" className="h-8" onClick={() => rejectCandidates(Array.from(selectedIds))}>
                <Archive className="h-3.5 w-3.5 mr-1.5" />
                Reject
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-500" onClick={() => setSelectedIds(new Set())}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Loading skeletons */}
        {loading && (
          <div className="grid gap-3">
            {Array.from({ length: Math.min(perPage, 6) }).map((_, i) => (
              <Card key={i} className="animate-pulse rounded-xl">
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-full bg-zinc-200" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-zinc-200 rounded w-1/3" />
                      <div className="h-3 bg-zinc-100 rounded w-1/2" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && matches.length === 0 && (
          <Card className="border-dashed border-zinc-300 bg-zinc-50/50 rounded-xl">
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Star className="h-8 w-8 text-zinc-300 mb-3" />
              <p className="text-zinc-500 font-semibold">No DB matches found</p>
              <p className="text-sm text-zinc-400 mt-1 mb-4">Hit Refresh to run a fresh match against the candidate database</p>
              <Button variant="outline" size="sm" onClick={runFreshMatch} disabled={refreshing}>
                <RotateCw className="h-4 w-4 mr-1.5" />
                Refresh
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Cards */}
        {!loading && matches.length > 0 && (
          <div className="space-y-3">
            {/* Select-all header */}
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={sortedMatches.length > 0 && sortedMatches.every((m) => selectedIds.has(String(m.candidate_id || "")))}
                  onCheckedChange={toggleSelectAll}
                />
                <span className="text-xs text-zinc-500">
                  Select all on page ({sortedMatches.length})
                </span>
              </div>
              <span className="text-xs text-zinc-400">
                Page {page} of {Math.max(1, Math.ceil(total / perPage))}
              </span>
            </div>

            <div className="grid gap-3">
              {sortedMatches.map((m) => {
                const candidate: Candidate = m.candidate || {}
                const pct = matchPercent(m)
                const candidateId = String(m.candidate_id || "")
                const isSelected = selectedIds.has(candidateId)
                const expYears = parseExperience(candidate.total_experience || candidate.totalExperience || "")
                const name = candidate.name || "Unknown Candidate"
                const role = candidate.currentRole || candidate.current_role || ""
                const company = candidate.currentCompany || candidate.current_company || ""
                const loc = candidate.location || ""
                const skills = getSkills(candidate)
                const reason = outreachDisabledReason(m)
                const outreachDisabled = reason !== null
                const insight = insights[candidateId]
                const isLoadingInsight = insightLoading.has(candidateId)
                const keywords = m.matchingKeywords || []

                return (
                  <Card
                    key={`${m.job_id}-${candidateId}`}
                    className={`hover:shadow-md transition-shadow rounded-xl ${isSelected ? "ring-2 ring-blue-300 bg-blue-50/30" : ""}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex gap-3">
                        {/* Left rail: checkbox + avatar */}
                        <div className="flex flex-col items-center gap-2 shrink-0">
                          <Checkbox checked={isSelected} onCheckedChange={() => toggleSelect(candidateId)} />
                          <Avatar className="h-11 w-11 border border-zinc-100">
                            <AvatarFallback className={`text-white font-bold text-sm ${avatarColor(pct)}`}>
                              {name.substring(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        </div>

                        {/* Main content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2 flex-wrap">
                            <div className="min-w-0 flex-1">
                              {/* Name + callable pill + score */}
                              <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="font-semibold text-base text-zinc-900 truncate">{name}</h3>

                                {reason ? (
                                  <Badge variant="outline" className="h-5 text-[10px] px-1.5 font-normal text-zinc-500 border-zinc-300">
                                    {reason}
                                  </Badge>
                                ) : (
                                  <Badge className="h-5 text-[10px] px-1.5 font-medium bg-green-100 text-green-700 border border-green-200 hover:bg-green-100">
                                    <span className="h-1.5 w-1.5 rounded-full bg-green-500 mr-1" />
                                    Callable
                                  </Badge>
                                )}

                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full border cursor-pointer hover:opacity-80 ${scorePillClass(pct)}`}
                                      title="Why this score?"
                                    >
                                      {pct}%
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-72 p-3">
                                    <div className="text-xs font-semibold text-zinc-700 mb-2">Match breakdown</div>
                                    {m.score_breakdown ? (
                                      <ScoreBreakdownGrid breakdown={m.score_breakdown} keywords={keywords} />
                                    ) : (
                                      <div className="text-xs text-zinc-400">No breakdown available</div>
                                    )}
                                  </PopoverContent>
                                </Popover>
                              </div>

                              {/* Role @ Company */}
                              <div className="flex items-center text-sm text-zinc-600 mt-1 min-w-0">
                                <Briefcase className="h-3.5 w-3.5 mr-1.5 text-blue-500 shrink-0" />
                                <span className="truncate">
                                  {role || "No role listed"}
                                  {company && <span className="text-zinc-400"> @ {company}</span>}
                                </span>
                              </div>

                              {/* Location + exp chips */}
                              <div className="flex items-center gap-3 mt-1 flex-wrap">
                                {loc && (
                                  <span className="inline-flex items-center text-xs text-zinc-500">
                                    <MapPin className="h-3.5 w-3.5 mr-1 text-green-500" />
                                    {loc}
                                  </span>
                                )}
                                {expYears > 0 && (
                                  <span className="inline-flex items-center text-xs text-zinc-500">
                                    <Clock className="h-3.5 w-3.5 mr-1 text-purple-500" />
                                    {expYears} yr{expYears === 1 ? "" : "s"} exp
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1.5 shrink-0 flex-wrap" title={reason || undefined}>
                              {/* Split button: primary = WhatsApp nudge; dropdown for both options */}
                              <div className="flex items-stretch">
                                <Button
                                  size="sm"
                                  className="h-8 rounded-r-none bg-green-600 hover:bg-green-700 border-r border-green-700"
                                  disabled={outreachDisabled || outreachBusy}
                                  onClick={() => triggerOutreach([candidateId], "whatsapp_first")}
                                >
                                  {outreachBusy ? (
                                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                  ) : (
                                    <MessageCircle className="h-3.5 w-3.5 mr-1" />
                                  )}
                                  WhatsApp
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      size="sm"
                                      className="h-8 w-6 p-0 rounded-l-none bg-green-600 hover:bg-green-700 px-0"
                                      disabled={outreachDisabled || outreachBusy}
                                    >
                                      <ChevronDown className="h-3.5 w-3.5" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => triggerOutreach([candidateId], "whatsapp_first")}>
                                      <MessageCircle className="h-3.5 w-3.5 mr-2" />
                                      WhatsApp Nudge First
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => triggerOutreach([candidateId], "call_now")}>
                                      <Phone className="h-3.5 w-3.5 mr-2" />
                                      AI Call Now
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>

                              <Button variant="outline" size="icon" className="h-8 w-8" title="View Profile" onClick={() => onViewProfile(candidate)}>
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>

                          {/* Skills */}
                          {skills.length > 0 && (
                            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                              {skills.slice(0, 6).map((s, i) => (
                                <Badge key={i} variant="secondary" className="text-[10px] px-1.5 py-0 h-5 font-normal bg-zinc-100 text-zinc-600 border-transparent">
                                  {s}
                                </Badge>
                              ))}
                              {skills.length > 6 && (
                                <span className="text-[10px] text-zinc-400">+{skills.length - 6}</span>
                              )}
                            </div>
                          )}

                          {/* AI Insight strip */}
                          <div className="mt-2.5">
                            {!insight && !isLoadingInsight && (
                              <button
                                onClick={() => fetchInsight(candidateId)}
                                className="inline-flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800 font-medium transition-colors"
                              >
                                <BrainCircuit className="h-3.5 w-3.5" />
                                AI Insight
                              </button>
                            )}
                            {isLoadingInsight && (
                              <div className="flex items-center gap-2 text-xs text-zinc-400">
                                <BrainCircuit className="h-3.5 w-3.5 animate-pulse" />
                                Analyzing fit...
                              </div>
                            )}
                            {insight && (
                              <div className="rounded-lg bg-purple-50 border border-purple-100 px-3 py-2 text-xs space-y-1.5">
                                <div className="flex items-center gap-2">
                                  <BrainCircuit className="h-3.5 w-3.5 text-purple-600" />
                                  <span className="font-semibold text-purple-700">
                                    AI Insight
                                  </span>
                                  {insight.summary && (
                                    <span className="text-zinc-600 truncate flex-1">{insight.summary}</span>
                                  )}
                                </div>
                                {(insight.pros?.length || insight.misses?.length) && (
                                  <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 pl-5">
                                    {insight.pros?.slice(0, 2).map((p, i) => (
                                      <div key={`p${i}`} className="text-green-700 truncate">+ {p}</div>
                                    ))}
                                    {insight.misses?.slice(0, 2).map((mi, i) => (
                                      <div key={`m${i}`} className="text-orange-700 truncate">− {mi}</div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchMatches({ page: page - 1 })}
                disabled={page <= 1 || loading}
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                Previous
              </Button>
              <span className="text-xs text-zinc-500 font-medium">
                Page {page} of {Math.max(1, Math.ceil(total / perPage))} · {total} matched
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchMatches({ page: page + 1 })}
                disabled={page >= Math.ceil(total / perPage) || loading}
              >
                Next
                <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ScoreBreakdownGrid({ breakdown, keywords }: { breakdown: Record<string, { earned: number; max: number }>; keywords?: string[] }) {
  const cells = [
    { key: "role", label: "Role", color: "text-green-600" },
    { key: "experience", label: "Experience", color: "text-orange-600" },
    { key: "location", label: "Location", color: "text-blue-600" },
    { key: "skills", label: "Skills", color: "text-purple-600" },
  ]
  return (
    <div className="space-y-2 text-xs">
      <div className="grid grid-cols-4 gap-2">
        {cells.map((c) => (
          <div key={c.key} className="text-center rounded-md bg-white border border-zinc-200 py-1.5">
            <div className="text-[10px] font-medium text-zinc-500">{c.label}</div>
            <div className={`font-bold ${c.color}`}>
              {breakdown[c.key]?.earned ?? 0}/{breakdown[c.key]?.max ?? 0}
            </div>
          </div>
        ))}
      </div>
      {keywords && keywords.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {keywords.slice(0, 6).map((k: string, i: number) => (
            <Badge key={i} variant="secondary" className="text-[10px] px-1.5 py-0 h-5 font-normal bg-green-50 text-green-700 border-green-200">
              {k}
            </Badge>
          ))}
          {keywords.length > 6 && (
            <span className="text-[10px] text-zinc-400 self-center">+{keywords.length - 6} more</span>
          )}
        </div>
      )}
    </div>
  )
}
