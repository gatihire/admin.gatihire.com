import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { parseSearchRequirement } from "@/lib/intelligent-search"
import { generateCandidateSummary } from "@/lib/ai-summary"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"
const summaryCache = new Map<string, { at: number; summary: string }>()
const SUMMARY_TTL_MS = 10 * 60_000

function cacheKey(input: string) {
  return Buffer.from(input, "utf8").toString("base64").slice(0, 200)
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.view") && !hasPermission(ctx, "candidates.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as any
  const candidateId = typeof body?.candidateId === "string" ? body.candidateId : ""
  const type = typeof body?.type === "string" ? body.type : "smart"
  const query = typeof body?.query === "string" ? body.query : ""
  const jd = typeof body?.jd === "string" ? body.jd : ""

  if (!candidateId) return NextResponse.json({ error: "Missing candidateId" }, { status: 400 })

  const { data: row, error } = await supabaseAdmin.from("candidates").select("*").eq("id", candidateId).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Candidate not found" }, { status: 404 })

  const candidate = SupabaseCandidateService.mapRowToCandidate(row as any)

  const searchText = type === "jd" ? jd : query
  const trimmedSearch = String(searchText || "").trim()
  const key = cacheKey(`${candidateId}:${type}:${trimmedSearch}`)
  const cached = summaryCache.get(key)
  const now = Date.now()
  if (cached && now - cached.at < SUMMARY_TTL_MS) {
    return NextResponse.json({ candidateId, summary: cached.summary, cached: true })
  }

  const requirements = trimmedSearch ? await parseSearchRequirement(trimmedSearch) : {}

  let summary = await generateCandidateSummary(candidate as any, requirements)
  if (/curly braces|\{\s*\}|provide the requirements|within the curly/i.test(summary)) {
    summary = await generateCandidateSummary(candidate as any, {
      ...(requirements || {}),
      _guard: "Do not ask for more input; write only the insight.",
    })
  }
  summaryCache.set(key, { at: now, summary })
  return NextResponse.json({ candidateId, summary })
}
