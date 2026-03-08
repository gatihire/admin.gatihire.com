import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

function parseIds(raw: string | null) {
  const items = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return Array.from(new Set(items)).slice(0, 200)
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const ids = parseIds(searchParams.get("ids"))
  if (!ids.length) return NextResponse.json({ error: "Missing ids" }, { status: 400 })

  const byClient: Record<string, { truckinzy: number; employee: number; total: number }> = {}
  ids.forEach((id) => {
    byClient[id] = { truckinzy: 0, employee: 0, total: 0 }
  })

  const { data, error } = await supabaseAdmin.from("jobs").select("client_id,source").in("client_id", ids)
  if (error) return NextResponse.json({ error: error.message || "Failed to load jobs" }, { status: 500 })

  for (const row of data || []) {
    const clientId = String((row as any)?.client_id || "").trim()
    if (!clientId || !(clientId in byClient)) continue
    const source = String((row as any)?.source || "truckinzy")
    byClient[clientId].total += 1
    if (source === "employee") byClient[clientId].employee += 1
    else byClient[clientId].truckinzy += 1
  }

  return NextResponse.json({ byClient })
}

