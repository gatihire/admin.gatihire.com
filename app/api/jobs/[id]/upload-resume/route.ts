import { after, type NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { parseResume } from "@/lib/resume-parser"
import { generateEmbedding } from "@/lib/ai-utils"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { ensureResumeBucketExists, supabaseAdmin } from "@/lib/supabase"
import { checkFileExistsInSupabase } from "@/lib/supabase-storage-utils"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { deriveOrigin } from "@/lib/origin"
import { getOrAnalyzeFit } from "@/lib/candidate-fit"

export const runtime = "nodejs"
// Parsing + embedding + fit analysis is an LLM-bound workflow. Give the
// function the full serverless budget so a slow model does not cut the
// connection mid-upload.
export const maxDuration = 60

function nowIso() {
  return new Date().toISOString()
}

/** A human-readable name from "bipul_sikder-resume.pdf" → "bipul sikder resume". */
function nameFromFileName(fileName: string) {
  const base = String(fileName || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return (base || "Unnamed candidate").slice(0, 120)
}

/**
 * Link a candidate to a job. Returns the application id (or null when the
 * application already existed).
 *
 * Falls back to the minimum columns when `source`/`origin`/`attribution` are
 * not present in the target schema. A schema drift must not be able to leave
 * a successfully parsed resume outside the job pipeline.
 */
async function linkCandidateToJob(
  jobId: string,
  candidateId: string,
  source: string,
  origin: string,
  authUserId: string,
): Promise<string | null> {
  const { data: application, error } = await supabaseAdmin
    .from("applications")
    .upsert(
      {
        job_id: jobId,
        candidate_id: candidateId,
        status: "applied",
        source,
        origin,
        created_by: authUserId,
        attribution: "recruiter_upload",
      },
      { onConflict: "job_id,candidate_id", ignoreDuplicates: true },
    )
    .select()
    .maybeSingle()

  // PGRST116 is PostgREST's "zero rows returned", the expected outcome when
  // ignoreDuplicates skipped an existing application.
  if (!error || error.code === "PGRST116") return application?.id ?? null

  console.error("Failed to link candidate to job, retrying with minimal columns", {
    jobId,
    candidateId,
    error: error.message,
  })

  const { data: retry, error: retryErr } = await supabaseAdmin
    .from("applications")
    .upsert(
      { job_id: jobId, candidate_id: candidateId, status: "applied" },
      { onConflict: "job_id,candidate_id", ignoreDuplicates: true },
    )
    .select()
    .maybeSingle()

  if (retryErr && retryErr.code !== "PGRST116") throw new Error(retryErr.message)
  return retry?.id ?? null
}

/**
 * Keep a resume whose text could not be read.
 *
 * Before this, a parse failure returned 422 *before* the file was stored, so
 * HR saw "failed" and the CV was gone. The candidate now exists with the file
 * attached and `resume_parse_state = 'needs_review'`, which is what the
 * needs-review screen lists.
 */
async function createNeedsReviewCandidate(opts: {
  authUserId: string
  fileName: string
  fileUrl: string
  fileHash: string
  fileSize: number
  fileType: string
  error: string
}): Promise<string> {
  const { data: byHash } = await supabaseAdmin
    .from("candidates")
    .select("id")
    .eq("file_hash", opts.fileHash)
    .limit(1)
    .maybeSingle()

  if (byHash?.id) {
    await supabaseAdmin
      .from("candidates")
      .update({
        file_name: opts.fileName,
        file_url: opts.fileUrl,
        file_size: opts.fileSize,
        file_type: opts.fileType,
        resume_parse_state: "needs_review",
        resume_parse_error: opts.error,
        updated_at: nowIso(),
      })
      .eq("id", byHash.id)
    return byHash.id as string
  }

  const { data: created, error } = await supabaseAdmin
    .from("candidates")
    .insert({
      name: nameFromFileName(opts.fileName),
      email: `${crypto.randomUUID()}@unknown.invalid`,
      phone: null,
      current_role: "Not specified",
      location: "Not specified",
      total_experience: "Not specified",
      status: "new",
      file_name: opts.fileName,
      file_url: opts.fileUrl,
      file_hash: opts.fileHash,
      file_size: opts.fileSize,
      file_type: opts.fileType,
      resume_parse_state: "needs_review",
      resume_parse_error: opts.error,
      uploaded_at: nowIso(),
      updated_at: nowIso(),
      uploaded_by_auth_user_id: opts.authUserId,
    })
    .select("id")
    .single()

  if (!error && created?.id) return created.id as string

  // Last resort: the standard insert path, then flag the row.
  const fallbackId = await SupabaseCandidateService.addCandidate({
    name: nameFromFileName(opts.fileName),
    email: `${crypto.randomUUID()}@unknown.invalid`,
    phone: "",
    currentRole: "Not specified",
    location: "Not specified",
    totalExperience: "Not specified",
    status: "new",
    fileName: opts.fileName,
    fileUrl: opts.fileUrl,
    fileHash: opts.fileHash,
    uploadedAt: nowIso(),
    updatedAt: nowIso(),
    uploadedBy: opts.authUserId,
  } as any)

  await supabaseAdmin
    .from("candidates")
    .update({
      resume_parse_state: "needs_review",
      resume_parse_error: opts.error,
      file_size: opts.fileSize,
      file_type: opts.fileType,
    })
    .eq("id", fallbackId)

  return fallbackId
}

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

    //
    // ── Save the file BEFORE parsing ───────────────────────────────────────
    //
    // The old order parsed first and only then uploaded, so any parse failure
    // threw the resume away before it reached storage: HR saw a failure and the
    // CV was gone forever. Storage is cheap; a lost resume is not.
    //
    let fileUrl = ""
    let filePath = ""

    if (existingFile && existingFile.url) {
      fileUrl = existingFile.url
      filePath = existingFile.path || contentAddressedPath
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
          contentType: rawFile.type || "application/octet-stream",
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

    //
    // ── Parse ──────────────────────────────────────────────────────────────
    //
    // "This is not a resume" is the only failure that rejects the upload. Any
    // other failure (model down, rate limit, unreadable scan) keeps the file and
    // creates a candidate flagged for review, so the CV still lands in the job.
    //
    let parsedData: any = null
    let parseError: any = null
    try {
      parsedData = await parseResume(file)
    } catch (e: any) {
      parseError = e
    }

    if (!parsedData) {
      const parseCode = String(parseError?.code || "")
      const assessment = (parseError as any)?.assessment
      const reason = String(assessment?.reason || parseError?.message || "Could not read this resume")

      if (parseCode === "NOT_RESUME") {
        return NextResponse.json(
          {
            error: "This file does not look like a resume",
            resultType: "blocked",
            validationFailed: true,
            blockedCategory: "not_resume",
            details: reason,
            docType: String(assessment?.docType || "unknown"),
            confidence: Number(assessment?.confidence ?? 0.6),
            fileName: rawFile.name,
            fileType: rawFile.type,
            fileSize: rawFile.size,
            suggestions: [
              "Upload a resume/CV (not invoices, receipts, offer letters, or other documents)",
              "If the PDF is scanned, upload a clearer PDF or a DOCX version",
              "Make sure the resume includes contact info and sections like Skills/Experience/Education",
            ],
            timestamp: nowIso(),
          },
          { status: 422 },
        )
      }

      const candidateId = await createNeedsReviewCandidate({
        authUserId: ctx.authUser.id,
        fileName: rawFile.name,
        fileUrl,
        fileHash,
        fileSize: rawFile.size,
        fileType: rawFile.type || "application/octet-stream",
        error: reason,
      })

      const applicationId = await linkCandidateToJob(jobId, candidateId, source, origin, ctx.authUser.id)

      return NextResponse.json({
        success: true,
        needsReview: true,
        candidateId,
        applicationId,
        fileUrl,
        message: `Resume saved and added to ${job.title}, but the text could not be read automatically. It is flagged for review.`,
        parseError: reason,
      })
    }

    let embedding: number[] = []
    try {
      embedding = await generateEmbedding(parsedData.resumeText || "")
    } catch {
      /* continue without embedding */
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
      // The file is already in storage (uploaded above, before parsing), so
      // there is nothing to upload here. Re-uploading used to overwrite the
      // content-addressed path with a candidate-scoped one and could fail after
      // a successful parse, losing the association between the row and file.

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

      // `updateCandidate` only maps a known subset of columns, so the parse
      // state is written directly. Without this a re-uploaded resume kept the
      // old "needs_review" flag even though it had just parsed cleanly.
      await supabaseAdmin
        .from("candidates")
        .update({
          uploaded_by_auth_user_id: ctx.authUser.id,
          resume_parse_state: "parsed",
          resume_parse_error: null,
          file_size: rawFile.size,
          file_type: rawFile.type || "application/octet-stream",
        })
        .eq("id", candidateId)
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

      // addCandidate() can return an existing row (it de-duplicates by email /
      // phone+name) and it does not persist file_size / file_type / parse state
      // for new rows either. Write those explicitly so the CV is attached and
      // visible regardless of which path was taken.
      await supabaseAdmin
        .from("candidates")
        .update({
          uploaded_by_auth_user_id: ctx.authUser.id,
          file_name: rawFile.name,
          file_url: fileUrl,
          file_hash: fileHash,
          file_size: rawFile.size,
          file_type: rawFile.type || "application/octet-stream",
          resume_parse_state: "parsed",
          resume_parse_error: null,
        })
        .eq("id", candidateId)
    }

    const applicationId = await linkCandidateToJob(jobId, candidateId, source, origin, ctx.authUser.id)

    //
    // Fit analysis is an LLM call and is not needed for the upload to be
    // correct. Awaiting it here used to push the request past the serverless
    // limit, which is what produced "the upload failed" while the candidate had
    // actually been created. `after()` keeps the function alive just long
    // enough to run it without delaying the response; the fit score is also
    // recomputed lazily by the job pipeline if this does not finish.
    //
    after(async () => {
      try {
        await getOrAnalyzeFit(jobId, candidateId, {
          id: candidateId,
          current_role: parsedData.currentRole || "Not specified",
          current_company: parsedData.currentCompany || "",
          total_experience: parsedData.totalExperience || "Not specified",
          location: parsedData.location || "Not specified",
          technical_skills: parsedData.technicalSkills || [],
          resume_text: parsedData.resumeText || "",
          summary: parsedData.summary || "",
        }, job)
      } catch (err: any) {
        console.error("Fit analysis failed for candidate", candidateId, err?.message || err)
      }
    })

    return NextResponse.json({
      success: true,
      candidateId,
      applicationId,
      fitScore: null,
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
