import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext } from "@/lib/internal-auth"
import { getProviderPause } from "@/lib/provider-health"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Is outbound calling healthy right now?
 *
 * A provider-wide failure (no balance, quota) is one fact, not per-candidate
 * state. Exposing it lets the pipeline show ONE banner instead of making a
 * recruiter infer it from twenty identical "failed" cards — which is exactly
 * what the 16–18 November outage looked like.
 */
export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pause = await getProviderPause(true)
  return NextResponse.json({
    paused: pause.paused,
    reason: pause.reason || null,
    since: pause.since || null,
  })
}
