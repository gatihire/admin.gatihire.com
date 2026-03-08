import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const runtime = "nodejs"

async function getAuthUserFromRequest(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null
  if (!token) return { token: null, user: null }
  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !data?.user) return { token, user: null }
  return { token, user: data.user }
}

async function ensureCandidate(user: any) {
  const authUserId = String(user.id)
  const email = String(user.email || "").trim().toLowerCase()

  const byAuth = await supabaseAdmin.from("candidates").select("id").eq("auth_user_id", authUserId).maybeSingle()
  if (byAuth.data?.id) return String(byAuth.data.id)

  if (email) {
    const byEmail = await supabaseAdmin.from("candidates").select("id,auth_user_id").eq("email", email).maybeSingle()
    if (byEmail.data?.id) {
      if (!byEmail.data.auth_user_id) {
        await supabaseAdmin.from("candidates").update({ auth_user_id: authUserId }).eq("id", byEmail.data.id)
      }
      return String(byEmail.data.id)
    }
  }

  const name = String(user.user_metadata?.full_name || user.user_metadata?.name || (email ? email.split("@")[0] : "Candidate")).trim()
  const created = await supabaseAdmin
    .from("candidates")
    .insert({
      name: name || "Candidate",
      email: email || `${crypto.randomUUID()}@unknown.invalid`,
      phone: null,
      current_role: "Not specified",
      desired_role: null,
      current_company: null,
      location: "India",
      preferred_location: "Anywhere in India",
      total_experience: "Not specified",
      status: "new",
      tags: [],
      uploaded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      auth_user_id: authUserId,
      public_profile_enabled: false,
      looking_for_work: true,
    })
    .select("id")
    .single()
  if (created.error) throw created.error
  return String(created.data.id)
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await getAuthUserFromRequest(request)
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const jobId = String(body.jobId || "").trim()
    const redirectUrl = String(body.redirectUrl || "").trim()
    const referrer = typeof body.referrer === "string" ? body.referrer : null

    if (!jobId || !redirectUrl) return NextResponse.json({ error: "jobId and redirectUrl are required" }, { status: 400 })

    const candidateId = await ensureCandidate(user)

    const { error } = await supabaseAdmin.from("external_apply_events").insert({
      auth_user_id: String(user.id),
      candidate_id: candidateId,
      job_id: jobId,
      redirect_url: redirectUrl,
      user_agent: request.headers.get("user-agent"),
      referrer,
      created_at: new Date().toISOString(),
    })

    if (error) throw error

    supabaseAdmin
      .from("analytics_events")
      .insert({
        actor_auth_user_id: String(user.id),
        event_name: "board.external_apply.submitted",
        entity_type: "jobs",
        entity_id: jobId,
        metadata: { job_id: jobId, candidate_id: candidateId, redirect_url: redirectUrl },
      })
      .then(() => {})
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal Server Error" }, { status: 500 })
  }
}
