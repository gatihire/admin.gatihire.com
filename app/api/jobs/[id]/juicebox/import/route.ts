import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { parseJuiceboxPayload, profileDedupeKey, type JuiceboxProfileInput } from "@/lib/juicebox-importer"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

async function insertProfile(jobId: string, batchId: string, order: number, profile: JuiceboxProfileInput) {
  const { data: inserted, error } = await supabaseAdmin
    .from("juicebox_profiles")
    .insert({
      job_id: jobId,
      import_batch_id: batchId,
      import_order: order,
      contact_id: profile.contact_id,
      linkedin_id: profile.linkedin_id,
      linkedin_url: profile.linkedin_url,
      first_name: profile.first_name,
      last_name: profile.last_name,
      full_name: profile.full_name || [profile.first_name, profile.last_name].filter(Boolean).join(" "),
      job_title: profile.job_title,
      job_company_name: profile.job_company_name,
      job_company_website: profile.job_company_website,
      location_name: profile.location_name,
      location_locality: profile.location_locality,
      location_country: profile.location_country,
      summary: profile.summary,
      total_experience_months: profile.total_experience_months,
      average_tenure: profile.average_tenure,
      ai_skills: profile.ai_skills,
      languages: profile.languages,
      tags: profile.tags,
      enrichment_status: "pending",
      raw_json: profile.raw,
    })
    .select("id")
    .single()

  if (error) return { ok: false, error }
  if (!inserted) return { ok: false, error: { message: "No row returned" } as any }

  const profileId = inserted.id

  if (profile.experience.length > 0) {
    await supabaseAdmin.from("juicebox_experience").insert(
      profile.experience.map((e, i) => ({ ...e, profile_id: profileId, sort_order: i }))
    )
  }

  if (profile.education.length > 0) {
    await supabaseAdmin.from("juicebox_education").insert(
      profile.education.map((e, i) => ({ ...e, profile_id: profileId, sort_order: i }))
    )
  }

  return { ok: true, id: profileId }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId } = await params

  const { data: job } = await supabaseAdmin.from("jobs").select("id, title").eq("id", jobId).maybeSingle()
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })

  let payloadText = ""
  try {
    const formData = await request.formData()
    const file = formData.get("file")
    if (!file || typeof (file as any).text !== "function") {
      return NextResponse.json({ error: "No JSON file provided" }, { status: 400 })
    }
    payloadText = await (file as File).text()
  } catch {
    return NextResponse.json({ error: "Failed to read file" }, { status: 400 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(payloadText)
  } catch {
    return NextResponse.json({ error: "File is not valid JSON" }, { status: 400 })
  }

  const { profiles, errors } = parseJuiceboxPayload(payload)

  // Dedupe within the file (first occurrence wins) and against the database.
  const seenKeys = new Set<string>()
  const uniqueProfiles: JuiceboxProfileInput[] = []
  let inFileDuplicates = 0
  for (const profile of profiles) {
    const key = profileDedupeKey(profile)
    if (key && seenKeys.has(key)) {
      inFileDuplicates++
      continue
    }
    if (key) seenKeys.add(key)
    uniqueProfiles.push(profile)
  }

  const keys = uniqueProfiles.map(profileDedupeKey).filter(Boolean)
  let existingKeys = new Set<string>()
  if (keys.length > 0) {
    const { data: existing } = await supabaseAdmin
      .from("juicebox_profiles")
      .select("contact_id, linkedin_id")
      .or(`contact_id.in.(${keys.join(",")}),linkedin_id.in.(${keys.join(",")})`)
    for (const row of existing || []) {
      if (row.contact_id) existingKeys.add(row.contact_id)
      if (row.linkedin_id) existingKeys.add(row.linkedin_id)
    }
  }

  const batchId = crypto.randomUUID()
  let imported = 0
  let alreadyExists = 0
  const rowErrors: { index: number; message: string }[] = []

  for (let i = 0; i < uniqueProfiles.length; i++) {
    const profile = uniqueProfiles[i]
    const key = profileDedupeKey(profile)
    if (key && existingKeys.has(key)) {
      alreadyExists++
      continue
    }

    const result = await insertProfile(jobId, batchId, i, profile)
    if (result.ok) {
      imported++
    } else {
      rowErrors.push({
        index: i,
        message: result.error?.message || "Insert failed",
      })
      logger.warn("Juicebox profile insert failed", { jobId, index: i, error: result.error?.message })
    }
  }

  return NextResponse.json({
    success: true,
    batchId,
    total: profiles.length,
    imported,
    duplicates: inFileDuplicates,
    alreadyExists,
    errors: [...errors, ...rowErrors],
  })
}
