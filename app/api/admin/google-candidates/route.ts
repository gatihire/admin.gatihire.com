import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const { data: candidates, error } = await supabaseAdmin
      .from("candidates")
      .select("*")
      .not("auth_user_id", "is", null)
      .order("uploaded_at", { ascending: false })

    if (error) throw error

    return NextResponse.json(candidates.map(SupabaseCandidateService.mapRowToCandidate))
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const { id } = await request.json()
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 })

    await SupabaseCandidateService.deleteCandidate(id)
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
