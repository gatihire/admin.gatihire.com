import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { deriveOrigin, type CandidateOrigin } from "@/lib/origin"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const jobId = searchParams.get("jobId")
  const origin = searchParams.get("origin") as CandidateOrigin | null

  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 })
  }

  let appQuery = supabaseAdmin
    .from("applications")
    .select("candidate_id, source, origin")
    .eq("job_id", jobId)

  if (origin === "inbound" || origin === "outbound") {
    appQuery = appQuery.eq("origin", origin)
  }

  const { data: applications, error: appError } = await appQuery

  if (appError) {
    return NextResponse.json({ error: appError.message }, { status: 500 })
  }

  const candidateIds = [...new Set((applications || []).map((a: any) => a.candidate_id))]

  if (candidateIds.length === 0) {
    return NextResponse.json([])
  }

  const { data: candidates, error: candError } = await supabaseAdmin
    .from("candidates")
    .select("id, name, email, phone, current_role, current_company")
    .in("id", candidateIds)
    .order("name")

  if (candError) {
    return NextResponse.json({ error: candError.message }, { status: 500 })
  }

  const appByCandidate = new Map<string, any>()
  for (const app of applications || []) {
    const a = app as any
    if (!appByCandidate.has(a.candidate_id)) {
      appByCandidate.set(a.candidate_id, a)
    }
  }

  return NextResponse.json(
    (candidates || []).map((c: any) => {
      const app = appByCandidate.get(c.id)
      const source = app?.source || "applied"
      return {
        ...c,
        source,
        origin: app?.origin || deriveOrigin(source),
      }
    })
  )
}
