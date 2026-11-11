import { NextRequest, NextResponse } from "next/server"
import {
  authContextErrorResponse,
  getInternalAuthContext,
  isAuthUnavailableError,
} from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(request: NextRequest) {
  let ctx
  try {
    ctx = await getInternalAuthContext(request)
  } catch (error) {
    console.error("super-admin/me auth failed:", error)
    const { status, body } = authContextErrorResponse(error)
    return NextResponse.json(body, { status })
  }

  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Profile/touch are best-effort: an outage must not sign the user out.
  let profile: any = null
  try {
    const { data } = await supabaseAdmin
      .from("internal_users")
      .select("*")
      .eq("auth_user_id", ctx.authUser.id)
      .maybeSingle()
    profile = data ?? null

    await supabaseAdmin
      .from("internal_users")
      .update({ last_active_at: new Date().toISOString() })
      .eq("auth_user_id", ctx.authUser.id)
  } catch (error) {
    if (isAuthUnavailableError(error)) {
      console.warn("super-admin/me profile lookup unavailable, returning session only")
    } else {
      console.warn("super-admin/me profile lookup failed:", error)
    }
  }

  const response = NextResponse.json({
    user: ctx.authUser,
    profile,
    permissions: Array.from(ctx.permissionKeys).sort(),
    fieldRules: ctx.fieldRules,
  })

  if (ctx.refreshedSession) {
    response.cookies.set("sb-access-token", ctx.refreshedSession.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: ctx.refreshedSession.expires_in,
    })
    response.cookies.set("sb-refresh-token", ctx.refreshedSession.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    })
  }

  return response
}
