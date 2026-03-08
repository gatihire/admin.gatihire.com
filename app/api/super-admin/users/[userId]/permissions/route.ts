import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { userId } = await params

  const [{ data: userRoles }, { data: userPerms }, { data: allPerms }] = await Promise.all([
    supabaseAdmin.from("user_roles").select("roles(name)").eq("auth_user_id", userId),
    supabaseAdmin.from("user_permissions").select("permissions(key)").eq("auth_user_id", userId),
    supabaseAdmin.from("permissions").select("key").order("key", { ascending: true }),
  ])

  const roleNames =
    (userRoles ?? [])
      .map((r: any) => r?.roles?.name)
      .filter((n: any) => typeof n === "string") ?? []

  const overridePermissionKeys =
    (userPerms ?? [])
      .map((p: any) => p?.permissions?.key)
      .filter((k: any) => typeof k === "string") ?? []

  const availablePermissionKeys = (allPerms ?? []).map((p: any) => p.key)

  return NextResponse.json({
    userId,
    roleNames,
    overridePermissionKeys,
    availablePermissionKeys,
  })
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { userId } = await params
  const body = await request.json().catch(() => null)
  const permissionKeys = Array.isArray(body?.permissionKeys) ? body.permissionKeys.map((p: any) => String(p)) : null
  if (!permissionKeys) return NextResponse.json({ error: "permissionKeys is required" }, { status: 400 })

  const { data: perms, error: permErr } = await supabaseAdmin.from("permissions").select("id,key").in("key", permissionKeys)
  if (permErr) return NextResponse.json({ error: "Failed to load permissions" }, { status: 500 })

  await supabaseAdmin.from("user_permissions").delete().eq("auth_user_id", userId)

  const rows = (perms ?? []).map((p: any) => ({ auth_user_id: userId, permission_id: p.id }))
  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("user_permissions").insert(rows)
    if (error) return NextResponse.json({ error: "Failed to set user permissions" }, { status: 500 })
  }

  supabaseAdmin
    .from("analytics_events")
    .insert({
      actor_auth_user_id: ctx.authUser.id,
      event_name: "user.permissions.updated",
      entity_type: "auth.users",
      entity_id: userId,
      metadata: { permission_keys: permissionKeys },
    })
    .then(() => {})

  return NextResponse.json({ success: true })
}
