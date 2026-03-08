import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "roles.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { data, error } = await supabaseAdmin
    .from("permission_field_rules")
    .select("id,resource,allowed_fields,denied_fields,permissions(id,key,description)")
    .order("resource", { ascending: true })

  if (error) return NextResponse.json({ error: "Failed to load field rules" }, { status: 500 })
  return NextResponse.json({ fieldRules: data ?? [] })
}

export async function PUT(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "roles.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const permissionKey = typeof body?.permissionKey === "string" ? body.permissionKey.trim() : ""
  const resource = typeof body?.resource === "string" ? body.resource.trim() : ""
  const allowedFields = Array.isArray(body?.allowedFields) ? body.allowedFields.map((f: any) => String(f)) : null
  const deniedFields = Array.isArray(body?.deniedFields) ? body.deniedFields.map((f: any) => String(f)) : null

  if (!permissionKey || !resource) return NextResponse.json({ error: "permissionKey and resource are required" }, { status: 400 })

  const { data: perm } = await supabaseAdmin.from("permissions").select("id").eq("key", permissionKey).maybeSingle()
  if (!perm?.id) return NextResponse.json({ error: "Permission not found" }, { status: 404 })

  const { error } = await supabaseAdmin
    .from("permission_field_rules")
    .upsert(
      {
        permission_id: perm.id,
        resource,
        allowed_fields: allowedFields,
        denied_fields: deniedFields,
      },
      { onConflict: "permission_id,resource" }
    )

  if (error) return NextResponse.json({ error: "Failed to save field rule" }, { status: 500 })
  return NextResponse.json({ success: true })
}
