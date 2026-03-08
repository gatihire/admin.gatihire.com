import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

function nowIso() {
  return new Date().toISOString()
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 50)
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.post") && !hasPermission(ctx, "jobs.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id } = await params

  const body = (await request.json().catch(() => null)) as any
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })

  const patch: Record<string, unknown> = { updated_at: nowIso() }
  const allowed = [
    "slug",
    "name",
    "about",
    "website",
    "company_type",
    "company_subtype",
    "location",
    "logo_url",
    "primary_contact_name",
    "primary_contact_email",
    "primary_contact_phone",
    "additional_contacts",
    "about_generated_at",
    "about_source_url"
  ]
  for (const k of allowed) {
    if (k in body) patch[k] = body[k]
  }
  if (typeof patch.slug === "string") patch.slug = slugify(patch.slug)

  if ("website" in patch) {
    if (typeof patch.website !== "string" || !patch.website.trim()) {
      return NextResponse.json({ error: "Website is required" }, { status: 400 })
    }
    patch.website = patch.website.trim()
  }
  if ("primary_contact_name" in patch) {
    if (typeof patch.primary_contact_name !== "string" || !patch.primary_contact_name.trim()) {
      return NextResponse.json({ error: "Primary contact name is required" }, { status: 400 })
    }
    patch.primary_contact_name = patch.primary_contact_name.trim()
  }
  if ("primary_contact_email" in patch) {
    if (typeof patch.primary_contact_email !== "string" || !patch.primary_contact_email.trim()) {
      return NextResponse.json({ error: "Primary contact email is required" }, { status: 400 })
    }
    patch.primary_contact_email = patch.primary_contact_email.trim()
  }
  if ("additional_contacts" in patch) {
    patch.additional_contacts = Array.isArray(patch.additional_contacts) ? patch.additional_contacts : []
  }

  const { data, error } = await supabaseAdmin.from("clients").update(patch).eq("id", id).select("*").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params

  const { error } = await supabaseAdmin.from("clients").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
