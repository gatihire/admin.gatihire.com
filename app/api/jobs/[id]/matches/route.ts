import { NextRequest, NextResponse } from "next/server"
import { supabase, supabaseAdmin } from "@/lib/supabase"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { generateEmbedding } from "@/lib/embedding"
import { redis } from "@/lib/redis"
import crypto from "crypto"
import { calculateCandidateScore, applySidebarFilters } from "@/lib/scoring"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

function buildWebsearchQuery(terms: string[], max = 15): string {
  return terms.slice(0, max).map(t => t.includes(" ") ? `"${t}"` : t).filter(Boolean).join(" OR ")
}

async function runEnhancedMatchmaking(jobId: string, jd: string) {
  try {
    // Step 1: Extract criteria + embedding (same as client-app jd search)
    const jdHash = crypto.createHash('md5').update(jd.trim().toLowerCase()).digest('hex')
    const cacheKey = `jd_search_criteria:${jdHash}`
    let criteriaResult: any = null
    let embedding: number[] = []

    if (redis) {
      const cachedData = await redis.get<{ criteria: any, embedding: number[] }>(cacheKey)
      if (cachedData) {
        criteriaResult = cachedData.criteria
        embedding = cachedData.embedding
      }
    }

    if (!criteriaResult) {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" })
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

      if (redis && embedding.length > 0) {
        await redis.set(cacheKey, { criteria: criteriaResult, embedding }, { ex: 3600 * 24 }) // Cache 24h
      }
    }

    const criteria = criteriaResult

    // Step 2: Build websearch query
    const allKeyTerms = [...(criteria.required_skills || []), ...(criteria.key_keywords || []), criteria.title || ""].filter(Boolean)
    const websearchQ = buildWebsearchQuery(allKeyTerms, 15).replace(/[()]/g, " ").trim()

    // Step 3: Build RPC filters
    const rpcFilters: any = {}
    if (criteria.location) rpcFilters.currentCity = [criteria.location]
    if (criteria.min_experience_years) rpcFilters.exp_min = criteria.min_experience_years.toString()
    if (allKeyTerms.length > 0) rpcFilters.must_kw = allKeyTerms

    // Step 4: Run RPC search
    const { data, error } = await supabaseAdmin.rpc("search_candidates_hybrid", {
      p_query_text: websearchQ,
      p_query_embedding: embedding.length ? embedding : null,
      p_match_threshold: 0.15,
      p_filters: rpcFilters,
      p_limit: 500,
      p_offset: 0
    })

    if (error) {
      console.error("Matchmaking RPC error:", error)
      return { success: false, error }
    }

    // Step 5: Score and sort candidates
    const mappedCriteria = {
      role: criteria.title,
      location: criteria.location,
      min_experience_years: criteria.min_experience_years,
      skills: [...(criteria.required_skills || []), ...(criteria.preferred_skills || [])]
    }

    let results = (data || [])
      .map((row: any) => {
        const rawCandidate = row.candidate_data
        const calculatedScore = calculateCandidateScore(mappedCriteria, rawCandidate)
        const finalScore = Math.max(calculatedScore, row.match_score * 100)
        return { ...rawCandidate, match_score: Math.round(finalScore) }
      })
      .filter((c: any) => c.match_score >= 12)

    results.sort((a: any, b: any) => (b.match_score || 0) - (a.match_score || 0))
    results = results.map((c: any) => ({ ...c, match_score: Math.min(100, c.match_score) }))
    results = applySidebarFilters(results, {})

    return { success: true, candidates: results }
  } catch (err) {
    console.error("Enhanced matchmaking failed:", err)
    return { success: false, error: err }
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
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
    const maxPages = 5
    const cacheLimit = Math.max(1, Math.min(100, perPage * maxPages))

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
      cached = cachedData || []
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

    if (countOnly) {
      return NextResponse.json({ total: totalMatches, cachedTotal: cachedMatches })
    }

    let matches = cached
    if (!cached.length || forceRefresh) {
      // Compute matches using JD or title/requirements
      const baseText = [
        job.title || "",
        job.description || "",
      ].join("\n").trim()

      const matchmakingResult = await runEnhancedMatchmaking(id, baseText)
      let ranked: any[] = []
      if (matchmakingResult.success && matchmakingResult.candidates) {
        ranked = matchmakingResult.candidates
      }

      totalMatches = Array.isArray(ranked) ? ranked.length : 0
      orderedCandidateIds = (Array.isArray(ranked) ? ranked : []).map((c: any) => String(c?.id || "")).filter(Boolean)
      storedRequirements = null
      const rankedTop = (Array.isArray(ranked) ? ranked : []).slice(0, cacheLimit)
      matches = rankedTop.map((c: any) => ({
        job_id: id,
        candidate_id: c.id,
        relevance_score: c.match_score || 0,
        match_summary: null,
        score_breakdown: null,
        matching_keywords: [],
        source: "enhanced_match",
        created_at: new Date().toISOString()
      }))
      cachedMatches = matches.length

      // Persist if table exists
      try {
        if (forceRefresh) {
          await supabaseAdmin.from("job_matches").delete().eq("job_id", id)
        }
        const { error: insertError } = await supabaseAdmin
          .from("job_matches")
          .upsert(matches, { onConflict: "job_id,candidate_id" })
        if (insertError) {
          // If matching_keywords column is missing, retry without it
          if ((insertError as any)?.code === 'PGRST204' || insertError.message.includes("matching_keywords")) {
            console.warn("Retrying upsert without matching_keywords column...")
            const matchesNoKeywords = matches.map(({ matching_keywords, ...rest }: any) => rest)
            const { error: retryError } = await supabaseAdmin
              .from("job_matches")
              .upsert(matchesNoKeywords, { onConflict: "job_id,candidate_id" })
            
            if (retryError) console.warn("Retry failed:", retryError.message)
          } else {
            console.warn("job_matches upsert failed:", insertError.message)
          }
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

    if (idsOnly) {
      const ids = orderedCandidateIds.length
        ? orderedCandidateIds
        : matches.slice(0, cacheLimit).map((m: any) => String(m?.candidate_id || "")).filter(Boolean)
      return NextResponse.json({
        total: totalMatches,
        cachedTotal: cachedMatches,
        candidateIds: ids,
        maxPages,
      })
    }

    if (page > maxPages) {
      const ids = orderedCandidateIds.length
        ? orderedCandidateIds
        : matches.map((m: any) => String(m?.candidate_id || "")).filter(Boolean)
      const start = (page - 1) * perPage
      const end = Math.min(start + perPage, ids.length)
      const pageIds = ids.slice(start, end)

      let items: any[] = pageIds.map((candidateId) => ({
        job_id: id,
        candidate_id: candidateId,
        relevance_score: 0,
        match_summary: null,
        score_breakdown: null,
        matching_keywords: [],
        source: "database",
        created_at: null,
        candidate: null,
      }))

      if (pageIds.length) {
        try {
          const { data: cands } = await supabase
            .from("candidates")
            .select("*")
            .in("id", pageIds)
          const candMap = new Map((cands || []).map((c: any) => [String(c.id), SupabaseCandidateService.mapRowToCandidate(c)]))
          items = pageIds.map((cid) => {
            return {
              job_id: id,
              candidate_id: cid,
              relevance_score: 0,
              match_summary: null,
              score_breakdown: null,
              matching_keywords: [],
              source: "database",
              created_at: null,
              candidate: candMap.get(cid) || null,
            }
          })
        } catch (_ignore) {}
      }

      return NextResponse.json({
        items,
        page,
        perPage,
        total: totalMatches,
        cachedTotal: cachedMatches,
        maxPages,
      })
    }

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
        items = pageItems.map(m => ({ ...m, candidate: map.get(m.candidate_id) || null }))
      } catch (_ignore) {}
    }

    return NextResponse.json({
      items,
      page: safePage,
      perPage,
      total: totalMatches,
      cachedTotal: cachedMatches,
      maxPages,
    })
  } catch (error) {
    console.error("Job matches error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
