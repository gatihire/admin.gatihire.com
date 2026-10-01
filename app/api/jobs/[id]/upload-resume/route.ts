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
import { getOrAnalyzeFit } from "@/lib/candidate-fit"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: jobId } = await params

  const { data: job } = await supabaseAdmin
    .from("jobs")
    .select("id,title,client_name,industry,city,location,experience_min_years,experience_max_years,skills_must_have,skills_good_to_have,description")
    .eq("id", jobId)
    .single()

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
    const fileExt = rawFile.name.split(".").pop() || "pdf"
    // Resumes are content-addressed, so the storage key can be derived from the
    // bytes alone. Compute it before the existence check so the check looks in
    // the right folder ("resumes/<hash>.pdf", not the bucket root).
    const contentAddressedPath = `resumes/${fileHash}.${fileExt}`

    const existingFile = await checkFileExistsInSupabase(contentAddressedPath)

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
      filePath = contentAddressedPath
      // The path is the content hash, so re-uploading identical bytes is a
      // no-op. `upsert: false` made re-uploading the same resume (e.g. after the
      // candidate row was deleted) fail with "The resource already exists" and
      // 500 before the candidate was ever inserted. Overwriting with identical
      // bytes is harmless; upsert keeps the operation idempotent.
      const { error: uploadError } = await supabaseAdmin.storage
        .from("resume-files")
        .upload(filePath, fileBuffer, {
          contentType: rawFile.type,
          upsert: true,
        })

      if (uploadError) {
        return NextResponse.json({ error: "File upload failed", details: uploadError.message }, { status: 500 })
      }

      const urlData = supabaseAdmin.storage
        .from("resume-files")
        .getPublicUrl(filePath)

      fileUrl = urlData.data.publicUrl
    }

    const emailToCheck = parsedData.email?.trim()
    const phoneToCheck = parsedData.phone?.trim()
    const nameToCheck = parsedData.name?.trim()
    const locationToCheck = parsedData.location?.trim()

    // Dedup by strongest identity signal first. Phone is the anchor: a person
    // re-uploading a revised resume often has a new/alternate email typed into
    // the document, so falling back to email-only would miss them and spawn a
    // second candidate row for one human.
    let duplicate = null as any
    if (phoneToCheck) {
      duplicate = await SupabaseCandidateService.getCandidateByPhoneE164(phoneToCheck)
    }
    if (!duplicate && phoneToCheck && emailToCheck) {
      duplicate = await SupabaseCandidateService.getCandidateByEmailAndPhone(emailToCheck, phoneToCheck)
    }
    if (!duplicate && emailToCheck) {
      duplicate = await SupabaseCandidateService.getCandidateByEmail(emailToCheck)
    }
    if (!duplicate && phoneToCheck) {
      duplicate = await SupabaseCandidateService.getCandidateByPhone(phoneToCheck)
    }
    if (!duplicate && nameToCheck && phoneToCheck) {
      duplicate = await SupabaseCandidateService.getCandidateByNameAndPhone(nameToCheck, phoneToCheck)
    }
    if (!duplicate && nameToCheck && locationToCheck) {
      duplicate = await SupabaseCandidateService.getCandidateByNameAndLocation(nameToCheck, locationToCheck)
    }

    let candidateId: string

    if (duplicate) {
      candidateId = duplicate.id
      fileUrl = await SupabaseCandidateService.uploadFile(file, candidateId)
      filePath = fileUrl.split("/").pop() || ""

      await SupabaseCandidateService.updateCandidate(candidateId, {
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
        degree: parsedData.degree || "",
        specialization: parsedData.specialization || "",
        university: parsedData.university || "",
        educationYear: parsedData.educationYear || "",
        educationPercentage: parsedData.educationPercentage || "",
        additionalQualifications: parsedData.additionalQualifications || "",
        technicalSkills: parsedData.technicalSkills || [],
        softSkills: parsedData.softSkills || [],
        languagesKnown: parsedData.languagesKnown || [],
        certifications: parsedData.certifications || [],
        previousCompanies: parsedData.previousCompanies || [],
        jobTitles: parsedData.jobTitles || [],
        workDuration: parsedData.workDuration || [],
        keyAchievements: parsedData.keyAchievements || [],
        workExperience: parsedData.workExperience || [],
        education: parsedData.education || [],
        projects: parsedData.projects || [],
        awards: parsedData.awards || [],
        publications: parsedData.publications || [],
        references: parsedData.references || [],
        linkedinProfile: parsedData.linkedinProfile || "",
        portfolioUrl: parsedData.portfolioUrl || "",
        githubProfile: parsedData.githubProfile || "",
        summary: parsedData.summary || "",
        resumeText: parsedData.resumeText,
        fileName: rawFile.name,
        filePath,
        fileUrl,
        fileHash,
        updatedAt: new Date().toISOString(),
        embedding,
      })

      await supabaseAdmin.from("candidates").update({ uploaded_by_auth_user_id: ctx.authUser.id }).eq("id", candidateId)
    } else {
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
        degree: parsedData.degree || "",
        specialization: parsedData.specialization || "",
        university: parsedData.university || "",
        educationYear: parsedData.educationYear || "",
        educationPercentage: parsedData.educationPercentage || "",
        additionalQualifications: parsedData.additionalQualifications || "",
        technicalSkills: parsedData.technicalSkills || [],
        softSkills: parsedData.softSkills || [],
        languagesKnown: parsedData.languagesKnown || [],
        certifications: parsedData.certifications || [],
        previousCompanies: parsedData.previousCompanies || [],
        jobTitles: parsedData.jobTitles || [],
        workDuration: parsedData.workDuration || [],
        keyAchievements: parsedData.keyAchievements || [],
        workExperience: parsedData.workExperience || [],
        education: parsedData.education || [],
        projects: parsedData.projects || [],
        awards: parsedData.awards || [],
        publications: parsedData.publications || [],
        references: parsedData.references || [],
        linkedinProfile: parsedData.linkedinProfile || "",
        portfolioUrl: parsedData.portfolioUrl || "",
        githubProfile: parsedData.githubProfile || "",
        summary: parsedData.summary || "",
        resumeText: parsedData.resumeText,
        fileName: rawFile.name,
        filePath,
        fileUrl,
        fileHash,
        status: "new" as const,
        uploadedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        embedding,
      }

      candidateId = await SupabaseCandidateService.addCandidate(candidateData)

      await supabaseAdmin.from("candidates").update({ uploaded_by_auth_user_id: ctx.authUser.id }).eq("id", candidateId)
    }

    // Link the candidate to this job.
    //
    // Two problems with the previous version:
    //  1. `.single()` after an upsert with ignoreDuplicates throws
    //     "Cannot coerce the result to a single JSON object" whenever the row
    //     already exists, because ignoreDuplicates returns no row to select.
    //     Re-uploading a resume for a candidate already on this job therefore
    //     500'd AFTER the candidate had been created or updated, so the UI
    //     showed a failure while the candidate row silently persisted with no
    //     application — the resume never appeared in the pipeline.
    //  2. The error was never checked, so a genuine failure to link also
    //     returned 200 with a null applicationId.
    const { data: application, error: applicationError } = await supabaseAdmin
      .from("applications")
      .upsert({
        job_id: jobId,
        candidate_id: candidateId,
        status: "applied",
        source,
        origin,
        created_by: ctx.authUser.id,
        attribution: "recruiter_upload",
      }, { onConflict: "job_id,candidate_id", ignoreDuplicates: true })
      .select()
      .maybeSingle()

    // PGRST116 is PostgREST's "zero rows returned", which is the expected
    // outcome when ignoreDuplicates skipped an existing application. Anything
    // else means the candidate is not actually on this job and must not be
    // reported as a success.
    const duplicateApplication = applicationError && applicationError.code === "PGRST116"
    if (applicationError && !duplicateApplication) {
      console.error("Failed to link candidate to job", {
        jobId,
        candidateId,
        error: applicationError.message,
      })
      return NextResponse.json(
        {
          error: "Resume was parsed but could not be added to this job's pipeline.",
          details: applicationError.message,
          candidateId,
        },
        { status: 500 },
      )
    }

    let fitScore: number | null = null
    try {
      const fitResult = await getOrAnalyzeFit(jobId, candidateId, {
        id: candidateId,
        current_role: parsedData.currentRole || "Not specified",
        current_company: parsedData.currentCompany || "",
        total_experience: parsedData.totalExperience || "Not specified",
        location: parsedData.location || "Not specified",
        technical_skills: parsedData.technicalSkills || [],
        resume_text: parsedData.resumeText || "",
        summary: parsedData.summary || "",
      }, job)
      fitScore = fitResult.fit_score
    } catch (err: any) {
      console.error("Fit analysis failed for candidate", candidateId, err?.message || err)
    }

    return NextResponse.json({
      success: true,
      candidateId,
      applicationId: application?.id,
      fitScore,
      message: duplicate
        ? `Resume matched existing candidate and assigned to ${job.title}`
        : `Resume uploaded and assigned to ${job.title}`,
      fileUrl,
      isDuplicate: !!duplicate,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Upload failed" }, { status: 500 })
  }
}
