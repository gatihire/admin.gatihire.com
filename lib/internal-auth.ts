import { createClient } from "@supabase/supabase-js"
import type { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  SupabaseUnavailableError,
  isUnavailableError,
  supabaseFetch,
  throwIfUnavailable,
  withTimeout,
} from "@/lib/fetch-with-timeout"
import { CacheNamespace, CacheTtl, cacheDeleteNamespace, cached } from "@/lib/cache"

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

const AUTH_TIMEOUT_MS = 8000

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
    global: { headers: { Authorization: `Bearer ${accessToken}` }, fetch: supabaseFetch },
  })
}

type GetUserResult = { data: any; error: any; unavailable: boolean }

async function getUserWithTimeout(accessToken: string, timeoutMs = AUTH_TIMEOUT_MS): Promise<GetUserResult> {
  try {
    const result = await withTimeout(
      supabaseAdmin.auth.getUser(accessToken),
      timeoutMs,
      "supabase.auth.getUser",
    )
    return {
      data: result?.data ?? null,
      error: result?.error ?? null,
      unavailable: isUnavailableError(result?.error),
    }
  } catch (error) {
    return { data: null, error, unavailable: isUnavailableError(error) }
  }
}

/**
 * Resolve the caller's identity and permissions.
 *
 * Returns `null` only when the credentials are genuinely invalid. If Supabase is
 * unreachable or slow, throws `SupabaseUnavailableError` so routes can answer
 * 503 and the client keeps its session instead of being logged out.
 */
export async function getInternalAuthContext(request: NextRequest): Promise<InternalAuthContext | null> {
  const initialAccessToken = getAccessTokenFromRequest(request)
  if (!initialAccessToken) return null
  let accessToken: string = initialAccessToken

  let refreshedSession: { access_token: string; refresh_token: string; expires_in: number } | undefined

  let authResult = await getUserWithTimeout(accessToken)
  let user = authResult.data?.user
  let unavailable = authResult.unavailable

  if (!user) {
    const refreshToken = getRefreshTokenFromRequest(request)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (refreshToken && supabaseUrl && supabaseAnonKey) {
      try {
        const refreshClient = createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { fetch: supabaseFetch },
        })
        const refreshed = await withTimeout(
          refreshClient.auth.refreshSession({ refresh_token: refreshToken }),
          AUTH_TIMEOUT_MS,
          "supabase.auth.refreshSession",
        )
        const session = (refreshed as any)?.data?.session
        const refreshError = (refreshed as any)?.error
        if (refreshError && isUnavailableError(refreshError)) unavailable = true
        if (session?.access_token && session?.refresh_token) {
          refreshedSession = {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: session.expires_in || 3600,
          }
          accessToken = session.access_token
          authResult = await getUserWithTimeout(accessToken)
          user = authResult.data?.user
          unavailable = unavailable || authResult.unavailable
        }
      } catch (error) {
        if (isUnavailableError(error)) unavailable = true
        // Otherwise the refresh token itself is invalid: fall through to null.
      }
    }
  }

  if (!user) {
    if (unavailable) {
      throw new SupabaseUnavailableError("Unable to verify session: Supabase is unreachable")
    }
    return null
  }

  const authedClient = createAuthedClient(accessToken)
  if (!authedClient) {
    throw new SupabaseUnavailableError("Supabase client is not configured")
  }

  const bundle = await loadPermissionBundle(user.id, authedClient)

  return {
    accessToken,
    authUser: { id: user.id, email: user.email ?? null },
    isSuperAdmin: bundle.isSuperAdmin,
    permissionKeys: new Set(bundle.permissionKeys),
    fieldRules: bundle.fieldRules,
    refreshedSession,
  }
}

type PermissionBundle = {
  isSuperAdmin: boolean
  permissionKeys: string[]
  fieldRules: FieldRule[]
}

/**
 * Resolve permissions for a user.
 *
 * Every API request used to run 5 permission queries (3 RPCs + 2 table reads)
 * *after* the token check. With the dashboard polling and several pages open
 * that dominated query volume while adding nothing — permissions change maybe
 * once a week. Cached for 60s per user, which is short enough that a revoked
 * permission takes effect quickly, and invalidated explicitly on writes.
 */
async function loadPermissionBundle(userId: string, authedClient: any): Promise<PermissionBundle> {
  return cached(CacheNamespace.permissions, userId, CacheTtl.permissions, async () => {
    const [permsResult, rulesResult, superAdminResult] = await Promise.all([
      withTimeout(authedClient.rpc("current_user_permission_keys"), AUTH_TIMEOUT_MS, "current_user_permission_keys"),
      withTimeout(authedClient.rpc("current_user_field_rules"), AUTH_TIMEOUT_MS, "current_user_field_rules"),
      withTimeout(authedClient.rpc("is_super_admin"), AUTH_TIMEOUT_MS, "is_super_admin"),
    ]).catch((error) => {
      throw new SupabaseUnavailableError(
        `Unable to load permissions: ${error instanceof Error ? error.message : "unknown error"}`,
      )
    })

    const perms = (permsResult as any)?.data
    const rules = (rulesResult as any)?.data
    const isSuperAdmin = (superAdminResult as any)?.data

    throwIfUnavailable(permsResult as any, "current_user_permission_keys")
    throwIfUnavailable(rulesResult as any, "current_user_field_rules")
    throwIfUnavailable(superAdminResult as any, "is_super_admin")

    const superAdmin = Boolean(isSuperAdmin)

    const rolePermissionKeys = Array.isArray(perms)
      ? perms
          .map((p: any) => String(p?.permission_key || "").trim())
          .filter(Boolean)
      : []

    let overridePermissionKeys: string[] = []
    if (!superAdmin) {
      const userPermsResult = await supabaseAdmin
        .from("user_permissions")
        .select("permissions(key)")
        .eq("auth_user_id", userId)
      throwIfUnavailable(userPermsResult, "user_permissions")
      overridePermissionKeys =
        (userPermsResult.data ?? [])
          .map((p: any) => String(p?.permissions?.key || "").trim())
          .filter(Boolean) ?? []
    }

    let permissionKeys: string[]
    if (superAdmin) {
      const allPermissions = await supabaseAdmin
        .from("permissions")
        .select("key")
        .order("key", { ascending: true })
      throwIfUnavailable(allPermissions, "permissions")
      permissionKeys = (allPermissions.data ?? [])
        .map((p: any) => String(p?.key || "").trim())
        .filter(Boolean)
    } else {
      permissionKeys = [...rolePermissionKeys, ...overridePermissionKeys]
    }

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

    return { isSuperAdmin: superAdmin, permissionKeys, fieldRules }
  })
}

/**
 * Drop every cached permission bundle.
 *
 * Call after changing roles, role permissions, user overrides or user status.
 * A namespace wipe is intentional: role changes affect many users and the
 * admin user base is small, so repopulating cheaply beats tracking per-user
 * dependency graphs.
 */
export async function invalidatePermissionCache() {
  await cacheDeleteNamespace(CacheNamespace.permissions)
}

/**
 * Build the correct response when auth lookup fails: 503 for infra outages
 * (keeps the user signed in), 401 only for genuinely invalid credentials.
 */
export function authContextErrorResponse(error: unknown) {
  if (error instanceof SupabaseUnavailableError || isUnavailableError(error)) {
    return {
      status: 503 as const,
      body: {
        error: "Service temporarily unavailable. Please retry in a moment.",
        code: "SERVICE_UNAVAILABLE",
      },
    }
  }
  return { status: 401 as const, body: { error: "Unauthorized" } }
}

export function isAuthUnavailableError(error: unknown) {
  return error instanceof SupabaseUnavailableError || isUnavailableError(error)
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
