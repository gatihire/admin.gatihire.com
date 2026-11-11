/**
 * Timeout + infra-error classification for Supabase calls.
 *
 * During the Nov 11 outage the Supabase origin (behind Cloudflare) answered with
 * 522 / never answered at all. Node's default HTTP/2 headers timeout is 300s, so
 * every Supabase query held its Vercel function for the full 300s budget. That
 * cascaded: functions filled up, middleware treated the aborted token check as
 * "not logged in", and HR was bounced to /login.
 *
 * These helpers make a stalled Supabase fail fast and let callers tell
 * "backend is down" apart from "credentials are wrong".
 */

/** Thrown when the backend looks unreachable rather than rejecting credentials. */
export class SupabaseUnavailableError extends Error {
  readonly code = "SERVICE_UNAVAILABLE"

  constructor(message = "Database temporarily unavailable") {
    super(message)
    this.name = "SupabaseUnavailableError"
  }
}

const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 15000
})()

// File uploads/downloads legitimately take longer than a table query.
const STORAGE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SUPABASE_STORAGE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120000
})()

function abortReason(timeoutMs: number) {
  const error = new SupabaseUnavailableError(`Supabase request timed out after ${timeoutMs}ms`)
  ;(error as any).name = "TimeoutError"
  return error
}

/**
 * Fetch-compatible wrapper with a hard timeout. Safe to pass to supabase-js via
 * `global: { fetch: supabaseFetch }` — it forwards every option untouched and
 * combines any caller-provided AbortSignal with our timeout signal.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const timeoutMs =
    typeof init?.timeoutMs === "number" && init.timeoutMs > 0 ? init.timeoutMs : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const externalSignal = init?.signal

  const onExternalAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason)
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true })
  }

  const timer = setTimeout(() => controller.abort(abortReason(timeoutMs)), timeoutMs)

  try {
    const { timeoutMs: _ignored, ...rest } = (init ?? {}) as RequestInit & { timeoutMs?: number }
    return await fetch(input, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort)
  }
}

/** Fetch used by every Supabase client (anon, service-role, authed, auth). */
export const supabaseFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : String((input as Request)?.url || "")
  const timeoutMs = /\/storage\/v1\//i.test(url) ? STORAGE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  return fetchWithTimeout(input as RequestInfo | URL, { ...(init as RequestInit), timeoutMs })
}

const UNAVAILABLE_PATTERNS =
  /timed out|timeout|fetch failed|network|socket hang|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|522|521|520|523|524|503|504|502/i

/**
 * True when an error means "Supabase is unreachable / degraded", and therefore
 * must NOT be treated as an invalid session.
 */
export function isUnavailableError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof SupabaseUnavailableError) return true

  const anyError = error as any
  const name = String(anyError?.name || "")
  const message = `${anyError?.message || ""} ${anyError?.cause?.message || ""} ${anyError?.code || ""}`
  const status = Number(anyError?.status ?? anyError?.cause?.status)

  if (name === "AuthRetryableFetchError") return true
  if (name === "AbortError" || name === "TimeoutError") return true
  if (status >= 500 || status === 0) return true
  return UNAVAILABLE_PATTERNS.test(message)
}

/** Resolve-or-reject with a SupabaseUnavailableError after `timeoutMs`. */
export function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SupabaseUnavailableError(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  return Promise.race<T>([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Inspect a `{ data, error }` Supabase result and throw when the error is an
 * infra failure. Credential/permission errors are left to the caller.
 */
export function throwIfUnavailable(result: { error?: any } | null | undefined, label: string) {
  if (result?.error && isUnavailableError(result.error)) {
    throw new SupabaseUnavailableError(`${label} unavailable: ${result.error?.message || "unknown error"}`)
  }
}
