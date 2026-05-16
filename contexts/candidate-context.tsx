"use client"

import { createContext, useContext, useState, useEffect, useCallback, ReactNode, Suspense } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { logger } from "@/lib/logger"
import { cachedFetchJson, invalidateSessionCache } from "@/lib/utils"

interface Candidate {
  _id: string
  name: string
  email?: string
  phone?: string
  currentRole: string
  desiredRole?: string
  currentCompany?: string
  location: string
  totalExperience: string
  highestQualification?: string
  degree?: string
  university?: string
  technicalSkills: string[]
  softSkills: string[]
  certifications?: string[]
  resumeText: string
  fileName: string
  fileUrl: string
  tags: string[]
  status: "new" | "reviewed" | "shortlisted" | "interviewed" | "selected" | "rejected" | "on-hold"
  rating?: number
  uploadedAt: string
  linkedinProfile?: string
  summary?: string
  notes?: string
  // Detailed sections
  workExperience?: Array<{ company: string; role: string; duration: string; description: string; responsibilities?: string[]; achievements?: string[]; technologies?: string[] }>
  education?: Array<{ degree: string; specialization: string; institution: string; year: string; percentage: string; grade?: string; coursework?: string[]; projects?: string[] }>
}

interface CandidateContextType {
  candidates: Candidate[]
  isLoading: boolean
  error: string | null
  hasMore: boolean
  currentPage: number
  pageSize: number
  total: number
  setPage: (page: number) => void
  setPageSize: (size: number) => void
  searchQuery: string
  setSearchQuery: (query: string) => void
  statusFilter: string
  setStatusFilter: (status: string) => void
  sortBy: string
  setSortBy: (sort: string) => void
  sortOrder: 'asc' | 'desc'
  setSortOrder: (order: 'asc' | 'desc') => void
  refreshCandidates: () => Promise<void>
  loadMoreCandidates: () => Promise<void>
  lastFetched: Date | null
}

const CandidateContext = createContext<CandidateContextType | undefined>(undefined)

export function CandidateProvider({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <CandidateProviderInner>{children}</CandidateProviderInner>
    </Suspense>
  )
}

function CandidateProviderInner({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const [currentPage, setCurrentPage] = useState(() => Number(searchParams.get("page")) || 1)
  const [pageSize, setPageSize] = useState(() => Number(searchParams.get("pageSize")) || 50)
  const [total, setTotal] = useState(0)
  const [searchQuery, setSearchQueryState] = useState(() => searchParams.get("search") || "")
  const [statusFilter, setStatusFilterState] = useState(() => searchParams.get("status") || "all")
  const [sortBy, setSortByState] = useState(() => searchParams.get("sortBy") || "uploaded_at")
  const [sortOrder, setSortOrderState] = useState<'asc' | 'desc'>(() => (searchParams.get("sortOrder") as 'asc' | 'desc') || "desc")
  const [permissionKeys, setPermissionKeys] = useState<string[] | null>(null)
  const shouldFetchCandidates = Boolean(pathname?.startsWith("/candidates"))

  // Sync state to URL when on candidates page
  const updateUrl = useCallback(() => {
    if (!pathname?.startsWith("/candidates")) return
    
    const params = new URLSearchParams(searchParams.toString())
    if (searchQuery) params.set("search", searchQuery)
    else params.delete("search")
    
    if (statusFilter !== "all") params.set("status", statusFilter)
    else params.delete("status")
    
    if (currentPage > 1) params.set("page", String(currentPage))
    else params.delete("page")
    
    if (sortBy !== "uploaded_at") params.set("sortBy", sortBy)
    else params.delete("sortBy")
    
    if (sortOrder !== "desc") params.set("sortOrder", sortOrder)
    else params.delete("sortOrder")

    const qs = params.toString()
    const newUrl = `${pathname}${qs ? `?${qs}` : ""}`
    router.replace(newUrl, { scroll: false })
  }, [pathname, searchQuery, statusFilter, currentPage, sortBy, sortOrder, searchParams, router])

  useEffect(() => {
    updateUrl()
  }, [updateUrl])

  const loadPermissions = useCallback(async (opts?: { force?: boolean }) => {
    try {
      const data = await cachedFetchJson<any>("internal:super-admin:me", "/api/super-admin/me", undefined, {
        ttlMs: 60_000,
        force: Boolean(opts?.force),
      })
      const perms = Array.isArray(data?.permissions) ? data.permissions : []
      setPermissionKeys(perms.map((p: any) => String(p)))
      return perms
    } catch (e: any) {
      setPermissionKeys(null)
      throw e
    }
  }, [])

  useEffect(() => {
    loadPermissions().catch((e: any) => {
      setError(String(e?.message || "Failed to load permissions"))
      setPermissionKeys([])
    })
  }, [])

  const fetchCandidates = useCallback(async (page = currentPage, perPage = pageSize, opts?: { force?: boolean }) => {
    if (permissionKeys === null) return
    const hasView = permissionKeys.includes("candidates.view") || permissionKeys.includes("candidates.edit")
    const hasSearchOnly = permissionKeys.includes("candidates.search-only")
    if (!hasView && !hasSearchOnly) {
      setCandidates([])
      setTotal(0)
      setHasMore(false)
      setLastFetched(new Date())
      return
    }
    if (!hasView && hasSearchOnly && !searchQuery.trim()) {
      setCandidates([])
      setTotal(0)
      setHasMore(false)
      setLastFetched(new Date())
      return
    }
    try {
      setIsLoading(true)
      setError(null)
      logger.info(`Fetching candidates from API (paginated): page=${page} perPage=${perPage} search=${searchQuery} status=${statusFilter} sort=${sortBy}:${sortOrder}`)
      const url = `/api/candidates?paginate=true&page=${page}&perPage=${perPage}&search=${encodeURIComponent(searchQuery)}&status=${encodeURIComponent(statusFilter)}&sortBy=${encodeURIComponent(sortBy)}&sortOrder=${encodeURIComponent(sortOrder)}`
      const data = await cachedFetchJson<any>(`internal:candidates:${url}`, url, undefined, {
        ttlMs: 5 * 60_000,
        force: Boolean(opts?.force),
        swr: true,
        onData: (freshData) => {
          const freshItems = Array.isArray(freshData) ? freshData : (freshData.items || [])
          const freshTotalCount = Array.isArray(freshData) ? freshItems.length : (freshData.total || freshItems.length)
          const freshPageNum = Array.isArray(freshData) ? page : (freshData.page || page)
          const freshPer = Array.isArray(freshData) ? perPage : (freshData.perPage || perPage)
          
          setCandidates(freshItems)
          setTotal(freshTotalCount)
          setHasMore(freshPageNum * freshPer < freshTotalCount)
          setLastFetched(new Date())
        }
      })
      logger.debug("API Response:", data)

      const items = Array.isArray(data) ? data : (data.items || [])
      const totalCount = Array.isArray(data) ? items.length : (data.total || items.length)
      const pageNum = Array.isArray(data) ? page : (data.page || page)
      const per = Array.isArray(data) ? perPage : (data.perPage || perPage)

      logger.info(`Fetched ${items.length} candidates of total ${totalCount}`)
      logger.info(`Setting candidates: page=${page} count=${items.length}`)

      setCandidates(items)
      setTotal(totalCount)
      setHasMore(pageNum * per < totalCount)
      setLastFetched(new Date())
    } catch (error: any) {
      logger.error('Error fetching candidates:', error)
      const msg = String(error?.message || "Failed to load candidates")
      setError(msg)
      // If token expired or permissions call was stale, refresh permissions once and retry
      if (/unauthorized/i.test(msg) || /forbidden/i.test(msg)) {
        try {
          await loadPermissions({ force: true })
          const url = `/api/candidates?paginate=true&page=${page}&perPage=${perPage}&search=${encodeURIComponent(searchQuery)}&status=${encodeURIComponent(statusFilter)}&sortBy=${encodeURIComponent(sortBy)}&sortOrder=${encodeURIComponent(sortOrder)}`
          const data = await cachedFetchJson<any>(`internal:candidates:${url}`, url, undefined, {
            ttlMs: 5 * 60_000,
            force: true,
          })
          const items = Array.isArray(data) ? data : (data.items || [])
          const totalCount = Array.isArray(data) ? items.length : (data.total || items.length)
          const pageNum = Array.isArray(data) ? page : (data.page || page)
          const per = Array.isArray(data) ? perPage : (data.perPage || perPage)
          setCandidates(items)
          setTotal(totalCount)
          setHasMore(pageNum * per < totalCount)
          setLastFetched(new Date())
          setError(null)
        } catch (retryErr: any) {
          setError(String(retryErr?.message || msg))
        }
      }
    } finally {
      setIsLoading(false)
    }
  }, [pageSize, searchQuery, statusFilter, sortBy, sortOrder, permissionKeys])

  const refreshCandidates = useCallback(async () => {
    if (!shouldFetchCandidates) return
    logger.info("Refreshing candidates...")
    invalidateSessionCache("internal:candidates:", { prefix: true })
    await fetchCandidates(1, pageSize, { force: true })
    setCurrentPage(1)
  }, [fetchCandidates, pageSize, shouldFetchCandidates])

  const loadMoreCandidates = useCallback(async () => {
    // Advance page if more results are available
    if (!hasMore) {
      logger.info("No more candidates to load")
      return
    }
    const nextPage = currentPage + 1
    setCurrentPage(nextPage)
    await fetchCandidates(nextPage, pageSize)
  }, [hasMore, currentPage, pageSize, fetchCandidates])

  // Fetch only when visiting candidates screen
  useEffect(() => {
    if (!shouldFetchCandidates) return
    logger.info("CandidateProvider active on candidates screen, fetching candidates...")
    fetchCandidates(currentPage, pageSize)
  }, [fetchCandidates, currentPage, pageSize, shouldFetchCandidates])

  const setPage = (page: number) => {
    logger.info(`setPage called: ${page}`)
    setCurrentPage(page)
  }

  const setSearchQuery = useCallback((query: string) => {
    logger.info(`Search query changed to: "${query}", resetting to page 1`)
    setSearchQueryState(query)
    // Reset to page 1 when search changes to show results from beginning
    setCurrentPage(1)
  }, [])

  const setStatusFilter = useCallback((status: string) => {
    setStatusFilterState(status)
    setCurrentPage(1)
  }, [])

  const setSortBy = useCallback((sort: string) => {
    setSortByState(sort)
    setCurrentPage(1)
  }, [])

  const setSortOrder = useCallback((order: 'asc' | 'desc') => {
    setSortOrderState(order)
    setCurrentPage(1)
  }, [])

  const value = {
    candidates,
    isLoading,
    error,
    hasMore,
    currentPage,
    pageSize,
    total,
    setPage,
    setPageSize,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    sortBy,
    setSortBy,
    sortOrder,
    setSortOrder,
    refreshCandidates,
    loadMoreCandidates,
    lastFetched,
  }

  logger.debug("Context value updated:", {
    candidatesCount: candidates.length,
    isLoading,
    lastFetched,
    currentPage,
    pageSize,
    total,
  })

  return (
    <CandidateContext.Provider value={value}>
      {children}
    </CandidateContext.Provider>
  )
}

export function useCandidates() {
  const context = useContext(CandidateContext)
  if (context === undefined) {
    throw new Error('useCandidates must be used within a CandidateProvider')
  }
  return context
}
