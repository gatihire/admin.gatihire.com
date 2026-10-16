"use client"

import { useEffect, useState } from "react"
import { cachedFetchJson } from "@/lib/utils"

type MeResponse = { permissions?: string[] }

// Module-level cache: the permission set is stable for a session and several
// components want it, so fetch it once and share.
let cachedKeys: Set<string> | null = null
let inflight: Promise<Set<string>> | null = null

function loadPermissions(): Promise<Set<string>> {
  if (cachedKeys) return Promise.resolve(cachedKeys)
  if (!inflight) {
    inflight = cachedFetchJson<MeResponse>("internal:me-permissions", "/api/super-admin/me", undefined, {
      ttlMs: 5 * 60_000,
    })
      .then((data) => {
        const set = new Set<string>(Array.isArray(data?.permissions) ? data!.permissions!.map(String) : [])
        cachedKeys = set
        return set
      })
      .catch(() => {
        // Don't cache a failure — allow a retry on the next mount.
        inflight = null
        return new Set<string>()
      })
  }
  return inflight
}

/**
 * The current internal user's permission keys, for deciding whether to render
 * management controls (assignment, claiming, team views). Server routes still
 * enforce permissions; this only avoids showing buttons that would 403.
 */
export function useInternalPermissions() {
  const [permissions, setPermissions] = useState<Set<string> | null>(cachedKeys)

  useEffect(() => {
    let active = true
    loadPermissions().then((set) => {
      if (active) setPermissions(set)
    })
    return () => {
      active = false
    }
  }, [])

  const can = (key: string) => permissions?.has(key) ?? false

  return { permissions, can, ready: permissions !== null }
}
