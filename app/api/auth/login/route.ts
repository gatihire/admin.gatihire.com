import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 })
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const trySignIn = async () =>
      authClient.auth.signInWithPassword({
        email,
        password,
      })

    let { data, error } = await trySignIn()
    let loginMethod = "password"

    if (error || !data?.session || !data?.user) {
      const { data: legacyUsers } = await supabaseAdmin.rpc("verify_hr_credentials", {
        email_input: email,
        password_input: password,
      })

      const legacyUser = Array.isArray(legacyUsers) && legacyUsers.length > 0 ? legacyUsers[0] : null
      if (!legacyUser) {
        return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
      }
      loginMethod = "legacy_password"

      const userMetadata = typeof legacyUser?.name === "string" && legacyUser.name.trim() ? { name: legacyUser.name.trim() } : undefined

      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: userMetadata,
      })

      if (createErr && !String((createErr as any)?.message || "").toLowerCase().includes("already")) {
        return NextResponse.json({ error: "Authentication failed" }, { status: 500 })
      }

      if (!created?.user?.id && createErr) {
        const { data: listed } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
        const existing = listed?.users?.find(u => (u.email || "").toLowerCase() === String(email).toLowerCase())
        if (existing?.id) {
          await supabaseAdmin.auth.admin.updateUserById(existing.id, {
            password,
            user_metadata: userMetadata,
          })
        }
      }

      ;({ data, error } = await trySignIn())
      if (error || !data?.session || !data?.user) {
        return NextResponse.json({ error: "Authentication failed" }, { status: 500 })
      }
    }

    const session = data.session
    const user = data.user

    const authedClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${session.access_token}` } },
    })
    const [{ data: permRows }, { data: existingInternal }] = await Promise.all([
      authedClient.rpc("current_user_permission_keys"),
      supabaseAdmin.from("internal_users").select("auth_user_id").eq("auth_user_id", user.id).maybeSingle(),
    ])

    const hasAnyPermission = Array.isArray(permRows) && permRows.length > 0
    const isMarkedInternal = Boolean((user.user_metadata as any)?.is_internal)
    const shouldTrackInternal = hasAnyPermission || isMarkedInternal || Boolean((existingInternal as any)?.auth_user_id)

    if (shouldTrackInternal) {
      await supabaseAdmin
        .from("internal_users")
        .upsert(
          {
            auth_user_id: user.id,
            email: user.email,
            name:
              typeof (user.user_metadata as any)?.name === "string"
                ? (user.user_metadata as any).name
                : null,
            last_active_at: new Date().toISOString(),
          },
          { onConflict: "auth_user_id" }
        )
    }

    supabaseAdmin
      .from("analytics_events")
      .insert({
        actor_auth_user_id: user.id,
        event_name: "login_succeeded",
        entity_type: "internal_users",
        entity_id: user.id,
        metadata: { method: loginMethod },
      })
      .then(() => {})

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: (user.user_metadata as any)?.name ?? null,
      },
    })

    if (user.email) {
      const { data: existingHrUser } = await supabaseAdmin
        .from("hr_users")
        .select("id,email,name")
        .eq("email", user.email)
        .maybeSingle()

      let hrUser = existingHrUser
      if (!hrUser) {
        const { data: createdHrUser } = await supabaseAdmin
          .from("hr_users")
          .insert({
            email: user.email,
            name: (user.user_metadata as any)?.name ?? null,
            password_hash: `internal:${user.id}`,
          })
          .select("id,email,name")
          .single()
        hrUser = createdHrUser
      }

      if (hrUser?.id) {
        response.cookies.set(
          "hr_user",
          JSON.stringify({ id: hrUser.id, email: hrUser.email, name: hrUser.name ?? null }),
          {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            path: "/",
            maxAge: 60 * 60 * 24 * 30,
          },
        )
      }
    }

    response.cookies.set("sb-access-token", session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: session.expires_in,
    })

    response.cookies.set("sb-refresh-token", session.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    })

    return response
  } catch (error) {
    console.error("Login exception:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
