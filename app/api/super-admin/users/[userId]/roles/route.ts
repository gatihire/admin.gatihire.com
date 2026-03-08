import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function PUT(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { userId } = await params
  const body = await request.json().catch(() => null)
  const roleNames = Array.isArray(body?.roleNames) ? body.roleNames.map((r: any) => String(r)) : null
  if (!roleNames) return NextResponse.json({ error: "roleNames is required" }, { status: 400 })

  const { data: roles, error: rolesErr } = await supabaseAdmin.from("roles").select("id,name").in("name", roleNames)
  if (rolesErr) return NextResponse.json({ error: "Failed to load roles" }, { status: 500 })

  await supabaseAdmin.from("user_roles").delete().eq("auth_user_id", userId)

  const rows = (roles ?? []).map((r: any) => ({ auth_user_id: userId, role_id: r.id }))
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("user_roles").insert(rows)
    if (error) return NextResponse.json({ error: "Failed to set roles" }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
