import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "roles.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { data, error } = await supabaseAdmin
    .from("roles")
    .select("id,name,description,created_at,role_permissions(permission_id,permissions(id,key,description))")
    .order("name", { ascending: true })

  if (error) return NextResponse.json({ error: "Failed to load roles" }, { status: 500 })
  return NextResponse.json({ roles: data ?? [] })
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "roles.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  const description = typeof body?.description === "string" ? body.description.trim() : null
  const permissionKeys = Array.isArray(body?.permissionKeys) ? body.permissionKeys.map((k: any) => String(k)) : []

  if (!name) return NextResponse.json({ error: "Role name is required" }, { status: 400 })

  const { data: role, error: roleError } = await supabaseAdmin
    .from("roles")
    .insert({ name, description })
    .select("id,name,description,created_at")
    .single()

  if (roleError || !role) return NextResponse.json({ error: "Failed to create role" }, { status: 500 })

  if (permissionKeys.length > 0) {
    const { data: perms } = await supabaseAdmin.from("permissions").select("id,key").in("key", permissionKeys)
    const rows = (perms ?? []).map((p: any) => ({ role_id: role.id, permission_id: p.id }))
    if (rows.length > 0) {
      await supabaseAdmin.from("role_permissions").insert(rows)
    }
  }

  return NextResponse.json({ role })
}
