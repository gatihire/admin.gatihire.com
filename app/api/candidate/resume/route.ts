import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin, ensureResumeBucketExists } from "@/lib/supabase"
import { parseResume } from "@/lib/resume-parser"
import { generateEmbedding } from "@/lib/ai-utils"
import { uploadFileToSupabase } from "@/lib/supabase-storage-utils"

export const runtime = "nodejs"

async function getAuthUserFromRequest(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null
  if (!token) return { token: null, user: null }
  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !data?.user) return { token, user: null }
  return { token, user: data.user }
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

  const created = await supabaseAdmin
    .from("candidates")
    .insert({
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
    })
    .select("id,name,email,phone,desired_role,preferred_location,open_job_types,preferred_roles,file_url,file_name,updated_at")
    .single()
  if (created.error) throw created.error
  return created.data
}

function safeFileName(input: string) {
  return String(input || "resume")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 140)
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await getAuthUserFromRequest(request)
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const candidate = await ensureCandidateForUser(user)
    const formData = await request.formData()
    const rawFile = formData.get("resume") as File
    if (!rawFile) return NextResponse.json({ error: "Resume is required" }, { status: 400 })

    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "text/plain",
    ]
    if (!allowed.includes(rawFile.type)) {
      const lower = rawFile.name.toLowerCase()
      const okByExt = lower.endsWith(".doc") || lower.endsWith(".docx")
      if (!okByExt) return NextResponse.json({ error: "Unsupported file type" }, { status: 400 })
    }
    if (rawFile.size > 10 * 1024 * 1024) return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 })

    await ensureResumeBucketExists()

    const parsed = await parseResume(rawFile)
    const resumeText = String((parsed as any)?.resumeText || "").trim()
    let embedding: number[] | null = null
    if (resumeText) {
      try {
        const v = await generateEmbedding(resumeText)
        if (Array.isArray(v) && v.length) embedding = v
      } catch {
        embedding = null
      }
    }

    const path = `${String(user.id)}/${Date.now()}_${safeFileName(rawFile.name)}`
    const uploaded = await uploadFileToSupabase(rawFile, path, { bucketName: "resume-files" })

    const patch: any = {
      updated_at: new Date().toISOString(),
      file_url: uploaded.url,
      file_name: rawFile.name,
      file_size: rawFile.size,
      file_type: rawFile.type,
      resume_text: resumeText || null,
      parsing_method: (parsed as any)?.parsing_method || "gemini",
      parsing_confidence: (parsed as any)?.parsing_confidence ?? null,
      parsing_errors: (parsed as any)?.parsing_errors || null,
      auth_user_id: String(user.id),
    }

    if (typeof (parsed as any)?.name === "string" && String((parsed as any).name).trim()) patch.name = String((parsed as any).name).trim()
    if (typeof (parsed as any)?.email === "string" && String((parsed as any).email).trim()) patch.email = String((parsed as any).email).trim().toLowerCase()
    if (typeof (parsed as any)?.phone === "string" && String((parsed as any).phone).trim()) patch.phone = String((parsed as any).phone).trim()
    if (typeof (parsed as any)?.currentRole === "string" && String((parsed as any).currentRole).trim()) patch.current_role = String((parsed as any).currentRole).trim()
    if (typeof (parsed as any)?.location === "string" && String((parsed as any).location).trim()) patch.location = String((parsed as any).location).trim()
    if (typeof (parsed as any)?.totalExperience === "string" && String((parsed as any).totalExperience).trim()) patch.total_experience = String((parsed as any).totalExperience).trim()
    if (typeof (parsed as any)?.desiredRole === "string" && String((parsed as any).desiredRole).trim()) patch.desired_role = String((parsed as any).desiredRole).trim()
    if (embedding) patch.embedding = embedding

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
        event_name: "board.resume.uploaded",
        entity_type: "candidates",
        entity_id: candidate.id,
        metadata: { candidate_id: candidate.id, file_type: rawFile.type, file_size: rawFile.size },
      })
      .then(() => {})
    return NextResponse.json({ candidate: updated.data })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal Server Error" }, { status: 500 })
  }
}
