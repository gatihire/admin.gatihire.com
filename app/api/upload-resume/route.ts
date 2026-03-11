import { type NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"
import { parseResume } from "@/lib/resume-parser"
import { generateEmbedding } from "@/lib/ai-utils"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { ensureResumeBucketExists, supabaseAdmin } from "@/lib/supabase"
import { checkFileExistsInSupabase } from "@/lib/supabase-storage-utils"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  console.log("=== Comprehensive Resume Upload Started ===")

  let uploadedBy: string | undefined
  const hrUserCookie = request.cookies.get("hr_user")?.value
  if (hrUserCookie) {
    try {
      const parsed = JSON.parse(hrUserCookie)
      const parsedId = String(parsed?.id || "").trim()
      if (parsedId) uploadedBy = parsedId
    } catch {
      uploadedBy = undefined
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

  let uploadLogId: string | null = null

  try {
    const formData = await request.formData()
    const rawFile = formData.get("resume") as File

    if (!rawFile) {
      console.error("No file provided in request")
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    const fileArrayBuffer = await rawFile.arrayBuffer()
    const file = {
      name: rawFile.name,
      type: rawFile.type,
      size: rawFile.size,
      arrayBuffer: async () => fileArrayBuffer,
      text: async () => new TextDecoder().decode(fileArrayBuffer),
    } as any as File

    // Validate file type
    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "text/plain",
    ]

    if (!allowedTypes.includes(file.type)) {
      // Check if it's a DOCX/DOC file with wrong MIME type
      const fileName = file.name.toLowerCase()
      if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
        console.log(`⚠️ File has wrong MIME type: ${file.type}, but extension suggests Word document. Proceeding anyway...`)
      } else {
        return NextResponse.json(
          { error: `Invalid file type: ${file.type}. Only PDF, DOCX, DOC, and TXT files are allowed.` },
          { status: 400 },
        )
      }
    }

    // Validate file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "File size too large. Maximum 10MB allowed." }, { status: 400 })
    }

    console.log(`Processing file: ${file.name}, type: ${file.type}, size: ${file.size}`)
    console.log(`File extension: ${file.name.split('.').pop()?.toLowerCase()}`)
    console.log(`MIME type validation: ${allowedTypes.includes(file.type) ? 'PASSED' : 'FAILED'}`)

    // Ensure the Supabase bucket exists
    await ensureResumeBucketExists()

    const hashBuffer = await crypto.subtle.digest('SHA-256', fileArrayBuffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const fileHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

    try {
      const { data: logRow } = await supabaseAdmin
        .from('upload_logs')
        .insert({
          hr_user_id: uploadedBy || null,
          file_name: file.name,
          file_type: file.type,
          file_size: file.size,
          file_hash: fileHash,
          status: 'processing',
          message: 'Upload received',
        })
        .select('id')
        .single()
      uploadLogId = logRow?.id || null
    } catch (e) {
      uploadLogId = null
    }

    const existingByHash = await SupabaseCandidateService.getCandidateByFileHash(fileHash)
    if (existingByHash) {
      if (uploadLogId) {
        await supabaseAdmin
          .from('upload_logs')
          .update({
            status: 'completed',
            result_type: 'duplicate',
            candidate_id: existingByHash.id,
            message: 'Duplicate upload blocked (matched by file hash)',
            updated_at: new Date().toISOString(),
          })
          .eq('id', uploadLogId)
      }
      return NextResponse.json({
        success: true,
        isDuplicate: true,
        message: "Resume already exists (matched by file hash)",
        updatedExisting: false,
        resultType: "duplicate",
        duplicateInfo: {
          existingName: existingByHash.name,
          existingId: existingByHash.id,
          uploadedAt: existingByHash.uploadedAt,
          reason: `This file matches an existing upload for ${existingByHash.name}`,
          fileUrl: existingByHash.fileUrl,
        },
      })
    }
    
    // FIRST: Check if file already exists in Supabase storage
    console.log("Checking if file already exists in Supabase storage...")
    const fileExistsCheck = await checkFileExistsInSupabase(file.name)
    
    let fileUrl: string
    let filePath: string
    
    if (fileExistsCheck.exists && fileExistsCheck.url && fileExistsCheck.path) {
      console.log(`✅ File already exists in Supabase storage: ${file.name}`)
      fileUrl = fileExistsCheck.url
      filePath = fileExistsCheck.path
      
      // Check if this file is already associated with a candidate in the database
      console.log("Checking if file is already associated with a candidate...")
      const [byUrl, byName] = await Promise.all([
        SupabaseCandidateService.getCandidateByFileUrl(fileUrl),
        SupabaseCandidateService.getCandidateByFileName(file.name),
      ])
      const existingCandidate = byUrl || byName
      
      if (existingCandidate) {
        console.log("File is already associated with existing candidate:", existingCandidate.name)
        if (uploadLogId) {
          await supabaseAdmin
            .from('upload_logs')
            .update({
              status: 'completed',
              result_type: 'duplicate',
              candidate_id: existingCandidate.id,
              message: 'Duplicate upload blocked (file already linked to candidate)',
              updated_at: new Date().toISOString(),
            })
            .eq('id', uploadLogId)
        }
        return NextResponse.json({
          success: true,
          isDuplicate: true,
          message: "Resume already exists and is linked to an existing candidate",
          updatedExisting: false,
          resultType: "duplicate",
          duplicateInfo: {
            existingName: existingCandidate.name,
            existingId: existingCandidate.id,
            uploadedAt: existingCandidate.uploadedAt,
            reason: `File ${file.name} is already uploaded and associated with candidate ${existingCandidate.name}`,
            fileUrl: fileUrl
          }
        })
      }
      
      // File exists in Supabase storage but not associated with any candidate - we can reuse it
      console.log("File exists in Supabase storage but not associated with any candidate - reusing existing file")
    } else {
      // File doesn't exist in Supabase storage - need to parse and upload
      console.log("File not found in Supabase storage - proceeding with parsing and upload...")
      
      // Parse the resume to get candidate information
      console.log("Starting resume parsing...")
      let parsedData
      let parsingError: string | null = null
      
      // Prefer external worker (Fly.io) if configured, with graceful fallback
      const workerUrl = process.env.RESUME_WORKER_URL
      const workerSecret = process.env.RESUME_WORKER_SECRET
      if (workerUrl) {
        try {
          console.log(`Attempting worker-first parsing via ${workerUrl} ...`)
          const form = new FormData()
          form.append("resume", file, file.name)
          if (uploadLogId) form.append("upload_log_id", uploadLogId)
          const res = await fetch(workerUrl, {
            method: "POST",
            headers: {
              ...(workerSecret ? { "X-Worker-Secret": workerSecret } : {}),
            } as any,
            body: form as any,
          })
          if (res.ok) {
            const payload: any = await res.json()
            if (payload && (payload.parsed || payload.parsedData || payload.data)) {
              parsedData = payload.parsed || payload.parsedData || payload.data
              console.log("✅ Worker returned parsed data successfully")
            } else if (payload && payload.name && (payload.resumeText || payload.currentRole || payload.location)) {
              parsedData = payload
              console.log("✅ Worker returned candidate-shaped data")
            } else {
              console.warn("Worker did not return parsed data shape, falling back to local parser")
            }
          } else {
            console.warn(`Worker parsing failed: ${res.status} ${res.statusText}`)
          }
        } catch (e: any) {
          console.warn(`Worker parsing exception: ${String(e?.message || e)}`)
        }
      }
      
      try {
        if (!parsedData) {
          parsedData = await parseResume(file)
          console.log("✅ Resume parsing successful (local)")
        } else {
          console.log("Skipping local parse — using worker result")
        }
        console.log("Parsed data:", JSON.stringify(parsedData, null, 2))
      } catch (parseError) {
        const code = (parseError as any)?.code
        const msg = parseError instanceof Error ? parseError.message : String(parseError)

        if (code === "NOT_RESUME") {
          const assessment = (parseError as any)?.assessment
          const reason = String(assessment?.reason || msg || "This file does not appear to be a resume")
          const docType = String(assessment?.docType || "unknown")
          const confidence = Number(assessment?.confidence ?? 0.6)

          if (uploadLogId) {
            await supabaseAdmin
              .from('upload_logs')
              .update({
                status: 'completed',
                result_type: 'blocked',
                message: 'Blocked: not a resume',
                error_code: 'NOT_RESUME',
                error_message: reason,
                updated_at: new Date().toISOString(),
              })
              .eq('id', uploadLogId)
          }

          return NextResponse.json({
            error: "This file does not look like a resume",
            resultType: "blocked",
            validationFailed: true,
            blockedCategory: "not_resume",
            details: reason,
            docType,
            confidence,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            suggestions: [
              "Upload a resume/CV (not invoices, receipts, offer letters, or other documents)",
              "If the PDF is scanned, upload a clearer PDF or a DOCX version",
              "Make sure the resume includes contact info and sections like Skills/Experience/Education",
            ],
            timestamp: new Date().toISOString(),
          }, { status: 422 })
        }

        console.error("❌ Resume parsing failed:", parseError)
        parsingError = msg || "Unknown parsing error"

        if (uploadLogId) {
          await supabaseAdmin
            .from('upload_logs')
            .update({
              status: 'failed',
              result_type: 'error',
              message: 'Parsing failed',
              error_message: parsingError,
              updated_at: new Date().toISOString(),
            })
            .eq('id', uploadLogId)
        }
        
        // Return detailed parsing error information
        return NextResponse.json({
          error: "Resume parsing failed",
          parsingFailed: true,
          details: parsingError,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          suggestions: [
            "Check if the file is corrupted or password protected",
            "Ensure the file contains readable text content",
            "Try converting the file to a different format (PDF/DOCX)",
            "If the PDF is scanned/image-based, ensure Gemini OCR is enabled (GEMINI_API_KEY)"
          ],
          timestamp: new Date().toISOString()
        }, { status: 422 })
      }

      // Enforce resume content presence and quality
      const resumeText = (parsedData.resumeText || "").trim()
      const resumeTextLooksErroneous = /^(error extracting text from|doc processing error:)/i.test(resumeText)
      if (!resumeText || resumeText.length < 50 || resumeTextLooksErroneous) {
        if (uploadLogId) {
          await supabaseAdmin
            .from('upload_logs')
            .update({
              status: 'completed',
              result_type: 'blocked',
              parsing_method: (parsedData as any).parsing_method || null,
              parsing_errors: (parsedData as any).parsing_errors || null,
              message: 'Blocked: resume content not extracted',
              error_message: resumeTextLooksErroneous ? 'Text extraction returned an error marker' : 'Insufficient resume text available',
              updated_at: new Date().toISOString(),
            })
            .eq('id', uploadLogId)
        }
        return NextResponse.json({
          error: "Resume content not extracted",
          parsingFailed: true,
          details: resumeTextLooksErroneous ? "Text extraction returned an error marker" : "Insufficient resume text available",
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          suggestions: [
            "If the PDF is scanned/image-based, ensure Gemini OCR is enabled (GEMINI_API_KEY)",
            "If DOC/DOCX, re-save as PDF and try again",
            "Ensure the file is not password protected",
            "Avoid uploading screenshots or photos of resumes"
          ],
          timestamp: new Date().toISOString(),
          resultType: "blocked"
        }, { status: 422 })
      }

      // Validation: block storing incomplete profiles
      const normalizedName = (parsedData.name || "").trim().toLowerCase()
      const isNameInvalid = !normalizedName || normalizedName.length < 2 || normalizedName === "unknown" || normalizedName === "not specified"
      const hasContact = !!(parsedData.email && parsedData.email.trim()) || !!(parsedData.phone && parsedData.phone.trim())
      const hasContent = !!(parsedData.resumeText && parsedData.resumeText.trim().length > 100)
      const isDocx = file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      const shouldBlock = isNameInvalid || !hasContact || !hasContent
      if (shouldBlock) {
        if (uploadLogId) {
          await supabaseAdmin
            .from('upload_logs')
            .update({
              status: 'completed',
              result_type: 'blocked',
              parsing_method: (parsedData as any).parsing_method || null,
              parsing_errors: (parsedData as any).parsing_errors || null,
              message: 'Blocked: invalid or incomplete profile',
              error_message: 'Invalid or incomplete profile',
              updated_at: new Date().toISOString(),
            })
            .eq('id', uploadLogId)
        }
        return NextResponse.json({
          error: "Invalid or incomplete profile",
          validationFailed: true,
          reasons: {
            nameInvalid: isNameInvalid,
            missingContact: !hasContact,
            missingContent: !hasContent,
            fileType: file.type
          },
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          suggestions: [
            "Ensure the resume contains a valid candidate name",
            "Include an email or phone number in the resume",
            "Upload a PDF for best parsing accuracy",
            isDocx ? "Consider converting DOCX to PDF for improved parsing" : "If the PDF is scanned/image-based, enable Gemini OCR (GEMINI_API_KEY)"
          ],
          timestamp: new Date().toISOString(),
          resultType: "blocked",
        }, { status: 422 })
      }

      // Check for duplicate resumes before processing
      console.log("Checking for duplicate resumes...")
      const emailToCheck = parsedData.email?.trim()
      const phoneToCheck = parsedData.phone?.trim()
      const nameToCheck = parsedData.name?.trim()
      const locationToCheck = parsedData.location?.trim()

      let duplicate = null as any
      if (emailToCheck && phoneToCheck) {
        duplicate = await SupabaseCandidateService.getCandidateByEmailAndPhone(emailToCheck, phoneToCheck)
      }

      if (!duplicate && emailToCheck && !phoneToCheck) {
        duplicate = await SupabaseCandidateService.getCandidateByEmail(emailToCheck)
      }

      if (!duplicate && phoneToCheck && !emailToCheck) {
        duplicate = await SupabaseCandidateService.getCandidateByPhone(phoneToCheck)
      }

      if (!duplicate && nameToCheck && phoneToCheck && !emailToCheck) {
        duplicate = await SupabaseCandidateService.getCandidateByNameAndPhone(nameToCheck, phoneToCheck)
      }

      if (!duplicate && nameToCheck && locationToCheck && !emailToCheck && !phoneToCheck) {
        duplicate = await SupabaseCandidateService.getCandidateByNameAndLocation(nameToCheck, locationToCheck)
      }

      if (duplicate) {
        console.log("Duplicate resume detected:", duplicate)

        const candidateId = duplicate.id
        console.log("Uploading to Supabase Storage and updating existing candidate...")
        fileUrl = await SupabaseCandidateService.uploadFile(file, candidateId)
        filePath = fileUrl.split('/').pop() || ''

        await SupabaseCandidateService.updateCandidate(candidateId, {
          // Basic Information
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
          // Additional Information
          projects: parsedData.projects || [],
          awards: parsedData.awards || [],
          publications: parsedData.publications || [],
          references: parsedData.references || [],
          linkedinProfile: parsedData.linkedinProfile || "",
          portfolioUrl: parsedData.portfolioUrl || "",
          githubProfile: parsedData.githubProfile || "",
          summary: parsedData.summary || "",
          // File Information
          resumeText: parsedData.resumeText,
          fileName: file.name,
          fileUrl: fileUrl,
          fileHash,
        })

        console.log("=== Existing candidate updated successfully ===")
        return NextResponse.json({
          success: true,
          candidateId,
          message: "Existing candidate updated with new resume",
          fileUrl: fileUrl,
          reusedExistingFile: false,
          updatedExisting: true,
          resultType: "updated",
          ...Object.fromEntries(Object.entries(parsedData).filter(([key]) => key !== 'fileUrl')),
        })
      }

      // Generate embedding for vector search (optional)
      console.log("Generating embedding...")
      let embedding: number[] | undefined = undefined
      try {
        const v = await generateEmbedding(parsedData.resumeText || "")
        if (Array.isArray(v) && v.length > 0) {
          embedding = v
        }
        console.log("✅ Embedding generated successfully")
      } catch (embeddingError) {
        console.warn("⚠️ Failed to generate embedding:", embeddingError)
        // Continue without embedding
      }

      // Prepare candidate data for Supabase
      const candidateData = {
        // Basic Information
        name: parsedData.name,
        email: (parsedData.email && parsedData.email.trim()) ? parsedData.email.trim() : `${crypto.randomUUID()}@unknown.invalid`,
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

        // Additional Information
        projects: parsedData.projects || [],
        awards: parsedData.awards || [],
        publications: parsedData.publications || [],
        references: parsedData.references || [],
        linkedinProfile: parsedData.linkedinProfile || "",
        portfolioUrl: parsedData.portfolioUrl || "",
        githubProfile: parsedData.githubProfile || "",
        summary: parsedData.summary || "",

        // File Information
        resumeText: parsedData.resumeText,
        fileName: file.name,
        fileUrl: "",
        filePath: "",
        fileHash,

        // Vector embedding (optional)
        ...(embedding ? { embedding } : {}),

        // System Fields
        status: "new" as const,
        tags: [],
        rating: undefined,
        notes: "",
        uploadedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastContacted: "",
        interviewStatus: "not-scheduled" as const,
        feedback: "",
        
        // Parsing metadata
        parsing_method: (parsedData as any).parsing_method || "gemini",
        parsing_confidence: (parsedData as any).parsing_confidence ?? 0.95,
        parsing_errors: (parsedData as any).parsing_errors || [],
        uploadedBy: uploadedBy,
      }

      // Add to Supabase
      console.log("Adding to Supabase...")
      // We already generated candidateId earlier for the file upload
      try {
        const insertedId = await SupabaseCandidateService.addCandidate(candidateData)

        console.log("Uploading to Supabase Storage...")
        fileUrl = await SupabaseCandidateService.uploadFile(file, insertedId)
        filePath = fileUrl.split('/').pop() || ''
        await SupabaseCandidateService.updateCandidate(insertedId, { fileHash, updatedAt: new Date().toISOString() })
        await supabaseAdmin.from("candidates").update({ uploaded_by_auth_user_id: ctx.authUser.id }).eq("id", insertedId)

        console.log("=== Resume Upload Completed Successfully ===")
        if (uploadLogId) {
          await supabaseAdmin
            .from('upload_logs')
            .update({
              status: 'completed',
              result_type: 'created',
              candidate_id: insertedId,
              parsing_method: (parsedData as any).parsing_method || null,
              parsing_errors: (parsedData as any).parsing_errors || null,
              message: 'Created candidate',
              updated_at: new Date().toISOString(),
            })
            .eq('id', uploadLogId)
        }
        supabaseAdmin
          .from("analytics_events")
          .insert({
            actor_auth_user_id: ctx.authUser.id,
            event_name: "candidate.uploaded",
            entity_type: "candidates",
            entity_id: insertedId,
            metadata: { file_name: file.name, file_hash: fileHash, result_type: "created" },
          })
          .then(() => {})
        return NextResponse.json({
          success: true,
          candidateId: insertedId,
          message: "Resume processed successfully",
          fileUrl: fileUrl,
          reusedExistingFile: false,
          updatedExisting: false,
          resultType: "created",
          ...Object.fromEntries(Object.entries(parsedData).filter(([key]) => key !== 'fileUrl')),
        })
      } catch (addError: any) {
        if (addError?.code === '23505' && addError?.message?.includes('email')) {
          console.log("Duplicate email detected during insert, updating existing candidate")
          
          let existingCandidate = null as any
          if (parsedData.email && parsedData.email.trim()) {
            existingCandidate = await SupabaseCandidateService.getCandidateByEmail(parsedData.email.trim().toLowerCase())
          }
          
          if (!existingCandidate) {
            console.warn("Duplicate email error but could not find candidate by email:", parsedData.email)
            throw addError
          }
          
          const existingId = existingCandidate?.id || existingCandidate?._id
          if (existingId) {
            const existingPhone = (existingCandidate.phone || '').trim()
            const newPhone = (parsedData.phone || '').trim()
            if (!existingPhone || !newPhone || existingPhone !== newPhone) {
              if (uploadLogId) {
                await supabaseAdmin
                  .from('upload_logs')
                  .update({
                    status: 'completed',
                    result_type: 'duplicate',
                    candidate_id: existingId,
                    parsing_method: (parsedData as any).parsing_method || null,
                    parsing_errors: (parsedData as any).parsing_errors || null,
                    message: 'Duplicate email; phone mismatch; not updated',
                    error_message: 'Email already exists with different phone',
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', uploadLogId)
              }
              return NextResponse.json({
                error: "Email already exists with different phone",
                isDuplicate: true,
                duplicateInfo: {
                  existingName: existingCandidate.name,
                  existingId: existingId,
                  uploadedAt: existingCandidate.uploadedAt,
                  reason: `Email ${parsedData.email} already exists, but phone doesn't match. Not updating.`
                },
              }, { status: 409 })
            }

            console.log("Uploading to Supabase Storage...")
            fileUrl = await SupabaseCandidateService.uploadFile(file, existingId)
            await supabaseAdmin.from("candidates").update({ uploaded_by_auth_user_id: ctx.authUser.id }).eq("id", existingId)
            supabaseAdmin
              .from("analytics_events")
              .insert({
                actor_auth_user_id: ctx.authUser.id,
                event_name: "candidate.uploaded",
                entity_type: "candidates",
                entity_id: existingId,
                metadata: { file_name: file.name, file_hash: fileHash, result_type: "updated" },
              })
              .then(() => {})
            filePath = fileUrl.split('/').pop() || ''

            await SupabaseCandidateService.updateCandidate(existingId, {
              ...candidateData,
              fileUrl,
              fileName: file.name,
              fileHash,
              uploadedAt: undefined,
              updatedAt: new Date().toISOString(),
            })

            if (uploadLogId) {
              await supabaseAdmin
                .from('upload_logs')
                .update({
                  status: 'completed',
                  result_type: 'updated',
                  candidate_id: existingId,
                  parsing_method: (parsedData as any).parsing_method || null,
                  parsing_errors: (parsedData as any).parsing_errors || null,
                  message: 'Updated existing candidate',
                  updated_at: new Date().toISOString(),
                })
                .eq('id', uploadLogId)
            }

            return NextResponse.json({
              success: true,
              candidateId: existingId,
              message: "Existing candidate updated with new resume",
              fileUrl: fileUrl,
              reusedExistingFile: false,
              updatedExisting: true,
              resultType: "updated",
              duplicateInfo: {
                existingName: existingCandidate.name,
                existingId: existingId,
                uploadedAt: existingCandidate.uploadedAt,
                reason: `Duplicate email detected; updated existing profile (email + phone matched)`
              },
              ...Object.fromEntries(Object.entries(parsedData).filter(([key]) => key !== 'fileUrl')),
            })
          }
        }
        throw addError
      }

      throw new Error("Unexpected state")
    }

    // If we reach here, we're reusing an existing file that's not associated with any candidate
    // We need to parse it to create a new candidate entry
    console.log("Reusing existing file - parsing to create new candidate entry...")
    
    try {
      // Download the existing file from Supabase storage to parse it
      const response = await fetch(fileUrl)
      if (!response.ok) {
        throw new Error(`Failed to download existing file from Supabase storage: ${response.status}`)
      }
      
      const blob = await response.blob()
      const arrayBuffer = await blob.arrayBuffer()
      
      // Create a mock File object for parsing
      const mockFile = {
        name: file.name,
        type: file.type,
        size: file.size,
        arrayBuffer: () => Promise.resolve(arrayBuffer),
        text: () => blob.text(),
        slice: (start?: number, end?: number) => {
          const slicedBuffer = arrayBuffer.slice(start || 0, end || arrayBuffer.byteLength)
          return {
            arrayBuffer: () => Promise.resolve(slicedBuffer),
            text: () => new TextDecoder().decode(slicedBuffer)
          }
        }
      }
      
      // Parse the resume using the mock file object
      console.log("Parsing existing file from Supabase storage...")
      const parsedData = await parseResume(mockFile as any)
      console.log("✅ Resume parsing successful from existing file")
      
      // Check for duplicate resumes before processing
      console.log("Checking for duplicate resumes...")
      const existingCandidates = await SupabaseCandidateService.getAllCandidates()
      
      const duplicateChecks = [
        // Check by exact email match (only if email exists)
        parsedData.email?.trim() ? existingCandidates.find(c => {
          const existingEmail = c.email?.trim()
          return existingEmail && existingEmail.toLowerCase() === parsedData.email!.trim().toLowerCase()
        }) : null,
        // Check by name + phone combination
        parsedData.phone?.trim() ? existingCandidates.find(c => 
          c.name?.toLowerCase() === parsedData.name?.toLowerCase() && 
          c.phone?.trim() === parsedData.phone?.trim()
        ) : null,
        // Check by name + location combination
        parsedData.location?.trim() ? existingCandidates.find(c => 
          c.name?.toLowerCase() === parsedData.name?.toLowerCase() && 
          c.location?.trim() && c.location.toLowerCase() === parsedData.location?.toLowerCase()
        ) : null,
        // Check by exact phone match (if phone exists)
        parsedData.phone?.trim() ? existingCandidates.find(c => c.phone?.trim() === parsedData.phone?.trim()) : null
      ].filter(Boolean) as any[]

      if (duplicateChecks.length > 0) {
        const duplicate = duplicateChecks[0]
        console.log("Duplicate resume detected:", duplicate)
        
        await SupabaseCandidateService.updateCandidate(duplicate.id, {
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
          fileName: file.name,
          fileUrl: fileUrl,
        })

        console.log("=== Existing candidate updated successfully (Reused File) ===")
        if (uploadLogId) {
          await supabaseAdmin
            .from('upload_logs')
            .update({
              status: 'completed',
              result_type: 'updated',
              candidate_id: duplicate.id,
              parsing_method: (parsedData as any).parsing_method || null,
              parsing_errors: (parsedData as any).parsing_errors || null,
              message: 'Updated existing candidate (reused file)',
              updated_at: new Date().toISOString(),
            })
            .eq('id', uploadLogId)
        }
        return NextResponse.json({
          success: true,
          candidateId: duplicate.id,
          message: "Existing candidate updated with reused file",
          fileUrl: fileUrl,
          reusedExistingFile: true,
          updatedExisting: true,
          resultType: "updated",
          ...Object.fromEntries(Object.entries(parsedData).filter(([key]) => key !== 'fileUrl')),
        })
      }

      // Generate embedding for vector search (optional)
      console.log("Generating embedding...")
      let embedding: number[] = []
      try {
        embedding = await generateEmbedding(parsedData.resumeText || "")
        console.log("✅ Embedding generated successfully")
      } catch (embeddingError) {
        console.warn("⚠️ Failed to generate embedding:", embeddingError)
        // Continue without embedding
      }

      // Generate a unique ID for the candidate
      const candidateId = crypto.randomUUID()

      // Prepare candidate data for Supabase
      const candidateData = {
        // Basic Information
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

        // Additional Information
        projects: parsedData.projects || [],
        awards: parsedData.awards || [],
        publications: parsedData.publications || [],
        references: parsedData.references || [],
        linkedinProfile: parsedData.linkedinProfile || "",
        portfolioUrl: parsedData.portfolioUrl || "",
        githubProfile: parsedData.githubProfile || "",
        summary: parsedData.summary || "",

        // File Information
        resumeText: parsedData.resumeText,
        fileName: file.name,
        filePath: filePath,
        fileUrl: fileUrl,

        // System Fields
        status: "new" as const,
        tags: [],
        rating: undefined,
        notes: "",
        uploadedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastContacted: "",
        interviewStatus: "not-scheduled" as const,
        feedback: "",
        
        // Parsing metadata
        parsing_method: "gemini",
        parsing_confidence: 0.95,
        parsing_errors: [],
        uploadedBy: uploadedBy,
      }

      // Add to Supabase
      console.log("Adding to Supabase...")
      let insertedCandidateId: string | null = null
      try {
        const insertedId = await SupabaseCandidateService.addCandidate(candidateData)
        insertedCandidateId = insertedId
        await supabaseAdmin.from("candidates").update({ uploaded_by_auth_user_id: ctx.authUser.id }).eq("id", insertedId)
        supabaseAdmin
          .from("analytics_events")
          .insert({
            actor_auth_user_id: ctx.authUser.id,
            event_name: "candidate.uploaded",
            entity_type: "candidates",
            entity_id: insertedId,
            metadata: { file_name: file.name, result_type: "created", reused_existing_file: true },
          })
          .then(() => {})

        if (uploadLogId) {
          await supabaseAdmin
            .from('upload_logs')
            .update({
              status: 'completed',
              result_type: 'created',
              candidate_id: insertedId,
              parsing_method: (parsedData as any).parsing_method || null,
              parsing_errors: (parsedData as any).parsing_errors || null,
              message: 'Created candidate (reused existing file)',
              updated_at: new Date().toISOString(),
            })
            .eq('id', uploadLogId)
        }
      } catch (addError: any) {
        // Handle duplicate email constraint violation
        if (addError?.code === '23505' && addError?.message?.includes('email')) {
          console.log("Duplicate email detected during insert")

          const email = (parsedData.email || '').trim().toLowerCase()
          const phone = (parsedData.phone || '').trim()
          const existingCandidate = email ? await SupabaseCandidateService.getCandidateByEmail(email) : null

          if (existingCandidate) {
            const existingId = existingCandidate.id || (existingCandidate as any)._id
            if (!existingId) {
              throw addError
            }
            const existingPhone = (existingCandidate.phone || '').trim()
            if (!existingPhone || !phone || existingPhone !== phone) {
              if (uploadLogId) {
                await supabaseAdmin
                  .from('upload_logs')
                  .update({
                    status: 'completed',
                    result_type: 'duplicate',
                    candidate_id: existingId,
                    parsing_method: (parsedData as any).parsing_method || null,
                    parsing_errors: (parsedData as any).parsing_errors || null,
                    message: 'Duplicate email; phone mismatch; not updated (reused file)',
                    error_message: 'Resume already exists, but phone does not match',
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', uploadLogId)
              }
              return NextResponse.json({
                error: "Resume already exists",
                isDuplicate: true,
                duplicateInfo: {
                  existingName: existingCandidate.name,
                  existingId: existingId,
                  uploadedAt: existingCandidate.uploadedAt,
                  reason: `Candidate with email ${parsedData.email} already exists, but phone doesn't match. Not updating.`
                }
              }, { status: 409 })
            }

            await SupabaseCandidateService.updateCandidate(existingId, {
              ...candidateData,
              fileUrl,
              fileName: file.name,
              updatedAt: new Date().toISOString(),
            })
            await supabaseAdmin.from("candidates").update({ uploaded_by_auth_user_id: ctx.authUser.id }).eq("id", existingId)
            supabaseAdmin
              .from("analytics_events")
              .insert({
                actor_auth_user_id: ctx.authUser.id,
                event_name: "candidate.uploaded",
                entity_type: "candidates",
                entity_id: existingId,
                metadata: { file_name: file.name, result_type: "updated", reused_existing_file: true },
              })
              .then(() => {})

            if (uploadLogId) {
              await supabaseAdmin
                .from('upload_logs')
                .update({
                  status: 'completed',
                  result_type: 'updated',
                  candidate_id: existingId,
                  parsing_method: (parsedData as any).parsing_method || null,
                  parsing_errors: (parsedData as any).parsing_errors || null,
                  message: 'Updated existing candidate (reused file; email + phone matched)',
                  updated_at: new Date().toISOString(),
                })
                .eq('id', uploadLogId)
            }

            return NextResponse.json({
              success: true,
              candidateId: existingId,
              message: "Existing candidate updated with reused file",
              fileUrl,
              reusedExistingFile: true,
              updatedExisting: true,
              resultType: "updated",
              duplicateInfo: {
                existingName: existingCandidate.name,
                existingId: existingId,
                uploadedAt: existingCandidate.uploadedAt,
                reason: `Duplicate email detected; updated existing profile (email + phone matched)`
              },
              ...Object.fromEntries(Object.entries(parsedData).filter(([key]) => key !== 'fileUrl')),
            })
          }
        }
        
        // Re-throw if it's not a duplicate email error
        throw addError
      }

      console.log("=== Resume Upload Completed Successfully (Reused Existing File) ===")

      if (!insertedCandidateId) {
        throw new Error("Failed to create candidate")
      }

      return NextResponse.json({
        success: true,
        candidateId: insertedCandidateId,
        message: "Resume processed successfully (reused existing file)",
        fileUrl: fileUrl,
        reusedExistingFile: true,
        updatedExisting: false,
        resultType: "created",
        ...Object.fromEntries(Object.entries(parsedData).filter(([key]) => key !== 'fileUrl')),
      })
      
    } catch (parseError) {
      console.error("❌ Failed to parse existing file from Supabase storage:", parseError)
      try {
        if (uploadLogId) {
          await supabaseAdmin
            .from('upload_logs')
            .update({
              status: 'failed',
              result_type: 'error',
              message: 'Failed to parse existing file from storage',
              error_message: parseError instanceof Error ? parseError.message : 'Unknown error',
              updated_at: new Date().toISOString(),
            })
            .eq('id', uploadLogId)
        }
      } catch (e) {
      }
      return NextResponse.json({
        error: "Failed to parse existing file from Supabase storage",
        details: parseError instanceof Error ? parseError.message : "Unknown error",
        fileName: file.name,
        fileUrl: fileUrl,
        suggestions: [
          "The file may be corrupted in Supabase storage",
          "Try uploading the file again to replace the existing one",
          "Check if the file format is supported"
        ],
        timestamp: new Date().toISOString()
      }, { status: 500 })
    }

  } catch (error) {
    console.error("=== Resume Upload Error ===")
    console.error("Error details:", error)

    try {
      if (uploadLogId) {
        await supabaseAdmin
          .from('upload_logs')
          .update({
            status: 'failed',
            result_type: 'error',
            error_message: error instanceof Error ? error.message : 'Unknown error',
            updated_at: new Date().toISOString(),
          })
          .eq('id', uploadLogId)
      }
    } catch (e) {
    }

    const anyErr = error as any
    const supabaseError = anyErr && typeof anyErr === "object" && "code" in anyErr && "message" in anyErr
      ? {
          code: String(anyErr.code),
          message: String(anyErr.message),
          details: anyErr.details ?? null,
          hint: anyErr.hint ?? null,
        }
      : undefined

    return NextResponse.json(
      {
        error: "Failed to process resume",
        details: error instanceof Error ? error.message : "Unknown error",
        supabaseError,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
