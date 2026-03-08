import { NextRequest, NextResponse } from "next/server"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const { searchParams } = new URL(request.url)
    const period = searchParams.get("period") || "all"

    const analytics = await SupabaseCandidateService.getAnalytics(period)
    return NextResponse.json(analytics)
  } catch (error) {
    console.error("Analytics error:", error)
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 })
  }
}
