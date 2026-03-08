import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

type SessionCacheEntry<T> = {
  value: T
  fetchedAt: number
  expiresAt: number
}

const SESSION_CACHE_PREFIX = "truckinzy:sessionCache:"
const memorySessionCache = new Map<string, { entry?: SessionCacheEntry<any>; inflight?: Promise<any> }>()

function nowMs() {
  return Date.now()
}

function buildSessionCacheStorageKey(key: string) {
  return `${SESSION_CACHE_PREFIX}${key}`
}

export function peekSessionCache<T>(key: string): T | null {
  if (typeof window === "undefined") return null

  const mem = memorySessionCache.get(key)?.entry
  if (mem && mem.expiresAt > nowMs()) return mem.value as T

  try {
    const raw = window.sessionStorage.getItem(buildSessionCacheStorageKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as SessionCacheEntry<T>
    if (!parsed || typeof parsed !== "object") return null
    if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= nowMs()) return null
    memorySessionCache.set(key, { entry: parsed })
    return parsed.value
  } catch {
    return null
  }
}

export function invalidateSessionCache(keyOrPrefix: string, opts?: { prefix?: boolean }) {
  if (typeof window === "undefined") return

  const prefix = Boolean(opts?.prefix)
  if (!prefix) {
    memorySessionCache.delete(keyOrPrefix)
    try {
      window.sessionStorage.removeItem(buildSessionCacheStorageKey(keyOrPrefix))
    } catch {}
    return
  }

  const storagePrefix = buildSessionCacheStorageKey(keyOrPrefix)
  try {
    const keysToRemove: string[] = []
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i)
      if (!k) continue
      if (k.startsWith(storagePrefix)) keysToRemove.push(k)
    }
    keysToRemove.forEach((k) => window.sessionStorage.removeItem(k))
  } catch {}

  Array.from(memorySessionCache.keys()).forEach((k) => {
    if (k.startsWith(keyOrPrefix)) memorySessionCache.delete(k)
  })
}

export async function getSessionCached<T>(
  key: string,
  loader: () => Promise<T>,
  opts?: { ttlMs?: number; force?: boolean },
): Promise<T> {
  const ttlMs = typeof opts?.ttlMs === "number" && opts.ttlMs > 0 ? opts.ttlMs : 5 * 60_000
  const force = Boolean(opts?.force)

  if (typeof window === "undefined") {
    return loader()
  }

  if (!force) {
    const cached = peekSessionCache<T>(key)
    if (cached !== null) return cached
  }

  const existing = memorySessionCache.get(key)
  if (!force && existing?.inflight) return existing.inflight as Promise<T>

  const inflight = (async () => {
    const value = await loader()
    const t = nowMs()
    const entry: SessionCacheEntry<T> = { value, fetchedAt: t, expiresAt: t + ttlMs }
    memorySessionCache.set(key, { entry })
    try {
      window.sessionStorage.setItem(buildSessionCacheStorageKey(key), JSON.stringify(entry))
    } catch {}
    return value
  })()

  memorySessionCache.set(key, { ...(existing || {}), inflight })

  try {
    return await inflight
  } finally {
    const cur = memorySessionCache.get(key)
    if (cur?.inflight === inflight) {
      memorySessionCache.set(key, { entry: cur.entry })
    }
  }
}

export async function cachedFetchJson<T>(
  key: string,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { ttlMs?: number; force?: boolean },
): Promise<T> {
  return getSessionCached<T>(
    key,
    async () => {
      const res = await fetch(input, {
        credentials: (init as any)?.credentials ?? "include",
        ...init,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const msg = (data as any)?.error || (data as any)?.message || "Request failed"
        throw new Error(msg)
      }
      return data as T
    },
    opts,
  )
}

export function getBoardAppBaseUrl() {
  const raw = String(
    process.env.NEXT_PUBLIC_CANDIDATE_APP_BASE_URL
      || process.env.CANDIDATE_APP_BASE_URL
      || process.env.NEXT_PUBLIC_BOARD_APP_BASE_URL
      || process.env.BOARD_APP_BASE_URL
      || ""
  ).trim()
  const base = raw.length ? raw : "http://localhost:3001"
  return base.replace(/\/$/, "")
}

export function getBoardJobApplyUrl(jobId: string) {
  return `${getBoardAppBaseUrl()}/jobs/${jobId}/apply`
}

export function normalizeExternalUrl(url: string | null | undefined) {
  const raw = String(url || "").trim()
  if (!raw) return ""
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^\/\//.test(raw)) return `https:${raw}`
  return `https://${raw}`
}
