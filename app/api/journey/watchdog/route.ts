import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { sweepJourney, type JourneyBucket } from "@/lib/journey-watchdog"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * The journey watchdog endpoint.
 *
 * GET  /api/journey/watchdog?dry=1   -> dry run: what would be rescued
 * GET  /api/journey/watchdog          -> rescue what can be rescued
 * GET  /api/journey/watchdog?bucket=booked_not_fired
 *
 * This exists as an endpoint (not only as an in-process sweep) so the work can
 * be inspected and triggered on demand, and so a scheduler can drive it.
 */
export async function GET(request: NextRequest) {
  // A scheduler authenticates with the cron secret; a human uses their session.
  const cronSecret = process.env.CRON_SECRET || ""
  const authHeader = request.headers.get("authorization") || ""
  const cronHeader = request.headers.get("x-cron-secret") || ""
  const isCron =
    !!cronSecret && (authHeader === `Bearer ${cronSecret}` || cronHeader === cronSecret)

  if (!isCron) {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!ctx.isSuperAdmin && !hasPermission(ctx, "applications.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
  }

  const { searchParams } = new URL(request.url)
  const dry = searchParams.get("dry") === "1"
  const bucketParam = searchParams.get("bucket")

  const buckets = (
    bucketParam
      ? bucketParam.split(",").map((b) => b.trim()).filter(Boolean)
      : undefined
  ) as JourneyBucket[] | undefined

  try {
    const result = await sweepJourney({ dry, buckets })
    return NextResponse.json({ ...result, dry })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Watchdog failed" },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
