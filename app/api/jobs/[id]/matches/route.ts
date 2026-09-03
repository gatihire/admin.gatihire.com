import { NextRequest, NextResponse } from "next/server"
import { supabase, supabaseAdmin } from "@/lib/supabase"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { generateEmbedding } from "@/lib/embedding"
import { redis } from "@/lib/redis"
import crypto from "crypto"
import { calculateCandidateScoreWithBreakdown } from "@/lib/scoring"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

// In-flight request deduplication map (per jobId)
const inFlightMatchmaking = new Map<string, Promise<{ success: boolean; candidates?: any[]; error?: any }>>()

// Recompute lock to prevent race conditions between sync and background recompute
const recomputeLocks = new Map<string, boolean>()

// Redis cache key for final scored results
const SCORED_RESULTS_TTL = 600 // 10 minutes

// In-memory caches with 10min TTL (like smart search)
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const jdRequirementsCache = new Map<string, { at: number; req: any }>()
const jdKeywordCache = new Map<string, { at: number; terms: string[] }>()
const jdWebsearchCache = new Map<string, { at: number; query: string }>()
const jdEmbeddingCache = new Map<string, { at: number; emb: number[] }>()

function hashKey(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').slice(0, 200)
}

function getScoredCacheKey(jobId: string, jdHash: string): string {
  return `jd_scored_results:${jobId}:${jdHash}`
}

function getJobJdHash(jobId: string, jd: string): string {
  return crypto.createHash('md5').update(`${jobId}:${jd.trim().toLowerCase()}`).digest('hex')
}

function buildWebsearchQuery(terms: string[], max = 15): string {
  return terms
    .slice(0, max)
    .map(t =>
      String(t || "")
        // Strip symbols that confuse websearch_to_tsquery and collapse whitespace
        .replace(/[^\w\s&+.#-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .map(t => (t.includes(" ") ? `"${t}"` : t))
    .join(" OR ")
}

// Helper functions (moved from lib/scoring.ts and search-service.ts)
function normalizeRoleText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Client-parity role synonyms (from client-app search/jd route)
const ROLE_SYNONYMS: Record<string, string[]> = {
  "fleet manager": ["fleet management", "transportation manager", "logistics manager", "transport manager", "fleet supervisor", "fleet incharge"],
  "fleet incharge": ["fleet manager", "fleet supervisor", "fleet operations", "transport incharge", "fleet executive"],
  "truck driver": ["driver", "heavy vehicle driver", "commercial driver", "truck operator", "vehicle driver"],
  "logistics coordinator": ["logistics executive", "supply chain coordinator", "transport coordinator", "dispatch executive"],
  "operations manager": ["operations executive", "operations head", "fleet manager", "branch manager"],
  "dispatcher": ["dispatch executive", "dispatch coordinator", "fleet dispatcher"],
  "supply chain": ["procurement", "warehouse", "inventory", "logistics", "distribution"],
  "driver": ["truck driver", "vehicle operator", "commercial driver", "delivery driver"],
}

function expandRoleVariants(role: string): string[] {
  const q = (role || "").trim().toLowerCase()
  if (!q) return []
  const out = new Set<string>([role.trim()])
  for (const [key, synonyms] of Object.entries(ROLE_SYNONYMS)) {
    if (q.includes(key) || key.includes(q)) synonyms.forEach(s => out.add(s))
  }
  return Array.from(out)
}

function parseYears(text: string): number {
  const t = String(text || '')
  const m = t.match(/(\d{1,2})(?:\+)?\s*(?:years?|yrs?)/i)
  if (!m) return 0
  const v = Number(m[1])
  return Number.isFinite(v) ? v : 0
}

async function runEnhancedMatchmaking(jobId: string, jd: string, bypassCache = false) {
  // Stage-by-stage diagnostics surfaced via ?debug=1 and always logged.
  const dbg: Record<string, any> = { baseTextLen: jd ? jd.length : 0 }
  const warnings: string[] = []
  try {
    const jdHash = getJobJdHash(jobId, jd)
    dbg.jdHash = jdHash
    const scoredCacheKey = getScoredCacheKey(jobId, jdHash)
    const criteriaCacheKey = `jd_search_criteria:${jdHash}`

    // Check Redis for cached final scored results (10 min TTL) — skipped on forced refresh
    if (redis && !bypassCache) {
      const cachedScored = await redis.get<{ candidates: any[]; criteria: any; jdHash: string }>(scoredCacheKey)
      if (cachedScored && cachedScored.candidates?.length) {
        console.log(`[Matchmaking] Cache HIT for job ${jobId} (${cachedScored.candidates.length} candidates)`)
        return { success: true, candidates: cachedScored.candidates, fromCache: true, debug: { ...dbg, servedFrom: "scored-cache" } }
      }
    }

    // Step 0: Load structured job fields so we don't rely on LLM extraction alone
    const { data: jobRow } = await supabaseAdmin
      .from("jobs")
      .select("title, description, location, city, skills_must_have, skills_good_to_have, experience_min_years, experience_max_years")
      .eq("id", jobId)
      .single()

    // Step 1: Extract criteria + embedding (with Redis caching - 24h TTL)
    const criteriaCacheKeyFull = `jd_search_criteria:${crypto.createHash('md5').update(jd.trim().toLowerCase()).digest('hex')}`
    let criteriaResult: any = null
    let embedding: number[] = []

    // In-memory cache for criteria (10min TTL) - like smart search
    const cachedReq = jdRequirementsCache.get(criteriaCacheKeyFull)
    if (cachedReq && Date.now() - cachedReq.at < CACHE_TTL_MS) {
      criteriaResult = cachedReq.req
      console.log(`[Matchmaking] In-memory cache HIT for criteria`)
    }

    const cachedEmb = jdEmbeddingCache.get(criteriaCacheKeyFull)
    if (cachedEmb && Date.now() - cachedEmb.at < CACHE_TTL_MS) {
      embedding = cachedEmb.emb
      console.log(`[Matchmaking] In-memory cache HIT for embedding`)
    }

    // Fallback to Redis if in-memory miss
    if (!criteriaResult || !embedding.length) {
      if (redis) {
        const cachedData = await redis.get<{ criteria: any, embedding: number[] }>(criteriaCacheKeyFull)
        if (cachedData) {
          criteriaResult = criteriaResult || cachedData.criteria
          embedding = embedding.length ? embedding : cachedData.embedding
          // Populate in-memory caches
          if (criteriaResult) jdRequirementsCache.set(criteriaCacheKeyFull, { at: Date.now(), req: criteriaResult })
          if (embedding.length) jdEmbeddingCache.set(criteriaCacheKeyFull, { at: Date.now(), emb: embedding })
        }
      }
    }

    if (!criteriaResult) {
      // gemini-1.5-flash-latest was retired by Google (404) and silently killed
      // criteria extraction — pin to a live model, env-overridable.
      const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.5-flash" })
      const prompt = `Analyze this job description and extract key hiring criteria for candidate matching.
JD: """${jd.slice(0, 3000)}"""
Return ONLY valid JSON:
{"title": string, "required_skills": string[], "preferred_skills": string[], "min_experience_years": number|null, "location": string|null, "key_keywords": string[]}`

      const [extracted, emb] = await Promise.all([
        model.generateContent(prompt).then(r => {
          const text = r.response.text().replace(/```json\n?|\n?```/g, "").trim()
          return JSON.parse(text)
        }).catch(() => ({ title: "", required_skills: [], preferred_skills: [], key_keywords: [] })),
        generateEmbedding(jd.slice(0, 7000)).catch(() => [] as number[]),
      ])
      
      criteriaResult = extracted
      embedding = emb

      // Cache in-memory (10min) + Redis (24h)
      jdRequirementsCache.set(criteriaCacheKeyFull, { at: Date.now(), req: criteriaResult })
      if (embedding.length) jdEmbeddingCache.set(criteriaCacheKeyFull, { at: Date.now(), emb: embedding })
      
      if (redis && embedding.length > 0) {
        await redis.set(criteriaCacheKeyFull, { criteria: criteriaResult, embedding }, { ex: 3600 * 24 }) // Cache 24h
      }
    }

    const criteria = criteriaResult

    // Diagnostics + silent-failure alarms (Step 2 of the parity investigation)
    dbg.criteriaTitle = criteria?.title || ""
    dbg.reqSkillsCount = (criteria?.required_skills || []).length
    dbg.keyKwCount = (criteria?.key_keywords || []).length
    dbg.embDims = embedding.length
    if (!dbg.criteriaTitle) warnings.push("gemini_title_empty")
    if (embedding.length === 0) warnings.push("embedding_failed_or_empty")

    // Step 2: Merge structured job fields over Gemini extraction (client-parity)
    const jobTitle = jobRow?.title || criteria.title || ""
    const jobLocation = jobRow?.city || jobRow?.location || criteria.location || ""
    const jobMinExp =
      typeof jobRow?.experience_min_years === "number"
        ? jobRow.experience_min_years
        : criteria.min_experience_years ?? null
    const jobMaxExp =
      typeof jobRow?.experience_max_years === "number"
        ? jobRow.experience_max_years
        : criteria.max_experience_years ?? null

    // Client parity: role variants first, then skills + keywords
    const roleVariants = expandRoleVariants(jobTitle)
    const allKeyTerms = [...roleVariants, ...(criteria.required_skills || []), ...(criteria.key_keywords || [])].filter(Boolean)
    const websearchQ = buildWebsearchQuery(allKeyTerms, 15).replace(/[()]/g, " ").trim()
    dbg.roleVariants = roleVariants.length
    dbg.allKeyTerms = allKeyTerms.length
    dbg.websearchQ = websearchQ

    // Step 3: Single hybrid search via the deployed RPC (same engine as the client portal).
    // SOFT RANKING: no hard SQL filters — the JD's city/exp/keyword requirements are
    // weighted by the JS re-scorer below instead of shrinking the candidate pool.
    let rows: any[] = []
    const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc("search_candidates_hybrid", {
      p_query_text: websearchQ,
      p_query_embedding: embedding.length ? embedding : null,
      p_match_threshold: 0.05,
      p_filters: {},
      p_limit: 500,
      p_offset: 0,
    })

    if (rpcError) {
      console.error("[Matchmaking] Hybrid RPC failed, falling back to text search:", rpcError.message)
      const fb = await SupabaseCandidateService.searchCandidatesByText(websearchQ || jobTitle, 500, false)
      rows = (fb || []).map((c: any) => ({ candidate_data: c, match_score: 0 }))
      dbg.fallbackUsed = true
      warnings.push(`rpc_error:${rpcError.message}`)
    } else {
      rows = rpcData || []
      dbg.fallbackUsed = false
    }
    dbg.rpcRawCount = rows.length

    // Safety net: the RPC's text-match leg can zero out the whole result set
    // (e.g. the JD title becomes one long quoted phrase that matches nothing).
    // The embedding leg is independent and proven — retry pure-vector once.
    if (!rpcError && rows.length === 0 && embedding.length > 0 && websearchQ) {
      console.warn("[Matchmaking] Hybrid returned 0 with text+embedding; retrying pure-vector")
      const { data: vecData, error: vecError } = await supabaseAdmin.rpc("search_candidates_hybrid", {
        p_query_text: "",
        p_query_embedding: embedding,
      p_match_threshold: 0.05,
        p_filters: {},
        p_limit: 500,
        p_offset: 0,
      })
      if (!vecError && vecData && vecData.length > 0) {
        rows = vecData
        dbg.vectorRetryUsed = true
        dbg.rpcRawCount = rows.length
      }
    }

    if (rows.length === 0) {
      console.warn(`[Matchmaking][DEBUG] job=${jobId} ZERO raw rows from RPC/fallback — embDims=${dbg.embDims} websearchQ="${dbg.websearchQ}" fallbackUsed=${dbg.fallbackUsed} warnings=[${warnings.join(" | ")}]`)
      return { success: true, candidates: [], debug: { ...dbg, servedFrom: "fresh-sync" } }
    }

    // Step 4: Criteria-based re-scoring (Smart Search parity).
    // The RPC's match_score mixes ts_rank_cd (unbounded) with cosine similarity,
    // so multiplying it by 100 inflated everyone to 100%. It is used ONLY for
    // retrieval ordering; the displayed/persisted score comes from the JS
    // breakdown formula (role 35 + skills 30 + experience 20 + location 15).
    const mappedCriteria = {
      role: jobTitle,
      location: jobLocation,
      min_experience_years: jobMinExp,
      max_experience_years: jobMaxExp,
      skills: Array.from(new Set([
        ...(Array.isArray(jobRow?.skills_must_have) ? jobRow.skills_must_have : []),
        ...(Array.isArray(jobRow?.skills_good_to_have) ? jobRow.skills_good_to_have : []),
        ...(criteria.required_skills || []),
        ...(criteria.preferred_skills || []),
      ].filter(Boolean))),
      // Phase 3: separate must-have vs good-to-have for weighted scoring
      must_have_skills: Array.from(new Set([
        ...(Array.isArray(jobRow?.skills_must_have) ? jobRow.skills_must_have : []),
        ...(criteria.required_skills || []),
      ].filter(Boolean))),
      good_to_have_skills: Array.from(new Set([
        ...(Array.isArray(jobRow?.skills_good_to_have) ? jobRow.skills_good_to_have : []),
        ...(criteria.preferred_skills || []),
      ].filter(Boolean))),
    }

    const keywordPool = mappedCriteria.skills.length > 0 ? mappedCriteria.skills : allKeyTerms
    const scored = rows.map((row: any) => {
      const candidate = row.candidate_data || row
      if (!candidate?.id) return null
      const jsScored = calculateCandidateScoreWithBreakdown(mappedCriteria, candidate)
      const finalScore = jsScored.score

      const candText = [
        candidate.current_role || "",
        candidate.summary || "",
        candidate.resume_text || "",
        candidate.current_company || "",
        ...(candidate.technical_skills || []),
        ...(candidate.soft_skills || []),
      ].join(" ").toLowerCase()

      const matchingKeywords = keywordPool
        .filter((k: string) => k && candText.includes(String(k).toLowerCase()))
        .slice(0, 12)

      return {
        ...candidate,
        match_score: Math.round(Math.min(100, finalScore)),
        score_breakdown: jsScored.breakdown,
        matchingCriteria: mappedCriteria,
        matching_keywords: matchingKeywords,
        matchingKeywords,
      }
    }).filter(Boolean)

    // Filter and sort (client parity: drop <12, sort desc, clamp 100; keep ALL for tier filtering)
    const results = scored
      .filter(c => (c.match_score || 0) >= 12)
      .sort((a, b) => (b.match_score || 0) - (a.match_score || 0))
    dbg.afterCutoff = results.length
    dbg.warnings = warnings
    if (warnings.length > 0) {
      console.warn(`[Matchmaking] Warnings for job ${jobId}:`, warnings.join(" | "))
    }
    console.log(`[Matchmaking][DEBUG] job=${jobId} baseText=${dbg.baseTextLen}ch title="${dbg.criteriaTitle}" skills=${dbg.reqSkillsCount} kw=${dbg.keyKwCount} embDims=${dbg.embDims} rawRPC=${dbg.rpcRawCount} afterCutoff=${dbg.afterCutoff}`)

    // Cache top 250 in Redis for fast access (10 min TTL)
    const resultsForCache = results.slice(0, 250)
    if (redis && resultsForCache.length > 0) {
      const criteriaForCache = {
        role: criteria.title,
        location: criteria.location,
        min_experience_years: criteria.min_experience_years,
        skills: [...(criteria.required_skills || []), ...(criteria.preferred_skills || [])]
      }
      await redis.set(scoredCacheKey, { candidates: results.slice(0, 250), criteria: criteriaForCache, jdHash: jdHash }, { ex: SCORED_RESULTS_TTL })
      console.log(`[Matchmaking] Cached ${Math.min(results.length, 250)} scored results for job ${jobId} (10min TTL)`)
    }

    return { success: true, candidates: results, debug: dbg }
  } catch (err) {
    console.error("Enhanced matchmaking failed:", err)
    return { success: false, error: err, debug: { ...dbg, fatal: String(err) } }
  }
}

// Helper function for synchronous recompute (module level to avoid control flow issues)
async function performSynchronousRecompute(jobId: string, baseText: string, force: boolean): Promise<{ candidates: any[]; debug?: any }> {
  if (!force && inFlightMatchmaking.has(jobId)) {
    console.log(`[Matchmaking] Using in-flight promise for job ${jobId}`)
    const result = await inFlightMatchmaking.get(jobId)!
    return { candidates: result.success && result.candidates ? result.candidates : [], debug: (result as any).debug }
  }

  // Check if background recompute is running - wait for it if so (silent, bounded)
  let waitedMs = 0
  while (recomputeLocks.get(jobId) && waitedMs < 30000) {
    await new Promise(resolve => setTimeout(resolve, 300))
    waitedMs += 300
  }

  const promise = runEnhancedMatchmaking(jobId, baseText, force)
  inFlightMatchmaking.set(jobId, promise)
  try {
    const result = await promise
    return { candidates: result.success && result.candidates ? result.candidates : [], debug: (result as any).debug }
  } catch (err) {
    console.error("Synchronous recompute failed:", err)
    return { candidates: [], debug: { fatal: String(err) } }
  } finally {
    inFlightMatchmaking.delete(jobId)
  }
}

// Helper function for background async recompute (module level to avoid control flow issues)
async function performBackgroundRecompute(
  jobId: string,
  baseText: string,
  cacheLimit: number,
  perPage: number,
  maxPages: number,
  job: any
): Promise<void> {
  // Acquire lock to prevent race with synchronous recompute
  if (recomputeLocks.get(jobId)) {
    console.log(`[Matchmaking] Background recompute skipped for job ${jobId} - already running`)
    return
  }
  recomputeLocks.set(jobId, true)
  
  try {
    console.log(`[Matchmaking] Background recompute started for job ${jobId}`)
    const matchmakingResult = await runEnhancedMatchmaking(jobId, baseText, true)
    
    if (!matchmakingResult.success || !matchmakingResult.candidates) return
    
    const ranked = matchmakingResult.candidates
    const totalMatches = Array.isArray(ranked) ? ranked.length : 0
    const orderedCandidateIds = (Array.isArray(ranked) ? ranked : []).map((c: any) => String(c?.id || "")).filter(Boolean)
    
    const rankedTop = (Array.isArray(ranked) ? ranked : []).slice(0, cacheLimit)
    
    // Persist ALL ranked candidates with their scores (not just top cacheLimit)
    // This ensures tier filter works on all pages
    const allRankedToPersist = ranked.map((c: any) => {
      const rawC = c as any
      const breakdown = rawC.score_breakdown || {
          role: { earned: 0, max: 30 },
        experience: { earned: 0, max: 25 },
        location: { earned: 0, max: 25 },
        skills: { earned: 0, max: 20 }
      }
      const matchingCrit = rawC.matchingCriteria || {
        role: job?.title || "",
        location: job?.location || "",
        skills: [],
        min_experience_years: null
      }
      return {
        job_id: jobId,
        candidate_id: c.id,
        relevance_score: Math.max(0, Math.min(1, (c.match_score || 0) / 100)),
        match_summary: null,
        score_breakdown: breakdown,
        matching_keywords: rawC.matching_keywords || [],
        source: "enhanced_match",
        created_at: new Date().toISOString(),
        matchingCriteria: matchingCrit
      }
    })
    
    // Persist ALL ranked candidates (not just top cacheLimit)
    // This ensures tier filter works on all pages
    const matchesToPersist = allRankedToPersist
    
    // Persist to database
    try {
      const { error: insertError } = await supabaseAdmin
        .from("job_matches")
        .upsert(matchesToPersist, { onConflict: "job_id,candidate_id" })
      if (insertError) {
        if ((insertError as any)?.code === 'PGRST204' || 
            insertError.message.includes("matching_keywords") || 
            insertError.message.includes("matchingCriteria")) {
          const matchesNoKeywords = matchesToPersist.map(({ matching_keywords, matchingCriteria, ...rest }: any) => rest)
          await supabaseAdmin
            .from("job_matches")
            .upsert(matchesNoKeywords, { onConflict: "job_id,candidate_id" })
        }
      }
    } catch (e) {
      console.warn("Background recompute persist failed:", e)
    }
    
    // Update job_match_runs
    try {
      await supabaseAdmin
        .from("job_match_runs")
        .upsert({
          job_id: jobId,
          total_matches: totalMatches,
          cached_matches: matchesToPersist.length,
          per_page: perPage,
          max_pages: maxPages,
          candidate_ids: orderedCandidateIds as any,
          requirements: null,
          last_matched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "job_id" })
    } catch (e) {
      console.warn("Background recompute run update failed:", e)
    }
    
    console.log(`[Matchmaking] Background recompute completed for job ${jobId} (${totalMatches} total)`)
  } catch (err) {
    console.error(`[Matchmaking] Background recompute failed for job ${jobId}:`, err)
  } finally {
    recomputeLocks.delete(jobId)
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  async function handleRequest(): Promise<NextResponse> {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params
    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get("page") || "1", 10)
    const perPage = Math.max(1, Math.min(20, parseInt(searchParams.get("perPage") || "20", 10) || 20))
    const countOnly = searchParams.get("countOnly") === "1"
    const idsOnly = searchParams.get("idsOnly") === "1"
    const forceRefresh = searchParams.get("refresh") === "1"
    const tierParam = searchParams.get("tier") || "all"
    const upTo = searchParams.get("upTo") || ""
    const minScoreParam = searchParams.get("minScore") || ""
    const minScore = parseFloat(minScoreParam)
    const hasMinScore = minScoreParam !== "" && !isNaN(minScore)
    const wantDebug = searchParams.get("debug") === "1"
    // Sidebar display filters (client-app applySidebarFilters parity)
    const parseNumParam = (name: string): number | null => {
      const v = searchParams.get(name) || ""
      return v !== "" && !isNaN(parseFloat(v)) ? parseFloat(v) : null
    }
    const parseListParam = (name: string): string[] => {
      const v = (searchParams.get(name) || "").trim()
      return v ? v.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : []
    }
    const minExpFilter = parseNumParam("minExp")
    const maxExpFilter = parseNumParam("maxExp")
    const cityFilters = parseListParam("cities")
    const mustKwFilters = parseListParam("mustKw")
    const excludeKwFilters = parseListParam("excludeKw")
    const hasPhoneOnly = searchParams.get("hasPhone") === "1"
    const hasDisplayFilters =
      hasPhoneOnly ||
      minExpFilter !== null ||
      maxExpFilter !== null ||
      cityFilters.length > 0 ||
      mustKwFilters.length > 0 ||
      excludeKwFilters.length > 0
    const maxPages = 50
    const maxCached = 500
    const cacheLimit = Math.max(1, Math.min(maxCached, perPage * maxPages))

    const TIER_RANGES: Record<string, { min?: number; max?: number }> = {
      excellent: { min: 85 },
      perfect: { min: 75, max: 84 },
      strong: { min: 65, max: 74 },
      good: { min: 55, max: 64 },
      average: { min: 45, max: 54 },
      fair: { min: 26, max: 44 },
      weak: { max: 25 },
    }
    const activeRange = TIER_RANGES[tierParam] || null

    const tierCounts = (matches: any[]) => {
      const pct = (m: any) => Math.round((m.relevance_score > 1 ? m.relevance_score / 100 : m.relevance_score) * 100)
      const inRange = (m: any, r: { min?: number; max?: number }) => {
        const p = pct(m)
        if (r.min !== undefined && p < r.min) return false
        if (r.max !== undefined && p > r.max) return false
        return true
      }
      return {
        all: matches.length,
        excellent: matches.filter((m) => inRange(m, TIER_RANGES.excellent)).length,
        perfect: matches.filter((m) => inRange(m, TIER_RANGES.perfect)).length,
        strong: matches.filter((m) => inRange(m, TIER_RANGES.strong)).length,
        good: matches.filter((m) => inRange(m, TIER_RANGES.good)).length,
        average: matches.filter((m) => inRange(m, TIER_RANGES.average)).length,
        fair: matches.filter((m) => inRange(m, TIER_RANGES.fair)).length,
        weak: matches.filter((m) => inRange(m, TIER_RANGES.weak)).length,
      }
    }

    // Request deduplication: return existing in-flight matchmaking for this job (skip if forceRefresh)
    if (!forceRefresh && inFlightMatchmaking.has(id)) {
      console.log(`[Matchmaking] Request deduplication: returning in-flight promise for job ${id}`)
      const result = await inFlightMatchmaking.get(id)!
      if (result.success && result.candidates) {
        const matches = result.candidates.map((c: any) => ({
          job_id: id,
          candidate_id: c.id,
          relevance_score: Math.max(0, Math.min(1, (c.match_score || 0) / 100)),
          match_summary: null,
          score_breakdown: c.score_breakdown || { role: { earned: 0, max: 30 }, experience: { earned: 0, max: 25 }, location: { earned: 0, max: 25 }, skills: { earned: 0, max: 20 } },
          matching_keywords: c.matchingKeywords || [],
          source: "enhanced_match",
          created_at: new Date().toISOString(),
          candidate: c,
          matchingCriteria: c.matchingCriteria || { role: c.matchingCriteria?.role, location: c.matchingCriteria?.location, skills: c.matchingCriteria?.skills, min_experience_years: c.matchingCriteria?.min_experience_years }
        }))
        return NextResponse.json({
          items: matches.slice(0, perPage).map((m: any) => ({ ...m, has_phone: (m.candidate as any)?.phone ? true : false, already_applied: false, already_called: false })),
          page: 1,
          perPage,
          total: matches.length,
          cachedTotal: matches.length,
          actionableTotal: matches.length,
          maxPages: 50,
          tierCounts: { all: matches.length, excellent: 0, perfect: 0, strong: 0, good: 0, average: 0, fair: 0, weak: 0 },
          ...(wantDebug ? { debug: { servedFrom: "dedupe" } } : {}),
        })
      }
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from("jobs")
      .select("*")
      .eq("id", id)
      .single()
    if (jobError || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    // Try to read cached matches if table exists
    let cached: any[] = []
    try {
      const { data: cachedData } = await supabaseAdmin
        .from("job_matches")
        .select("*")
        .eq("job_id", id)
        .order("relevance_score", { ascending: false })
        .limit(cacheLimit)
      // Normalize relevance_score to be between 0 and 1
      cached = (cachedData || []).map(match => ({
        ...match,
        relevance_score: Math.max(0, Math.min(1, match.relevance_score > 1 ? match.relevance_score / 100 : match.relevance_score))
      }))
    } catch (_ignore) {
      cached = []
    }

    let totalMatches = cached.length
    let cachedMatches = cached.length
    let orderedCandidateIds: string[] = []
    let storedRequirements: any | null = null
    try {
      const { data: runRow } = await supabaseAdmin
        .from("job_match_runs")
        .select("*")
        .eq("job_id", id)
        .single()
      if (runRow) {
        totalMatches = typeof (runRow as any)?.total_matches === "number" ? (runRow as any).total_matches : totalMatches
        cachedMatches = typeof (runRow as any)?.cached_matches === "number" ? (runRow as any).cached_matches : cachedMatches
        storedRequirements = (runRow as any)?.requirements ?? null
        const ids = (runRow as any)?.candidate_ids
        if (Array.isArray(ids)) orderedCandidateIds = ids.map((x: any) => String(x || "")).filter(Boolean)
        else if (typeof ids === "string") {
          try {
            const parsed = JSON.parse(ids)
            if (Array.isArray(parsed)) orderedCandidateIds = parsed.map((x: any) => String(x || "")).filter(Boolean)
          } catch {}
        }
      }
    } catch (_ignore) {}

    // Fallback: if no run row but we have cached matches, use cached length
    if (totalMatches === 0 && cached.length > 0) {
      totalMatches = cached.length
    }

    let matches = cached
    const cachedBeforeCount = cached.length
    // Recompute when the cache is empty, a refresh is forced, OR the cached set
    // is incomplete relative to the known total (e.g. a wider cacheLimit than
    // the run that populated it) — otherwise stale partial counts like
    // "Cached: 50 of 500" would persist indefinitely until a manual refresh.
    // FIX: Use cachedMatches (actual cached count) instead of stale totalMatches from job_match_runs
    const cacheIncomplete = cached.length > 0 && cached.length < cacheLimit && cachedMatches > cached.length
    const needsRecompute = !cached.length || forceRefresh || cacheIncomplete

    // Background async recompute: only on the serve-stale path (cached data exists and
    // we're returning it immediately). The sync path (empty cache / forced refresh)
    // runs its own single recompute — firing both would double the work.
    const hasCachedData = cached.length > 0
    const shouldWaitForRecompute = needsRecompute && (!hasCachedData || forceRefresh)

    if (needsRecompute && !shouldWaitForRecompute) {
      const baseText = [
        job.title || "",
        job.description || "",
      ].join("\n").trim()

      // Fire-and-forget background recompute using module-level function
      performBackgroundRecompute(id, baseText, cacheLimit, perPage, maxPages, job).catch(() => {})
    }

    let ranked: any[] = []
    let lastDebug: any = null

    // If we need to wait for recompute (no cached data or forceRefresh), do it synchronously
    if (shouldWaitForRecompute) {
      console.log(`[Matchmaking] Synchronous recompute for job ${id} (forceRefresh: ${forceRefresh}, hasCached: ${hasCachedData})`)

      const baseText = [
        job.title || "",
        job.description || "",
      ].join("\n").trim()

      const syncResult = await performSynchronousRecompute(id, baseText, forceRefresh)
      ranked = syncResult.candidates
      lastDebug = { ...(syncResult.debug || {}), servedFrom: "fresh-sync" }
    } else if (hasCachedData) {
      // Use cached data, ranked is empty so we'll use cached matches below
      ranked = []
      lastDebug = { servedFrom: "cache" }
    }

    // Only rebuild/persist when a fresh synchronous recompute returned results;
    // otherwise keep serving cached rows loaded above.
    if (ranked.length > 0) {
      totalMatches = Array.isArray(ranked) ? ranked.length : 0
      orderedCandidateIds = (Array.isArray(ranked) ? ranked : []).map((c: any) => String(c?.id || "")).filter(Boolean)
      storedRequirements = null
      const rankedTop = (Array.isArray(ranked) ? ranked : []).slice(0, cacheLimit)
      
      // Extract criteria from the first ranked candidate's matchingCriteria or rebuild from job
      const firstCandidate = ranked[0]
      const matchCriteria = firstCandidate?.matchingCriteria || {
        role: job.title,
        location: job.location || "",
        skills: [],
        min_experience_years: null
      }
      
      matches = rankedTop.map((c: any) => {
        const rawC = c as any
        const breakdown = rawC.score_breakdown || {
          role: { earned: 0, max: 30 },
          experience: { earned: 0, max: 25 },
          location: { earned: 0, max: 25 },
          skills: { earned: 0, max: 20 }
        }
        const matchingCrit = rawC.matchingCriteria || {
          role: matchCriteria.role,
          location: matchCriteria.location,
          skills: matchCriteria.skills || [],
          min_experience_years: matchCriteria.min_experience_years
        }
        return {
          job_id: id,
          candidate_id: c.id,
          relevance_score: Math.max(0, Math.min(1, (c.match_score || 0) / 100)),
          match_summary: null,
          score_breakdown: breakdown,
          matching_keywords: rawC.matching_keywords || [],
          source: "enhanced_match",
          created_at: new Date().toISOString(),
          matchingCriteria: matchingCrit
        }
      })
      cachedMatches = matches.length

      // Always persist recomputed matches — a "refresh" that isn't written back
      // just means the very next page navigation (which reads job_matches with
      // no refresh param) hits an empty/stale cache, triggers its OWN
      // independent recompute, and overwrites the cache with a different
      // (LLM/embedding nondeterminism) score set than what refresh just showed.
      // That's what produced the "page 2 drops, page 1 goes to 0%" bug — every
      // read must serve the SAME persisted numbers, and only an explicit
      // recompute (refresh, or an empty cache) should ever write new ones.
      try {
        const { error: insertError } = await supabaseAdmin
          .from("job_matches")
          .upsert(matches, { onConflict: "job_id,candidate_id" })
        let upsertOk = !insertError
        if (insertError) {
          // If matching_keywords or matchingCriteria column is missing, retry without them
          if ((insertError as any)?.code === 'PGRST204' ||
              insertError.message.includes("matching_keywords") ||
              insertError.message.includes("matchingCriteria")) {
            console.warn("Retrying upsert without matching_keywords/matchingCriteria columns...")
            const matchesNoKeywords = matches.map(({ matching_keywords, matchingCriteria, ...rest }: any) => rest)
            const { error: retryError } = await supabaseAdmin
              .from("job_matches")
              .upsert(matchesNoKeywords, { onConflict: "job_id,candidate_id" })

            upsertOk = !retryError
            if (retryError) console.warn("Retry failed:", retryError.message)
          } else {
            console.warn("job_matches upsert failed:", insertError.message)
          }
        }

        // Full-replace semantics on refresh — but SAFELY: write the fresh rows
        // FIRST, then prune stale ones. Deleting before writing meant that any
        // failed/empty recompute left the job with ZERO cached matches (a
        // death spiral where every subsequent load recomputed into the wall).
        if (forceRefresh && upsertOk && rankedTop.length > 0) {
          const freshIds = rankedTop.map((m: any) => `"${m.candidate_id}"`).join(",")
          const { error: pruneError } = await supabaseAdmin
            .from("job_matches")
            .delete()
            .eq("job_id", id)
            .not("candidate_id", "in", `(${freshIds})`)
          if (pruneError) console.warn("Stale match pruning failed:", pruneError.message)
        }
      } catch (_ignore) {}

      try {
        await supabaseAdmin
          .from("job_match_runs")
          .upsert(
            {
              job_id: id,
              total_matches: totalMatches,
              cached_matches: cachedMatches,
              per_page: perPage,
              max_pages: maxPages,
              candidate_ids: orderedCandidateIds as any,
              requirements: storedRequirements as any,
              last_matched_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "job_id" }
          )
      } catch (_ignore) {}
    }

    const scores = tierCounts(matches)
    const pct = (m: any) => Math.round((m.relevance_score > 1 ? m.relevance_score / 100 : m.relevance_score) * 100)
    // Compute actionable total from ALL matches (before tier/minScore filtering)
    // so "X callable of Y matched" shows correct relationship
    const allMatchCandidateIds = Array.from(
      new Set(matches.map((m: any) => String(m?.candidate_id || "")).filter(Boolean))
    )
    let actionableTotal = 0
    if (allMatchCandidateIds.length > 0) {
      try {
        const { data: candRows } = await supabaseAdmin
          .from("candidates")
          .select("id, phone")
          .in("id", allMatchCandidateIds)
        const phoneById = new Map<string, boolean>()
        if (candRows) {
          for (const c of candRows) phoneById.set(String(c.id), Boolean(c.phone && String(c.phone).trim()))
        }
        const { data: appRows } = await supabaseAdmin
          .from("applications")
          .select("candidate_id")
          .eq("job_id", id)
          .in("candidate_id", allMatchCandidateIds)
        const appliedIds = new Set<string>()
        if (appRows) for (const a of appRows) appliedIds.add(String(a.candidate_id))
        const { data: partRows } = await supabaseAdmin
          .from("phone_screening_participants")
          .select("candidate_id")
          .eq("job_id", id)
          .in("candidate_id", allMatchCandidateIds)
        const calledIds = new Set<string>()
        if (partRows) for (const p of partRows) calledIds.add(String(p.candidate_id))
        actionableTotal = allMatchCandidateIds.filter(
          (cid) => phoneById.get(cid) && !appliedIds.has(cid) && !calledIds.has(cid)
        ).length
      } catch (_ignore) {}
    }

    // Now apply tier/minScore filtering for display
    if (hasMinScore) {
      matches = matches.filter((m: any) => pct(m) >= minScore)
      totalMatches = matches.length
    } else if (activeRange) {
      matches = matches.filter((m: any) => {
        const p = pct(m)
        if (activeRange.min !== undefined && p < activeRange.min) return false
        if (activeRange.max !== undefined && p > activeRange.max) return false
        return true
      })
      totalMatches = matches.length
    }

    // Compute phone/applied/called sets from ALL matches for decorateMatch
    const allMatchCandidateIdsForDecorate = Array.from(
      new Set(matches.map((m: any) => String(m?.candidate_id || "")).filter(Boolean))
    )
    const phoneById = new Map<string, boolean>()
    const appliedIds = new Set<string>()
    const calledIds = new Set<string>()
    const candMetaById = new Map<string, any>()
    if (allMatchCandidateIdsForDecorate.length > 0) {
      try {
        // Batch all three lookups into single queries
        const [candRows, appRows, partRows] = await Promise.all([
          supabaseAdmin.from("candidates").select("id, phone, current_city, total_experience, current_role, desired_role, summary, technical_skills, soft_skills, job_titles").in("id", allMatchCandidateIdsForDecorate),
          supabaseAdmin.from("applications").select("candidate_id").eq("job_id", id).in("candidate_id", allMatchCandidateIdsForDecorate),
          supabaseAdmin.from("phone_screening_participants").select("candidate_id").eq("job_id", id).in("candidate_id", allMatchCandidateIdsForDecorate)
        ])
        if (candRows?.data) {
          for (const c of candRows.data) {
            phoneById.set(String(c.id), Boolean(c.phone && String(c.phone).trim()))
            candMetaById.set(String(c.id), c)
          }
        }
        if (appRows?.data) for (const a of appRows.data) appliedIds.add(String(a.candidate_id))
        if (partRows?.data) for (const p of partRows.data) calledIds.add(String(p.candidate_id))
      } catch (_ignore) {}
    }

    // Display filters (client-app applySidebarFilters parity) — applied after tier filtering
    if (hasDisplayFilters && matches.length > 0) {
      const yearsOf = (v: any): number => {
        if (typeof v === "number") return v
        const m = String(v || "").match(/(\d{1,2})(?:\+)?\s*(?:years?|yrs?)/i)
        return m ? Number(m[1]) : 0
      }
      // Build searchable text per candidate once (name excluded — admin filters target profile content)
      const candTextById = new Map<string, string>()
      for (const m of matches) {
        const cid = String(m?.candidate_id || "")
        const meta = candMetaById.get(cid) || {}
        const text = [
          meta.current_role || "",
          meta.desired_role || "",
          meta.summary || "",
          ...(Array.isArray(meta.technical_skills) ? meta.technical_skills : []),
          ...(Array.isArray(meta.soft_skills) ? meta.soft_skills : []),
          ...(Array.isArray(meta.job_titles) ? meta.job_titles : []),
        ].join(" ").toLowerCase()
        candTextById.set(cid, text)
      }
      matches = matches.filter((m: any) => {
        const cid = String(m?.candidate_id || "")
        if (hasPhoneOnly && phoneById.get(cid) !== true) return false
        const meta = candMetaById.get(cid)
        const yrs = yearsOf(meta?.total_experience)
        if (minExpFilter !== null && yrs < minExpFilter) return false
        if (maxExpFilter !== null && yrs > maxExpFilter) return false
        if (cityFilters.length > 0) {
          const loc = String(meta?.current_city || "").toLowerCase()
          if (!cityFilters.some((c) => loc.includes(c))) return false
        }
        if (mustKwFilters.length > 0) {
          const text = candTextById.get(cid) || ""
          if (!mustKwFilters.every((k) => text.includes(k))) return false
        }
        if (excludeKwFilters.length > 0) {
          const text = candTextById.get(cid) || ""
          if (excludeKwFilters.some((k) => text.includes(k))) return false
        }
        return true
      })
      totalMatches = matches.length
    }

    const decorateMatch = (item: any): any => {
      const cid = String(item?.candidate_id || "")
      const candPhone = (item?.candidate as any)?.phone
      const hasPhone = Boolean(candPhone && String(candPhone).trim()) || phoneById.get(cid) === true
      return {
        ...item,
        has_phone: hasPhone,
        already_applied: appliedIds.has(cid),
        already_called: calledIds.has(cid),
      }
    }

    if (countOnly) {
      return NextResponse.json({ total: totalMatches, cachedTotal: cachedMatches, actionableTotal })
    }

    if (idsOnly) {
      let ids: string[] = []
      if (hasMinScore) {
        // Arbitrary threshold: everything at or above the input percentage.
        ids = matches
          .filter((m: any) => pct(m) >= minScore)
          .map((m: any) => String(m?.candidate_id || ""))
          .filter(Boolean)
      } else if (upTo && TIER_RANGES[upTo]?.min !== undefined) {
        // Cumulative select: everything at or above this tier's threshold.
        const threshold = TIER_RANGES[upTo].min!
        ids = matches
          .filter((m: any) => pct(m) >= threshold)
          .map((m: any) => String(m?.candidate_id || ""))
          .filter(Boolean)
      } else if (activeRange) {
        ids = matches.map((m: any) => String(m?.candidate_id || "")).filter(Boolean)
      } else {
        ids = orderedCandidateIds.length
          ? orderedCandidateIds
          : matches.slice(0, cacheLimit).map((m: any) => String(m?.candidate_id || "")).filter(Boolean)
      }
      if (hasDisplayFilters) {
        const allowed = new Set(matches.map((m: any) => String(m?.candidate_id || "")))
        ids = ids.filter((cid) => allowed.has(cid))
      }
      return NextResponse.json({
        total: totalMatches,
        cachedTotal: cachedMatches,
        actionableTotal,
        candidateIds: ids,
        maxPages,
        tierCounts: scores,
      })
    }

if (page > maxPages && !activeRange) {
      const ids = orderedCandidateIds.length
        ? orderedCandidateIds
        : matches.map((m: any) => String(m?.candidate_id || "")).filter(Boolean)
      const start = (page - 1) * perPage
      const end = Math.min(start + perPage, ids.length)
      const pageIds = ids.slice(start, end)

      // Fetch actual scores from database for beyond-cache pages
      let items: any[] = []
      if (pageIds.length) {
        try {
          const { data: matchesData } = await supabaseAdmin
            .from("job_matches")
            .select("candidate_id, relevance_score, score_breakdown, matching_keywords, matchingCriteria")
            .eq("job_id", id)
            .in("candidate_id", pageIds)
          const matchMap = new Map((matchesData || []).map((m: any) => [String(m.candidate_id), m]))
          
          const { data: cands } = await supabase
            .from("candidates")
            .select("*")
            .in("id", pageIds)
          const candMap = new Map((cands || []).map((c: any) => [String(c.id), SupabaseCandidateService.mapRowToCandidate(c)]))
          
          items = pageIds.map((cid: string) => {
            const matchData = matchMap.get(cid)
            return {
              job_id: id,
              candidate_id: cid,
              relevance_score: matchData?.relevance_score || 0,
              match_summary: null,
              score_breakdown: matchData?.score_breakdown || null,
              matching_keywords: matchData?.matching_keywords || [],
              source: "database",
              created_at: matchData?.created_at || null,
              candidate: candMap.get(cid) || null,
              matchingCriteria: matchData?.matchingCriteria || {
                role: job.title,
                location: job.location || "",
                skills: [],
                min_experience_years: null
              }
            }
          })
        } catch (_ignore) {}
      }

    return NextResponse.json({
        items: items.map((x: any) => decorateMatch(x)),
        page,
        perPage,
        total: totalMatches,
        cachedTotal: cachedMatches,
        actionableTotal,
        maxPages,
        tierCounts: scores,
      })
    } else {
      // Pagination
      const limited = matches.slice(0, cacheLimit)
      const pageCountFromCache = Math.max(1, Math.ceil(limited.length / perPage))
      const safePage = Math.max(1, Math.min(page, pageCountFromCache, maxPages))
      const start = (safePage - 1) * perPage
      const end = Math.min(start + perPage, limited.length)
      const pageItems = limited.slice(start, end)

      // Hydrate candidate info for display
      let items = pageItems
      if (pageItems.length) {
        const ids = pageItems.map(m => m.candidate_id)
        try {
          const { data: cands } = await supabase
            .from("candidates")
            .select("*")
            .in("id", ids)
          const map = new Map((cands || []).map((c: any) => [c.id, SupabaseCandidateService.mapRowToCandidate(c)]))
          items = pageItems.map(m => ({
            ...m,
            candidate: map.get(m.candidate_id) || null,
            score_breakdown: m.score_breakdown || {
              role: { earned: 0, max: 30 },
              experience: { earned: 0, max: 25 },
              location: { earned: 0, max: 25 },
              skills: { earned: 0, max: 20 }
            },
            matchingCriteria: m.matchingCriteria || {
              role: job.title,
              location: job.location || "",
              skills: [],
              min_experience_years: null
            }
          }))
        } catch (_ignore) {}
      }

      return NextResponse.json({
        items: items.map((x: any) => decorateMatch(x)),
        page: safePage,
        perPage,
        total: totalMatches,
        cachedTotal: cachedMatches,
        actionableTotal,
        maxPages,
        tierCounts: scores,
        ...(wantDebug ? { debug: lastDebug || { servedFrom: "unknown" }, cachedBefore: cachedBeforeCount } : {}),
      })
    }
  }
  try {
    const response = await handleRequest()
    return response
  } catch (error) {
    console.error("Job matches error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
