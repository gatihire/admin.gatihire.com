import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; profileId: string }> }) {
  const ctx = await getInternalAuthContext(_request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId, profileId } = await params

  const { data: profile, error } = await supabaseAdmin
    .from("juicebox_profiles")
    .select("*")
    .eq("id", profileId)
    .eq("job_id", jobId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 })

  const [experience, education, contacts] = await Promise.all([
    supabaseAdmin.from("juicebox_experience").select("*").eq("profile_id", profileId).order("sort_order", { ascending: true }),
    supabaseAdmin.from("juicebox_education").select("*").eq("profile_id", profileId).order("sort_order", { ascending: true }),
    supabaseAdmin.from("juicebox_contacts").select("*").eq("profile_id", profileId),
  ])

  return NextResponse.json({
    profile,
    experience: experience.data || [],
    education: education.data || [],
    contacts: contacts.data || [],
  })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; profileId: string }> }) {
  const ctx = await getInternalAuthContext(_request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId, profileId } = await params

  const { error } = await supabaseAdmin
    .from("juicebox_profiles")
    .delete()
    .eq("id", profileId)
    .eq("job_id", jobId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
