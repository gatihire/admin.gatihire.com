// thepeakai.com enrichment adapter — real v1 API contract.
// Docs: https://thepeakai.com/api-docs?tab=api
//
//   Base URL: https://build.thepeakai.com
//   Auth:     JWT access token (15-day) via POST /token {email, password}
//             Passed as `Authorization: Bearer <token>`.
//   Lookup:   POST /api?type=<type>&profile_url=<full linkedin url>
//             type=phone_no (9 credits) | work_email | personal_email
//   Balance:  GET /api/balance
//
// Env:
//   PEAKAI_BASE_URL           (optional, defaults to https://build.thepeakai.com)
//   PEAKAI_ACCESS_TOKEN       (optional static JWT; skips /token login)
//   PEAKAI_EMAIL + PEAKAI_PASSWORD  (used to obtain/refresh the token)

import { logger } from "@/lib/logger"

const PEAKAI_BASE_URL = process.env.PEAKAI_BASE_URL || "https://build.thepeakai.com"
const PEAKAI_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 15 // tokens live 15 days
const PEAKAI_REFRESH_BEFORE_MS = 1000 * 60 * 60 * 24 // refresh ~1 day early

export const PEAKAI_CREDIT_PHONE = 9 // credits charged per successful phone_no lookup

export interface PeakAIResult {
  phone?: string | null
  work_email?: string | null
  personal_email?: string | null
  from_cache?: boolean
  credits_charged?: number
  raw?: unknown
}

export interface PeakAIBalance {
  credits: number
  account_type: string
}

export class PeakAIError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = "PeakAIError"
  }
}

let cachedToken: { token: string; expiresAt: number } | null = null

export function isPeakAIConfigured(): boolean {
  return Boolean(
    process.env.PEAKAI_ACCESS_TOKEN ||
    (process.env.PEAKAI_EMAIL && process.env.PEAKAI_PASSWORD)
  )
}

async function peakAIGetToken(): Promise<string> {
  const staticToken = process.env.PEAKAI_ACCESS_TOKEN
  if (staticToken) return staticToken

  const email = process.env.PEAKAI_EMAIL
  const password = process.env.PEAKAI_PASSWORD
  if (!email || !password) {
    throw new PeakAIError("PeakAI not configured. Set PEAKAI_ACCESS_TOKEN or PEAKAI_EMAIL + PEAKAI_PASSWORD.")
  }

  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token

  const res = await fetch(`${PEAKAI_BASE_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new PeakAIError(data?.response || data?.error || `PeakAI /token failed: HTTP ${res.status}`, res.status)
  }
  if (!data?.access_token) {
    throw new PeakAIError("PeakAI /token returned no access_token")
  }

  const ttlMs = Number(data.token_expires_in || PEAKAI_TOKEN_TTL_MS) * 1000 || PEAKAI_TOKEN_TTL_MS
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + ttlMs - PEAKAI_REFRESH_BEFORE_MS,
  }
  return data.access_token
}

async function peakAIRequest(type: string, profileUrl: string, _retried = false): Promise<any> {
  const token = await peakAIGetToken()
  const url = new URL(`${PEAKAI_BASE_URL}/api`)
  url.searchParams.set("type", type)
  url.searchParams.set("profile_url", profileUrl)

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    // Expired/malformed token → clear cache, re-login, retry once.
    if (res.status === 401 && !_retried && !process.env.PEAKAI_ACCESS_TOKEN) {
      cachedToken = null
      return peakAIRequest(type, profileUrl, true)
    }
    throw new PeakAIError(data?.error || `PeakAI lookup failed: HTTP ${res.status}`, res.status)
  }
  return data
}

function normalizeValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "not found")
    return first ? (first as string).trim() : null
  }
  if (typeof value === "string") {
    const s = value.trim()
    if (!s || s.toLowerCase() === "not found") return null
    return s
  }
  return null
}

function normalizeLinkedInUrl(url?: string | null): string {
  if (!url) return ""
  const trimmed = url.trim()
  if (!trimmed) return ""
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * Enrich a LinkedIn profile into contact data (phone / emails).
 *
 * @param input.linkedinUrl   full LinkedIn profile URL (e.g. linkedin.com/in/kunalbahl)
 * @param input.contactTypes  ["phone"] | ["email"] | ["phone","email"] (default both)
 */
export async function enrichLinkedInProfile(input: {
  linkedinId?: string | null
  linkedinUrl?: string | null
  contactTypes?: ("phone" | "email")[]
}): Promise<PeakAIResult> {
  if (!isPeakAIConfigured()) {
    throw new PeakAIError("PeakAI is not configured. Set PEAKAI_ACCESS_TOKEN (or PEAKAI_EMAIL + PEAKAI_PASSWORD).")
  }

  const profileUrl = normalizeLinkedInUrl(input.linkedinUrl)
  if (!profileUrl) {
    throw new PeakAIError("A LinkedIn profile URL is required for PeakAI enrichment.")
  }

  const contactTypes = input.contactTypes && input.contactTypes.length > 0 ? input.contactTypes : ["phone", "email"]

  const result: PeakAIResult = {
    phone: null,
    work_email: null,
    personal_email: null,
    from_cache: false,
    credits_charged: 0,
  }

  if (contactTypes.includes("phone")) {
    const data = await peakAIRequest("phone_no", profileUrl)
    result.phone = normalizeValue(data?.phone_no)
    result.from_cache = Boolean(data?.from_cache)
    result.credits_charged = (result.credits_charged || 0) + Number(data?.credits_charged || 0)
    result.raw = { ...(result.raw as object), phone_no: data }
  }

  if (contactTypes.includes("email")) {
    try {
      const data = await peakAIRequest("work_email", profileUrl)
      result.work_email = normalizeValue(data?.work_email)
      result.from_cache = result.from_cache || Boolean(data?.from_cache)
      result.credits_charged = (result.credits_charged || 0) + Number(data?.credits_charged || 0)
      result.raw = { ...(result.raw as object), work_email: data }
    } catch (err) {
      if (!(err instanceof PeakAIError)) throw err
      logger.warn("PeakAI work_email lookup failed", { profileUrl, error: err.message })
    }

    if (!result.work_email) {
      try {
        const data = await peakAIRequest("personal_email", profileUrl)
        result.personal_email = normalizeValue(data?.personal_email)
        result.credits_charged = (result.credits_charged || 0) + Number(data?.credits_charged || 0)
        result.raw = { ...(result.raw as object), personal_email: data }
      } catch (err) {
        if (!(err instanceof PeakAIError)) throw err
        logger.warn("PeakAI personal_email lookup failed", { profileUrl, error: err.message })
      }
    }
  }

  return result
}

/** Current account balance (credits + account type), or null when unavailable. */
export async function getPeakAIBalance(): Promise<PeakAIBalance | null> {
  if (!isPeakAIConfigured()) return null
  try {
    const token = await peakAIGetToken()
    const res = await fetch(`${PEAKAI_BASE_URL}/api/balance`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    return await res.json()
  } catch (err: any) {
    logger.warn("PeakAI balance fetch failed", { error: err?.message })
    return null
  }
}
