import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "analytics.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const from = searchParams.get("from")
  const to = searchParams.get("to")
  const eventName = searchParams.get("event")
  const entityType = searchParams.get("entityType")
  const entityId = searchParams.get("entityId")
  const actor = searchParams.get("actor")
  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") ?? "50")))

  let q = supabaseAdmin
    .from("analytics_events")
    .select("id,created_at,actor_auth_user_id,event_name,entity_type,entity_id,metadata")
    .order("created_at", { ascending: false })
    .limit(limit)

  if (from) q = q.gte("created_at", new Date(from).toISOString())
  if (to) q = q.lt("created_at", new Date(to).toISOString())
  if (eventName) q = q.eq("event_name", eventName)
  if (entityType) q = q.eq("entity_type", entityType)
  if (entityId) q = q.eq("entity_id", entityId)
  if (actor) q = q.eq("actor_auth_user_id", actor)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: "Failed to load events" }, { status: 500 })
  return NextResponse.json({ events: data ?? [] })
}

