import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function PUT(request: NextRequest, { params }: { params: Promise<{ roleId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "roles.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { roleId } = await params
  const body = await request.json().catch(() => null)
  const permissionKeys = Array.isArray(body?.permissionKeys) ? body.permissionKeys.map((k: any) => String(k)) : null
  if (!permissionKeys) return NextResponse.json({ error: "permissionKeys is required" }, { status: 400 })

  const { data: perms, error: permErr } = await supabaseAdmin.from("permissions").select("id,key").in("key", permissionKeys)
  if (permErr) return NextResponse.json({ error: "Failed to load permissions" }, { status: 500 })

  await supabaseAdmin.from("role_permissions").delete().eq("role_id", roleId)

  const rows = (perms ?? []).map((p: any) => ({ role_id: roleId, permission_id: p.id }))
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("role_permissions").insert(rows)
    if (error) return NextResponse.json({ error: "Failed to set role permissions" }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
