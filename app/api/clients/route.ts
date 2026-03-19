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

function randomSuffix(len = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.post") && !hasPermission(ctx, "jobs.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin.from("clients").select("*").order("created_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data || [])
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.post") && !hasPermission(ctx, "jobs.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as any
  if (!body?.name || typeof body.name !== "string") return NextResponse.json({ error: "Name is required" }, { status: 400 })

  const desiredSlug = body.slug && typeof body.slug === "string" ? slugify(body.slug) : slugify(body.name)
  const baseSlug = desiredSlug || `client-${randomSuffix(6)}`

  let slug = baseSlug
  const { data: existing } = await supabaseAdmin.from("clients").select("id").eq("slug", slug).maybeSingle()
  if (existing?.id) slug = `${baseSlug}-${randomSuffix(4)}`

  const insert = {
    slug,
    name: body.name.trim(),
    about: typeof body.about === "string" ? body.about : null,
    website: typeof body.website === "string" ? body.website.trim() : "",
    company_type: typeof body.company_type === "string" ? body.company_type : null,
    company_subtype: typeof body.company_subtype === "string" ? body.company_subtype : null,
    location: typeof body.location === "string" ? body.location : null,
    logo_url: typeof body.logo_url === "string" ? body.logo_url : null,
    primary_contact_name: typeof body.primary_contact_name === "string" ? body.primary_contact_name.trim() : null,
    primary_contact_email: typeof body.primary_contact_email === "string" ? body.primary_contact_email.trim() : null,
    primary_contact_phone: typeof body.primary_contact_phone === "string" ? body.primary_contact_phone : null,
    additional_contacts: Array.isArray(body.additional_contacts) ? body.additional_contacts : [],
    created_at: nowIso(),
    updated_at: nowIso()
  }

  const { data, error } = await supabaseAdmin.from("clients").insert(insert).select("*").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
