import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"

export const runtime = "nodejs"

/**
 * Claim an unassigned job for yourself.
 *
 * Deliberately not an overwrite: if the job already has an owner the caller gets
 * a 409 and must be given it by someone with `jobs.assign`. That keeps "claim"
 * from becoming a silent steal.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.claim")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params

  const { data: job } = await supabaseAdmin
    .from("jobs")
    .select("id, owner_auth_user_id")
    .eq("id", id)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })

  if ((job as any).owner_auth_user_id && (job as any).owner_auth_user_id !== ctx.authUser.id) {
    return NextResponse.json({ error: "This job already has an owner" }, { status: 409 })
  }

  const { error } = await supabaseAdmin
    .from("jobs")
    .update({ owner_auth_user_id: ctx.authUser.id })
    .eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin
    .from("analytics_events")
    .insert({
      actor_auth_user_id: ctx.authUser.id,
      event_name: "job.claimed",
      entity_type: "jobs",
      entity_id: id,
      metadata: { previous_owner_auth_user_id: (job as any).owner_auth_user_id ?? null },
    })
    .then(() => {})

  return NextResponse.json({ success: true, ownerAuthUserId: ctx.authUser.id })
}
