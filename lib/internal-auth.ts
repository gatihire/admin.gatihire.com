import { createClient } from "@supabase/supabase-js"
import type { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

type FieldRule = {
  permission_key: string
  resource: string
  allowed_fields: string[] | null
  denied_fields: string[] | null
}

export type InternalAuthContext = {
  accessToken: string
  authUser: { id: string; email: string | null }
  isSuperAdmin: boolean
  permissionKeys: Set<string>
  fieldRules: FieldRule[]
  refreshedSession?: { access_token: string; refresh_token: string; expires_in: number }
}

function getAccessTokenFromRequest(request: NextRequest) {
  const cookieToken = request.cookies.get("sb-access-token")?.value
  if (cookieToken) return cookieToken
  const authHeader = request.headers.get("authorization") || ""
  if (authHeader.toLowerCase().startsWith("bearer ")) return authHeader.slice(7)
  return null
}

function getRefreshTokenFromRequest(request: NextRequest) {
  const cookieToken = request.cookies.get("sb-refresh-token")?.value
  return cookieToken || null
}

function createAuthedClient(accessToken: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) return null
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

async function getUserWithTimeout(accessToken: string, timeoutMs = 3500) {
  const timeout = new Promise<{ data: any; error: any }>((resolve) =>
    setTimeout(() => resolve({ data: null, error: new Error("timeout") }), timeoutMs)
  )
  try {
    return await Promise.race([supabaseAdmin.auth.getUser(accessToken), timeout])
  } catch (error) {
    return { data: null, error }
  }
}

export async function getInternalAuthContext(request: NextRequest): Promise<InternalAuthContext | null> {
  const initialAccessToken = getAccessTokenFromRequest(request)
  if (!initialAccessToken) return null
  let accessToken: string = initialAccessToken

  let refreshedSession: { access_token: string; refresh_token: string; expires_in: number } | undefined

  let { data, error } = await getUserWithTimeout(accessToken)
  let user = data?.user

  if (error || !user) {
    const refreshToken = getRefreshTokenFromRequest(request)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (refreshToken && supabaseUrl && supabaseAnonKey) {
      try {
        const refreshClient = createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
        const refreshed = await refreshClient.auth.refreshSession({ refresh_token: refreshToken })
        const session = (refreshed as any)?.data?.session
        if (session?.access_token && session?.refresh_token) {
          refreshedSession = {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: session.expires_in || 3600,
          }
          accessToken = session.access_token
          ;({ data, error } = await getUserWithTimeout(accessToken))
          user = data?.user
        }
      } catch {
        // ignore
      }
    }
  }

  if (error || !user) return null

  const authedClient = createAuthedClient(accessToken)
  if (!authedClient) return null

  const [{ data: perms }, { data: rules }, { data: isSuperAdmin }] = await Promise.all([
    authedClient.rpc("current_user_permission_keys"),
    authedClient.rpc("current_user_field_rules"),
    authedClient.rpc("is_super_admin"),
  ])

  const superAdmin = Boolean(isSuperAdmin)

  const rolePermissionKeys = Array.isArray(perms)
    ? perms
        .map((p: any) => String(p?.permission_key || "").trim())
        .filter(Boolean)
    : []

  let overridePermissionKeys: string[] = []
  if (!superAdmin) {
    const { data: userPerms } = await supabaseAdmin
      .from("user_permissions")
      .select("permissions(key)")
      .eq("auth_user_id", user.id)
    overridePermissionKeys =
      (userPerms ?? [])
        .map((p: any) => String(p?.permissions?.key || "").trim())
        .filter(Boolean) ?? []
  }

  const permissionKeys = superAdmin
    ? new Set<string>(
        (
          (
            await supabaseAdmin.from("permissions").select("key").order("key", { ascending: true })
          ).data?.map((p: any) => String(p?.key || "").trim()).filter(Boolean) ?? []
        )
      )
    : new Set<string>([...rolePermissionKeys, ...overridePermissionKeys])

  const fieldRules: FieldRule[] = superAdmin
    ? []
    : Array.isArray(rules)
      ? rules.map((r: any) => ({
          permission_key: String(r?.permission_key || ""),
          resource: String(r?.resource || ""),
          allowed_fields: Array.isArray(r?.allowed_fields) ? r.allowed_fields.map((f: any) => String(f)) : null,
          denied_fields: Array.isArray(r?.denied_fields) ? r.denied_fields.map((f: any) => String(f)) : null,
        }))
      : []

  return {
    accessToken,
    authUser: { id: user.id, email: user.email ?? null },
    isSuperAdmin: superAdmin,
    permissionKeys,
    fieldRules,
    refreshedSession,
  }
}

export function hasPermission(ctx: InternalAuthContext, permissionKey: string) {
  if (ctx.isSuperAdmin) return true
  return ctx.permissionKeys.has(permissionKey)
}

export function getFieldRule(ctx: InternalAuthContext, permissionKey: string, resource: string) {
  return ctx.fieldRules.find(r => r.permission_key === permissionKey && r.resource === resource) || null
}

export function filterRecordByRule<T extends Record<string, any>>(record: T, rule: { allowed_fields: string[] | null; denied_fields: string[] | null } | null) {
  if (!rule) return record
  const allowed = Array.isArray(rule.allowed_fields) ? new Set(rule.allowed_fields) : null
  const denied = Array.isArray(rule.denied_fields) ? new Set(rule.denied_fields) : null

  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(record)) {
    if (allowed && !allowed.has(key)) continue
    if (denied && denied.has(key)) continue
    out[key] = value
  }
  return out as T
}
