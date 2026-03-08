import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage") && !hasPermission(ctx, "analytics.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { userId } = await params
  const { searchParams } = new URL(request.url)
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") ?? "50")))
  const event = searchParams.get("event")?.trim()

  let q = supabaseAdmin
    .from("analytics_events")
    .select("id,event_name,entity_type,entity_id,metadata,created_at")
    .eq("actor_auth_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (event) q = q.eq("event_name", event)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: "Failed to load activity" }, { status: 500 })
  return NextResponse.json({ userId, events: data ?? [] })
}
