import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export const runtime = "nodejs"

/**
 * Mark a WhatsApp thread handled ("Done"), or restore it.
 *
 * Only the operator-state row (public.whatsapp_thread_states) is written — the
 * thread itself is untouched, so nothing is lost. The inbox view hides a thread
 * while its done_at is at or after the thread's last activity, so a later reply
 * brings it back on its own.
 *
 * Mirrors the Today board's done/undone (lib/dispatch/work-item-states.ts).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ participantId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { participantId } = await params
  const body = await request.json().catch(() => null)
  const action = String(body?.action || "done")
  if (action !== "done" && action !== "undone") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }

  const nowIso = new Date().toISOString()
  const { error } = await supabaseAdmin.from("whatsapp_thread_states").upsert(
    {
      participant_id: participantId,
      done_at: action === "done" ? nowIso : null,
      done_by: action === "done" ? ctx.authUser.id : null,
      updated_at: nowIso,
    },
    { onConflict: "participant_id" }
  )

  if (error) {
    // 20261017 adds this table. Say so plainly instead of a bare 500.
    const code = String((error as any)?.code || "")
    const missing =
      code === "42P01" ||
      code === "PGRST205" ||
      /does not exist|could not find the table/i.test(error.message || "")
    return NextResponse.json(
      { error: missing ? "The inbox 'done' migration (20261017) has not been applied yet." : error.message },
      { status: missing ? 503 : 500 }
    )
  }

  return NextResponse.json({ success: true, action })
}
