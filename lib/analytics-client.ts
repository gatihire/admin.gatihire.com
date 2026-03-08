export type TrackInput = {
  event_name: string
  entity_type?: string | null
  entity_id?: string | null
  metadata?: Record<string, any>
  access_token?: string | null
}

const ANON_KEY = "tz_anon_id"
const SESSION_KEY = "tz_session_id"
const SESSION_STARTED_KEY = "tz_session_started"

function getOrCreateStorageId(storage: Storage, key: string) {
  try {
    const existing = storage.getItem(key)
    if (existing) return existing
    const created = crypto.randomUUID()
    storage.setItem(key, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

export function getAnonymousId() {
  if (typeof window === "undefined") return null
  return getOrCreateStorageId(window.localStorage, ANON_KEY)
}

export function getSessionId() {
  if (typeof window === "undefined") return null
  return getOrCreateStorageId(window.sessionStorage, SESSION_KEY)
}

export async function trackEvent(input: TrackInput) {
  if (typeof window === "undefined") return

  const anonId = getAnonymousId()
  const sessionId = getSessionId()
  const metadata = { ...(input.metadata ?? {}), anonymous_id: anonId, session_id: sessionId }

  const headers: Record<string, string> = { "content-type": "application/json" }
  if (input.access_token) headers.authorization = `Bearer ${input.access_token}`

  await fetch("/api/analytics/track", {
    method: "POST",
    headers,
    body: JSON.stringify({
      event_name: input.event_name,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      metadata,
    }),
  }).catch(() => {})
}

export async function ensureSessionStart(access_token?: string | null) {
  if (typeof window === "undefined") return
  const sessionStarted = window.sessionStorage.getItem(SESSION_STARTED_KEY)
  if (sessionStarted) return
  window.sessionStorage.setItem(SESSION_STARTED_KEY, "1")
  await trackEvent({
    event_name: "session_start",
    metadata: { path: window.location.pathname, referrer: document.referrer || null },
    access_token,
  })
}

export async function trackPageView(access_token?: string | null) {
  if (typeof window === "undefined") return
  await trackEvent({
    event_name: "page_view",
    metadata: { path: window.location.pathname, referrer: document.referrer || null },
    access_token,
  })
}

