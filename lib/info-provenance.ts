// Per-field provenance for the candidate info we hold.
//
// ── The bug this exists to fix ───────────────────────────────────────────
// phone_screening_participants.info_data is a flat JSONB blob. Portal
// applicants filled the same fields in on the talent-portal apply form, which
// call-orchestrator seeded into info_data at campaign creation. The UI then
// rendered every non-empty key under a heading that said "Confirmed by the
// candidate on WhatsApp" with a green "Collected" badge and a "3/5 fields"
// counter.
//
// So an applicant who filled in their CTC, notice period, relocation answer and
// switching reason BEFORE we ever messaged them was shown to the hiring team as
// having confirmed them over WhatsApp. The data was right; the claim about where
// it came from was not. That distinction is the whole point of a screening call,
// so it has to be tracked rather than assumed.
//
// ── The model ─────────────────────────────────────────────────────────────
// One source per field key, stored alongside the value in
// phone_screening_participants.info_sources (jsonb):
//
//   "application"  from the talent-portal apply form / candidate profile,
//                  seeded when the campaign was created
//   "whatsapp"     the candidate typed it into a WhatsApp Flow or free-text reply
//   "resume"       parsed from the uploaded resume; never asked on WhatsApp
//
// Two rules keep this honest:
//  1. Provenance is written by the SAME code that writes the value, in the same
//     update. They cannot drift apart.
//  2. A key with no recorded source is NOT reported as WhatsApp-confirmed. The
//     fallback below guesses "application" for pre-migration rows, because a
//     campaign row only ever has content if something seeded it, and WhatsApp
//     values always arrive with a source after this change ships. Guessing
//     "whatsapp" for an unknown key would recreate the original lie.

export type InfoSource = "application" | "whatsapp" | "resume"

export const INFO_SOURCES: readonly InfoSource[] = ["application", "whatsapp", "resume"]

export const SOURCE_LABEL: Record<InfoSource, string> = {
  application: "From their application",
  whatsapp: "Confirmed on WhatsApp",
  resume: "From the resume",
}

/** Short form for dense UI (chips, tables). */
export const SOURCE_SHORT: Record<InfoSource, string> = {
  application: "Application",
  whatsapp: "WhatsApp",
  resume: "Resume",
}

/**
 * The five fields we ask for on WhatsApp. These are the only ones where
 * "confirmed by the candidate" is a meaningful claim — we do not ask for
 * experience or location, so we must never describe those as collected.
 */
export const WHATSAPP_INFO_KEYS = [
  "current_ctc",
  "expected_ctc",
  "notice_period",
  "willing_to_relocate",
  "reason_for_switching",
] as const

/** Trusted from the resume. Reused by lib/pre-screen.ts and the call prompt. */
export const RESUME_INFO_KEYS = ["total_experience", "location"] as const

export type WhatsappInfoKey = (typeof WHATSAPP_INFO_KEYS)[number]

export function isInfoSource(value: unknown): value is InfoSource {
  return typeof value === "string" && (INFO_SOURCES as readonly string[]).includes(value)
}

/** Read a recorded source, or null when the key has never been stamped. */
export function readSource(
  infoSources: Record<string, unknown> | null | undefined,
  key: string,
): InfoSource | null {
  const raw = infoSources?.[key]
  return isInfoSource(raw) ? raw : null
}

/**
 * The source to DISPLAY for a key. Un-stamped keys fall back to "application":
 * see rule 2 at the top of this file.
 */
export function sourceForDisplay(
  infoSources: Record<string, unknown> | null | undefined,
  key: string,
): InfoSource {
  return readSource(infoSources, key) ?? "application"
}

/**
 * Build the info_sources patch for a set of keys written by one code path.
 * Merging is left to the caller so a single update can carry both the values
 * and their provenance.
 */
export function stampSources(
  keys: readonly string[],
  source: InfoSource,
): Record<string, InfoSource> {
  const out: Record<string, InfoSource> = {}
  for (const k of keys) out[k] = source
  return out
}

/**
 * Merge new provenance into the existing map. An existing source is only
 * overwritten by a genuinely newer observation:
 *   - a WhatsApp answer supersedes a seeded application value (the candidate
 *     corrected it themselves)
 *   - a WhatsApp answer supersedes another WhatsApp answer (they re-answered)
 *   - a re-seed from the application does NOT overwrite a WhatsApp answer, so a
 *     nudge loop cannot silently revert a candidate's correction.
 */
export function mergeSources(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, InfoSource>,
): Record<string, InfoSource> {
  const out: Record<string, InfoSource> = {}
  for (const [k, v] of Object.entries(existing || {})) {
    if (isInfoSource(v)) out[k] = v
  }
  for (const [k, v] of Object.entries(incoming)) {
    const prev = out[k]
    if (prev === undefined || prev === "whatsapp" || v === "whatsapp" || v === prev) {
      out[k] = v
    }
  }
  return out
}

export interface InfoFieldDisplay {
  key: string
  value: unknown
  source: InfoSource
  sourceLabel: string
  filled: boolean
  /** True when the value could not be parsed into a usable number/unit. */
  needsAttention: boolean
}

/** Values the talent-portal form stores when a question was left unanswered. */
const EMPTY_SENTINELS = new Set(["", "-", "--", "void", "n/a", "na", "null", "undefined", "not provided"])

/**
 * A value counts as provided only if it is a real answer. The portal form posts
 * "void" for skipped optional questions; showing that as an answer (or as "No")
 * is how a candidate ends up flagged as "not willing to relocate" for a question
 * they were never really asked.
 */
export function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "boolean") return true
  const s = String(value).trim()
  if (!s) return false
  return !EMPTY_SENTINELS.has(s.toLowerCase())
}

/** Human-readable rendering of a relocation answer of any stored type. */
export function formatRelocation(value: unknown): string {
  if (!isMeaningfulValue(value)) return "Not provided"
  if (value === true) return "Yes"
  if (value === false) return "No"
  const s = String(value).trim()
  if (/^(yes|y|true|1)$/i.test(s)) return "Yes"
  if (/^(no|n|false|0)$/i.test(s)) return "No"
  return s
}

/**
 * Assemble the ordered field list a card renders: the five WhatsApp fields
 * first (they are what screening is actually about), then the resume fields.
 *
 * `whatsappValue`/`fallback` are split deliberately. A WhatsApp field is read
 * ONLY from info_data — never from the candidate row — so an apply-form value
 * can never be displayed as if the candidate had confirmed it. Resume fields
 * fall back to the candidate row because that is where they legitimately live.
 */
export function buildInfoFieldList(opts: {
  infoData: Record<string, unknown> | null | undefined
  infoSources: Record<string, unknown> | null | undefined
  /** Candidate-row values, used for resume fields only. */
  fallback?: Record<string, unknown> | null | undefined
  /** Field key -> true when the raw value could not be parsed (e.g. "30% hike"). */
  unparsedKeys?: readonly string[]
}): InfoFieldDisplay[] {
  const { infoData, infoSources, fallback, unparsedKeys } = opts
  const info = infoData || {}
  const unparsed = new Set(unparsedKeys || [])

  const rows: InfoFieldDisplay[] = []

  for (const key of WHATSAPP_INFO_KEYS) {
    const raw = info[key]
    const filled = isMeaningfulValue(raw)
    const source = sourceForDisplay(infoSources, key)
    rows.push({
      key,
      value: key === "willing_to_relocate" ? formatRelocation(raw) : raw,
      source,
      sourceLabel: SOURCE_LABEL[source],
      filled,
      needsAttention: filled && unparsed.has(key),
    })
  }

  for (const key of RESUME_INFO_KEYS) {
    const fromInfo = info[key]
    const raw = isMeaningfulValue(fromInfo) ? fromInfo : fallback?.[key]
    const filled = isMeaningfulValue(raw)
    // Resume fields are resume-sourced whether they were seeded into info_data
    // by an older code path or read straight off the candidate row.
    const source: InfoSource = "resume"
    rows.push({
      key,
      value: raw,
      source,
      sourceLabel: SOURCE_LABEL.resume,
      filled,
      needsAttention: false,
    })
  }

  return rows
}

/**
 * Counts for the section header. Deliberately NOT a "3/5 collected" score:
 * a denominator implies a goal, and these fields are never all collected —
 * portal applicants legitimately have zero WhatsApp fields because we skip the
 * form for them. Summarise by source instead.
 */
export function summariseCoverage(fields: readonly InfoFieldDisplay[]): {
  application: number
  whatsapp: number
  resume: number
  missing: number
} {
  let application = 0
  let whatsapp = 0
  let resume = 0
  let missing = 0
  for (const f of fields) {
    if (!f.filled) {
      missing++
      continue
    }
    if (f.source === "whatsapp") whatsapp++
    else if (f.source === "resume") resume++
    else application++
  }
  return { application, whatsapp, resume, missing }
}

/** "1 field updated on WhatsApp" — how HR should read the WhatsApp count. */
export function describeCoverage(coverage: ReturnType<typeof summariseCoverage>): string {
  const parts: string[] = []
  if (coverage.application) parts.push(`${coverage.application} from application`)
  if (coverage.whatsapp) parts.push(`${coverage.whatsapp} updated on WhatsApp`)
  if (coverage.resume) parts.push(`${coverage.resume} from resume`)
  if (!parts.length) return "Nothing captured yet"
  return parts.join(" · ")
}
