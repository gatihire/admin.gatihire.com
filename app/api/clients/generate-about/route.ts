import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export const runtime = "nodejs"

const GEMINI_MODEL_CANDIDATES = [
  "models/gemini-3.1-flash-lite-preview",
  "models/gemini-2.5-flash",
  "models/gemini-2.0-flash",
  "models/gemini-1.5-flash-latest",
] as const

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function cleanWebsiteText(input: string) {
  let t = String(input || "")
    .replace(/\s+/g, " ")
    .trim()

  // Decode a few common HTML entities that leak through the Jina proxy.
  t = t
    .replace(/&#0*38;|&amp;/gi, "and")
    .replace(/&#0*8211;|&#0*8212;|&ndash;|&mdash;/gi, "-")
    .replace(/&#0*8217;|&rsquo;/gi, "'")
    .replace(/&quot;|&#0*34;/gi, '"')

  // Remove "skip to content" / nav boilerplate.
  t = t.replace(/\bskip to content\b/gi, " ")
  t = t.replace(/\btoggle navigation\b/gi, " ")
  t = t.replace(/\bmenu\b/gi, " ")

  // Remove timestamps / admin-like artifacts.
  t = t.replace(/\badmin\b/gi, " ")
  t = t.replace(/\b\d{2}:\d{2}:\d{2}(?:\+\d{2}:\d{2}|Z)?\b/g, " ")
  t = t.replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\+\d{2}:\d{2}|z)\b/gi, " ")

  // Remove phone-like sequences (keeps narrative cleaner).
  t = t.replace(/(\+?\d[\d\s\-().]{7,}\d)/g, " ")

  // Remove common nav/footer noise words.
  t = t.replace(
    /\b(home|about|services?|contact|clients?|privacy|terms|cookie|subscribe|newsletter|facebook|twitter|youtube|linkedin|instagram)\b/gi,
    " ",
  )

  // De-duplicate consecutive repeated words (e.g. "Rakesh Road Carriers Rakesh Road Carriers").
  t = t.replace(/\b(\w+)(\s+\1\b)+/gi, "$1")

  // Remove long "all caps nav lists" chunks.
  t = t.replace(/\b([A-Z][A-Z0-9]{2,})(\s+[A-Z][A-Z0-9]{2,}){6,}\b/g, " ")

  // De-duplicate long repeated segments.
  const parts = t.split(/\s*(?:\||•|–|-{2,})\s*/).map((p) => p.trim()).filter(Boolean)
  const seen = new Set<string>()
  const kept: string[] = []
  for (const p of parts) {
    const key = p.toLowerCase()
    if (key.length < 10) continue
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(p)
    if (kept.join(" ").length > 18000) break
  }
  const out = (kept.length ? kept.join(". ") : t).replace(/\s+/g, " ").trim()
  return out
}

async function fetchWebsiteText(url: string, timeoutMs = 6500) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Truckinzy/1.0 (About generator)"
      },
      signal: controller.signal
    })

    if (!res.ok) return { ok: false as const, status: res.status, text: "" }
    const contentType = res.headers.get("content-type") || ""
    const body = await res.text()
    if (contentType.includes("text/html")) return { ok: true as const, status: res.status, text: stripHtml(body) }
    return { ok: true as const, status: res.status, text: body.replace(/\s+/g, " ").trim() }
  } catch (e: any) {
    return { ok: false as const, status: 0, text: "", error: e?.name === "AbortError" ? "Timeout" : e?.message || "Fetch failed" }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchWebsiteTextWithFallback(url: string) {
  const altUrl = `https://r.jina.ai/${url}`
  // Parallel fetch (reduces total latency).
  const [direct, viaJina] = await Promise.all([
    fetchWebsiteText(url, 6500),
    fetchWebsiteText(altUrl, 6500),
  ])

  const directText = direct.ok ? String(direct.text || "") : ""
  const jinaText = viaJina.ok ? String(viaJina.text || "") : ""

  const good = (t: string) => t && t.length > 700
  const chosen = (good(directText) ? directText : "") || (good(jinaText) ? jinaText : "") || directText || jinaText
  if (chosen) return { sourceUrl: url, text: chosen }

  const reason = (direct as any).error || (viaJina as any).error || "Failed to fetch website"
  throw new Error(reason)
}

function normalizeWebsite(input: string) {
  const raw = input.trim()
  if (!raw) return null
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw
  return `https://${raw}`
}

async function geminiGenerateText(apiKey: string, prompt: string) {
  let lastErr: any = null
  for (const modelName of GEMINI_MODEL_CANDIDATES) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 520 }
        })
      })
      const json = (await res.json().catch(() => null)) as any
      if (!res.ok) {
        const msg = json?.error?.message || "Gemini generateContent failed"
        throw new Error(msg)
      }
      const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("\n")
      const out = typeof text === "string" ? text.trim() : ""
      if (out) return out
    } catch (e: any) {
      lastErr = e
    }
  }
  throw lastErr || new Error("Gemini generateContent failed")
}

function wordCount(text: string) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function trimToLastSentence(text: string) {
  const t = String(text || "").trim()
  if (!t) return ""
  if (/[.!?]["')\]]?$/.test(t)) return t
  const last = Math.max(t.lastIndexOf("."), t.lastIndexOf("!"), t.lastIndexOf("?"))
  if (last >= 0) return t.slice(0, last + 1).trim()
  return t
}

function looksCompleteAbout(text: string) {
  const t = String(text || "").trim()
  if (!t) return false
  if (t.length < 150) return false
  if (wordCount(t) < 55) return false
  if (!/[.!?]["')\]]?$/.test(t)) return false
  return true
}

function buildFallbackAbout(excerpt: string, sourceUrl: string) {
  const raw = String(excerpt || "").replace(/\s+/g, " ").trim()
  const sentences = raw
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40)

  const picked: string[] = []
  for (const s of sentences) {
    if (/cookie|privacy|terms|copyright|all rights reserved|newsletter|subscribe/i.test(s)) continue
    picked.push(s)
    if (wordCount(picked.join(" ")) >= 95) break
  }

  let out = trimToLastSentence(picked.join(" ").trim())
  if (!out) {
    out =
      "This company operates in transportation and logistics. It supports hiring needs across operations, fleet, and related roles. Review the company website for details on services, locations served, and current openings."
  }

  // Clamp 90–140 words.
  let words = out.split(/\s+/).filter(Boolean)
  if (words.length > 140) {
    out = words.slice(0, 140).join(" ")
    out = trimToLastSentence(out)
    if (!/[.!?]$/.test(out)) out = `${out}.`
    words = out.split(/\s+/).filter(Boolean)
  }
  if (words.length < 90) {
    out = `${out} This summary is intended to help candidates quickly understand the business and role fit.`
    out = trimToLastSentence(out)
    if (!/[.!?]$/.test(out)) out = `${out}.`
  }
  return out.trim()
}

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "jobs.post") && !hasPermission(ctx, "jobs.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  if (!process.env.GEMINI_API_KEY) return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 })

  const body = (await request.json().catch(() => null)) as any
  const website = typeof body?.website === "string" ? normalizeWebsite(body.website) : null
  if (!website) return NextResponse.json({ error: "Website is required" }, { status: 400 })

  try {
    const { text, sourceUrl } = await fetchWebsiteTextWithFallback(website)
    const cleaned = cleanWebsiteText(text)
    const excerpt = cleaned.slice(0, 14000)

    const prompt = [
      "You are writing an 'About the company' section for a hiring marketplace.",
      "Use ONLY facts you can infer from the provided website text. Do NOT invent numbers, customers, awards, funding, or claims.",
      "Write a simple candidate-facing summary in 2-3 sentences (70-110 words).",
      "Do not use phrases like 'over' or 'more than' unless the website text includes the specific number you are referencing.",
      "Do not include disclaimers like 'Based on publicly available information' or 'Candidates should review the website'. Just write the About.",
      "Avoid hypey marketing superlatives. No fake things. No navigation/menu text.",
      "Return plain text only.",
      "",
      `Website: ${sourceUrl}`,
      "",
      "Website text (excerpt):",
      excerpt
    ].join("\n")

    let about = await geminiGenerateText(process.env.GEMINI_API_KEY, prompt)
    // Fast fix for common cutoffs: trim to last complete sentence (no extra Gemini call).
    about = trimToLastSentence(about)

    if (!looksCompleteAbout(about)) {
      about = buildFallbackAbout(excerpt, sourceUrl)
    }

    if (!about) return NextResponse.json({ error: "No content generated" }, { status: 500 })
    const response = NextResponse.json({ about, sourceUrl })
    if (ctx.refreshedSession) {
      response.cookies.set("sb-access-token", ctx.refreshedSession.access_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: ctx.refreshedSession.expires_in,
      })
      response.cookies.set("sb-refresh-token", ctx.refreshedSession.refresh_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      })
    }
    return response
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to generate" }, { status: 500 })
  }
}
