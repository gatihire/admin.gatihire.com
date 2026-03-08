import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import crypto from "crypto"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { data: users, error } = await supabaseAdmin
    .from("internal_users")
    .select("auth_user_id,email,name,disabled,created_at,last_active_at")
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: "Failed to load users" }, { status: 500 })

  const userIds = (users ?? []).map((u: any) => u.auth_user_id).filter(Boolean)
  if (userIds.length === 0) return NextResponse.json({ users: [] })

  const { data: roleRows, error: rolesError } = await supabaseAdmin
    .from("user_roles")
    .select("auth_user_id,role_id,roles(id,name)")
    .in("auth_user_id", userIds)

  if (rolesError) return NextResponse.json({ error: "Failed to load users" }, { status: 500 })

  const rolesByUser = new Map<string, Array<{ role_id: string; roles: { id: string; name: string } | null }>>()
  for (const row of roleRows ?? []) {
    const authUserId = String((row as any).auth_user_id || "")
    if (!authUserId) continue
    if (!rolesByUser.has(authUserId)) rolesByUser.set(authUserId, [])
    rolesByUser.get(authUserId)!.push({
      role_id: String((row as any).role_id || ""),
      roles: (row as any).roles ?? null,
    })
  }

  const payload = (users ?? []).map((u: any) => ({
    ...u,
    user_roles: rolesByUser.get(String(u.auth_user_id)) ?? [],
  }))

  return NextResponse.json({ users: payload })
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""
  const passwordInput = typeof body?.password === "string" ? body.password : ""
  const name = typeof body?.name === "string" ? body.name.trim() : null
  const roleNames = Array.isArray(body?.roleNames)
    ? body.roleNames.map((r: any) => String(r))
    : typeof body?.roleName === "string"
      ? [body.roleName]
      : []
  const permissionKeys = Array.isArray(body?.permissionKeys) ? body.permissionKeys.map((p: any) => String(p)) : []
  const effectivePermissionKeys = Array.from(
    new Set(permissionKeys.length > 0 ? permissionKeys : ["analytics.view"])
  )

  if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 })

  const password = passwordInput.trim().length
    ? passwordInput
    : crypto.randomBytes(12).toString("base64url")

  const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { ...(name ? { name } : {}), is_internal: true },
  })

  const createErrorMessage = String((error as any)?.message || "")
  const createErrorLower = createErrorMessage.toLowerCase()
  const isAlreadyExists =
    createErrorLower.includes("already") || createErrorLower.includes("registered") || createErrorLower.includes("exists")

  let authUserId = created?.user?.id || ""
  if (!authUserId && isAlreadyExists) {
    const { data: listed } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
    const existing = listed?.users?.find((u) => (u.email || "").toLowerCase() === email.toLowerCase())
    if (existing?.id) {
      authUserId = existing.id
      await supabaseAdmin.auth.admin.updateUserById(existing.id, {
        user_metadata: { ...(name ? { name } : {}), is_internal: true },
      })
    }
  }

  if (!authUserId) {
    if (isAlreadyExists) {
      return NextResponse.json({ error: "User already exists" }, { status: 409 })
    }
    if (createErrorLower.includes("password") || createErrorLower.includes("invalid") || createErrorLower.includes("weak")) {
      return NextResponse.json({ error: createErrorMessage || "Invalid password" }, { status: 400 })
    }
    return NextResponse.json({ error: createErrorMessage || "Failed to create user" }, { status: 500 })
  }

  const { error: profileErr } = await supabaseAdmin.from("internal_users").upsert(
    {
      auth_user_id: authUserId,
      email,
      name,
      disabled: false,
      last_active_at: null,
    },
    { onConflict: "auth_user_id" }
  )

  if (profileErr) {
    return NextResponse.json({ error: profileErr.message || "Failed to save user profile" }, { status: 500 })
  }

  await supabaseAdmin.from("candidates").delete().or(`auth_user_id.eq.${authUserId},email.eq.${email}`)

  if (roleNames.length > 0) {
    const { data: roles } = await supabaseAdmin.from("roles").select("id,name").in("name", roleNames)
    const rows = (roles ?? []).map((r: any) => ({ auth_user_id: authUserId, role_id: r.id }))
    if (rows.length > 0) await supabaseAdmin.from("user_roles").insert(rows)
  }

  if (effectivePermissionKeys.length > 0) {
    const { data: perms } = await supabaseAdmin.from("permissions").select("id,key").in("key", effectivePermissionKeys)
    const rows = (perms ?? []).map((p: any) => ({ auth_user_id: authUserId, permission_id: p.id }))
    if (rows.length > 0) await supabaseAdmin.from("user_permissions").insert(rows)
  }

  supabaseAdmin
    .from("analytics_events")
    .insert({
      actor_auth_user_id: ctx.authUser.id,
      event_name: "user.created",
      entity_type: "auth.users",
      entity_id: authUserId,
      metadata: { email, role_names: roleNames, permission_keys: effectivePermissionKeys },
    })
    .then(() => {})

  return NextResponse.json({ user: { id: authUserId, email }, password: passwordInput.trim().length ? null : password })
}
