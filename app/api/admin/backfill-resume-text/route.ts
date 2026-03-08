import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"

import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

function normalizeText(v: unknown) {
  return String(v || "").trim()
}

function listText(label: string, values: unknown[]) {
  const items = (Array.isArray(values) ? values : []).map((v) => normalizeText(v)).filter(Boolean)
  if (!items.length) return ""
  return `${label}: ${items.join(", ")}`
}

function buildResumeText(row: any) {
  const lines: string[] = []
  const name = normalizeText(row?.name)
  const currentRole = normalizeText(row?.current_role)
  const desiredRole = normalizeText(row?.desired_role)
  const location = normalizeText(row?.location)
  const company = normalizeText(row?.current_company)
  const summary = normalizeText(row?.summary)
  const experience = normalizeText(row?.total_experience)
  const qualification = normalizeText(row?.highest_qualification)
  const degree = normalizeText(row?.degree)
  const university = normalizeText(row?.university)
  const workDuration = Array.isArray(row?.work_duration) ? row.work_duration : []

  if (name) lines.push(`Name: ${name}`)
  if (currentRole) lines.push(`Current Role: ${currentRole}`)
  if (desiredRole) lines.push(`Desired Role: ${desiredRole}`)
  if (company) lines.push(`Company: ${company}`)
  if (location) lines.push(`Location: ${location}`)
  if (experience) lines.push(`Experience: ${experience}`)
  if (summary) lines.push(`Summary: ${summary}`)
  if (qualification || degree || university) {
    const eduParts = [qualification, degree, university].filter(Boolean).join(", ")
    lines.push(`Education: ${eduParts}`)
  }

  const skills = listText("Technical Skills", row?.technical_skills || [])
  if (skills) lines.push(skills)
  const softSkills = listText("Soft Skills", row?.soft_skills || [])
  if (softSkills) lines.push(softSkills)
  const certifications = listText("Certifications", row?.certifications || [])
  if (certifications) lines.push(certifications)
  const companies = listText("Previous Companies", row?.previous_companies || [])
  if (companies) lines.push(companies)
  const titles = listText("Job Titles", row?.job_titles || [])
  if (titles) lines.push(titles)
  const durations = listText("Work Duration", workDuration)
  if (durations) lines.push(durations)

  return lines.join("\n").trim()
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = request.nextUrl.searchParams
  const limit = Math.min(Math.max(Number(sp.get("limit") || 25) || 25, 1), 200)
  const minChars = Math.min(Math.max(Number(sp.get("minChars") || 200) || 200, 0), 5000)

  const { data: rows, error } = await supabaseAdmin
    .from("candidates")
    .select("id,name,current_role,desired_role,current_company,location,total_experience,summary,technical_skills,soft_skills,certifications,previous_companies,job_titles,work_duration,highest_qualification,degree,university,resume_text")
    .or("resume_text.is.null,resume_text.eq.")
    .order("uploaded_at", { ascending: false })
    .limit(limit)

  if (error) return NextResponse.json({ error: "Failed to load candidates" }, { status: 500 })

  const processed: Array<{ id: string; status: string; message?: string }> = []
  let updated = 0
  let skipped = 0
  let failed = 0

  for (const row of rows || []) {
    const id = String((row as any)?.id || "")
    if (!id) continue

    const resumeText = buildResumeText(row)
    if (resumeText.length < minChars) {
      skipped += 1
      processed.push({ id, status: "skipped", message: "too_short" })
      continue
    }

    const { error: updErr } = await supabaseAdmin
      .from("candidates")
      .update({ resume_text: resumeText, updated_at: new Date().toISOString() })
      .eq("id", id)

    if (updErr) {
      failed += 1
      processed.push({ id, status: "failed", message: updErr.message })
      continue
    }

    updated += 1
    processed.push({ id, status: "updated" })
  }

  return NextResponse.json({
    ok: true,
    scanned: rows?.length || 0,
    updated,
    skipped,
    failed,
    processed,
  })
}
