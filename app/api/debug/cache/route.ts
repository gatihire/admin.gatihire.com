import { NextRequest, NextResponse } from "next/server"
import { redis } from "@/lib/redis"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Cache health check.
 *
 * Answers the only question that matters after configuring Redis: is the layer
 * actually live? The cache degrades to a no-op when the env vars are missing, so
 * a green portal does not prove caching is working.
 *
 * GET /api/debug/cache
 */
export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!ctx.isSuperAdmin && !hasPermission(ctx, "analytics.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const env = {
    hasUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL),
    hasToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN),
  }

  if (!redis) {
    return NextResponse.json({
      redisConfigured: false,
      roundTrip: false,
      env,
      hint:
        "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (REST URL, not redis://) and redeploy. " +
        "Until then every cache call is a no-op and pages are served directly from Postgres.",
    })
  }

  const key = `health:${ctx.authUser.id}:${Date.now()}`
  const payload = { ok: true, at: new Date().toISOString() }
  const startedAt = Date.now()
  let roundTrip = false
  let error: string | null = null

  try {
    roundTrip = await Promise.race<boolean>([
      (async () => {
        await redis!.set(key, payload, { ex: 30 })
        const got = await redis!.get<typeof payload>(key)
        return Boolean(got?.ok)
      })(),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("Redis timed out after 3000ms")), 3000),
      ),
    ])
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown Redis error"
  }

  // Best-effort cleanup; never fail the response because of it.
  try {
    await redis.del(key)
  } catch {
    /* noop */
  }

  return NextResponse.json({
    redisConfigured: true,
    roundTrip,
    latencyMs: Date.now() - startedAt,
    env,
    error,
  })
}
