import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "jobs.view") && !hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = await params
    const { data, error } = await supabaseAdmin.from("jobs").select("*").eq("id", id).single()

    if (error) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    return NextResponse.json(data)
  } catch (error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.edit") && !hasPermission(ctx, "jobs.post")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))

    const normalizeOptionalString = (value: unknown) => {
      if (typeof value !== "string") return value
      const trimmed = value.trim()
      return trimmed.length ? trimmed : null
    }

    const sections = Array.isArray((body as any)?.sections) ? (body as any).sections : null
    if (body && typeof body === "object" && "sections" in body) {
      delete (body as any).sections
    }

    const safeArray = (v: any): any[] | null => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : null)
    ;(body as any).languages_required = (body as any)?.languages_required !== undefined ? safeArray((body as any).languages_required) : (body as any).languages_required
    ;(body as any).skills_must_have = (body as any)?.skills_must_have !== undefined ? safeArray((body as any).skills_must_have) : (body as any).skills_must_have
    ;(body as any).skills_good_to_have = (body as any)?.skills_good_to_have !== undefined ? safeArray((body as any).skills_good_to_have) : (body as any).skills_good_to_have

    const optionalStringKeys = [
      "industry",
      "sub_category",
      "city",
      "urgency_tag",
      "education_min",
      "english_level",
      "license_type",
      "gender_preference",
      "role_category",
      "department_category",
      "client_id",
      "client_name",
      "external_apply_url"
    ]
    for (const k of optionalStringKeys) {
      if ((body as any)?.[k] !== undefined) (body as any)[k] = normalizeOptionalString((body as any)[k])
    }
    
    if ((body as any)?.apply_type !== undefined) {
      ;(body as any).apply_type = (body as any).apply_type === "external" ? "external" : "in_platform"
      if ((body as any).apply_type !== "external") {
        ;(body as any).external_apply_url = null
      }
    }

    const { data, error } = await supabaseAdmin
      .from("jobs")
      .update(body)
      .eq("id", id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (sections && sections.length > 0) {
      try {
        await supabaseAdmin.from("job_sections").delete().eq("job_id", id)
        const rows = sections
          .filter((s: any) => s && typeof s.section_key === "string" && typeof s.heading === "string" && typeof s.body_md === "string")
          .map((s: any, idx: number) => ({
            job_id: id,
            section_key: s.section_key,
            heading: s.heading,
            body_md: s.body_md,
            sort_order: typeof s.sort_order === "number" ? s.sort_order : idx,
            is_visible: typeof s.is_visible === "boolean" ? s.is_visible : true,
          }))
        if (rows.length) {
          const { error: sErr } = await supabaseAdmin.from("job_sections").insert(rows)
          if (sErr) console.warn("Failed to save job sections:", sErr)
        }
      } catch (e) {
        console.warn("Failed to save job sections:", e)
      }
    }

    return NextResponse.json(data)
  } catch (error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const { id } = await params
    const { error } = await supabaseAdmin
      .from("jobs")
      .delete()
      .eq("id", id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ message: "Job deleted successfully" })
  } catch (error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
