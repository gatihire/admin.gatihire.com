import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { renderJuiceboxResume } from "@/lib/juicebox-resume"

export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId } = await params
  const body: { profileId?: string } = await request.json().catch(() => ({}))
  if (!body.profileId) return NextResponse.json({ error: "profileId is required" }, { status: 400 })

  const { data: profile, error } = await supabaseAdmin
    .from("juicebox_profiles")
    .select("*")
    .eq("id", body.profileId)
    .eq("job_id", jobId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 })

  const [experience, education, contacts] = await Promise.all([
    supabaseAdmin.from("juicebox_experience").select("*").eq("profile_id", profile.id).order("sort_order", { ascending: true }),
    supabaseAdmin.from("juicebox_education").select("*").eq("profile_id", profile.id).order("sort_order", { ascending: true }),
    supabaseAdmin.from("juicebox_contacts").select("*").eq("profile_id", profile.id),
  ])

  const html = renderJuiceboxResume({
    profile,
    experience: experience.data || [],
    education: education.data || [],
    contacts: contacts.data || [],
  })

  const fileName = (profile.full_name || "candidate").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-resume.html"

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  })
}
