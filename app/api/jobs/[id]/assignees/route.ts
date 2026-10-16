import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { setJobAssignees } from "@/lib/jobs/assignments"

export const runtime = "nodejs"

/**
 * Set the primary owner and the collaborator set for a job.
 *
 * Body: { ownerAuthUserId: string | null, collaboratorIds: string[] }
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.assign")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params
  const body = await request.json().catch(() => null)

  const ownerRaw = body?.ownerAuthUserId
  const ownerAuthUserId =
    typeof ownerRaw === "string" && ownerRaw.trim() ? ownerRaw.trim() : null
  const collaboratorIds = Array.isArray(body?.collaboratorIds)
    ? body.collaboratorIds.map((v: any) => String(v)).filter(Boolean)
    : []

  const result = await setJobAssignees({
    jobId: id,
    ownerAuthUserId,
    collaboratorIds,
    actorId: ctx.authUser.id,
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error || "Failed to update assignment" },
      { status: result.error === "Job not found" ? 404 : 500 }
    )
  }

  return NextResponse.json({
    success: true,
    ownerAuthUserId,
    collaboratorIds,
    previousOwnerAuthUserId: result.previousOwnerAuthUserId ?? null,
  })
}
