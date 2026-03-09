import { type NextRequest, NextResponse } from "next/server"
import { extractKeywordsFromSentence, extractSearchKeywordsWithAI, generateEmbedding, generateWebsearchQueryFromJDWithAI } from "@/lib/ai-utils"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { logger } from "@/lib/logger"
import { intelligentCandidateSearch, parseSearchRequirement, type RoleScope, type SearchRequirement } from "@/lib/intelligent-search"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { 
  jdBasedSearch, 
  enhancedManualSearch, 
  applySidebarFilters, 
  parseListParam, 
  calculateRoleMatch 
} from "@/lib/search-service"

// Caches for smart search (non-JD based)
// Note: JD caches are now inside lib/search-service.ts, but we keep smart search caches here as they are specific to this endpoint's "smart" mode logic which is slightly different
// Actually, let's keep the "smart" mode logic here as it was, but reuse helpers where possible.

const smartRequirementsCache = new Map<string, { at: number; req: any }>()
const SMART_REQUIREMENTS_TTL_MS = 10 * 60_000
const smartKeywordCache = new Map<string, { at: number; terms: string[] }>()
const SMART_KEYWORDS_TTL_MS = 10 * 60_000
const smartWebsearchCache = new Map<string, { at: number; query: string }>()
const SMART_WEBSEARCH_TTL_MS = 10 * 60_000
const smartEmbeddingCache = new Map<string, { at: number; emb: number[] }>()
const SMART_EMBEDDING_TTL_MS = 10 * 60_000

function hashKey(input: string) {
  return Buffer.from(input, 'utf8').toString('base64').slice(0, 200)
}

function expandRoleVariants(role: string) {
  const t = String(role || "").trim()
  if (!t) return []
  const parts = t.split(/\s+/).filter(Boolean)
  if (!parts.length) return [t]

  const first = parts[0]
  const lower = first.toLowerCase()
  const out = new Set<string>()
  out.add(t)

  if (lower.length > 3) {
    if (lower.endsWith("s") && !lower.endsWith("ss")) {
      const singular = first.slice(0, -1)
      out.add([singular, ...parts.slice(1)].join(" "))
    } else if (!lower.endsWith("s")) {
      out.add([first + "s", ...parts.slice(1)].join(" "))
    }
  }

  return Array.from(out)
}

function normalizeTerms(list: string[]) {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const v = String(raw || '').trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

function toWebsearchOrQuery(terms: string[], maxTerms = 18) {
  return terms
    .slice(0, maxTerms)
    .map((t) => {
      const v = String(t || "").trim()
      if (!v) return ""
      return v.includes(" ") ? `"${v}"` : v
    })
    .filter(Boolean)
    .join(" OR ")
}

function sanitizeWebsearchQuery(q: string) {
  return String(q || "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const hasAdminToken = authHeader === `Bearer ${process.env.ADMIN_TOKEN}`
  const ctx = hasAdminToken ? null : await getInternalAuthContext(request)
  if (!hasAdminToken) {
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const canSearch =
      hasPermission(ctx, "candidates.search") ||
      hasPermission(ctx, "candidates.search-only") ||
      hasPermission(ctx, "candidates.view") ||
      hasPermission(ctx, "candidates.edit")
    if (!canSearch) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const searchType   = searchParams.get('type') ?? 'smart'
    const query        = searchParams.get('keywords') ?? searchParams.get('query') ?? ''
    const jobDescription = searchParams.get('jobDescription') ?? searchParams.get('jd') ?? ''
    const paginate     = searchParams.get('paginate') === 'true'
    const pageRaw      = Number(searchParams.get('page') ?? '1')
    const perPageRaw   = Number(searchParams.get('perPage') ?? '20')
    const page         = Math.max(1, Number.isFinite(pageRaw) ? pageRaw : 1)
    const perPage      = Math.min(100, Math.max(1, Number.isFinite(perPageRaw) ? perPageRaw : 20))
    const roleScope: RoleScope = searchParams.get("roleScope") === "current" ? "current" : "current_past"

    // Build filters object from individual keys
    const filters: any = {}
    if (searchParams.get('location')) filters.location = searchParams.get('location')
    if (searchParams.get('education')) filters.education = searchParams.get('education')
    if (searchParams.get('minExperience')) filters.minExperience = Number(searchParams.get('minExperience'))
    if (searchParams.get('maxExperience')) filters.maxExperience = Number(searchParams.get('maxExperience'))

    console.log("=== Enhanced Search API ===")
    console.log("Search Type:", searchType)
    console.log("Query:", query)
    console.log("Job Description:", jobDescription ? "Provided" : "Not provided")
    const sidebarFilters = {
      hideInactive: searchParams.get("hideInactive") === "true",
      showOnlyAvailable: searchParams.get("showOnlyAvailable") === "true",
      mustHaveKeywords: parseListParam(searchParams.get("mustHaveKeywords")),
      excludeKeywords: parseListParam(searchParams.get("excludeKeywords")),
      currentCity: parseListParam(searchParams.get("currentCity")),
      experience: {
        min: searchParams.get("expMin") || "",
        max: searchParams.get("expMax") || "",
      },
      salaryRange: {
        min: searchParams.get("salaryMin") || "",
        max: searchParams.get("salaryMax") || "",
      },
      education: parseListParam(searchParams.get("educationFilters")),
      gender: parseListParam(searchParams.get("genderFilters")),
      languages: parseListParam(searchParams.get("languageFilters")),
    }
    const hasSidebarFilters = Boolean(
      sidebarFilters.hideInactive ||
        sidebarFilters.showOnlyAvailable ||
        sidebarFilters.mustHaveKeywords.length ||
        sidebarFilters.excludeKeywords.length ||
        sidebarFilters.currentCity.length ||
        sidebarFilters.experience.min ||
        sidebarFilters.experience.max ||
        sidebarFilters.salaryRange.min ||
        sidebarFilters.salaryRange.max ||
        sidebarFilters.education.length ||
        sidebarFilters.gender.length ||
        sidebarFilters.languages.length,
    )

    console.log("Filters:", filters)
    logger.info(`Search request: type=${searchType} query="${query}" jd=${!!jobDescription} filters=${JSON.stringify(filters)}`)

    let results: any[] = []
    let roleFilterTerm = ""

    switch (searchType) {
      case "smart":
        // Enhanced TruckinzyAI search with deep requirement understanding
        logger.info(`TruckinzyAI search validation: query="${query}" jobDescription="${jobDescription}"`)
        if (!query.trim() && !jobDescription.trim()) {
          return NextResponse.json({ error: "Invalid search parameters", details: "Missing keywords or job description" }, { status: 400 })
        }
        
        console.log("🧠 Processing TruckinzyAI search query:", query)
        
        const nl = query.trim() ? query : jobDescription
        const smartKey = hashKey(nl.trim())
        const now = Date.now()

        const cachedReq = smartRequirementsCache.get(smartKey)
        const requirementsPromise = cachedReq && now - cachedReq.at < SMART_REQUIREMENTS_TTL_MS
          ? Promise.resolve(cachedReq.req as SearchRequirement)
          : parseSearchRequirement(nl).catch(() => null).then((req) => {
              smartRequirementsCache.set(smartKey, { at: now, req })
              return req as SearchRequirement | null
            })

        const cachedKw = smartKeywordCache.get(smartKey)
        const keywordPromise = cachedKw && now - cachedKw.at < SMART_KEYWORDS_TTL_MS
          ? Promise.resolve(cachedKw.terms)
          : extractSearchKeywordsWithAI(nl)
              .catch(() => [])
              .then((terms) => {
                smartKeywordCache.set(smartKey, { at: now, terms })
                return terms
              })

        const cachedWeb = smartWebsearchCache.get(smartKey)
        const websearchPromise = cachedWeb && now - cachedWeb.at < SMART_WEBSEARCH_TTL_MS
          ? Promise.resolve(cachedWeb.query)
          : generateWebsearchQueryFromJDWithAI(nl)
              .catch(() => "")
              .then((query) => {
                smartWebsearchCache.set(smartKey, { at: now, query: String(query || "") })
                return String(query || "")
              })

        const cachedEmb = smartEmbeddingCache.get(smartKey)
        const embeddingPromise = cachedEmb && now - cachedEmb.at < SMART_EMBEDDING_TTL_MS
          ? Promise.resolve(cachedEmb.emb)
          : generateEmbedding(nl.slice(0, 7000))
              .catch(() => [])
              .then((emb) => {
                smartEmbeddingCache.set(smartKey, { at: now, emb })
                return emb
              })

        const [parsedRequirements, keywordTerms, websearchFromAI, embedding] = await Promise.all([
          requirementsPromise,
          keywordPromise,
          websearchPromise,
          embeddingPromise,
        ])

        console.log("📋 Parsed requirements:", JSON.stringify(parsedRequirements, null, 2))
        roleFilterTerm = parsedRequirements?.role || ""

        const roleVariants = parsedRequirements?.role ? expandRoleVariants(parsedRequirements.role) : []
        const websearchFallback = toWebsearchOrQuery(normalizeTerms([...roleVariants, ...keywordTerms]), 20)
        const websearchQuery = sanitizeWebsearchQuery(websearchFromAI) || websearchFallback || nl
        const roleTerms = normalizeTerms(roleVariants)
        const roleQuery = roleTerms.length ? toWebsearchOrQuery(roleTerms, 8) : ""

        const [textPool, vectorPool, roleTextPool, currentRolePool] = await Promise.all([
          SupabaseCandidateService.searchCandidatesByText(websearchQuery, 700, false),
          embedding.length ? SupabaseCandidateService.searchCandidatesByEmbedding(embedding, 0.22, 250) : Promise.resolve([]),
          roleQuery ? SupabaseCandidateService.searchCandidatesByText(roleQuery, 800, false) : Promise.resolve([]),
          roleScope === "current" && roleTerms.length ? SupabaseCandidateService.searchCandidatesByCurrentRole(roleTerms, 800) : Promise.resolve([]),
        ])

        const mergedById = new Map<string, any>()
        for (const c of textPool || []) {
          if (!c?.id) continue
          mergedById.set(String(c.id), c)
        }
        for (const c of vectorPool || []) {
          if (!c?.id) continue
          const id = String(c.id)
          const existing = mergedById.get(id)
          mergedById.set(id, existing ? { ...existing, ...c } : c)
        }
        for (const c of roleTextPool || []) {
          if (!c?.id) continue
          const id = String(c.id)
          const existing = mergedById.get(id)
          mergedById.set(id, existing ? { ...existing, ...c } : c)
        }
        for (const c of currentRolePool || []) {
          if (!c?.id) continue
          const id = String(c.id)
          const existing = mergedById.get(id)
          mergedById.set(id, existing ? { ...existing, ...c } : c)
        }

        const pool = Array.from(mergedById.values())
        const transformedCandidates = pool.map((candidate) => ({
          ...candidate,
          _id: candidate.id,
          technicalSkills: Array.isArray(candidate.technicalSkills) ? candidate.technicalSkills : [],
          softSkills: Array.isArray(candidate.softSkills) ? candidate.softSkills : [],
          tags: Array.isArray(candidate.tags) ? candidate.tags : [],
          certifications: Array.isArray(candidate.certifications) ? candidate.certifications : [],
          languagesKnown: Array.isArray(candidate.languagesKnown) ? candidate.languagesKnown : [],
        }))

        const parsedRequirementsSafe = parsedRequirements || {}
        results = await intelligentCandidateSearch(parsedRequirementsSafe, transformedCandidates, { roleScope })
        
        // Add explanation of why candidates were matched
        results = results.map(candidate => ({
          ...candidate,
          searchExplanation: `Matched based on: ${candidate.matchingCriteria?.join(', ') || 'profile analysis'}`,
          aiUnderstanding: parsedRequirementsSafe
        }))
        
        console.log(`🎯 Found ${results.length} relevant candidates with intelligent matching`)
        break

      case "jd":
        // JD-based search - SEPARATE from manual search
        if (!jobDescription || jobDescription.trim().length === 0) {
          return NextResponse.json({ error: "Job description is required" }, { status: 400 })
        }
        
        // Extract keywords from job description for better matching
        const extractedJDKeywords = extractKeywordsFromSentence(jobDescription);
        console.log("Extracted keywords from JD:", extractedJDKeywords);
        
        // Use jdBasedSearch with the original job description
        results = await jdBasedSearch(jobDescription, extractedJDKeywords, roleScope)
        
        // Add extracted keywords to the results
        results = results.map(candidate => ({
          ...candidate,
          extractedKeywords: extractedJDKeywords
        }))
        break

      case "manual":
        // Enhanced manual search with intelligent filtering
        logger.info(`Enhanced manual search validation: query="${query}" jobDescription="${jobDescription}" filters=${JSON.stringify(filters)}`)
        if (!query.trim() && !jobDescription.trim()) {
          return NextResponse.json({ error: "Invalid search parameters", details: "Provide keywords or job description" }, { status: 400 })
        }
        
        results = await enhancedManualSearch({ ...filters, query, keywords: query }, [], roleScope)
        // Note: enhancedManualSearch in service assumes it receives candidates list or we need to fetch them.
        // Wait, enhancedManualSearch in service takes `candidates: any[]`. But in the original code, it was fetching inside if candidates were not provided?
        // No, looking at original code, `enhancedManualSearch` was taking `candidates: any[]`.
        // BUT wait, in the original `manual` case:
        /*
        if (jobDescription.trim()) {
             const pool = await SupabaseCandidateService.searchCandidatesByText(jobDescription, 800, false)
             ...
             results = await intelligentCandidateSearch(...)
        } else {
             const pool = await SupabaseCandidateService.searchCandidatesByText(query, 800, false)
             ...
             results = await intelligentCandidateSearch(...) or SupabaseCandidateService.searchCandidatesByText
        }
        */
        // My `enhancedManualSearch` in `lib/search-service.ts` copied from the file had logic to filter candidates, but not to FETCH them if they weren't passed.
        // In `lib/search-service.ts`, `enhancedManualSearch` takes `candidates` array.
        // So I need to fetch candidates here first.
        
        // Re-implementing manual search fetch logic here because it was intertwined with logic
        if (jobDescription.trim()) {
          const pool = await SupabaseCandidateService.searchCandidatesByText(jobDescription, 800, false)
           const transformedCandidates = pool.map((candidate) => ({
            ...candidate,
            _id: candidate.id,
            technicalSkills: Array.isArray(candidate.technicalSkills) ? candidate.technicalSkills : [],
            softSkills: Array.isArray(candidate.softSkills) ? candidate.softSkills : [],
            tags: Array.isArray(candidate.tags) ? candidate.tags : [],
            certifications: Array.isArray(candidate.certifications) ? candidate.certifications : [],
            languagesKnown: Array.isArray(candidate.languagesKnown) ? candidate.languagesKnown : [],
          }))
          // Reuse intelligentCandidateSearch directly as before
          const requirements = await parseSearchRequirement(jobDescription)
          results = await intelligentCandidateSearch(requirements, transformedCandidates, { roleScope })
          roleFilterTerm = requirements?.role || ""
        } else {
          const hasNaturalLanguage = query.trim().includes(' ') && query.trim().length > 5
          if (hasNaturalLanguage) {
             const pool = await SupabaseCandidateService.searchCandidatesByText(query, 800, false)
             const transformedCandidates = pool.map((candidate) => ({
              ...candidate,
              _id: candidate.id,
              technicalSkills: Array.isArray(candidate.technicalSkills) ? candidate.technicalSkills : [],
              softSkills: Array.isArray(candidate.softSkills) ? candidate.softSkills : [],
              tags: Array.isArray(candidate.tags) ? candidate.tags : [],
              certifications: Array.isArray(candidate.certifications) ? candidate.certifications : [],
              languagesKnown: Array.isArray(candidate.languagesKnown) ? candidate.languagesKnown : [],
            }))
            const requirements = await parseSearchRequirement(query)
            results = await intelligentCandidateSearch(requirements, transformedCandidates, { roleScope })
            roleFilterTerm = requirements?.role || ""
          } else {
            results = await SupabaseCandidateService.searchCandidatesByText(query, 800, false)
            roleFilterTerm = query.trim()
          }
        }
        break

      default:
        return NextResponse.json({ error: "Invalid search type" }, { status: 400 })
    }

    if (roleScope === "current" && roleFilterTerm.trim()) {
      const roleQuery = roleFilterTerm.trim()
      results = results.filter((candidate) => calculateRoleMatch(roleQuery, candidate, roleScope) >= 0.2)
    }

    const enforceRoleMatch =
      roleFilterTerm.trim() &&
      (sidebarFilters.currentCity.length > 0 ||
        sidebarFilters.mustHaveKeywords.length > 0 ||
        sidebarFilters.experience.min ||
        sidebarFilters.experience.max)

    if (enforceRoleMatch) {
      const roleQuery = roleFilterTerm.trim()
      results = results.filter((candidate) => calculateRoleMatch(roleQuery, candidate, roleScope) >= 0.2)
    }

    if (hasSidebarFilters) {
      results = applySidebarFilters(results, sidebarFilters)
    }

    console.log("Search results:", results.length)

    // Optional server-side pagination (already parsed from query above)

    if (paginate) {
      const total = results.length
      const totalPages = Math.max(1, Math.ceil(total / perPage))
      const currentPage = Math.min(page, totalPages)
      const startIdx = (currentPage - 1) * perPage
      const items = results.slice(startIdx, startIdx + perPage)
      return NextResponse.json({ items, total, page: currentPage, perPage })
    }

    return NextResponse.json(results)
  } catch (error) {
    console.error("Search error:", error)
    return NextResponse.json(
      { error: "Search failed", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
