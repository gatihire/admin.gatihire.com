import { type NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"
import crypto from "crypto"
import { parseResume } from "@/lib/resume-parser"
import { generateEmbedding } from "@/lib/ai-utils"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { ensureResumeBucketExists, supabaseAdmin } from "@/lib/supabase"
import { checkFileExistsInSupabase } from "@/lib/supabase-storage-utils"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { deriveOrigin } from "@/lib/origin"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: jobId } = await params

  const { data: job } = await supabaseAdmin.from("jobs").select("id,title,client_name").eq("id", jobId).single()

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })

  let uploadedBy: string | undefined
  const hrUserCookie = request.cookies.get("hr_user")?.value
  if (hrUserCookie) {
    try {
      const parsed = JSON.parse(hrUserCookie)
      const parsedId = String(parsed?.id || "").trim()
      if (parsedId) uploadedBy = parsedId
    } catch {
      /* noop */
    }
  }

  if (!uploadedBy && ctx.authUser.email) {
    const { data: hrUserRow } = await supabaseAdmin
      .from("hr_users")
      .select("id")
      .eq("email", ctx.authUser.email)
      .maybeSingle()
    if (hrUserRow?.id) uploadedBy = hrUserRow.id
  }

  try {
    const formData = await request.formData()
    const rawFile = formData.get("resume") as File
    const source = (formData.get("source") as string) || "recruiter_upload"
    const origin = (formData.get("origin") as string) || deriveOrigin(source)

    if (!rawFile) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "text/plain",
    ]

    if (!allowedTypes.includes(rawFile.type)) {
      const fileName = rawFile.name.toLowerCase()
      if (!fileName.endsWith(".docx") && !fileName.endsWith(".doc") && !fileName.endsWith(".pdf") && !fileName.endsWith(".txt")) {
        return NextResponse.json({ error: "Invalid file type. Only PDF, DOCX, DOC, and TXT files are allowed." }, { status: 400 })
      }
    }

    if (rawFile.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large. Maximum size is 10MB." }, { status: 400 })
    }

    await ensureResumeBucketExists()

    const fileArrayBuffer = await rawFile.arrayBuffer()
    const fileHash = crypto.createHash("sha256").update(Buffer.from(fileArrayBuffer)).digest("hex")

    const existingFile = await checkFileExistsInSupabase(fileHash)

    const file = {
      name: rawFile.name,
      type: rawFile.type,
      size: rawFile.size,
      arrayBuffer: async () => fileArrayBuffer,
      text: async () => new TextDecoder().decode(fileArrayBuffer),
    } as any as File

    const parsedData = await parseResume(file)

    let embedding: number[] = []
    try {
      embedding = await generateEmbedding(parsedData.resumeText || "")
    } catch {
      /* continue without embedding */
    }

    let fileUrl = ""
    let filePath = ""

    if (existingFile && existingFile.url) {
      fileUrl = existingFile.url
      filePath = existingFile.path || ""
    } else {
      const fileBuffer = Buffer.from(fileArrayBuffer)
      const ext = rawFile.name.split(".").pop() || "pdf"
      filePath = `resumes/${fileHash}.${ext}`
      const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
        .from("resume-files")
        .upload(filePath, fileBuffer, {
          contentType: rawFile.type,
          upsert: false,
        })

      if (uploadError) {
        return NextResponse.json({ error: "File upload failed", details: uploadError.message }, { status: 500 })
      }

      const urlData = supabaseAdmin.storage
        .from("resume-files")
        .getPublicUrl(uploadData.path)

      fileUrl = urlData.data.publicUrl
    }

    const candidateData = {
      name: parsedData.name,
      email: parsedData.email || "",
      phone: parsedData.phone || "",
      dateOfBirth: parsedData.dateOfBirth || "",
      gender: parsedData.gender || "",
      maritalStatus: parsedData.maritalStatus || "",
      currentRole: parsedData.currentRole || "Not specified",
      desiredRole: parsedData.desiredRole || "",
      currentCompany: parsedData.currentCompany || "",
      location: parsedData.location || "Not specified",
      preferredLocation: parsedData.preferredLocation || "",
      totalExperience: parsedData.totalExperience || "Not specified",
      currentSalary: parsedData.currentSalary || "",
      expectedSalary: parsedData.expectedSalary || "",
      noticePeriod: parsedData.noticePeriod || "",
      highestQualification: parsedData.highestQualification || "",
      technicalSkills: parsedData.technicalSkills || [],
      softSkills: parsedData.softSkills || [],
      resumeText: parsedData.resumeText,
      fileName: rawFile.name,
      filePath,
      fileUrl,
      fileHash,
      status: "new" as const,
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      embedding: embedding,
    }

    const candidateId = await SupabaseCandidateService.addCandidate(candidateData)

    await supabaseAdmin.from("candidates").update({ uploaded_by_auth_user_id: ctx.authUser.id }).eq("id", candidateId)

    const { data: application } = await supabaseAdmin
      .from("applications")
      .insert({
        job_id: jobId,
        candidate_id: candidateId,
        status: "applied",
        source,
        origin,
        created_by: ctx.authUser.id,
        attribution: "recruiter_upload",
      })
      .select()
      .single()

    return NextResponse.json({
      success: true,
      candidateId,
      applicationId: application?.id,
      message: `Resume uploaded and assigned to ${job.title}`,
      fileUrl,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Upload failed" }, { status: 500 })
  }
}
