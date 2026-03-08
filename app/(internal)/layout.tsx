import { cookies } from "next/headers"
import { InternalShell } from "@/components/internal-shell"
import { createClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"

export default async function InternalLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies()
  const accessToken = cookieStore.get("sb-access-token")?.value
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  let permissionKeys: string[] = []
  let isSuperAdmin = false
  if (accessToken && supabaseUrl && supabaseAnonKey) {
    const authedClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })
    const [{ data }, { data: isSuperAdminData }] = await Promise.all([
      authedClient.rpc("current_user_permission_keys"),
      authedClient.rpc("is_super_admin"),
    ])

    isSuperAdmin = Boolean(isSuperAdminData)
    if (isSuperAdmin) {
      const { data: all } = await supabaseAdmin.from("permissions").select("key").order("key", { ascending: true })
      permissionKeys = (all ?? []).map((p: any) => String(p?.key || "").trim()).filter(Boolean)
    } else {
      permissionKeys = Array.isArray(data)
        ? data.map((p: any) => String(p?.permission_key || "").trim()).filter(Boolean)
        : []
    }
  }

  const isHrUser = isSuperAdmin || permissionKeys.includes("analytics.view")
  return (
    <InternalShell isHrUser={isHrUser} permissionKeys={permissionKeys} isSuperAdmin={isSuperAdmin}>
      {children}
    </InternalShell>
  )
}
