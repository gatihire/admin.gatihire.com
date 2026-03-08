import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"

import { supabaseAdmin } from "@/lib/supabase"
import { generateEmbedding } from "@/lib/ai-utils"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

function normalizeText(v: unknown) {
  return String(v || "").trim()
}

function buildEmbeddingInput(row: any) {
  const parts = [
    normalizeText(row?.current_role),
    normalizeText(row?.desired_role),
    normalizeText(row?.current_company),
    normalizeText(row?.location),
    normalizeText(row?.summary),
    normalizeText(row?.resume_text),
  ].filter(Boolean)
  return parts.join("\n")
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const [{ count: total }, { count: missingEmbedding }, { count: missingResumeText }] = await Promise.all([
    supabaseAdmin.from("candidates").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("candidates").select("id", { count: "exact", head: true }).is("embedding", null),
    supabaseAdmin
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .or("resume_text.is.null,resume_text.eq.")
  ])

  const { data: latest } = await supabaseAdmin
    .from("candidates")
    .select("uploaded_at")
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    ok: true,
    totalCandidates: total || 0,
    missingEmbedding: missingEmbedding || 0,
    missingResumeText: missingResumeText || 0,
    latestUploadedAt: (latest as any)?.uploaded_at || null,
  })
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = request.nextUrl.searchParams
  const limit = Math.min(Math.max(Number(sp.get("limit") || 25) || 25, 1), 200)
  const threshold = Math.min(Math.max(Number(sp.get("minChars") || 200) || 200, 0), 5000)

  const { data: rows, error } = await supabaseAdmin
    .from("candidates")
    .select("id,resume_text,summary,current_role,desired_role,current_company,location")
    .is("embedding", null)
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

    const input = buildEmbeddingInput(row)
    if (input.length < threshold) {
      skipped += 1
      processed.push({ id, status: "skipped", message: "too_short" })
      continue
    }

    try {
      const embedding = await generateEmbedding(input)
      if (!Array.isArray(embedding) || embedding.length === 0) {
        skipped += 1
        processed.push({ id, status: "skipped", message: "empty_embedding" })
        continue
      }

      const { error: updErr } = await supabaseAdmin
        .from("candidates")
        .update({ embedding, updated_at: new Date().toISOString() })
        .eq("id", id)

      if (updErr) {
        failed += 1
        processed.push({ id, status: "failed", message: updErr.message })
        continue
      }

      updated += 1
      processed.push({ id, status: "updated" })
    } catch (e: any) {
      failed += 1
      processed.push({ id, status: "failed", message: String(e?.message || e) })
    }
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
