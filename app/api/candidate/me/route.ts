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

async function isInternalUser(user: any) {
  const authUserId = String(user.id)
  const email = String(user.email || "").trim().toLowerCase()
  let query = supabaseAdmin.from("internal_users").select("auth_user_id").eq("auth_user_id", authUserId)
  if (email) {
    query = query.or(`auth_user_id.eq.${authUserId},email.eq.${email}`)
  }
  const { data } = await query.maybeSingle()
  return Boolean(data)
}

async function ensureCandidateForUser(user: any) {
  const authUserId = String(user.id)
  const email = String(user.email || "").trim().toLowerCase()
  const fullName = String(user.user_metadata?.full_name || user.user_metadata?.name || "").trim()

  const byAuth = await supabaseAdmin
    .from("candidates")
    .select("id,name,email,phone,desired_role,preferred_location,open_job_types,preferred_roles,file_url,file_name,updated_at")
    .eq("auth_user_id", authUserId)
    .maybeSingle()
  if (byAuth.data) return byAuth.data

  if (email) {
    const byEmail = await supabaseAdmin
      .from("candidates")
      .select("id,name,email,phone,desired_role,preferred_location,open_job_types,preferred_roles,file_url,file_name,updated_at,auth_user_id")
      .eq("email", email)
      .maybeSingle()
    if (byEmail.data) {
      if (!byEmail.data.auth_user_id) {
        await supabaseAdmin.from("candidates").update({ auth_user_id: authUserId }).eq("id", byEmail.data.id)
      }
      const { auth_user_id: _omit, ...rest } = byEmail.data as any
      return rest
    }
  }

  const insertPayload: any = {
    name: fullName || (email ? email.split("@")[0] : "Candidate"),
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
  }

  const created = await supabaseAdmin
    .from("candidates")
    .insert(insertPayload)
    .select("id,name,email,phone,desired_role,preferred_location,open_job_types,preferred_roles,file_url,file_name,updated_at")
    .single()

  if (created.error) throw created.error
  return created.data
}

export async function GET(request: NextRequest) {
  try {
    const { user } = await getAuthUserFromRequest(request)
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (await isInternalUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const candidate = await ensureCandidateForUser(user)
    return NextResponse.json(candidate)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal Server Error" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { user } = await getAuthUserFromRequest(request)
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (await isInternalUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const candidate = await ensureCandidateForUser(user)
    const body = await request.json().catch(() => ({}))

    const patch: any = { updated_at: new Date().toISOString() }
    if (typeof body.name === "string") patch.name = body.name.trim()
    if (typeof body.phone === "string") patch.phone = body.phone.trim() || null
    if (typeof body.desired_role === "string") patch.desired_role = body.desired_role.trim() || null
    if (typeof body.preferred_location === "string") patch.preferred_location = body.preferred_location.trim() || null
    if (Array.isArray(body.open_job_types)) patch.open_job_types = body.open_job_types.map((v: any) => String(v))
    if (Array.isArray(body.preferred_roles)) patch.preferred_roles = body.preferred_roles.map((v: any) => String(v))

    const updated = await supabaseAdmin
      .from("candidates")
      .update(patch)
      .eq("id", candidate.id)
      .select("id,name,email,phone,desired_role,preferred_location,open_job_types,preferred_roles,file_url,file_name,updated_at")
      .single()
    if (updated.error) throw updated.error

    supabaseAdmin
      .from("analytics_events")
      .insert({
        actor_auth_user_id: String(user.id),
        event_name: "board.profile.updated",
        entity_type: "candidates",
        entity_id: candidate.id,
        metadata: { candidate_id: candidate.id },
      })
      .then(() => {})
    return NextResponse.json(updated.data)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal Server Error" }, { status: 500 })
  }
}
