import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { generateJDQuestions, type JobContext, type CandidateContext } from "@/lib/jd-questions"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const jobId = searchParams.get("jobId")
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 })

  const { data: job, error: jobError } = await supabaseAdmin
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 })
  }

  const jobContext: JobContext = {
    id: job.id,
    title: job.title,
    client_name: job.client_name,
    skills_must_have: job.skills_must_have,
    skills_good_to_have: job.skills_good_to_have,
    experience_min_years: job.experience_min_years,
    experience_max_years: job.experience_max_years,
    salary_min: job.salary_min,
    salary_max: job.salary_max,
    salary_type: job.salary_type,
    city: job.city,
    work_type: job.work_type,
    key_responsibilities: job.key_responsibilities,
    daily_work_summary: job.daily_work_summary,
    education_min: job.education_min,
    languages_required: job.languages_required,
    english_level: job.english_level,
    license_type: job.license_type,
    role_category: job.role_category,
    shift_type: job.shift_type,
    employment_type: job.employment_type,
  }

  // Use a sample candidate profile to generate preview questions
  const sampleCandidate: CandidateContext = {
    id: "preview",
    name: "Sample Candidate",
    current_role: "Operations Manager",
    current_company: "Sample Company",
    total_experience: 5,
    location: job.city || "Delhi",
    technical_skills: job.skills_must_have?.slice(0, 3) || [],
    resume_text: "",
  }

  const { questions } = await generateJDQuestions(jobContext, sampleCandidate)

  return NextResponse.json({
    questions,
    jobTitle: job.title,
    clientName: job.client_name,
    skillsRequired: job.skills_must_have || [],
    experienceRange: `${job.experience_min_years ?? 0}-${job.experience_max_years ?? "any"} years`,
    salaryRange: job.salary_min || job.salary_max
      ? `${job.salary_min ?? ""} - ${job.salary_max ?? ""}${job.salary_type ? ` per ${job.salary_type}` : ""}`
      : "Not specified",
    location: job.city || "Not specified",
  })
}
