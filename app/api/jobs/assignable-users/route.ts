import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { listAssignableUsers } from "@/lib/jobs/assignments"

export const runtime = "nodejs"

/** The people a job can be assigned to. Gated on `jobs.assign`. */
export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.assign")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const users = await listAssignableUsers()
  return NextResponse.json({
    users,
    viewer: { id: ctx.authUser.id, email: ctx.authUser.email },
  })
}
