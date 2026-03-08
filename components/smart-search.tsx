"use client"
import { useState, useEffect, useMemo, useRef } from "react"
import dynamic from "next/dynamic"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { SuggestionInput } from "@/components/ui/suggestion-input"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { logger } from "@/lib/logger"
import { getSessionCached, peekSessionCache } from "@/lib/utils"
import { INTERNAL_SEARCH_SUGGESTIONS } from "@/lib/search-suggestions"
import {
  Search,
  Sparkles,
  User,
  MapPin,
  Briefcase,
  Download,
  Eye,
  Building,
  Mail,
  Phone,
  GraduationCap,
  Code,
  TrendingUp,
  SortDesc,
  Filter,
  Bot,
  FileText,
  Truck,
  X,
  Plus,
  ChevronDown,
  Clock,
  Languages,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { AssignJobDialog } from "./assign-job-dialog"
const CandidatePreviewDialogDynamic = dynamic(() => import("./candidate-preview-dialog").then(m => m.CandidatePreviewDialog), {
  ssr: false,
})

interface SearchResult {
  _id: string
  id?: string
  name: string
  currentRole: string
  location: string
  totalExperience: string
  technicalSkills: string[]
  softSkills: string[]
  email: string
  phone: string
  currentCompany?: string
  degree?: string
  university?: string
  certifications?: string[]
  relevanceScore: number
  matchPercentage?: number
  matchingKeywords: string[]
  fileUrl?: string
  fileName?: string
  summary?: string
  linkedinProfile?: string
  resumeText: string
  status?: "new" | "reviewed" | "shortlisted" | "interviewed" | "selected" | "rejected" | "on-hold"
  uploadedAt?: string
  currentSalary?: string
  expectedSalary?: string
  highestQualification?: string
  languagesKnown?: string[]
  noticePeriod?: string
  preferredLocation?: string
  gender?: string
  age?: number
  maritalStatus?: string
  notes?: string
  rating?: number
  tags?: string[]
  matchDetails?: {
    category: string
    status: 'match' | 'partial' | 'miss'
    score: number
    message: string
    weight: number
  }[]
  scoreBreakdown?: {
    [key: string]: { earned: number; max: number; percentage: number }
  }
  matchSummary?: string
  gapAnalysis?: string[]
  education?: string
}

interface MinimalSearchFilters {
  experienceType: "freshers" | "experienced" | "any"
  keywords: string[]
  location: string
  minExperience: string
  maxExperience: string
  education: string
}

interface SidebarFilters {
  hideInactive: boolean
  showOnlyAvailable: boolean
  mustHaveKeywords: string[]
  excludeKeywords: string[]
  currentCity: string[]
  experience: { min: string; max: string }
  industries: string[]
  companies: string[]
  salaryRange: { min: string; max: string }
  degrees: string[]
  education: string[]
  gender: string[]
  ageRange: { min: string; max: string }
  languages: string[]
  englishFluency: string[]
}

const getAvatarColor = (score: number) => {
  if (score >= 0.8) return "bg-green-500"
  if (score >= 0.5) return "bg-yellow-500"
  return "bg-gray-400"
}

const getMatchColor = (score: number) => {
  if (score >= 0.8) return "bg-green-100 text-green-800 hover:bg-green-200"
  if (score >= 0.5) return "bg-yellow-100 text-yellow-800 hover:bg-yellow-200"
  return "bg-gray-100 text-gray-800 hover:bg-gray-200"
}

export function SmartSearch() {
  const [searchMode, setSearchMode] = useState<"manual" | "smart" | "jd">("manual")
  const [roleScope, setRoleScope] = useState<"current" | "current_past">("current_past")
  const [smartSearchQuery, setSmartSearchQuery] = useState("")
  const [jobDescription, setJobDescription] = useState("")
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [filteredResults, setFilteredResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [selectedCandidate, setSelectedCandidate] = useState<SearchResult | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [sortBy, setSortBy] = useState<"relevance" | "experience" | "name" | "recent">("relevance")
  const [showFilters, setShowFilters] = useState(true)

  // AI keyword suggestions
  const [keywordInput, setKeywordInput] = useState("")
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([])
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false)

  // Manual search filters (minimal)
  const [manualFilters, setManualFilters] = useState<MinimalSearchFilters>({
    experienceType: "any",
    keywords: [],
    location: "",
    minExperience: "",
    maxExperience: "",
    education: "",
  })

  // Sidebar filters
  const [sidebarFilters, setSidebarFilters] = useState<SidebarFilters>({
    hideInactive: false,
    showOnlyAvailable: false,
    mustHaveKeywords: [],
    excludeKeywords: [],
    currentCity: [],
    experience: { min: "", max: "" },
    industries: [],
    companies: [],
    salaryRange: { min: "", max: "" },
    degrees: [],
    education: [],
    gender: [],
    ageRange: { min: "", max: "" },
    languages: [],
    englishFluency: [],
  })

  const [openFilters, setOpenFilters] = useState<Record<string, boolean>>({})
  const [includeKeywordInput, setIncludeKeywordInput] = useState("")
  const [excludeKeywordInput, setExcludeKeywordInput] = useState("")

  // Client-side pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  // Server-side pagination state
  const [serverPaginated, setServerPaginated] = useState(false)
  const [totalResultsServer, setTotalResultsServer] = useState(0)
  const [lastSearchParams, setLastSearchParams] = useState<any | null>(null)
  
  // Cache for search results to improve pagination performance
  const [resultsCache, setResultsCache] = useState<Record<string, { items: SearchResult[], total: number, serverPaginated: boolean }>>({})

  const [aiInsightsById, setAiInsightsById] = useState<Record<string, { summary: string; expanded: boolean; visible: boolean }>>({})
  const [aiInsightLoadingById, setAiInsightLoadingById] = useState<Record<string, boolean>>({})

  const [assignOpen, setAssignOpen] = useState(false)
  const [assignCandidateId, setAssignCandidateId] = useState<string>("")
  const [assignCandidateName, setAssignCandidateName] = useState<string>("")
  const lastSidebarFiltersKeyRef = useRef<string>("")

  const { toast } = useToast()

  useEffect(() => {
    setMounted(true)
  }, [])

  // Common search execution function
  const executeSearch = async (page: number, params: any) => {
    setIsSearching(true)
    if (page === 1) setHasSearched(true)
    setCurrentPage(page)
    setLastSearchParams(params) // Save params for pagination
    if (params.sidebarFilters || params.roleScope) {
      lastSidebarFiltersKeyRef.current = JSON.stringify({
        sidebarFilters: params.sidebarFilters || sidebarFilters,
        roleScope: params.roleScope || roleScope,
      })
    }

    // Check cache first
    const cacheKey = JSON.stringify({ ...params, page })
    const sessionKey = `internal:smartSearch:${cacheKey}`
    if (resultsCache[cacheKey]) {
      logger.info(`Serving search results from cache for page ${page}`)
      const cached = resultsCache[cacheKey]
      setSearchResults(cached.items)
      // filteredResults will be set by useEffect hook that applies filters
      setTotalResultsServer(cached.total)
      setServerPaginated(cached.serverPaginated)
      setIsSearching(false)
      return
    }

    const persisted = peekSessionCache<{ items: SearchResult[]; total: number; serverPaginated: boolean }>(sessionKey)
    if (persisted) {
      logger.info(`Serving search results from session cache for page ${page}`)
      setSearchResults(persisted.items)
      setTotalResultsServer(persisted.total)
      setServerPaginated(persisted.serverPaginated)
      setResultsCache((prev) => ({ ...prev, [cacheKey]: persisted }))
      setIsSearching(false)
      return
    }

    // Construct URL params
    const searchParams = new URLSearchParams({
      type: params.type,
      paginate: 'true',
      page: String(page),
      perPage: String(pageSize),
    })

    if (params.query) searchParams.set(params.type === 'smart' ? 'query' : 'keywords', params.query)
    if (params.jd) searchParams.set('jd', params.jd)
    if (params.roleScope) searchParams.set('roleScope', params.roleScope)
    
    // Add manual filters if present
    if (params.filters) {
      Object.entries(params.filters).forEach(([key, value]) => {
        if (value) searchParams.set(key, String(value))
      })
    }

    if (params.sidebarFilters) {
      const sf = params.sidebarFilters as SidebarFilters
      if (sf.mustHaveKeywords.length) searchParams.set("mustHaveKeywords", sf.mustHaveKeywords.join(","))
      if (sf.excludeKeywords.length) searchParams.set("excludeKeywords", sf.excludeKeywords.join(","))
      if (sf.currentCity.length) searchParams.set("currentCity", sf.currentCity.join(","))
      if (sf.experience.min) searchParams.set("expMin", sf.experience.min)
      if (sf.experience.max) searchParams.set("expMax", sf.experience.max)
      if (sf.salaryRange.min) searchParams.set("salaryMin", sf.salaryRange.min)
      if (sf.salaryRange.max) searchParams.set("salaryMax", sf.salaryRange.max)
      if (sf.education.length) searchParams.set("educationFilters", sf.education.join(","))
      if (sf.gender.length) searchParams.set("genderFilters", sf.gender.join(","))
      if (sf.languages.length) searchParams.set("languageFilters", sf.languages.join(","))
      if (sf.showOnlyAvailable) searchParams.set("showOnlyAvailable", "true")
      if (sf.hideInactive) searchParams.set("hideInactive", "true")
    }
    
    logger.info(`Search fetch: mode=${params.type} page=${page}`)
    
    try {
      const url = `/api/search?${searchParams.toString()}`
      const cached = await getSessionCached<{ items: SearchResult[]; total: number; serverPaginated: boolean }>(
        sessionKey,
        async () => {
          const response = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } })
          const data = await response.json().catch(() => null)
          if (!response.ok) throw new Error((data as any)?.error || "Search failed")
          const items = Array.isArray(data) ? data : (data.items || [])
          const total = Array.isArray(data) ? items.length : (data.total || items.length)
          const processedResults = processSearchResults(items)
          return { items: processedResults, total, serverPaginated: !Array.isArray(data) }
        },
        { ttlMs: 10 * 60_000 },
      )

      setServerPaginated(cached.serverPaginated)
      setTotalResultsServer(cached.total)
      setSearchResults(cached.items)

      setResultsCache((prev) => ({ ...prev, [cacheKey]: cached }))
      
      if (page === 1) {
        toast({
          title: "Search Complete",
          description: `Found ${cached.total} matching candidates`,
        })
      }
    } catch (error) {
      logger.error("Search error:", error)
      toast({
        title: "Error",
        description: "Search failed. Please try again.",
        variant: "destructive",
      })
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }

  const candidateKey = (r: SearchResult) => String(r._id || r.id || "").trim()

  const openAssign = (result: SearchResult) => {
    const id = candidateKey(result)
    if (!id) {
      toast({ title: "Cannot assign", description: "Missing candidate id", variant: "destructive" })
      return
    }
    setAssignCandidateId(id)
    setAssignCandidateName(result.name || "Candidate")
    setAssignOpen(true)
  }

  const loadAiInsight = async (result: SearchResult) => {
    const id = candidateKey(result)
    if (!id) return

    if (aiInsightsById[id]?.summary) {
      setAiInsightsById((prev) => ({
        ...prev,
        [id]: { ...prev[id], visible: !prev[id].visible }
      }))
      return
    }

    const params = lastSearchParams || { type: searchMode }
    const payload = {
      candidateId: id,
      type: params.type || searchMode,
      query: params.query || smartSearchQuery,
      jd: params.jd || jobDescription,
    }

    setAiInsightLoadingById((prev) => ({ ...prev, [id]: true }))
    try {
      const res = await fetch("/api/search/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to generate insight")
      setAiInsightsById((prev) => ({
        ...prev,
        [id]: { summary: String(data?.summary || ""), expanded: false, visible: true }
      }))
    } catch (e: any) {
      toast({ title: "AI insight failed", description: e?.message || "Failed", variant: "destructive" })
    } finally {
      setAiInsightLoadingById((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  const handleSmartSearch = () => {
    if (!smartSearchQuery.trim()) {
      toast({ title: "Error", description: "Please enter a search query", variant: "destructive" })
      return
    }
    const params = { type: 'smart', query: smartSearchQuery, roleScope, sidebarFilters }
    setLastSearchParams(params)
    executeSearch(1, params)
  }

  const handleJDSearch = () => {
    if (!jobDescription.trim()) {
      toast({ title: "Error", description: "Please paste a job description", variant: "destructive" })
      return
    }
    const params = { type: 'jd', jd: jobDescription, roleScope, sidebarFilters }
    setLastSearchParams(params)
    executeSearch(1, params)
  }

  const handleManualSearch = () => {
    if (manualFilters.keywords.length === 0) {
      toast({ title: "Error", description: "Please add at least one keyword", variant: "destructive" })
      return
    }
    const params = {
      type: 'manual',
      query: manualFilters.keywords.join(','),
      filters: {
        location: manualFilters.location,
        minExperience: manualFilters.minExperience,
        maxExperience: manualFilters.maxExperience,
        education: manualFilters.education,
      },
      roleScope,
      sidebarFilters,
    }
    setLastSearchParams(params)
    executeSearch(1, params)
  }


  const processSearchResults = (results: any[]) => {
    return Array.isArray(results)
      ? results.map((result) => ({
          ...result,
          technicalSkills: Array.isArray(result.technicalSkills) ? result.technicalSkills : [],
          softSkills: Array.isArray(result.softSkills) ? result.softSkills : [],
          matchingKeywords: Array.isArray(result.matchingKeywords) ? result.matchingKeywords : [],
          certifications: Array.isArray(result.certifications) ? result.certifications : [],
          languagesKnown: Array.isArray(result.languagesKnown) ? result.languagesKnown : [],
          relevanceScore: typeof result.relevanceScore === "number" ? result.relevanceScore : 0,
          matchPercentage: typeof result.matchPercentage === "number" ? result.matchPercentage : Math.round((result.relevanceScore || 0) * 100),
          status: result.status || "new",
          uploadedAt: result.uploadedAt || new Date().toISOString(),
          // Avoid rendering huge resume text in list to reduce lag. Fetch full on preview.
          resumeText: "",
        }))
      : []
  }

  // Apply sidebar filters to search results
  const applyFilters = (results: SearchResult[]): SearchResult[] => {
    return results.filter((candidate) => {
      // Must have keywords filter
      if (sidebarFilters.mustHaveKeywords.length > 0) {
        const candidateText = [
          candidate.name || "",
          candidate.currentRole || "",
          candidate.location || "",
          ...(candidate.technicalSkills || []),
          ...(candidate.softSkills || []),
          candidate.resumeText || "",
        ].join(" ").toLowerCase()

        const hasAllKeywords = sidebarFilters.mustHaveKeywords.every(keyword =>
          candidateText.includes(keyword.toLowerCase())
        )
        if (!hasAllKeywords) return false
      }

      // Exclude keywords filter
      if (sidebarFilters.excludeKeywords.length > 0) {
        const candidateText = [
          candidate.name || "",
          candidate.currentRole || "",
          candidate.location || "",
          ...(candidate.technicalSkills || []),
          ...(candidate.softSkills || []),
          candidate.resumeText || "",
        ].join(" ").toLowerCase()

        const hasExcludedKeyword = sidebarFilters.excludeKeywords.some(keyword =>
          candidateText.includes(keyword.toLowerCase())
        )
        if (hasExcludedKeyword) return false
      }

      // Hide inactive filter - currently disabled as "inactive" status doesn't exist in the type definition
      // This can be enabled if the status type is extended to include "inactive"
      // if (sidebarFilters.hideInactive && candidate.status === "inactive") {
      //   return false
      // }

      // Show only available filter
      if (sidebarFilters.showOnlyAvailable) {
        const noticePeriod = candidate.noticePeriod || ""
        const isAvailable = noticePeriod.toLowerCase().includes("immediate") ||
          noticePeriod.toLowerCase().includes("0") ||
          noticePeriod === "" ||
          noticePeriod.toLowerCase().includes("ready")
        if (!isAvailable) return false
      }

      // Current City filter
      if (sidebarFilters.currentCity.length > 0) {
        const candidateLocation = (candidate.location || "").toLowerCase()
        const matchesCity = sidebarFilters.currentCity.some(city =>
          candidateLocation.includes(city.toLowerCase())
        )
        if (!matchesCity) return false
      }

      // Experience filter
      if (sidebarFilters.experience.min || sidebarFilters.experience.max) {
        const experienceYears = parseFloat(candidate.totalExperience?.replace(/[^0-9.]/g, "") || "0")
        const minExp = sidebarFilters.experience.min ? parseFloat(sidebarFilters.experience.min) : 0
        const maxExp = sidebarFilters.experience.max ? parseFloat(sidebarFilters.experience.max) : Infinity
        if (experienceYears < minExp || experienceYears > maxExp) return false
      }

      // Salary range filter
      if (sidebarFilters.salaryRange.min || sidebarFilters.salaryRange.max) {
        const currentSalary = candidate.currentSalary || ""
        const expectedSalary = candidate.expectedSalary || ""
        const salaryStr = currentSalary || expectedSalary
        
        if (salaryStr) {
          const salaryMatch = salaryStr.match(/(\d+(?:\.\d+)?)/)
          if (salaryMatch) {
            const salaryValue = parseFloat(salaryMatch[1])
            const minSalary = sidebarFilters.salaryRange.min ? parseFloat(sidebarFilters.salaryRange.min) : 0
            const maxSalary = sidebarFilters.salaryRange.max ? parseFloat(sidebarFilters.salaryRange.max) : Infinity
            if (salaryValue < minSalary || salaryValue > maxSalary) return false
          }
        }
      }

      // Education filter
      if (sidebarFilters.education.length > 0) {
        const candidateEducation = [
          candidate.degree || "",
          candidate.highestQualification || "",
          candidate.education || "",
        ].join(" ").toLowerCase()

        const matchesEducation = sidebarFilters.education.some(edu => {
          const eduLower = edu.toLowerCase()
          return candidateEducation.includes(eduLower) ||
            (eduLower.includes("graduate") && (candidateEducation.includes("bachelor") || candidateEducation.includes("master"))) ||
            (eduLower.includes("post graduate") && candidateEducation.includes("master"))
        })
        if (!matchesEducation) return false
      }

      // Gender filter
      if (sidebarFilters.gender.length > 0) {
        const candidateGender = (candidate.gender || "").toLowerCase()
        const matchesGender = sidebarFilters.gender.some(g =>
          candidateGender.includes(g.toLowerCase())
        )
        if (!matchesGender) return false
      }

      // Languages filter
      if (sidebarFilters.languages.length > 0) {
        const candidateLanguages = (candidate.languagesKnown || []).map(l => l.toLowerCase())
        const matchesLanguage = sidebarFilters.languages.some(lang =>
          candidateLanguages.some(cl => cl.includes(lang.toLowerCase()))
        )
        if (!matchesLanguage) return false
      }

      return true
    })
  }

  const serverFilterKey = useMemo(() => JSON.stringify({ sidebarFilters, roleScope }), [sidebarFilters, roleScope])

  useEffect(() => {
    if (searchResults.length > 0) {
      if (serverPaginated) {
        setFilteredResults(searchResults)
      } else {
        const filtered = applyFilters(searchResults)
        setFilteredResults(filtered)
        setCurrentPage(1)
      }
    } else {
      setFilteredResults([])
    }
  }, [searchResults, sidebarFilters, serverPaginated])

  useEffect(() => {
    if (!hasSearched || !serverPaginated || !lastSearchParams) return
    if (lastSidebarFiltersKeyRef.current === serverFilterKey) return
    lastSidebarFiltersKeyRef.current = serverFilterKey
    executeSearch(1, { ...lastSearchParams, sidebarFilters, roleScope })
  }, [serverFilterKey, hasSearched, lastSearchParams, roleScope, serverPaginated])

  const openPreview = async (candidate: SearchResult) => {
    try {
      setIsPreviewLoading(true)
      // Fetch complete candidate data from the individual candidate API
      const id = candidate._id || candidate.id
      if (id) {
        const res = await fetch(`/api/candidates/${id}`)
        if (res.ok) {
          const fullCandidateData = await res.json()
          // Preserve search-specific fields while using the complete candidate data
          const mergedCandidate = {
            ...fullCandidateData,
            relevanceScore: candidate.relevanceScore,
            matchingKeywords: candidate.matchingKeywords,
          }
          setSelectedCandidate(mergedCandidate)
        } else {
          // Fallback to search result data if API call fails
          setSelectedCandidate(candidate)
        }
      } else {
        setSelectedCandidate(candidate)
      }
    } catch (e) {
      logger.error("Error fetching candidate details:", e)
      // Fallback to search result data if there's an error
      setSelectedCandidate(candidate)
    } finally {
      setIsPreviewLoading(false)
    }
  }

  const addKeyword = (keyword: string) => {
    if (!manualFilters.keywords.includes(keyword)) {
      setManualFilters((prev) => ({
        ...prev,
        keywords: [...prev.keywords, keyword],
      }))
    }
    setKeywordInput("")
    setAiSuggestions([])
  }

  const removeKeyword = (keyword: string) => {
    setManualFilters((prev) => ({
      ...prev,
      keywords: prev.keywords.filter((k) => k !== keyword),
    }))
  }

  const resetSearch = () => {
    setSmartSearchQuery("")
    setJobDescription("")
    setRoleScope("current_past")
    setManualFilters({
      experienceType: "any",
      keywords: [],
      location: "",
      minExperience: "",
      maxExperience: "",
      education: "",
    })
    setKeywordInput("")
    setAiSuggestions([])
    setSearchResults([])
    setFilteredResults([])
    setResultsCache({})
    setHasSearched(false)
    setCurrentPage(1)
    setLastSearchParams(null) // Clear search parameters
  }

  const updateCandidateStatus = async (candidateId: string, status: string) => {
    try {
      const response = await fetch(`/api/candidates/${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })

      if (response.ok) {
        setSearchResults((prev) =>
          prev.map((c) => (c._id === candidateId || c.id === candidateId ? { ...c, status: status as any } : c)),
        )
        setFilteredResults((prev) =>
          prev.map((c) => (c._id === candidateId || c.id === candidateId ? { ...c, status: status as any } : c)),
        )
        if (selectedCandidate && (selectedCandidate._id === candidateId || selectedCandidate.id === candidateId)) {
          setSelectedCandidate({ ...selectedCandidate, status: status as any })
        }
        toast({ title: "Status Updated", description: "Candidate status updated successfully" })
      } else {
        throw new Error("Failed to update status")
      }
    } catch (error) {
      toast({ title: "Error", description: "Failed to update candidate status", variant: "destructive" })
      throw error
    }
  }

  const updateCandidateNotes = async (candidateId: string, notes: string) => {
    try {
      const response = await fetch(`/api/candidates/${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      })

      if (response.ok) {
        setSearchResults((prev) =>
          prev.map((c) => (c._id === candidateId || c.id === candidateId ? { ...c, notes } : c)),
        )
        setFilteredResults((prev) =>
          prev.map((c) => (c._id === candidateId || c.id === candidateId ? { ...c, notes } : c)),
        )
        if (selectedCandidate && (selectedCandidate._id === candidateId || selectedCandidate.id === candidateId)) {
          setSelectedCandidate({ ...selectedCandidate, notes })
        }
        toast({ title: "Notes Updated", description: "Candidate notes updated successfully" })
      } else {
        throw new Error("Failed to update notes")
      }
    } catch (error) {
      toast({ title: "Error", description: "Failed to update candidate notes", variant: "destructive" })
      throw error
    }
  }

  const updateCandidateRating = async (candidateId: string, rating: number) => {
    try {
      const response = await fetch(`/api/candidates/${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      })

      if (response.ok) {
        setSearchResults((prev) =>
          prev.map((c) => (c._id === candidateId || c.id === candidateId ? { ...c, rating } : c)),
        )
        setFilteredResults((prev) =>
          prev.map((c) => (c._id === candidateId || c.id === candidateId ? { ...c, rating } : c)),
        )
        if (selectedCandidate && (selectedCandidate._id === candidateId || selectedCandidate.id === candidateId)) {
          setSelectedCandidate({ ...selectedCandidate, rating })
        }
        toast({ title: "Rating Updated", description: "Candidate rating updated successfully" })
      } else {
        throw new Error("Failed to update rating")
      }
    } catch (error) {
      toast({ title: "Error", description: "Failed to update candidate rating", variant: "destructive" })
      throw error
    }
  }

  const getRelevanceColor = (score: number) => {
    if (score >= 0.8) return "bg-green-100 text-green-800 border-green-200"
    if (score >= 0.6) return "bg-yellow-100 text-yellow-800 border-yellow-200"
    return "bg-red-100 text-red-800 border-red-200"
  }

  const getRelevanceLabel = (score: number) => {
    if (score >= 0.8) return "High Match"
    if (score >= 0.6) return "Medium Match"
    return "Low Match"
  }

  const getInitials = (name: string) => {
    if (!name) return "??"
    return name
      .split(" ")
      .map((n) => n[0])
      .slice(0, 2)
      .join("")
      .toUpperCase()
  }

  const sortedResults = [...filteredResults].sort((a, b) => {
    switch (sortBy) {
      case "relevance":
        return (b.relevanceScore || 0) - (a.relevanceScore || 0)
      case "recent":
        // Sort by upload date (newest first)
        const dateA = new Date(a.uploadedAt || 0).getTime()
        const dateB = new Date(b.uploadedAt || 0).getTime()
        return dateB - dateA
      case "experience":
        return (b.totalExperience || "").localeCompare(a.totalExperience || "")
      case "name":
        return (a.name || "").localeCompare(b.name || "")
      default:
        return 0
    }
  })

  // Apply pagination
  const totalResults = serverPaginated ? totalResultsServer : sortedResults.length
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize))
  const currentPageSafe = Math.min(Math.max(1, currentPage), totalPages)
  const startIdx = (currentPageSafe - 1) * pageSize
  const endIdx = startIdx + pageSize
  const pagedResults = serverPaginated ? sortedResults : sortedResults.slice(startIdx, endIdx)

  if (!mounted) {
    return (
      <div className="flex justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-2 text-gray-600">Loading...</span>
      </div>
    )
  }

  return (
    <div className="flex gap-6">
      {/* Left Sidebar Filters - Only show when there are search results */}
      {hasSearched && searchResults.length > 0 && (
        <div className={`transition-all duration-300 ${showFilters ? "w-80" : "w-12"} flex-shrink-0`}>
          <Card className="sticky top-4 h-fit">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-4">
                {showFilters && (
                  <h3 className="font-semibold text-lg flex items-center">
                    <Filter className="h-5 w-5 mr-2" />
                    Filters
                  </h3>
                )}
                <Button variant="ghost" size="sm" onClick={() => setShowFilters(!showFilters)} className="p-2">
                  {showFilters ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </div>

              {showFilters && (
                <div className="space-y-3">
                  {/* Specific Keywords */}
                  <Collapsible
                    open={openFilters.specificKeywords}
                    onOpenChange={(open) => setOpenFilters((prev) => ({ ...prev, specificKeywords: open }))}
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2 hover:bg-gray-50 rounded">
                      <span className="font-medium">Specific Keywords</span>
                      <ChevronDown className="h-4 w-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-2 space-y-3">
                      <div>
                        <Label className="text-sm">Must include</Label>
                        <div className="flex gap-2 mt-1">
                          <Input
                            placeholder="e.g. GPS, WMS, TMS"
                            value={includeKeywordInput}
                            onChange={(e) => setIncludeKeywordInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && includeKeywordInput.trim()) {
                                const kw = includeKeywordInput.trim()
                                if (!sidebarFilters.mustHaveKeywords.includes(kw)) {
                                  setSidebarFilters((prev) => ({ ...prev, mustHaveKeywords: [...prev.mustHaveKeywords, kw] }))
                                }
                                setIncludeKeywordInput("")
                              }
                            }}
                          />
                          <Button
                            variant="outline"
                            onClick={() => {
                              if (includeKeywordInput.trim()) {
                                const kw = includeKeywordInput.trim()
                                if (!sidebarFilters.mustHaveKeywords.includes(kw)) {
                                  setSidebarFilters((prev) => ({ ...prev, mustHaveKeywords: [...prev.mustHaveKeywords, kw] }))
                                }
                                setIncludeKeywordInput("")
                              }
                            }}
                          >
                            Add
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {sidebarFilters.mustHaveKeywords.map((kw) => (
                            <Badge key={kw} variant="secondary" className="text-xs">
                              {kw}
                              <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() => setSidebarFilters((prev) => ({ ...prev, mustHaveKeywords: prev.mustHaveKeywords.filter((k) => k !== kw) }))} />
                            </Badge>
                          ))}
                        </div>
                      </div>

                      <div>
                        <Label className="text-sm">Exclude</Label>
                        <div className="flex gap-2 mt-1">
                          <Input
                            placeholder="e.g. fresher, trainee"
                            value={excludeKeywordInput}
                            onChange={(e) => setExcludeKeywordInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && excludeKeywordInput.trim()) {
                                const kw = excludeKeywordInput.trim()
                                if (!sidebarFilters.excludeKeywords.includes(kw)) {
                                  setSidebarFilters((prev) => ({ ...prev, excludeKeywords: [...prev.excludeKeywords, kw] }))
                                }
                                setExcludeKeywordInput("")
                              }
                            }}
                          />
                          <Button
                            variant="outline"
                            onClick={() => {
                              if (excludeKeywordInput.trim()) {
                                const kw = excludeKeywordInput.trim()
                                if (!sidebarFilters.excludeKeywords.includes(kw)) {
                                  setSidebarFilters((prev) => ({ ...prev, excludeKeywords: [...prev.excludeKeywords, kw] }))
                                }
                                setExcludeKeywordInput("")
                              }
                            }}
                          >
                            Add
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {sidebarFilters.excludeKeywords.map((kw) => (
                            <Badge key={kw} variant="secondary" className="text-xs">
                              {kw}
                              <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() => setSidebarFilters((prev) => ({ ...prev, excludeKeywords: prev.excludeKeywords.filter((k) => k !== kw) }))} />
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                  {/* Hide candidates that are */}
                  <Collapsible
                    open={openFilters.hideInactive}
                    onOpenChange={(open) => setOpenFilters((prev) => ({ ...prev, hideInactive: open }))}
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2 hover:bg-gray-50 rounded">
                      <span className="font-medium">Hide candidates that are</span>
                      <ChevronDown className="h-4 w-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-2">
                      <div className="space-y-2">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="hide-inactive"
                            checked={sidebarFilters.hideInactive}
                            onCheckedChange={(checked) =>
                              setSidebarFilters((prev) => ({ ...prev, hideInactive: checked as boolean }))
                            }
                          />
                          <Label htmlFor="hide-inactive" className="text-sm">
                            Inactive
                          </Label>
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Show only candidates who */}
                  <Collapsible
                    open={openFilters.showOnly}
                    onOpenChange={(open) => setOpenFilters((prev) => ({ ...prev, showOnly: open }))}
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2 hover:bg-gray-50 rounded">
                      <span className="font-medium">Show only candidates who</span>
                      <ChevronDown className="h-4 w-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-2">
                      <div className="space-y-2">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="show-available"
                            checked={sidebarFilters.showOnlyAvailable}
                            onCheckedChange={(checked) =>
                              setSidebarFilters((prev) => ({ ...prev, showOnlyAvailable: checked as boolean }))
                            }
                          />
                          <Label htmlFor="show-available" className="text-sm">
                            Are immediately available
                          </Label>
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Current City / Area */}
                  <Collapsible
                    open={openFilters.currentCity}
                    onOpenChange={(open) => setOpenFilters((prev) => ({ ...prev, currentCity: open }))}
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2 hover:bg-gray-50 rounded">
                      <span className="font-medium">Current City / Area</span>
                      <ChevronDown className="h-4 w-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-2">
                      <Input
                        placeholder="Enter city name"
                        onKeyPress={(e) => {
                          if (e.key === "Enter" && e.currentTarget.value.trim()) {
                            const city = e.currentTarget.value.trim()
                            if (!sidebarFilters.currentCity.includes(city)) {
                              setSidebarFilters((prev) => ({
                                ...prev,
                                currentCity: [...prev.currentCity, city],
                              }))
                            }
                            e.currentTarget.value = ""
                          }
                        }}
                      />
                      <div className="flex flex-wrap gap-1 mt-2">
                        {sidebarFilters.currentCity.map((city) => (
                          <Badge key={city} variant="secondary" className="text-xs">
                            {city}
                            <X
                              className="h-3 w-3 ml-1 cursor-pointer"
                              onClick={() =>
                                setSidebarFilters((prev) => ({
                                  ...prev,
                                  currentCity: prev.currentCity.filter((c) => c !== city),
                                }))
                              }
                            />
                          </Badge>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Experience */}
                  <Collapsible
                    open={openFilters.experience}
                    onOpenChange={(open) => setOpenFilters((prev) => ({ ...prev, experience: open }))}
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2 hover:bg-gray-50 rounded">
                      <span className="font-medium">Experience</span>
                      <ChevronDown className="h-4 w-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-2">
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          placeholder="Min years"
                          type="number"
                          value={sidebarFilters.experience.min}
                          onChange={(e) =>
                            setSidebarFilters((prev) => ({
                              ...prev,
                              experience: { ...prev.experience, min: e.target.value },
                            }))
                          }
                        />
                        <Input
                          placeholder="Max years"
                          type="number"
                          value={sidebarFilters.experience.max}
                          onChange={(e) =>
                            setSidebarFilters((prev) => ({
                              ...prev,
                              experience: { ...prev.experience, max: e.target.value },
                            }))
                          }
                        />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Annual Salary */}
                  <Collapsible
                    open={openFilters.salary}
                    onOpenChange={(open) => setOpenFilters((prev) => ({ ...prev, salary: open }))}
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2 hover:bg-gray-50 rounded">
                      <span className="font-medium">Annual Salary</span>
                      <ChevronDown className="h-4 w-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-2">
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          placeholder="Min LPA"
                          type="number"
                          value={sidebarFilters.salaryRange.min}
                          onChange={(e) =>
                            setSidebarFilters((prev) => ({
                              ...prev,
                              salaryRange: { ...prev.salaryRange, min: e.target.value },
                            }))
                          }
                        />
                        <Input
                          placeholder="Max LPA"
                          type="number"
                          value={sidebarFilters.salaryRange.max}
                          onChange={(e) =>
                            setSidebarFilters((prev) => ({
                              ...prev,
                              salaryRange: { ...prev.salaryRange, max: e.target.value },
                            }))
                          }
                        />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Education */}
                  <Collapsible
                    open={openFilters.education}
                    onOpenChange={(open) => setOpenFilters((prev) => ({ ...prev, education: open }))}
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2 hover:bg-gray-50 rounded">
                      <span className="font-medium">Education</span>
                      <ChevronDown className="h-4 w-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-2">
                      <div className="space-y-2">
                        {["10th Pass", "12th Pass", "Diploma", "Graduate", "Post Graduate"].map((edu) => (
                          <div key={edu} className="flex items-center space-x-2">
                            <Checkbox
                              id={edu}
                              checked={sidebarFilters.education.includes(edu)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSidebarFilters((prev) => ({
                                    ...prev,
                                    education: [...prev.education, edu],
                                  }))
                                } else {
                                  setSidebarFilters((prev) => ({
                                    ...prev,
                                    education: prev.education.filter((e) => e !== edu),
                                  }))
                                }
                              }}
                            />
                            <Label htmlFor={edu} className="text-sm">
                              {edu}
                            </Label>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Gender */}
                  <Collapsible
                    open={openFilters.gender}
                    onOpenChange={(open) => setOpenFilters((prev) => ({ ...prev, gender: open }))}
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2 hover:bg-gray-50 rounded">
                      <span className="font-medium">Gender</span>
                      <ChevronDown className="h-4 w-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-2">
                      <div className="space-y-2">
                        {["Male", "Female", "Other"].map((gender) => (
                          <div key={gender} className="flex items-center space-x-2">
                            <Checkbox
                              id={gender}
                              checked={sidebarFilters.gender.includes(gender)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSidebarFilters((prev) => ({
                                    ...prev,
                                    gender: [...prev.gender, gender],
                                  }))
                                } else {
                                  setSidebarFilters((prev) => ({
                                    ...prev,
                                    gender: prev.gender.filter((g) => g !== gender),
                                  }))
                                }
                              }}
                            />
                            <Label htmlFor={gender} className="text-sm">
                              {gender}
                            </Label>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Languages */}
                  <Collapsible
                    open={openFilters.languages}
                    onOpenChange={(open) => setOpenFilters((prev) => ({ ...prev, languages: open }))}
                  >
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-2 hover:bg-gray-50 rounded">
                      <span className="font-medium">Languages</span>
                      <ChevronDown className="h-4 w-4" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-2">
                      <div className="space-y-2">
                        {["English", "Hindi", "Tamil", "Telugu", "Bengali", "Marathi", "Gujarati"].map((lang) => (
                          <div key={lang} className="flex items-center space-x-2">
                            <Checkbox
                              id={lang}
                              checked={sidebarFilters.languages.includes(lang)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSidebarFilters((prev) => ({
                                    ...prev,
                                    languages: [...prev.languages, lang],
                                  }))
                                } else {
                                  setSidebarFilters((prev) => ({
                                    ...prev,
                                    languages: prev.languages.filter((l) => l !== lang),
                                  }))
                                }
                              }}
                            />
                            <Label htmlFor={lang} className="text-sm">
                              {lang}
                            </Label>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              )}

              {/* Clear All Filters */}
              {showFilters && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-4 bg-transparent"
                  onClick={() =>
                    setSidebarFilters({
                      hideInactive: false,
                      showOnlyAvailable: false,
                      mustHaveKeywords: [],
                      excludeKeywords: [],
                      currentCity: [],
                      experience: { min: "", max: "" },
                      industries: [],
                      companies: [],
                      salaryRange: { min: "", max: "" },
                      degrees: [],
                      education: [],
                      gender: [],
                      ageRange: { min: "", max: "" },
                      languages: [],
                      englishFluency: [],
                    })
                  }
                >
                  Clear All Filters
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 space-y-6">
        {/* Enhanced Search Header - Only show when not searched */}
        {!hasSearched && (
          <>
            <div className="text-center space-y-4">
              <div className="flex items-center justify-center space-x-2">
                <Truck className="h-8 w-8 text-blue-600" />
                <h2 className="text-3xl font-bold text-gray-900">Truckinzy Smart Search</h2>
              </div>
              <p className="text-gray-600 max-w-2xl mx-auto">
                Find the perfect logistics and transportation candidates with AI-powered search.
              </p>
            </div>

            {/* Search Mode Toggle */}
            <Card className="border-2 border-blue-100">
              <CardContent className="p-6">
                <div className="flex justify-center space-x-4 mb-6">
                  <Button
                    variant={searchMode === "manual" ? "default" : "outline"}
                    onClick={() => setSearchMode("manual")}
                    className="flex items-center space-x-2"
                  >
                    <Filter className="h-4 w-4" />
                    <span>Search manually</span>
                  </Button>
                  <Button
                    variant={searchMode === "smart" ? "default" : "outline"}
                    onClick={() => setSearchMode("smart")}
                    className="flex items-center space-x-2"
                  >
                    <Sparkles className="h-4 w-4" />
                    <span>Use TruckinzyAI</span>
                  </Button>
                  <Button
                    variant={searchMode === "jd" ? "default" : "outline"}
                    onClick={() => setSearchMode("jd")}
                    className="flex items-center space-x-2"
                  >
                    <FileText className="h-4 w-4" />
                    <span>Use Job Description</span>
                  </Button>
                </div>
                <div className="flex items-center justify-end gap-3 mb-4">
                  <Label className="text-sm text-gray-600">Role scope</Label>
                  <select
                    value={roleScope}
                    onChange={(e) => setRoleScope(e.target.value as "current" | "current_past")}
                    className="text-sm border rounded px-2 py-1"
                  >
                    <option value="current">Current Role</option>
                    <option value="current_past">Current + Past Role</option>
                  </select>
                </div>

                {/* Manual Search Interface */}
                {searchMode === "manual" && (
                  <div className="space-y-6">
                    {/* Searching for */}
                    <div>
                      <Label className="text-base font-semibold mb-3 block">Searching for</Label>
                      <RadioGroup
                        value={manualFilters.experienceType}
                        onValueChange={(value: "freshers" | "experienced" | "any") =>
                          setManualFilters((prev) => ({ ...prev, experienceType: value }))
                        }
                        className="flex space-x-6"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="freshers" id="freshers" />
                          <Label htmlFor="freshers">Freshers only</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="experienced" id="experienced" />
                          <Label htmlFor="experienced">Experienced only</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="any" id="any" />
                          <Label htmlFor="any">Any</Label>
                        </div>
                      </RadioGroup>
                    </div>

                    {/* Keywords */}
                    <div>
                      <Label className="text-base font-semibold mb-3 block">
                        Keywords <span className="text-red-500">*</span>
                      </Label>
                      <div className="border-2 border-blue-200 rounded-lg p-4 min-h-[80px]">
                        <div className="flex flex-wrap gap-2 mb-3">
                          {manualFilters.keywords.map((keyword) => (
                            <Badge key={keyword} variant="secondary" className="flex items-center gap-1 px-3 py-1">
                              {keyword}
                              <X className="h-3 w-3 cursor-pointer" onClick={() => removeKeyword(keyword)} />
                            </Badge>
                          ))}
                          <Input
                            placeholder="Type to search keyword"
                            value={keywordInput}
                            onChange={(e) => setKeywordInput(e.target.value)}
                            onKeyPress={(e) => {
                              if (e.key === "Enter" && keywordInput.trim()) {
                                addKeyword(keywordInput.trim())
                              }
                            }}
                            className="border-none shadow-none focus-visible:ring-0 flex-1 min-w-[200px]"
                          />
                        </div>
                      </div>

                      {/* AI Recommendations */}
                      {(aiSuggestions.length > 0 || isLoadingSuggestions) && (
                        <div className="mt-4">
                          <div className="flex items-center gap-2 mb-3">
                            <Sparkles className="h-4 w-4 text-purple-600" />
                            <span className="text-sm font-medium text-purple-900">Recommended by AI</span>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {isLoadingSuggestions ? (
                              <div className="flex items-center gap-2 text-sm text-gray-500">
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-purple-600"></div>
                                Getting suggestions...
                              </div>
                            ) : (
                              aiSuggestions.map((suggestion) => (
                                <Button
                                  key={suggestion}
                                  variant="outline"
                                  size="sm"
                                  onClick={() => addKeyword(suggestion)}
                                  className="flex items-center gap-1 text-sm"
                                >
                                  {suggestion}
                                  <Plus className="h-3 w-3" />
                                </Button>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Current city/region */}
                    <div>
                      <Label htmlFor="location" className="text-base font-semibold">
                        Current city/region
                      </Label>
                      <Input
                        id="location"
                        placeholder="Type to search city/region"
                        value={manualFilters.location}
                        onChange={(e) => setManualFilters((prev) => ({ ...prev, location: e.target.value }))}
                        className="mt-2"
                      />
                    </div>

                    {/* Experience */}
                    <div>
                      <Label className="text-base font-semibold mb-3 block">Experience</Label>
                      <div className="grid grid-cols-2 gap-4">
                        <Select
                          value={manualFilters.minExperience}
                          onValueChange={(value) => setManualFilters((prev) => ({ ...prev, minExperience: value }))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Minimum experience" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="0">0 years</SelectItem>
                            <SelectItem value="1">1 year</SelectItem>
                            <SelectItem value="2">2 years</SelectItem>
                            <SelectItem value="3">3 years</SelectItem>
                            <SelectItem value="5">5 years</SelectItem>
                            <SelectItem value="10">10+ years</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select
                          value={manualFilters.maxExperience}
                          onValueChange={(value) => setManualFilters((prev) => ({ ...prev, maxExperience: value }))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Maximum experience" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">1 year</SelectItem>
                            <SelectItem value="2">2 years</SelectItem>
                            <SelectItem value="5">5 years</SelectItem>
                            <SelectItem value="10">10 years</SelectItem>
                            <SelectItem value="15">15+ years</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {/* Minimum education */}
                    <div>
                      <Label className="text-base font-semibold">Minimum education</Label>
                      <Select
                        value={manualFilters.education}
                        onValueChange={(value) => setManualFilters((prev) => ({ ...prev, education: value }))}
                      >
                        <SelectTrigger className="mt-2">
                          <SelectValue placeholder="Select minimum education" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="10th">10th Pass</SelectItem>
                          <SelectItem value="12th">12th Pass</SelectItem>
                          <SelectItem value="diploma">Diploma</SelectItem>
                          <SelectItem value="graduate">Graduate</SelectItem>
                          <SelectItem value="postgraduate">Post Graduate</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Search Actions */}
                    <div className="flex justify-between pt-4 border-t">
                      <Button variant="outline" onClick={resetSearch}>
                        Reset
                      </Button>
                      <Button onClick={handleManualSearch} disabled={isSearching} size="lg">
                        {isSearching ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                            Searching...
                          </>
                        ) : (
                          <>
                            <Search className="h-4 w-4 mr-2" />
                            Search candidates
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Smart Search Interface */}
                {searchMode === "smart" && (
                  <div className="space-y-6">
                    <div className="bg-gradient-to-r from-purple-50 to-blue-50 p-6 rounded-lg border border-purple-200">
                      <div className="flex items-start space-x-3">
                        <Bot className="h-8 w-8 text-purple-600 mt-1" />
                        <div>
                          <h3 className="text-lg font-semibold text-purple-900 mb-2">Smart AI Search</h3>
                          <p className="text-purple-800">
                            Use natural language to describe your ideal candidate. Our AI understands logistics
                            terminology and context.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="flex gap-4">
                        <div className="relative flex-1">
                          <SuggestionInput
                            value={smartSearchQuery}
                            onValueChange={setSmartSearchQuery}
                            suggestions={INTERNAL_SEARCH_SUGGESTIONS}
                            placeholder="Type your requirements"
                            inputClassName="h-12 text-lg"
                            onEnter={handleSmartSearch}
                            maxItems={8}
                          />
                        </div>
                        <Button onClick={handleSmartSearch} disabled={isSearching} size="lg" className="px-8">
                          {isSearching ? (
                            <>
                              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                              Searching...
                            </>
                          ) : (
                            <>
                              <Sparkles className="h-5 w-5 mr-2" />
                              Smart Search
                            </>
                          )}
                        </Button>
                      </div>

                      <div className="flex justify-between">
                        <Button variant="outline" onClick={resetSearch}>
                          Reset
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* JD Search Interface */}
                {searchMode === "jd" && (
                  <div className="space-y-6">
                    <div className="bg-gradient-to-r from-green-50 to-teal-50 p-6 rounded-lg border border-green-200">
                      <div className="flex items-start space-x-3">
                        <FileText className="h-8 w-8 text-green-600 mt-1" />
                        <div>
                          <h3 className="text-lg font-semibold text-green-900 mb-2">Job Description Analysis</h3>
                          <p className="text-green-800">
                            Paste your job description and our AI will extract requirements and find matching candidates
                            automatically.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <Textarea
                          placeholder="Paste your complete job description here. Include role requirements, skills needed, experience level, location, etc."
                          value={jobDescription}
                          onChange={(e) => setJobDescription(e.target.value)}
                          className="min-h-[120px]"
                        />
                      </div>

                      <div className="flex justify-between">
                        <Button variant="outline" onClick={resetSearch}>
                          Reset
                        </Button>
                        <Button onClick={handleJDSearch} disabled={isSearching} size="lg">
                          {isSearching ? (
                            <>
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                              Analyzing JD...
                            </>
                          ) : (
                            <>
                              <FileText className="h-4 w-4 mr-2" />
                              Analyze & Search
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Search Examples - Only for Smart Search */}
            {searchMode === "smart" && (
              <Card className="bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200">
                <CardContent className="p-6">
                  <h3 className="font-semibold text-blue-900 mb-4 flex items-center">
                    <TrendingUp className="h-5 w-5 mr-2" />
                    Try these logistics-specific searches:
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {[
                      "Fleet manager with GPS tracking experience",
                      "Truck driver Delhi NCR with clean license",
                      "Logistics coordinator with WMS knowledge",
                      "Supply chain manager with ERP experience",
                      "Warehouse supervisor with forklift certification",
                      "Transport planner with route optimization skills",
                    ].map((example, index) => (
                      <Button
                        key={index}
                        variant="outline"
                        size="sm"
                        onClick={() => setSmartSearchQuery(example)}
                        className="text-blue-700 border-blue-200 hover:bg-blue-100 text-left justify-start"
                      >
                        {example}
                      </Button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Search Results */}
        {hasSearched && (
          <div className="space-y-6">
            {/* Results Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center space-y-4 sm:space-y-0">
              <div>
                <h3 className="text-xl font-semibold flex items-center">
                  <Search className="h-5 w-5 mr-2" />
                  {isSearching ? (
                    <>
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600 mr-2"></div>
                      Searching...
                    </>
                  ) : (
                    <>
                      {totalResults} profiles found
                      {searchMode === "smart" && smartSearchQuery && ` for "${smartSearchQuery}"`}
                      {searchMode === "jd" && " for Job Description Analysis"}
                      {searchMode === "manual" &&
                        manualFilters.keywords.length > 0 &&
                        ` for "${manualFilters.keywords.join(", ")}"`}
                    </>
                  )}
                </h3>
                <p className="text-sm text-gray-600 mt-1">
                  Showing {startIdx + 1}-{Math.min(endIdx, totalResults)} of {totalResults} results
                </p>
              </div>
              <div className="flex items-center space-x-4">
                <Button variant="outline" onClick={resetSearch}>
                  New Search
                </Button>
                {filteredResults.length > 0 && (
                  <div className="flex items-center space-x-2">
                    <SortDesc className="h-4 w-4 text-gray-500" />
                    <span className="text-sm text-gray-600">Sort by:</span>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as any)}
                      className="text-sm border rounded px-2 py-1"
                    >
                      <option value="relevance">Relevance</option>
                      <option value="experience">Experience</option>
                      <option value="name">Name</option>
                      <option value="recent">Recent</option>
                    </select>
                    {/* Page size */}
                    <span className="text-sm text-gray-600 ml-4">Per page:</span>
                    <select
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value))
                        setCurrentPage(1)
                      }}
                      className="text-sm border rounded px-2 py-1"
                    >
                      {[10, 20, 30, 50].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            {isSearching ? (
              <Card>
                <CardContent className="p-12 text-center">
                  <div className="flex flex-col items-center space-y-4">
                    <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600"></div>
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">Searching for candidates...</h3>
                      <p className="text-gray-600">
                        {searchMode === "smart" && "Using AI to find the best matches"}
                        {searchMode === "jd" && "Analyzing job description and finding matches"}
                        {searchMode === "manual" && "Searching with your criteria"}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : filteredResults.length === 0 ? (
              <Card>
                <CardContent className="p-12 text-center">
                  <Search className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">No matches found</h3>
                  <p className="text-gray-600 mb-4">Try adjusting your search criteria or filters.</p>
                  <Button onClick={resetSearch}>Try New Search</Button>
                </CardContent>
              </Card>
            ) : (
              <div>
                <div className="grid gap-6">
                {/* Compact Candidate Card Layout */}
                {pagedResults.map((result, index) => (
                  <Card
                    key={`${result._id || result.id}-${index}`}
                    className={`transition-all hover:shadow-md cursor-pointer border-l-4 ${
                      result.relevanceScore >= 0.8
                        ? "border-l-green-500"
                        : result.relevanceScore >= 0.5
                          ? "border-l-yellow-500"
                          : "border-l-gray-300"
                    }`}
                    onClick={() => openPreview(result)}
                  >
                    <CardContent className="p-6">
                      <div className="flex justify-between items-start mb-3">
                        <div className="flex items-start space-x-3">
                          <Avatar className="h-10 w-10 border-2 border-white shadow-sm">
                            <AvatarFallback className={`${getAvatarColor(result.relevanceScore)} text-white text-xs`}>
                              {getInitials(result.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="flex items-center space-x-2">
                              <h3 className="font-bold text-gray-900 text-base">{result.name}</h3>
                              <Badge
                                variant="secondary"
                                className={`${getMatchColor(result.relevanceScore)} text-xs px-1.5 py-0`}
                              >
                                {result.matchPercentage}% Match
                              </Badge>
                            </div>
                            <div className="flex items-center text-sm text-gray-600 mt-0.5">
                              <Briefcase className="h-3 w-3 mr-1" />
                              <span className="font-medium mr-2 truncate max-w-[180px]" title={result.currentRole}>{result.currentRole}</span>
                              
                              <Building className="h-3 w-3 mr-1 ml-1" />
                              <span className="" title={result.currentCompany || "N/A"}>{result.currentCompany || "N/A"}</span>
                              
                              <MapPin className="h-3 w-3 mr-1 ml-3" />
                              <span className="truncate max-w-[120px]" title={result.location}>{result.location}</span>
                            </div>
                            
                            <div className="flex items-center text-xs text-gray-500 mt-1.5 space-x-3">
                                <span className="flex items-center"><Clock className="h-3 w-3 mr-1" /> {result.totalExperience} Exp</span>
                                {result.degree && <span className="flex items-center"><GraduationCap className="h-3 w-3 mr-1" /> {result.degree}</span>}
                                {result.matchingKeywords?.length ? (
                                  <span className="flex items-center" title={result.matchingKeywords.join(", ")}>
                                    <Code className="h-3 w-3 mr-1" />
                                    {result.matchingKeywords.slice(0, 3).join(", ")}
                                    {result.matchingKeywords.length > 3 ? ` +${result.matchingKeywords.length - 3}` : ""}
                                  </span>
                                ) : null}
                            </div>
                          </div>
                        </div>
                        
                        <div className="flex flex-col space-y-2">
                            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={(e) => {
                                e.stopPropagation();
                                openPreview(result);
                            }}>
                                <Eye className="h-3 w-3 mr-1" /> View Profile
                            </Button>

                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={(e) => {
                                e.stopPropagation()
                                openAssign(result)
                              }}
                            >
                              <Briefcase className="h-3 w-3 mr-1" /> Assign to Job
                            </Button>

                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={(e) => {
                                e.stopPropagation()
                                loadAiInsight(result)
                              }}
                              disabled={aiInsightLoadingById[candidateKey(result)]}
                            >
                              {aiInsightLoadingById[candidateKey(result)] ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Bot className="h-3 w-3 mr-1" />}
                              AI Insight
                            </Button>
                            {result.fileUrl && (
                                <Button variant="ghost" size="sm" className="h-7 text-xs text-gray-500" asChild onClick={(e) => e.stopPropagation()}>
                                    <a href={result.fileUrl} target="_blank" rel="noopener noreferrer">
                                        <Eye className="h-3 w-3 mr-1" /> View Resume
                                    </a>
                                </Button>
                            )}
                        </div>
                      </div>


                      {aiInsightsById[candidateKey(result)]?.summary || aiInsightLoadingById[candidateKey(result)] ? (
                        <div className="mt-2 pt-2 border-t border-gray-100 bg-gray-50/30 p-2 rounded">
                          <div className="mb-2 text-xs text-gray-700 bg-purple-50/50 p-2 rounded border border-purple-100">
                            <span className="font-bold text-purple-700 mr-1">AI Insight:</span>
                            {aiInsightsById[candidateKey(result)]?.summary ? (
                              <>
                                {aiInsightsById[candidateKey(result)]?.expanded
                                  ? aiInsightsById[candidateKey(result)]?.summary
                                  : (aiInsightsById[candidateKey(result)]?.summary || "").length > 260
                                    ? (aiInsightsById[candidateKey(result)]?.summary || "").slice(0, 260) + "…"
                                    : aiInsightsById[candidateKey(result)]?.summary}
                                {(aiInsightsById[candidateKey(result)]?.summary || "").length > 260 ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs ml-2"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const id = candidateKey(result)
                                      setAiInsightsById((prev) => ({
                                        ...prev,
                                        [id]: { ...prev[id], expanded: !prev[id].expanded }
                                      }))
                                    }}
                                  >
                                    {aiInsightsById[candidateKey(result)]?.expanded ? "View less" : "View more"}
                                  </Button>
                                ) : null}
                              </>
                            ) : (
                              <span className="text-gray-500 italic">Generating…</span>
                            )}
                          </div>

                          {result.scoreBreakdown && (
                            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
                              {Object.entries(result.scoreBreakdown).map(([key, data]) => (
                                <div key={key} className="flex items-center text-[10px] w-[140px]">
                                  <span className="w-16 font-medium text-gray-500 truncate">{key}</span>
                                  <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden mx-1">
                                    <div
                                      className={`h-full rounded-full ${
                                        data.percentage > 80 ? 'bg-green-500' :
                                        data.percentage > 40 ? 'bg-yellow-500' : 'bg-red-400'
                                      }`}
                                      style={{ width: `${data.percentage}%` }}
                                    />
                                  </div>
                                  <span className="text-gray-400">{data.earned}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="mt-2 space-y-2">
                            <div>
                              {result.matchDetails?.filter(d => d.status === 'match').length ? (
                                <div className="text-sm text-green-700">
                                  <span className="font-semibold mr-1">✓ Matched:</span>
                                  {result.matchDetails.filter(d => d.status === 'match').map(d => d.category).join(', ')}
                                </div>
                              ) : null}
                            </div>
                            <div>
                              {(result.gapAnalysis && result.gapAnalysis.length > 0) || result.matchDetails?.some(d => d.status === 'miss') ? (
                                <div className="text-sm text-red-700">
                                  <span className="font-semibold mr-1">✗ Missing:</span>
                                  {Array.from(new Set([
                                    ...(result.gapAnalysis || []),
                                    ...(result.matchDetails?.filter(d => d.status === 'miss').map(d => d.category) || [])
                                  ])).join(', ')}
                                </div>
                              ) : (
                                <div className="text-sm text-gray-400 italic">No major gaps</div>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                ))}
                </div>

                {/* Pagination controls */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between border-t pt-4">
                    <span className="text-sm text-gray-600">
                      Page {currentPageSafe} of {totalPages} • Showing {startIdx + 1}-{Math.min(endIdx, totalResults)} of {totalResults}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" disabled={currentPageSafe <= 1} onClick={() => executeSearch(1, { ...lastSearchParams, sidebarFilters, roleScope })}>
                        First
                      </Button>
                      <Button variant="outline" size="sm" disabled={currentPageSafe <= 1} onClick={() => executeSearch(Math.max(1, currentPageSafe - 1), { ...lastSearchParams, sidebarFilters, roleScope })}>
                        Prev
                      </Button>
                      <Button variant="outline" size="sm" disabled={currentPageSafe >= totalPages} onClick={() => executeSearch(Math.min(totalPages, currentPageSafe + 1), { ...lastSearchParams, sidebarFilters, roleScope })}>
                        Next
                      </Button>
                      <Button variant="outline" size="sm" disabled={currentPageSafe >= totalPages} onClick={() => executeSearch(totalPages, { ...lastSearchParams, sidebarFilters, roleScope })}>
                        Last
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Truckinzy Features Notice - Only show when not searched */}
        {!hasSearched && (
          <Card className="bg-gradient-to-r from-purple-50 to-pink-50 border-purple-200">
            <CardContent className="p-6">
              <div className="flex items-start space-x-3">
                <Truck className="h-6 w-6 text-purple-600 mt-0.5" />
                <div>
                  <h4 className="font-semibold text-purple-900 mb-2">Truckinzy Logistics Intelligence</h4>
                  <p className="text-sm text-purple-800 mb-3">
                    Our platform is specifically designed for logistics, transportation, and supply chain recruitment
                    with industry-specific filters and AI understanding.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                      <span className="text-purple-700">Logistics-specific roles & skills</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                      <span className="text-purple-700">Vehicle & transport expertise</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                      <span className="text-purple-700">Industry certifications & licenses</span>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <AssignJobDialog
          candidateId={assignCandidateId}
          candidateName={assignCandidateName}
          open={assignOpen}
          onOpenChange={setAssignOpen}
        />

        {/* Candidate Preview Dialog */}
        <CandidatePreviewDialogDynamic
          candidate={selectedCandidate ? ({
            ...selectedCandidate,
            fileName: selectedCandidate.fileName || "",
            fileUrl: selectedCandidate.fileUrl || "",
            tags: selectedCandidate.tags || [],
          } as any) : null}
          isOpen={!!selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
          onStatusUpdate={updateCandidateStatus}
          onNotesUpdate={updateCandidateNotes}
          onRatingUpdate={updateCandidateRating}
          showRelevanceScore={searchMode === "smart" || searchMode === "jd"}
        />
      </div>
    </div>
  )
}
