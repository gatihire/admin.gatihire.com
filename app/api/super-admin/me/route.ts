import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: profile } = await supabaseAdmin
    .from("internal_users")
    .select("*")
    .eq("auth_user_id", ctx.authUser.id)
    .maybeSingle()

  await supabaseAdmin
    .from("internal_users")
    .update({ last_active_at: new Date().toISOString() })
    .eq("auth_user_id", ctx.authUser.id)

  const response = NextResponse.json({
    user: ctx.authUser,
    profile: profile ?? null,
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
