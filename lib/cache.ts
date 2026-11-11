import { redis } from "@/lib/redis"

/**
 * Application cache layer.
 *
 * Design goals:
 *  - Never break a request because the cache is missing, slow or erroring.
 *  - One helper (`cached`) for read-through caching with single-flight, so a
 *    burst of concurrent requests on the same key runs the loader once.
 *  - Namespaced keys so whole feature areas can be invalidated at once.
 *
 * If `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are not configured,
 * every call degrades to a no-op: reads return `null`, writes are dropped and
 * `cached()` simply runs the loader. That means the app works identically
 * (just without the speed-up) on a machine with no Redis.
 */

const KEY_PREFIX = "gh"

/** A dead or slow Redis must never add latency to a page load. */
const REDIS_OP_TIMEOUT_MS = 1200

/** In-process single-flight: collapses concurrent identical loads. */
const inFlight = new Map<string, Promise<unknown>>()

/** Rate-limit error logging so a Redis outage does not spam the logs. */
let lastErrorLogAt = 0
const ERROR_LOG_INTERVAL_MS = 30_000

function noteError(operation: string, error: unknown) {
  const now = Date.now()
  if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return
  lastErrorLogAt = now
  console.warn(`[cache] ${operation} failed:`, error instanceof Error ? error.message : error)
}

function withRedisTimeout<T>(promise: Promise<T>, operation: string): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      noteError(operation, new Error(`timed out after ${REDIS_OP_TIMEOUT_MS}ms`))
      resolve(null)
    }, REDIS_OP_TIMEOUT_MS)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        noteError(operation, error)
        resolve(null)
      },
    )
  })
}

export function cacheKey(namespace: string, key: string) {
  return `${KEY_PREFIX}:${namespace}:${key}`
}

/** Spread expiries so a whole namespace does not fall out of cache at once. */
function withJitter(ttlSeconds: number, jitterRatio = 0.12) {
  const jitter = Math.floor(ttlSeconds * jitterRatio * Math.random())
  return Math.max(1, ttlSeconds + jitter)
}

export async function cacheGet<T>(namespace: string, key: string): Promise<T | null> {
  if (!redis) return null
  const value = await withRedisTimeout<T | null>(
    redis.get<T>(cacheKey(namespace, key)),
    `get ${namespace}`,
  )
  return value ?? null
}

export async function cacheSet<T>(
  namespace: string,
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  if (!redis) return
  await withRedisTimeout(
    redis.set(cacheKey(namespace, key), value, { ex: withJitter(ttlSeconds) }),
    `set ${namespace}`,
  )
}

export async function cacheDelete(namespace: string, key: string): Promise<void> {
  if (!redis) return
  await withRedisTimeout(redis.del(cacheKey(namespace, key)), `del ${namespace}`)
}

/**
 * Invalidate every key in a namespace.
 *
 * Uses SCAN (never KEYS) and is bounded, because the admin cache namespaces are
 * small and this runs only on writes (role change, job edit, …).
 */
export async function cacheDeleteNamespace(namespace: string): Promise<void> {
  if (!redis) return
  const match = `${KEY_PREFIX}:${namespace}:*`
  let cursor = "0"
  let iterations = 0
  try {
    do {
      const result = await withRedisTimeout(
        redis.scan(cursor, { match, count: 200 }) as Promise<[string, string[]]>,
        `scan ${namespace}`,
      )
      if (!result) return
      const [nextCursor, keys] = result
      cursor = String(nextCursor)
      if (keys.length > 0) {
        await withRedisTimeout(redis.del(...keys), `del ${namespace} keys`)
      }
      iterations += 1
      // Safety valve: never loop forever on a huge namespace.
    } while (cursor !== "0" && iterations < 50)
  } catch (error) {
    noteError(`scan ${namespace}`, error)
  }
}

/**
 * Read-through cache with single-flight.
 *
 * `load()` is awaited only on a miss. Concurrent callers for the same key share
 * one in-process promise, and a cache miss caused by Redis being unavailable
 * still returns fresh data.
 *
 * Set `ttlSeconds` to 0 to bypass caching entirely (useful for a `force` path).
 */
export async function cached<T>(
  namespace: string,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  if (!redis || ttlSeconds <= 0) return load()

  const fullKey = cacheKey(namespace, key)

  const existing = inFlight.get(fullKey) as Promise<T> | undefined
  if (existing) return existing

  const task = (async () => {
    const hit = await cacheGet<T>(namespace, key)
    if (hit !== null && hit !== undefined) return hit

    const value = await load()
    // Do not cache empty/falsey results: a transient DB blip would otherwise
    // pin "no data" in the cache for the whole TTL.
    if (value) await cacheSet(namespace, key, value, ttlSeconds)
    return value
  })()

  inFlight.set(fullKey, task)
  try {
    return await task
  } finally {
    inFlight.delete(fullKey)
  }
}

/** Namespaces, in one place so invalidation call sites cannot typo them. */
export const CacheNamespace = {
  permissions: "perm",
  metrics: "metrics",
  analytics: "analytics",
  clients: "clients",
  jobs: "jobs",
  candidateList: "candlist",
} as const

/** TTLs, in seconds. Keep these next to the namespaces they belong to. */
export const CacheTtl = {
  permissions: 60,
  metrics: 60,
  analytics: 120,
  clients: 120,
  jobs: 60,
  candidateList: 20,
} as const
