// Renders a Juicebox/LinkedIn profile into a clean, self-contained HTML resume
// ("our template"). Browsers can print/download to PDF via the print dialog.

export interface JuiceboxResumeInput {
  profile: any
  experience: any[]
  education: any[]
  contacts: any[]
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function formatDate(value: string): string {
  if (!value) return ""
  const m = /(\d{4})(?:-(\d{1,2}))?/.exec(value)
  if (!m) return value
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return m[2] ? `${months[Number(m[2]) - 1]} ${m[1]}` : m[1]
}

function formatDuration(months: number | null | undefined): string {
  if (months == null || months <= 0) return ""
  const years = Math.floor(months / 12)
  const rem = months % 12
  if (years && rem) return `${years} yr ${rem} mo`
  if (years) return `${years} yr`
  return `${rem} mo`
}

export function renderJuiceboxResume(input: JuiceboxResumeInput): string {
  const { profile, experience, education, contacts } = input

  const name = profile.full_name || [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "Candidate"
  const headline = profile.job_title
    ? `${profile.job_title}${profile.job_company_name ? ` · ${profile.job_company_name}` : ""}`
    : ""

  const contact = contacts?.[0] || {}
  const phone = contact.phone || ""
  const workEmail = contact.work_email || ""
  const personalEmail = contact.personal_email || ""
  const email = personalEmail || workEmail
  const linkedin = profile.linkedin_url || ""
  const location = profile.location_name || ""

  const contactItems = [phone, email, linkedin, location].filter(Boolean)
  const skills = Array.isArray(profile.ai_skills) ? profile.ai_skills : []
  const languages = Array.isArray(profile.languages) ? profile.languages : []

  const expRows = (experience || [])
    .map((e) => {
      const title = e.title || ""
      const company = e.company || ""
      const loc = e.location || ""
      const start = formatDate(e.start_date)
      const end = e.end_date ? formatDate(e.end_date) : "Present"
      const period = start || end ? `${start} — ${end}` : ""
      const duration = formatDuration(e.duration_months)
      const summary = e.summary || ""
      return { title, company, loc, period, duration, summary }
    })
    .filter((e) => e.title || e.company)

  const eduRows = (education || [])
    .map((e) => {
      const school = e.school || ""
      const degree = e.degree || ""
      const field = e.field || ""
      const years = [e.start_year, e.end_year].filter(Boolean).join(" – ")
      return { school, degree, field, years }
    })
    .filter((e) => e.school || e.degree)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(name)} — Resume</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; color: #1f2937; background: #f3f4f6; }
  .page { max-width: 800px; margin: 24px auto; background: #fff; padding: 40px 48px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  .header { border-bottom: 3px solid #2563eb; padding-bottom: 16px; margin-bottom: 24px; }
  .name { font-size: 28px; font-weight: 700; color: #111827; letter-spacing: .5px; }
  .headline { font-size: 15px; color: #2563eb; margin-top: 4px; font-weight: 600; }
  .contact { font-size: 12px; color: #4b5563; margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
  .section { margin-bottom: 22px; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: #2563eb; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; margin-bottom: 12px; }
  .summary { font-size: 13px; line-height: 1.6; color: #374151; white-space: pre-wrap; }
  .job { margin-bottom: 14px; }
  .job-top { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px; }
  .job-title { font-size: 14px; font-weight: 700; color: #111827; }
  .job-company { font-size: 13px; color: #374151; }
  .job-loc { font-size: 12px; color: #6b7280; }
  .job-period { font-size: 12px; color: #2563eb; font-weight: 600; white-space: nowrap; }
  .job-summary { font-size: 12.5px; color: #374151; margin-top: 6px; line-height: 1.55; white-space: pre-wrap; }
  .edu { margin-bottom: 10px; }
  .edu-top { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px; }
  .edu-school { font-size: 13.5px; font-weight: 700; color: #111827; }
  .edu-degree { font-size: 12.5px; color: #374151; }
  .edu-years { font-size: 12px; color: #6b7280; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { background: #eff6ff; color: #1d4ed8; border: 1px solid #dbeafe; border-radius: 9999px; padding: 3px 10px; font-size: 11.5px; }
  .lang { font-size: 12.5px; color: #374151; }
  @media print { body { background: #fff; } .page { margin: 0; box-shadow: none; max-width: none; } }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="name">${escapeHtml(name)}</div>
    ${headline ? `<div class="headline">${escapeHtml(headline)}</div>` : ""}
    ${contactItems.length ? `<div class="contact">${contactItems.map((c) => `<span>${escapeHtml(c)}</span>`).join("")}</div>` : ""}
  </div>

  ${profile.summary ? `<div class="section"><div class="section-title">Professional Summary</div><div class="summary">${escapeHtml(profile.summary)}</div></div>` : ""}

  ${expRows.length ? `<div class="section"><div class="section-title">Work Experience</div>${expRows
    .map(
      (e) => `<div class="job">
        <div class="job-top">
          <div><span class="job-title">${escapeHtml(e.title)}</span>${e.company ? ` &nbsp;·&nbsp; <span class="job-company">${escapeHtml(e.company)}</span>` : ""}${e.loc ? ` &nbsp;<span class="job-loc">(${escapeHtml(e.loc)})</span>` : ""}</div>
          <div class="job-period">${escapeHtml(e.period)}${e.duration ? ` · ${escapeHtml(e.duration)}` : ""}</div>
        </div>
        ${e.summary ? `<div class="job-summary">${escapeHtml(e.summary)}</div>` : ""}
      </div>`
    )
    .join("")}</div>` : ""}

  ${eduRows.length ? `<div class="section"><div class="section-title">Education</div>${eduRows
    .map(
      (e) => `<div class="edu">
        <div class="edu-top">
          <div><span class="edu-school">${escapeHtml(e.school)}</span>${e.degree || e.field ? `<div class="edu-degree">${escapeHtml([e.degree, e.field].filter(Boolean).join(" — "))}</div>` : ""}</div>
          ${e.years ? `<div class="edu-years">${escapeHtml(e.years)}</div>` : ""}
        </div>
      </div>`
    )
    .join("")}</div>` : ""}

  ${skills.length ? `<div class="section"><div class="section-title">Skills</div><div class="chips">${skills.map((s: string) => `<span class="chip">${escapeHtml(s)}</span>`).join("")}</div></div>` : ""}

  ${languages.length ? `<div class="section"><div class="section-title">Languages</div><div class="lang">${escapeHtml(languages.join(", "))}</div></div>` : ""}
</div>
</body>
</html>`
}
