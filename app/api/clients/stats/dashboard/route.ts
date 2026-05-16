import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "analytics.view") && !hasPermission(ctx, "jobs.view")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // 1. Total Clients
    const { count: totalClients } = await supabaseAdmin
      .from("clients")
      .select("*", { count: "exact", head: true })

    // 2. New Clients (last 7 days)
    const { count: newClients } = await supabaseAdmin
      .from("clients")
      .select("*", { count: "exact", head: true })
      .gte("created_at", sevenDaysAgo)

    // 3. Client Users
    const { count: totalClientUsers } = await supabaseAdmin
      .from("client_users")
      .select("*", { count: "exact", head: true })

    // 4. Client Jobs
    const { count: totalClientJobs } = await supabaseAdmin
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .not("client_id", "is", null)

    const { count: openClientJobs } = await supabaseAdmin
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .not("client_id", "is", null)
      .eq("status", "open")

    // 5. Total Unlocks
    const { count: totalUnlocks } = await supabaseAdmin
      .from("client_unlocked_candidates")
      .select("*", { count: "exact", head: true })

    // 6. Pending Credit Requests
    const { count: pendingCreditRequests } = await supabaseAdmin
      .from("client_credit_requests")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")

    return NextResponse.json({
      totalClients: totalClients || 0,
      newClients: newClients || 0,
      totalClientUsers: totalClientUsers || 0,
      totalClientJobs: totalClientJobs || 0,
      openClientJobs: openClientJobs || 0,
      totalUnlocks: totalUnlocks || 0,
      pendingCreditRequests: pendingCreditRequests || 0
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
