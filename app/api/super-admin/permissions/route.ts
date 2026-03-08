import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "roles.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { data, error } = await supabaseAdmin.from("permissions").select("*").order("key", { ascending: true })
  if (error) return NextResponse.json({ error: "Failed to load permissions" }, { status: 500 })
  return NextResponse.json({ permissions: data ?? [] })
}
