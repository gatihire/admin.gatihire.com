import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { GoogleGenerativeAI } from "@google/generative-ai"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview"

export async function POST(request: NextRequest) {
  try {
    const { jobId, candidateId, force } = await request.json()
    
    if (!jobId || !candidateId) {
      return NextResponse.json({ error: "Missing jobId or candidateId" }, { status: 400 })
    }

    const { data: existingMatch } = await supabaseAdmin
      .from("job_matches")
      .select("match_summary")
      .eq("job_id", jobId)
      .eq("candidate_id", candidateId)
      .maybeSingle()

    const existingText = typeof existingMatch?.match_summary === "string" ? existingMatch.match_summary.trim() : ""
    const looksStructured = Boolean(existingText) && existingText.startsWith("Fit:")
    const tooLong = Boolean(existingText) && existingText.length > 900

    if (!force && existingText && looksStructured && !tooLong) {
      return NextResponse.json({ summary: existingText, cached: true })
    }

    // 1. Fetch Job
    const { data: job, error: jobError } = await supabaseAdmin
      .from("jobs")
      .select("title, description, industry, location, city, employment_type, shift_type, salary_type, salary_min, salary_max, openings, education_min, experience_min_years, experience_max_years, english_level, license_type, age_min, age_max, gender_preference, skills_must_have, skills_good_to_have")
      .eq("id", jobId)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    // 2. Fetch Candidate
    const { data: candidate, error: candError } = await supabaseAdmin
      .from("candidates")
      .select("*")
      .eq("id", candidateId)
      .single()

    if (candError || !candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 })
    }

    // 3. Generate AI Analysis
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "AI service not configured" }, { status: 503 })
    }

    const model = genAI.getGenerativeModel({ model: DEFAULT_GEMINI_MODEL })
    
    const prompt = `
You are an expert recruiter. Write a SHORT, structured match analysis.

Return EXACTLY this format (no extra text):

Fit: <Strong Match | Potential Match | Risky>
Strengths:
- <bullet>
- <bullet>
Risks:
- <bullet>
- <bullet>
Interview probes:
- <bullet>
- <bullet>

Rules:
- Max 150 words total.
- Use concrete job requirements (skills, location, experience).
- If info is missing, say "Unknown" briefly.

JOB:
- Title: ${job.title}
- Location: ${[job.city, job.location].filter(Boolean).join(", ")}
- Experience: ${job.experience_min_years || 0}-${job.experience_max_years || 0} years
- Must-have skills: ${Array.isArray(job.skills_must_have) ? job.skills_must_have.join(", ") : ""}
- Good-to-have skills: ${Array.isArray(job.skills_good_to_have) ? job.skills_good_to_have.join(", ") : ""}
- JD: ${(job.description || "").substring(0, 350)}

CANDIDATE:
- Name: ${candidate.name}
- Current role: ${candidate.current_role}
- Location: ${candidate.location}
- Experience: ${candidate.total_experience}
- Skills: ${Array.isArray(candidate.technical_skills) ? candidate.technical_skills.slice(0, 20).join(", ") : candidate.technical_skills}
- Summary: ${(candidate.summary || "").substring(0, 250)}
`

    const result = await model.generateContent(prompt)
    const analysis = result.response.text().trim()

    const now = new Date().toISOString()

    if (existingMatch) {
      await supabaseAdmin
        .from("job_matches")
        .update({ match_summary: analysis, updated_at: now })
        .eq("job_id", jobId)
        .eq("candidate_id", candidateId)
    } else {
      await supabaseAdmin
        .from("job_matches")
        .insert({ job_id: jobId, candidate_id: candidateId, match_summary: analysis, updated_at: now })
    }

    return NextResponse.json({ summary: analysis, cached: false })
  } catch (error: any) {
    console.error("AI Analysis error:", error)
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}
