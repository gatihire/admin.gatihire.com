# Juicebox / LinkedIn Outbound Pipeline + Inbound Screening Flow

> Companion to `bolna-outbound-screening.md` (Bolna prompts/settings) and `phone-screening-setup.md` (legacy Plivo path).
> This doc describes the **end-to-end operational flow** — inbound (job-board resumes) and outbound (database + unlocked external resumes + Juicebox premium-search JSON) — from candidate acquisition to Bolna AI screening calls and shortlist sharing.

## 1. Overview

| Path | Origin | How candidates arrive | Phone source |
|---|---|---|---|
| Inbound | `inbound` | Candidate applies on apna / naukri / workindia / GatiHire portal; HR re-uploads the resume into the job opening | Parsed from resume |
| Outbound — database | `outbound` | AI database match inside a job opening | Already in DB |
| Outbound — external resume | `outbound` | Unlocked external resume uploaded to a job opening | Parsed from resume |
| Outbound — Juicebox | `outbound` | Juicebox premium-search JSON imported into a job opening | Enriched via thepeakai.com from LinkedIn id |

Every path ends in the same Bolna direct-call pipeline: trigger → `phone_screening_participants` → Bolna call → webhook verdict → callback auto-redial (`due-calls`) → review in the results sheet.

---

## 2. Inbound flow (job boards → auto screening-ready candidates)

```
Candidate applies on apna/naukri/workindia/portal
        │
        ▼
HR downloads resumes locally from the job board
        │
        ▼
HR opens the job opening in admin.gatihire.com
  → "Upload resume" (JobUploadDialog)
  → Origin: INBOUND, Source: apna/naukri/workindia/portal
        │
        ▼
Resume parsed (AI) → candidate created (or updated)
  → application attached with origin=inbound, source=<board>
        │
        ▼
HR selects the candidates → "Start AI screening" (manual batch trigger)
        │
        ▼
Bolna inbound call (Hinglish default, "Bipul ji" intro)
  → transcript + verdict written back via webhook
        │
        ▼
Review verdict in phone-screening results sheet → shortlist / callback
```

### Notes
- **No auto-call.** Uploading a resume never triggers a call by itself. After upload, HR selects candidates and starts screening (existing manual flow). Candidates whose resume did not parse a phone are shown as "no phone — skipped" so HR can fix them manually.
- Upload dialog already supports both Inbound and Outbound sources; the origin is persisted on both the application and the participant.

---

## 3. Outbound flow (Juicebox premium search → Bolna calls → results)

### 3.1 Sources of outbound profiles
1. **Database matches** — existing AI matching inside a job opening.
2. **Unlocked external resumes** — uploaded as "Sourced Profile" (`recruiter_upload`, outbound).
3. **Juicebox premium search JSON** (new) — see below.

### 3.2 Juicebox JSON import

```
User runs a Juicebox premium search (LinkedIn index)
  → exports result.json via the Juicebox browser extension
        │
        ▼
Open the job opening in admin.gatihire.com
  → "Juicebox / LinkedIn" tab → "Import JSON"
  → drop result.json
        │
        ▼
Importer validates + normalizes
  → inserts profiles into juicebox_profiles in FILE ORDER (top-most first)
  → dedupes by contact_id / linkedin_id
  → stores the full original payload in raw_json (never lost)
```

**Important data reality** (verified from a real export):
- The extension export contains **no phone or email values** — only `linkedin_id` (and `contactId`) are usable for enrichment.
- Fields available per profile: `first_name, last_name, full_name, summary, location_name, location_locality, location_country, job_title, job_company_name, job_company_website, linkedin_url, linkedin_id, education[], experience[], skills[], languages[], total_experience_months, ai_skills, tags, manualEmails, manualPhoneNumbers, work_email, recommended_personal_email, personal_emails, phone_numbers, mobile_phone, supplemented_emails, supplemented_phone_number, contact_info_availability, contactId, ...`
- Contact data (`work_email`, `personal_emails`, `phone_numbers`, ...) is **empty** in the export even when `contact_info_availability` claims a phone exists.

### 3.3 Preview → detail → download resume

```
Juicebox / LinkedIn tab
  ├─ List (file order): name, title, company, location, experience, enrichment badge
  │    filters: All / Enriched / Pending / Failed   +   search
  │    bulk checkboxes
  ├─ Detail view: full structured profile
  │    summary, experience timeline, education, skills, languages,
  │    LinkedIn URL, enrichment card (phone/email + provider + fetched date)
  └─ "Download resume" → generates a resume in OUR template (PDF) from the profile
```

### 3.4 Enrichment (thepeakai.com)

```
Select profiles → "Enrich" button
  → confirm contact type: phone only / email only / both
  → shows estimated PeakAI credits
        │
        ▼
Enrich route calls PeakAI per profile (linkedin_id → contact data)
  → results cached in juicebox_contacts (fetched ONCE, persisted FOREVER)
  → profile.enrichment_status = enriched | failed
        │
        ▼
Filters update: Enriched / Pending / Failed
```

### 3.5 Call assignment

```
Bulk-select ENRICHED profiles (e.g. 50) → "Assign to AI calls"
  → confirmation (count + estimated calls)
        │
        ▼
For each profile: materialize a thin candidates row
  ├─ source = 'juicebox'
  ├─ source_profile_id → juicebox_profiles.id
  ├─ name / phone (from juicebox_contacts) / current_role / current_company
  ├─ location / total_experience / technical_skills / linkedin_profile
  └─ origin=outbound
        │
        ▼
Reuse existing /api/phone-screening/trigger flow
  → phone_screening_participants → Bolna outbound call
  → webhook verdict + transcript → callback auto-redial (due-calls)
        │
        ▼
Review each call's verdict in the phone-screening results sheet
  → shortlist → share shortlisted candidates with the client
```

### Data hygiene
- Juicebox data **never** lives in the resume-derived candidates flow. It is stored in its own schema (`juicebox_profiles` + children + `juicebox_contacts`).
- The `candidates` row materialized at call-assignment time is flagged (`source='juicebox'`, `source_profile_id` set) and is **excluded from resume-based candidate lists and DB-match views** so the two datasets never mix.

---

## 4. Where things live

| Concern | Location |
|---|---|
| Juicebox data schema | `supabase/migrations/20260810_juicebox_pipeline.sql` |
| JSON import / normalizer | `lib/juicebox-importer.ts` |
| PeakAI adapter | `lib/peakai.ts` (env: `PEAKAI_API_KEY`) |
| API | `app/api/jobs/[id]/juicebox/*` |
| UI | `components/juicebox-import-dialog.tsx`, `components/juicebox-profiles-tab.tsx`, `components/juicebox-profile-detail.tsx` |
| Tab wiring | `components/job-details.tsx` |
| Global section | `/candidates` → "Juicebox / LinkedIn Profiles" subsection |
| Bolna prompts / settings | `lib/bolna.ts`, `docs/bolna-outbound-screening.md` |

---

## 5. Manual end-to-end test (with `result.json`)

1. Open a job opening → Juicebox / LinkedIn tab → Import JSON → pick `result.json` (15 profiles).
2. Verify list shows 15 profiles in file order, dedupe badge if re-imported.
3. Open a detail view; verify experience/education/skills render.
4. Download resume for one profile → verify PDF uses our template.
5. Select profiles → Enrich (needs `PEAKAI_API_KEY`) → verify Enriched/Pending/Failed badges and that a second enrich does not re-fetch (`juicebox_contacts` cached).
6. Select enriched profiles → Assign to AI calls → verify candidates rows created (`source='juicebox'`) and participants appear in the phone-screening tab.
7. Verify `source='juicebox'` candidates are hidden from the resume candidate list / DB matches.

## 6. Env / secrets

- `PEAKAI_API_KEY` (+ optional `PEAKAI_BASE_URL`) — enrichment provider.
- `BOLNA_API_KEY`, `BOLNA_AGENT_ID`, confirmed outbound/inbound phone numbers — live call tests.
