import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"

import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { toE164, resolvePhone } from "@/lib/phone"

// Backfill candidates.phone_e164 so the Meta webhook lookup can use the fast
// indexed path and send/lookup always share the canonical number.
// GET -> status/counts, POST -> process N rows (deterministic first, LLM for
// ambiguous ones).

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { count: total } = await supabaseAdmin.from("candidates").select("id", { count: "exact", head: true })
  const { count: missing } = await supabaseAdmin
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .or(`phone_e164.is.null,phone_e164.eq.`)

  const { count: unmatchable } = await supabaseAdmin
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .or("phone.is.null,phone.eq.")

  return NextResponse.json({
    ok: true,
    totalCandidates: total || 0,
    missingPhoneE164: missing || 0,
    missingPhone: unmatchable || 0,
  })
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = request.nextUrl.searchParams
  const limit = Math.min(Math.max(Number(sp.get("limit") || 100) || 100, 1), 500)
  const useLlm = sp.get("llm") === "1" || sp.get("llm") === "true"

  const { data: rows, error } = await supabaseAdmin
    .from("candidates")
    .select("id,phone,phone_e164")
    .or(`phone_e164.is.null,phone_e164.eq.`)
    .not("phone", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit)

  if (error) return NextResponse.json({ error: "Failed to load candidates" }, { status: 500 })

  const processed: Array<{ id: string; status: string; phone: string; phone_e164: string | null; message?: string }> = []
  let updated = 0
  let skipped = 0
  let failed = 0

  for (const row of rows || []) {
    const id = String((row as any)?.id || "")
    const raw = String((row as any)?.phone || "")
    if (!id || !raw) continue

    try {
      const deterministic = toE164(raw)
      let e164 = deterministic || null
      let usedLlm = false

      if (useLlm || (deterministic && deterministic.replace(/\D/g, "").length !== 12)) {
        const resolved = await resolvePhone(raw)
        if (resolved.e164 && resolved.e164.replace(/\D/g, "").length >= 12) {
          e164 = resolved.e164
          usedLlm = resolved.llm
        }
      }

      if (!e164) {
        skipped += 1
        processed.push({ id, status: "skipped", phone: raw, phone_e164: null, message: "unparseable" })
        continue
      }

      const { error: updErr } = await supabaseAdmin
        .from("candidates")
        .update({ phone_e164: e164, updated_at: new Date().toISOString() })
        .eq("id", id)

      if (updErr) {
        failed += 1
        processed.push({ id, status: "failed", phone: raw, phone_e164: e164, message: updErr.message })
        continue
      }

      updated += 1
      processed.push({ id, status: usedLlm ? "updated_llm" : "updated", phone: raw, phone_e164: e164 })
    } catch (e: any) {
      failed += 1
      processed.push({ id, status: "failed", phone: raw, phone_e164: null, message: e?.message })
    }
  }

  return NextResponse.json({ ok: true, updated, skipped, failed, processed })
}