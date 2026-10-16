import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { applyWorkItemAction, type WorkItemAction } from "@/lib/dispatch/work-item-states"

export const runtime = "nodejs"

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ applicationId: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const canAct = hasPermission(ctx, "applications.manage")
  if (!canAct) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { applicationId } = await params
  const body = await request.json().catch(() => null)
  const action = String(body?.action || "") as WorkItemAction
  if (!["snooze", "unsnooze", "log_call"].includes(action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }

  const result = await applyWorkItemAction({
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
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Failed" }, { status: result.error === "Application not found" ? 404 : 500 })
  }

  return NextResponse.json({ success: true, action })
}
