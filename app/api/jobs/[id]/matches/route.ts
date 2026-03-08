import { NextRequest, NextResponse } from "next/server"
import { supabase, supabaseAdmin } from "@/lib/supabase"
import { parseSearchRequirement, intelligentCandidateSearch } from "@/lib/intelligent-search"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

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

    const { data: job, error: jobErr } = await supabaseAdmin
      .from("jobs")
      .select("*")
      .eq("id", id)
      .single()
    if (jobErr || !job) {
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

      const candidates = await SupabaseCandidateService.getAllCandidates()
      const requirements = await parseSearchRequirement(baseText)
      const ranked = await intelligentCandidateSearch(requirements, candidates)

      totalMatches = Array.isArray(ranked) ? ranked.length : 0
      orderedCandidateIds = (Array.isArray(ranked) ? ranked : []).map((c: any) => String(c?.id || "")).filter(Boolean)
      storedRequirements = requirements
      const rankedTop = (Array.isArray(ranked) ? ranked : []).slice(0, cacheLimit)
      matches = rankedTop.map((c: any) => ({
        job_id: id,
        candidate_id: c.id,
        relevance_score: c.relevanceScore || 0,
        match_summary: c.matchSummary || null,
        score_breakdown: c.scoreBreakdown || null,
        matching_keywords: c.matchingKeywords || [],
        source: "database",
        created_at: new Date().toISOString()
      }))
      cachedMatches = matches.length

      // Persist if table exists
      try {
        if (forceRefresh) {
          await supabaseAdmin.from("job_matches").delete().eq("job_id", id)
        }
        const { error: insertErr } = await supabaseAdmin
          .from("job_matches")
          .upsert(matches, { onConflict: "job_id,candidate_id" })
        if (insertErr) {
          // If matching_keywords column is missing, retry without it
          if ((insertErr as any)?.code === 'PGRST204' || insertErr.message.includes("matching_keywords")) {
            console.warn("Retrying upsert without matching_keywords column...")
            const matchesNoKeywords = matches.map(({ matching_keywords, ...rest }: any) => rest)
            const { error: retryErr } = await supabaseAdmin
              .from("job_matches")
              .upsert(matchesNoKeywords, { onConflict: "job_id,candidate_id" })
            
            if (retryErr) console.warn("Retry failed:", retryErr.message)
          } else {
            console.warn("job_matches upsert failed:", insertErr.message)
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
          const candidatesForScoring = pageIds.map((cid) => candMap.get(cid)).filter(Boolean) as any[]
          let scoreById = new Map<string, { score: number; keywords: any[] }>()
          if (storedRequirements && candidatesForScoring.length) {
            const scored = await intelligentCandidateSearch(storedRequirements, candidatesForScoring)
            scoreById = new Map(
              (Array.isArray(scored) ? scored : []).map((c: any) => [
                String(c?.id || ""),
                { score: c?.relevanceScore || 0, keywords: c?.matchingKeywords || [] }
              ])
            )
          }
          items = pageIds.map((cid) => {
            const s = scoreById.get(cid)
            return {
              job_id: id,
              candidate_id: cid,
              relevance_score: s?.score || 0,
              match_summary: null,
              score_breakdown: null,
              matching_keywords: s?.keywords || [],
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
      maxPages
    })
  } catch (error) {
    console.error("Job matches error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
