// Juicebox premium-search JSON import normalizer.
// Handles the browser-extension export shape (see docs/juicebox-outbound-flow.md)
// and reduces it to the fields we persist in juicebox_profiles + children.

export interface JuiceboxExperienceInput {
  title: string
  company: string
  company_industry: string
  company_linkedin_url: string
  location: string
  start_date: string
  end_date: string
  duration_months: number | null
  summary: string
}

export interface JuiceboxEducationInput {
  school: string
  degree: string
  field: string
  start_year: string
  end_year: string
}

export interface JuiceboxProfileInput {
  contact_id: string | null
  linkedin_id: string | null
  linkedin_url: string | null
  first_name: string
  last_name: string
  full_name: string
  job_title: string
  job_company_name: string
  job_company_website: string
  location_name: string
  location_locality: string
  location_country: string
  summary: string
  total_experience_months: number | null
  average_tenure: string
  ai_skills: string[]
  languages: string[]
  tags: string[]
  experience: JuiceboxExperienceInput[]
  education: JuiceboxEducationInput[]
  raw: unknown
}

export interface JuiceboxImportError {
  index: number
  message: string
}

export interface JuiceboxImportResult {
  profiles: JuiceboxProfileInput[]
  errors: JuiceboxImportError[]
}

function asString(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value.trim()
  return String(value).trim()
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const s = asString(item)
    if (s) out.push(s)
  }
  return out
}

// Accepts "2024-10" or "2024" (or full ISO) and returns [year, month].
function parseYearMonth(value: string): [number, number] | null {
  if (!value) return null
  const m = /(\d{4})(?:-(\d{1,2}))?/.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = m[2] ? Number(m[2]) : 1
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null
  return [year, month]
}

export function computeDurationMonths(start: string, end: string): number | null {
  const s = parseYearMonth(start)
  const e = parseYearMonth(end)
  if (!s || !e) return null
  return (e[0] - s[0]) * 12 + (e[1] - s[1])
}

function normalizeExperience(raw: unknown[]): JuiceboxExperienceInput[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry: any) => {
    const titleObj = entry?.title
    const companyObj = entry?.company
    const start = asString(entry?.start_date)
    const end = asString(entry?.end_date)
    return {
      title: typeof titleObj === "object" ? asString(titleObj?.name) : asString(entry?.title),
      company: asString(companyObj?.name),
      company_industry: asString(companyObj?.industry),
      company_linkedin_url: asString(companyObj?.linkedin_url),
      location:
        asString(entry?.locality) ||
        asString(companyObj?.location?.name) ||
        asString(entry?.inferred_location?.name),
      start_date: start,
      end_date: end,
      duration_months: end ? computeDurationMonths(start, end) : null,
      summary: asString(entry?.summary),
    }
  })
}

function normalizeEducation(raw: unknown[]): JuiceboxEducationInput[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry: any) => ({
    school: asString(entry?.school?.name),
    degree: asStringArray(entry?.degrees).join(", "),
    field: asStringArray(entry?.majors).join(", ") || asString(entry?.field_of_study),
    start_year: asString(entry?.start_date),
    end_year: asString(entry?.end_date),
  }))
}

function normalizeProfile(profile: any): JuiceboxProfileInput {
  const skills =
    Array.isArray(profile?.ai_skills) && profile.ai_skills.length > 0
      ? profile.ai_skills
      : profile?.skills

  const languagesRaw = Array.isArray(profile?.languages) ? profile.languages : []
  const languages = languagesRaw.map((l: any) => (typeof l === "object" ? asString(l?.name) : asString(l)))

  return {
    contact_id: profile?.contactId ? asString(profile.contactId) : null,
    linkedin_id: profile?.linkedin_id ? asString(profile.linkedin_id) : null,
    linkedin_url: asString(profile?.linkedin_url),
    first_name: asString(profile?.first_name),
    last_name: asString(profile?.last_name),
    full_name: asString(profile?.full_name),
    job_title: asString(profile?.job_title),
    job_company_name: asString(profile?.job_company_name),
    job_company_website: asString(profile?.job_company_website),
    location_name: asString(profile?.location_name),
    location_locality: asString(profile?.location_locality),
    location_country: asString(profile?.location_country),
    summary: asString(profile?.summary),
    total_experience_months: asNumber(profile?.total_experience_months),
    average_tenure: profile?.average_tenure != null ? String(profile.average_tenure) : "",
    ai_skills: asStringArray(skills),
    languages,
    tags: asStringArray(profile?.tags),
    experience: normalizeExperience(profile?.experience),
    education: normalizeEducation(profile?.education),
    raw: profile,
  }
}

/**
 * Parse a Juicebox export payload.
 * Accepts either the top-level export shape `{ pageResults: [...] }` or a bare array.
 */
export function parseJuiceboxPayload(payload: unknown): JuiceboxImportResult {
  const errors: JuiceboxImportError[] = []
  let list: any[] | null = null

  if (Array.isArray(payload)) {
    list = payload
  } else if (payload && typeof payload === "object" && Array.isArray((payload as any).pageResults)) {
    list = (payload as any).pageResults
  } else {
    return { profiles: [], errors: [{ index: -1, message: "Invalid JSON: expected an array or { pageResults: [...] }" }] }
  }

  const profiles: JuiceboxProfileInput[] = []
  if (!list) return { profiles, errors }

  list.forEach((profile, index) => {
    if (!profile || typeof profile !== "object") {
      errors.push({ index, message: "Row is not an object" })
      return
    }
    try {
      profiles.push(normalizeProfile(profile))
    } catch (err: any) {
      errors.push({ index, message: err?.message || "Failed to normalize row" })
    }
  })

  return { profiles, errors }
}

export function profileDedupeKey(profile: JuiceboxProfileInput): string {
  return profile.contact_id || profile.linkedin_id || ""
}
