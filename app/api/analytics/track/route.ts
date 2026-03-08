import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const runtime = "nodejs"

async function getOptionalAuthUserId(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null
  if (!token) return null
  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !data?.user?.id) return null
  return data.user.id
}

export async function POST(request: NextRequest) {
  const actorAuthUserId = await getOptionalAuthUserId(request)
  const body = await request.json().catch(() => null)

  const eventName = typeof body?.event_name === "string" ? body.event_name.trim() : ""
  const entityType = typeof body?.entity_type === "string" ? body.entity_type.trim() : null
  const entityId = typeof body?.entity_id === "string" ? body.entity_id.trim() : null
  const metadata = typeof body?.metadata === "object" && body?.metadata ? body.metadata : {}

  if (!eventName) return NextResponse.json({ error: "event_name is required" }, { status: 400 })

  const { data, error } = await supabaseAdmin
    .from("analytics_events")
    .insert({
      actor_auth_user_id: actorAuthUserId,
      event_name: eventName,
      entity_type: entityType,
      entity_id: entityId,
      metadata,
    })
    .select("id")
    .single()

  if (error) return NextResponse.json({ error: "Failed to track" }, { status: 500 })
  return NextResponse.json({ accepted: true, event_id: data?.id ?? null })
}

