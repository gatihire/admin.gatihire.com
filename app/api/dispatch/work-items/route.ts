import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { applyWorkItemAction, type WorkItemAction } from "@/lib/dispatch/work-item-states"

export const runtime = "nodejs"

const MAX_BULK = 100

/**
 * Bulk snooze / unsnooze / manual-call / done, used by the Today queue's selection bar.
 */
export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const canAct = hasPermission(ctx, "applications.manage")
  if (!canAct) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const action = String(body?.action || "") as WorkItemAction
  if (!["snooze", "unsnooze", "log_call", "done", "undone"].includes(action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }

  const applicationIds = Array.isArray(body?.applicationIds)
    ? body.applicationIds.map((id: any) => String(id)).filter(Boolean).slice(0, MAX_BULK)
    : []
  if (applicationIds.length === 0) {
    return NextResponse.json({ error: "applicationIds is required" }, { status: 400 })
  }

  const results = await Promise.all(
    applicationIds.map((applicationId: string) =>
      applyWorkItemAction({
        applicationId,
        action,
        until: body?.until,
        hours: body?.hours,
        reason: body?.reason,
        outcome: body?.outcome,
        note: body?.note,
        actorId: ctx.authUser.id,
        actorEmail: ctx.authUser.email,
      })
    )
  )

  const succeeded = results.filter((r) => r.ok).length
  return NextResponse.json({ success: true, action, requested: applicationIds.length, succeeded })
}
