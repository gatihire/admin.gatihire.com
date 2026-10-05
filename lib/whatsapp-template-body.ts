/**
 * Render a WhatsApp template's body from the template registry.
 *
 * Why this exists: the Graph send API returns only a message id. It does not
 * tell you what it rendered, so every send site hand-wrote a "text" for the
 * thread. Those hand-written strings drift from the real template body, and the
 * drift is invisible until a recruiter reads the thread and notices the
 * candidate's name is missing from a message they demonstrably received.
 *
 * That happened: `collect_info_form` sends
 *   "Hi {{1}}, thanks for your interest in the {{2}} position at {{3}}..."
 * while call-orchestrator recorded
 *   "Please share a few details so we can screen you for <title>."
 * — dropping the greeting and the company name, so the thread misrepresented
 * what the candidate was told.
 *
 * So the body is fetched from the same registry the audit already reads and
 * filled in with the exact parameters that were sent. One source of truth: if
 * the body on the WABA changes, the thread changes with it, with no code edit.
 */

function getCfg() {
  return {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
    apiVersion: process.env.WHATSAPP_API_VERSION || "v21.0",
  }
}

type TemplateComponent = { type?: string; text?: string; format?: string }

/** Cache per (template, language). Bodies only change when a template is edited. */
const bodyCache = new Map<string, string | null>()
const TTL_MS = 60 * 60 * 1000
const fetchedAt = new Map<string, number>()

/**
 * Seed the cache from templates already known at boot or from a caller that has
 * them in hand. Avoids a Graph round-trip on the very first send.
 */
export function seedTemplateBodies(templates: Array<{ name: string; language?: string | null; body?: string | null }>): void {
  for (const t of templates) {
    if (!t?.name || !t.body) continue
    const key = cacheKey(t.name, t.language)
    bodyCache.set(key, t.body)
    fetchedAt.set(key, Date.now())
  }
}

/**
 * Fill a template body with its parameters.
 *
 * Returns null when the body cannot be resolved, so callers fall back to their
 * own label rather than rendering a half-substituted string containing raw
 * "{{1}}" braces into a recruiter-facing thread.
 */
export async function renderTemplateBody(
  templateName: string,
  languageCode: string,
  params: Array<string | null | undefined>,
): Promise<string | null> {
  if (!templateName) return null
  const body = await resolveBody(templateName, languageCode)
  if (!body) return null
  return body.replace(/\{\{(\d+)\}\}/g, (match, n: string) => {
    const idx = Number(n) - 1
    const v = params[idx]
    return v === null || v === undefined || v === "" ? match : String(v)
  })
}

function cacheKey(templateName: string, languageCode?: string | null): string {
  return `${templateName}::${languageCode || "en_US"}`
}

async function resolveBody(templateName: string, languageCode: string): Promise<string | null> {
  const key = cacheKey(templateName, languageCode)
  const at = fetchedAt.get(key)
  if (at && Date.now() - at < TTL_MS && bodyCache.has(key)) {
    return bodyCache.get(key) ?? null
  }

  const cfg = getCfg()
  if (!cfg.accessToken || !cfg.businessAccountId) return null

  try {
    const url =
      `https://graph.facebook.com/${cfg.apiVersion}/${cfg.businessAccountId}` +
      `/message_templates?fields=name,status,components,language&limit=500`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.accessToken}` } })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Array<{ name: string; language?: string; components?: TemplateComponent[] }> }

    const wanted = new Set([languageCode, "en_US", "en"])
    for (const t of data.data ?? []) {
      if (t.name !== templateName) continue
      const tKey = cacheKey(t.name, t.language)
      const body = (t.components ?? []).find((c) => c.type === "BODY")?.text ?? null
      bodyCache.set(tKey, body)
      fetchedAt.set(tKey, Date.now())
      // The requested language wins; the fallbacks are only used when the exact
      // language is absent from the registry.
      if (wanted.has(t.language || "en_US")) return body
    }
    return null
  } catch {
    return null
  }
}