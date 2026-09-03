import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { enrichLinkedInProfile, getPeakAIBalance, isPeakAIConfigured, PeakAIError } from "@/lib/peakai"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

interface EnrichRequest {
  profileIds: string[]
  contactTypes?: ("phone" | "email")[]
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId } = await params

  const body: EnrichRequest = await request.json().catch(() => ({}))
  const profileIds = Array.isArray(body.profileIds) ? body.profileIds : []
  const contactTypes: ("phone" | "email")[] =
    Array.isArray(body.contactTypes) && body.contactTypes.length > 0 ? body.contactTypes : ["phone", "email"]

  if (profileIds.length === 0) {
    return NextResponse.json({ error: "profileIds are required" }, { status: 400 })
  }

  if (!isPeakAIConfigured()) {
    return NextResponse.json(
      { error: "PeakAI is not configured. Set PEAKAI_ACCESS_TOKEN, or PEAKAI_EMAIL + PEAKAI_PASSWORD in the environment." },
      { status: 400 }
    )
  }

  const { data: profiles, error } = await supabaseAdmin
    .from("juicebox_profiles")
    .select("id, full_name, contact_id, linkedin_id, linkedin_url, enrichment_status")
    .eq("job_id", jobId)
    .in("id", profileIds)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!profiles || profiles.length === 0) return NextResponse.json({ error: "No profiles found" }, { status: 404 })

  const { data: existingContacts } = await supabaseAdmin
    .from("juicebox_contacts")
    .select("profile_id")
    .in("profile_id", profiles.map((p) => p.id))

  const alreadyEnriched = new Set((existingContacts || []).map((c) => c.profile_id))

  const enriched: string[] = []
  const failed: { profileId: string; name: string; message: string }[] = []
  const skipped: string[] = []
  let creditsCharged = 0

  for (const profile of profiles) {
    if (alreadyEnriched.has(profile.id)) {
      skipped.push(profile.full_name || profile.id)
      continue
    }

    await supabaseAdmin
      .from("juicebox_profiles")
      .update({ enrichment_status: "enriching", updated_at: new Date().toISOString() })
      .eq("id", profile.id)

    try {
      const result = await enrichLinkedInProfile({
        linkedinId: profile.linkedin_id,
        linkedinUrl: profile.linkedin_url,
        contactTypes,
      })

      const insert: Record<string, unknown> = {
        profile_id: profile.id,
        provider: "thepeakai",
        phone: result.phone || null,
        phone_verified: false,
        work_email: result.work_email || null,
        personal_email: result.personal_email || null,
        credits_charged: result.credits_charged || null,
        from_cache: result.from_cache || null,
        raw_json: result.raw || null,
      }

      const { error: upsertError } = await supabaseAdmin
        .from("juicebox_contacts")
        .upsert(insert, { onConflict: "profile_id,provider" })

      await supabaseAdmin
        .from("juicebox_profiles")
        .update({ enrichment_status: upsertError ? "failed" : "enriched", updated_at: new Date().toISOString() })
        .eq("id", profile.id)

      if (upsertError) {
        failed.push({ profileId: profile.id, name: profile.full_name || profile.id, message: upsertError.message })
      } else {
        creditsCharged += result.credits_charged || 0
        enriched.push(profile.full_name || profile.id)
      }
    } catch (err: any) {
      const message = err instanceof PeakAIError ? err.message : err?.message || "Unknown enrichment error"
      await supabaseAdmin
        .from("juicebox_profiles")
        .update({ enrichment_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", profile.id)
      failed.push({ profileId: profile.id, name: profile.full_name || profile.id, message })
      logger.warn("Juicebox enrichment failed", { profileId: profile.id, error: message })
    }
  }

  return NextResponse.json({
    total: profiles.length,
    enriched,
    skipped,
    failed,
    creditsCharged,
    balance: await getPeakAIBalance(),
  })
}
