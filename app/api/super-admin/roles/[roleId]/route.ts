import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ roleId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "roles.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { roleId } = await params
  const body = await request.json().catch(() => null)
  const patch: Record<string, any> = {}
  if (typeof body?.name === "string") patch.name = body.name.trim()
  if (typeof body?.description === "string") patch.description = body.description.trim()
  if (body?.description === null) patch.description = null

  const { data, error } = await supabaseAdmin.from("roles").update(patch).eq("id", roleId).select("*").maybeSingle()
  if (error) return NextResponse.json({ error: "Failed to update role" }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Role not found" }, { status: 404 })
  return NextResponse.json({ role: data })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ roleId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "roles.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { roleId } = await params
  const { error } = await supabaseAdmin.from("roles").delete().eq("id", roleId)
  if (error) return NextResponse.json({ error: "Failed to delete role" }, { status: 500 })
  return NextResponse.json({ success: true })
}
