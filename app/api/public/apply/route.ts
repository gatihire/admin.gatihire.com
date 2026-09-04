import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseResume } from "@/lib/resume-parser"
import { uploadFileToSupabase } from "@/lib/supabase-storage-utils"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { generateEmbedding } from "@/lib/ai-utils"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get("resume") as File
    const jobId = formData.get("jobId") as string
    const name = formData.get("name") as string
    const email = formData.get("email") as string
    const phone = formData.get("phone") as string
    const coverLetter = formData.get("coverLetter") as string

    if (!file || !jobId || !name || !email) {
      return NextResponse.json(
        { error: "Missing required fields (resume, jobId, name, email)" },
        { status: 400 }
      )
    }

    // 1. Upload Resume
    const fileName = `${Date.now()}_${file.name.replace(/\s+/g, "_")}`
    const { url: fileUrl, path: filePath } = await uploadFileToSupabase(file, fileName)

    // 2. Parse Resume (Try to extract more info)
    let candidateData: any = {
      name,
      email,
      phone,
      resumeText: "",
      technicalSkills: [],
      workExperience: [],
      education: [],
    }

    try {
      const parsedData = await parseResume(file)
      // Merge parsed data, but manual inputs take precedence
      candidateData = {
        ...parsedData,
        name,
        email,
        phone: phone || parsedData.phone,
      }
    } catch (parseError) {
      console.warn("Resume parsing failed, using manual inputs only:", parseError)
    }

    // 3. Add file info
    candidateData.fileUrl = fileUrl
    candidateData.fileName = file.name
    candidateData.filePath = filePath
    candidateData.uploadedAt = new Date().toISOString()
    candidateData.status = "new"

    // 4. Generate Embedding (if resume text exists)
    if (candidateData.resumeText) {
      try {
        const embedding = await generateEmbedding(candidateData.resumeText)
        candidateData.embedding = embedding
      } catch (embError) {
        console.warn("Embedding generation failed:", embError)
      }
    }

    // 5. Upsert Candidate
    // Check if candidate exists by email
    const { data: existingCandidate } = await supabaseAdmin
      .from("candidates")
      .select("id")
      .eq("email", email)
      .single()

    let candidateId = existingCandidate?.id

    if (candidateId) {
      // Update existing candidate
      await supabaseAdmin
        .from("candidates")
        .update({
          ...candidateData,
          updated_at: new Date().toISOString(),
        })
        .eq("id", candidateId)
    } else {
      // Create new candidate
      // We need to map our data to the insert format if SupabaseCandidateService doesn't expose it directly
      // But we can use SupabaseCandidateService.addCandidate if it handles mapping
      // Let's just use direct supabaseAdmin insert to be safe with the fields we have
      const { data: newCandidate, error: createError } = await supabaseAdmin
        .from("candidates")
        .insert({
           name: candidateData.name,
           email: candidateData.email,
           phone: candidateData.phone,
           resume_text: candidateData.resumeText,
           file_url: candidateData.fileUrl,
           file_name: candidateData.fileName,
           skills: candidateData.technicalSkills, // Map to correct column if needed
           technical_skills: candidateData.technicalSkills,
           experience: candidateData.workExperience, // Map to correct column
           education: candidateData.education,
           status: "new",
           embedding: candidateData.embedding,
           // Add other fields as necessary from parsed data
           current_role: candidateData.currentRole,
           current_company: candidateData.currentCompany,
           location: candidateData.location,
           total_experience: candidateData.totalExperience,
        })
        .select()
        .single()

      if (createError) {
        console.error("Error creating candidate:", createError)
        return NextResponse.json({ error: "Failed to create candidate profile" }, { status: 500 })
      }
      candidateId = newCandidate.id
    }

    // 6. Create Application
    const { error: appError } = await supabaseAdmin
      .from("applications")
      .insert({
        job_id: jobId,
        candidate_id: candidateId,
        status: "applied",
        source: "board-app",
        candidate_notes: coverLetter || undefined,
        applied_at: new Date().toISOString()
      })

    if (appError) {
        // Check for duplicate application
        if (appError.code === '23505') { // Unique violation
            return NextResponse.json({ error: "You have already applied for this position" }, { status: 409 })
        }
        console.error("Error creating application:", appError)
        return NextResponse.json({ error: "Failed to submit application" }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: "Application submitted successfully" })

  } catch (error: any) {
    console.error("Public apply error:", error)
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}
