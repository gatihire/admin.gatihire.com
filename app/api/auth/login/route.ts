import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { isUnavailableError, supabaseFetch, withTimeout } from "@/lib/fetch-with-timeout"

export const runtime = "nodejs"

const LOGIN_TIMEOUT_MS = 12000

function serviceUnavailable(message = "Sign-in is temporarily unavailable because the database is not responding. Please try again in a minute.") {
  return NextResponse.json({ error: message, code: "SERVICE_UNAVAILABLE" }, { status: 503 })
}

function isRateLimited(error: any) {
  return Number(error?.status) === 429 || /rate limit|too many requests/i.test(String(error?.message || ""))
}

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
      global: { fetch: supabaseFetch },
    })

    const trySignIn = () =>
      withTimeout(authClient.auth.signInWithPassword({ email, password }), LOGIN_TIMEOUT_MS, "signInWithPassword")

    let signInResult: any
    try {
      signInResult = await trySignIn()
    } catch (error) {
      if (isUnavailableError(error)) return serviceUnavailable()
      throw error
    }

    let { data, error } = signInResult
    let loginMethod = "password"

    if (isUnavailableError(error)) return serviceUnavailable()
    if (isRateLimited(error)) {
      return NextResponse.json(
        { error: "Too many sign-in attempts. Please wait a moment and try again.", code: "RATE_LIMITED" },
        { status: 429 },
      )
    }

    if (error || !data?.session || !data?.user) {
      let legacyUsers: any[] | null = null
      try {
        const legacyResult = await withTimeout(
          supabaseAdmin.rpc("verify_hr_credentials", {
            email_input: email,
            password_input: password,
          }),
          LOGIN_TIMEOUT_MS,
          "verify_hr_credentials",
        )
        if (isUnavailableError((legacyResult as any)?.error)) return serviceUnavailable()
        legacyUsers = (legacyResult as any)?.data ?? null
      } catch (legacyError) {
        if (isUnavailableError(legacyError)) return serviceUnavailable()
        // Fall through: legacy lookup failing for a non-infra reason means the
        // credentials are simply not valid.
      }

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

      if (isUnavailableError(createErr)) return serviceUnavailable()

      if (createErr && !String((createErr as any)?.message || "").toLowerCase().includes("already")) {
        return NextResponse.json({ error: "Authentication failed" }, { status: 500 })
      }

      if (!created?.user?.id && createErr) {
        const { data: listed, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
        if (isUnavailableError(listErr)) return serviceUnavailable()
        const existing = listed?.users?.find(u => (u.email || "").toLowerCase() === String(email).toLowerCase())
        if (existing?.id) {
          const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
            password,
            user_metadata: userMetadata,
          })
          if (isUnavailableError(updateErr)) return serviceUnavailable()
        }
      }

      try {
        ;({ data, error } = await trySignIn())
      } catch (retryError) {
        if (isUnavailableError(retryError)) return serviceUnavailable()
        throw retryError
      }
      if (isUnavailableError(error)) return serviceUnavailable()
      if (error || !data?.session || !data?.user) {
        return NextResponse.json({ error: "Authentication failed" }, { status: 500 })
      }
    }

    const session = data.session
    const user = data.user

    // Everything below is best-effort. The user is authenticated at this point,
    // so a flaky permission/metadata query must never turn into a failed login.
    let hasAnyPermission = false
    let isMarkedInternal = false
    let existingInternal: any = null
    try {
      const authedClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${session.access_token}` }, fetch: supabaseFetch },
      })
      const [permResult, internalResult] = await Promise.all([
        withTimeout(authedClient.rpc("current_user_permission_keys"), LOGIN_TIMEOUT_MS, "current_user_permission_keys"),
        withTimeout(
          supabaseAdmin.from("internal_users").select("auth_user_id").eq("auth_user_id", user.id).maybeSingle(),
          LOGIN_TIMEOUT_MS,
          "internal_users lookup",
        ),
      ])
      const permRows = (permResult as any)?.data
      existingInternal = (internalResult as any)?.data ?? null
      hasAnyPermission = Array.isArray(permRows) && permRows.length > 0
      isMarkedInternal = Boolean((user.user_metadata as any)?.is_internal)
    } catch (enrichError) {
      console.warn("Login enrichment failed (continuing with session):", enrichError)
    }

    const shouldTrackInternal = hasAnyPermission || isMarkedInternal || Boolean((existingInternal as any)?.auth_user_id)

    if (shouldTrackInternal) {
      try {
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
            { onConflict: "auth_user_id" },
          )
      } catch (upsertError) {
        console.warn("internal_users upsert failed (continuing):", upsertError)
      }
    }

    Promise.resolve(
      supabaseAdmin
        .from("analytics_events")
        .insert({
          actor_auth_user_id: user.id,
          event_name: "login_succeeded",
          entity_type: "internal_users",
          entity_id: user.id,
          metadata: { method: loginMethod },
        }),
    ).catch(() => {})

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: (user.user_metadata as any)?.name ?? null,
      },
    })

    if (user.email) {
      try {
        const { data: existingHrUser } = await withTimeout(
          supabaseAdmin.from("hr_users").select("id,email,name").eq("email", user.email).maybeSingle(),
          LOGIN_TIMEOUT_MS,
          "hr_users lookup",
        )

        let hrUser = existingHrUser
        if (!hrUser) {
          const { data: createdHrUser } = await withTimeout(
            supabaseAdmin
              .from("hr_users")
              .insert({
                email: user.email,
                name: (user.user_metadata as any)?.name ?? null,
                password_hash: `internal:${user.id}`,
              })
              .select("id,email,name")
              .single(),
            LOGIN_TIMEOUT_MS,
            "hr_users insert",
          )
          hrUser = createdHrUser
        }

        if (hrUser?.id) {
          response.cookies.set(
            "hr_user",
            JSON.stringify({ id: (hrUser as any).id, email: (hrUser as any).email, name: (hrUser as any).name ?? null }),
            {
              httpOnly: true,
              secure: process.env.NODE_ENV === "production",
              sameSite: "strict",
              path: "/",
              maxAge: 60 * 60 * 24 * 30,
            },
          )
        }
      } catch (hrUserError) {
        console.warn("hr_users sync failed (continuing):", hrUserError)
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
    if (isUnavailableError(error)) return serviceUnavailable()
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
