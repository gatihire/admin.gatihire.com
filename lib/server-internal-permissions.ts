import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { createClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { supabaseFetch, withTimeout } from "@/lib/fetch-with-timeout"

const permissionCache = new Map<string, { data: any; expiry: number }>()
const CACHE_TTL = 30000 // 30 seconds
const LOOKUP_TIMEOUT_MS = 8000

async function getUserIdFromAccessToken(accessToken: string) {
  const { data, error } = await withTimeout(
    supabaseAdmin.auth.getUser(accessToken),
    LOOKUP_TIMEOUT_MS,
    "supabase.auth.getUser",
  )
  if (error || !data?.user?.id) return null
  return data.user.id
}

export async function getServerInternalPermissions() {
  const cookieStore = await cookies()
  const accessToken = cookieStore.get("sb-access-token")?.value
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!accessToken || !supabaseUrl || !supabaseAnonKey) {
    return { isSuperAdmin: false, permissionKeys: new Set<string>() }
  }

  // Check cache first
  const cacheKey = accessToken.slice(-32)
  const cached = permissionCache.get(cacheKey)
  if (cached && cached.expiry > Date.now()) {
    return cached.data
  }

  const authedClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` }, fetch: supabaseFetch },
  })

  try {
    const [{ data: perms }, { data: isSuperAdminData }] = await Promise.all([
      withTimeout(authedClient.rpc("current_user_permission_keys"), LOOKUP_TIMEOUT_MS, "current_user_permission_keys"),
      withTimeout(authedClient.rpc("is_super_admin"), LOOKUP_TIMEOUT_MS, "is_super_admin"),
    ])

    const isSuperAdmin = Boolean(isSuperAdminData)
    if (isSuperAdmin) {
      const { data: all } = await withTimeout(
        supabaseAdmin.from("permissions").select("key").order("key", { ascending: true }),
        LOOKUP_TIMEOUT_MS,
        "permissions",
      )
      const keys = (all ?? []).map((p: any) => String(p?.key || "").trim()).filter(Boolean)
      const result = { isSuperAdmin: true, permissionKeys: new Set(keys) }
      permissionCache.set(cacheKey, { data: result, expiry: Date.now() + CACHE_TTL })
      return result
    }

    const roleKeys = Array.isArray(perms)
      ? perms.map((p: any) => String(p?.permission_key || "").trim()).filter(Boolean)
      : []

    const userId = await getUserIdFromAccessToken(accessToken)
    const { data: userPerms } = userId
      ? await withTimeout(
          supabaseAdmin.from("user_permissions").select("permissions(key)").eq("auth_user_id", userId),
          LOOKUP_TIMEOUT_MS,
          "user_permissions",
        )
      : { data: [] as any[] }
    const overrideKeys =
      (userPerms ?? [])
        .map((p: any) => String(p?.permissions?.key || "").trim())
        .filter(Boolean) ?? []

    const result = { isSuperAdmin: false, permissionKeys: new Set([...roleKeys, ...overrideKeys]) }
    permissionCache.set(cacheKey, { data: result, expiry: Date.now() + CACHE_TTL })
    return result
  } catch (error) {
    // If RPC fails, return cached or empty to avoid blocking
    if (cached) {
      return cached.data
    }
    return { isSuperAdmin: false, permissionKeys: new Set<string>() }
  }
}

export async function requireSuperAdmin() {
  const { isSuperAdmin } = await getServerInternalPermissions()
  if (!isSuperAdmin) redirect("/dashboard")
}

export async function requireAnyInternalPermission(permissionKeys: string[]) {
  const { isSuperAdmin, permissionKeys: keys } = await getServerInternalPermissions()
  if (isSuperAdmin) return
  if (permissionKeys.length === 0) return // Allow access if no specific permissions required
  if (permissionKeys.some((k) => keys.has(k))) return
  redirect("/dashboard")
}
