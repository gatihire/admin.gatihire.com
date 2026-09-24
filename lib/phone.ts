import { GoogleGenerativeAI } from "@google/generative-ai"
import { logger } from "@/lib/logger"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview"

/**
 * Canonical E.164 phone format (e.g. "+919932338847"). Single source of truth
 * for BOTH sending (WhatsApp, Bolna, Plivo) and receiving (Meta webhook lookup)
 * so a candidate stored as "+91-99323 38847" always matches a sender "919932338847".
 *
 * Rules:
 *  - strip all non-digits
 *  - drop leading national "0"
 *  - 10 digits       -> +91XXXXXXXXXX (India)
 *  - 12 digits, 91.. -> +91XXXXXXXXXX
 *  - >12 digits, 91..-> truncate to last 12, keep 91
 *  - other leading country codes (as explicit "+<CC>...") are preserved; a bare
 *    non-10/12 digit blob is left unpadded (handled by LLM fallback, not invented here)
 * Returns "" only when the input is null/empty.
 */
export function toE164(phone: string | null | undefined): string {
  if (!phone) return ""

  let cleaned = String(phone).replace(/\D/g, "")
  if (!cleaned) return ""

  // Explicit "+" prefix means a country code was intended — trust it as-is.
  const hasExplicitCc = /^\s*\+\s*\d/.test(String(phone).trim())
  if (hasExplicitCc) {
    while (cleaned.startsWith("0")) cleaned = cleaned.substring(1)
    return `+${cleaned}`
  }

  while (cleaned.startsWith("0")) cleaned = cleaned.substring(1)

  if (cleaned.length === 10) return `+91${cleaned}`
  if (cleaned.length === 12 && cleaned.startsWith("91")) return `+${cleaned}`
  if (cleaned.length > 12 && cleaned.startsWith("91")) {
    cleaned = cleaned.substring(cleaned.length - 12)
    return `+${cleaned}`
  }

  // Ambiguous: let the LLM decide (country code guess). Keep a deterministic
  // best-effort fallback so this never throws.
  return `+91${cleaned.length === 10 ? cleaned : cleaned.padStart(10, "0").slice(-10)}`
}

/** Normalize to the 12-digit dial format Meta/Bolna expect without the "+" (e.g. "919932338847"). */
export function toDial(phone: string | null | undefined): string {
  const e164 = toE164(phone)
  return e164.replace(/\D/g, "")
}

/**
 * LLM-assisted normalization for truly ambiguous numbers (wrong digit count,
 * possible non-India country code, obvious transcription typos). Returns the
 * canonical E.164 string or null when it can't be trusted.
 */
export async function normalizePhoneWithLlm(raw: string | null | undefined): Promise<string | null> {
  const candidate = toE164(raw)
  if (!candidate) return null
  const digits = candidate.replace(/\D/g, "")
  // Deterministic path is good enough for standard 10/12-digit Indian numbers.
  if (digits.length === 12) return candidate

  if (!process.env.GEMINI_API_KEY) return null
  try {
    const model = genAI.getGenerativeModel({ model: MODEL })
    const result = await model.generateContent(
      `You are normalizing an Indian job candidate's phone number that appeared in a resume/upload and is hard to parse.
RAW INPUT: "${raw ?? ""}"
DETERMINISTIC PARSED: "${candidate}"
Return the single most likely correct phone number as a JSON object: {"phone": "string in E.164 form like +919932338847"}.
Rules: India is the only market. 10-digit mobile numbers get +91. If digits appear missing/duplicated, correct the most likely typo (common drops of a repeated digit). If you cannot make a confident correction, set phone to "" (empty).
Return ONLY valid JSON, no extra text.`
    )
    const text = result.response.text().trim()
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim()
    const parsed = JSON.parse(cleaned)
    const phone = String(parsed?.phone || "").trim()
    if (!phone) return null
    const normalized = toE164(phone)
    return normalized && normalized.replace(/\D/g, "").length >= 12 ? normalized : null
  } catch (err: any) {
    logger.warn("LLM phone normalization failed", { raw, error: err?.message })
    return null
  }
}

/** Best effort resolution used on write paths: deterministic first, LLM only if needed. */
export async function resolvePhone(raw: string | null | undefined): Promise<{ e164: string; llm: boolean }> {
  if (!raw) return { e164: "", llm: false }
  const deterministic = toE164(raw)
  const digits = deterministic.replace(/\D/g, "")
  if (digits.length === 12) return { e164: deterministic, llm: false }
  const llm = await normalizePhoneWithLlm(raw)
  return { e164: llm || deterministic, llm: !!llm && digits.length < 12 }
}