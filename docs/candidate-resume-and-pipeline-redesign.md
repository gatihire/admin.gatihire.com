# Candidate resume reliability & pipeline redesign

Two problems, both rooted in the same thing: **the system was quietly failing
and nobody could see it fail.**

---

## 1. Resume parsing

### The symptom

"Candidates apply through the site and their resume doesn't parse. The file is
there, but the candidate record is empty."

### What was actually wrong

Six independent defects, all ending in the same place — a candidate row with no
resume text and no embedding, indistinguishable from someone who never
uploaded anything.

| # | Defect | Where |
|---|---|---|
| 1 | The public apply path **never wrote an embedding** | `app/api/candidate/resume/parse/route.ts` had no `generateEmbedding` call |
| 2 | A structured-parse failure **threw the resume away** | `parseResume` validates the whole result and throws — the extracted text was discarded with it |
| 3 | **Transient Gemini errors were permanent** | The main parse path called `generateContent` with no retry; a 429 fell through to a regex parser that then failed |
| 4 | The candidate row was created **before the upload** | A failed upload left a permanently empty candidate |
| 5 | Failures returned **HTTP 200** | The UI showed "Parsing status: failed" in 12px grey |
| 6 | **`gemini-2.0-flash` was retired** (404) | The PDF-OCR path and the preferences classifier |

### The root cause of #6

Google retires models without warning. A 404 is indistinguishable from a rate
limit as far as the parser is concerned, so the failure was completely silent:

```
⚠️ Gemini PDF OCR failed (404): gemini-2.0-flash is no longer available
⚠️ Gemini parsing failed validation, trying basic parsing...
❌ All parsing methods failed validation
❌ Resume parsing completely failed
```

The OCR step failed, the structured parse failed, the regex fallback produced
garbage — and the candidate got the same error message a genuinely unreadable
scanned PDF gets. **Nobody could tell "this PDF is a scan" from "our model was
switched off."**

### The fix

**One ingestion path** (`lib/resume-ingest.ts`) shared by the apply route, the
queue worker and the status fallback. It never throws for a parse failure — it
returns what it extracted plus a state:

- `parsed` — structured fields extracted
- `partial` — text read, some fields missing. **The text is saved.**
- `needs_review` — no usable text (scanned image). The file is kept and the
  candidate is flagged for a human.

Also: retry with backoff on the main parse path; always write an embedding;
create the candidate row with a `resume_parse_state`; re-queue rather than drop
on failure; tell the candidate in plain English.

### The stuck-journey problem

A worker claims a job by flipping it to `processing`. If the worker is killed
mid-parse — a deploy, an OOM, a laptop closing — the job stays `processing`
forever, and the claim RPC only ever picks `queued` rows. The queue looks
empty while jobs sit locked, and those candidates are never parsed again.

**That is exactly how a resume ends up stuck.** The worker now releases any job
locked for more than 15 minutes back to `queued`.

### Data repaired

| | Before | After |
|---|---|---|
| Candidates with no embedding | 1,426 | **68** (all with no resume text at all) |
| Candidates with text but no embedding | 1,312 | **0** |
| Resumes needing review | 51 | **2** (one PDF, one legacy `.doc`) |
| Parse jobs stuck queued | 385 (oldest April) | **0** |
| Duplicate active queue jobs | 88 candidates | **0** (partial unique index added) |

### New surface

- `candidates.resume_parse_state` / `resume_parse_error`
- `scripts/backfill-resumes.mjs` — resumable backfill for embeddings, stale
  queue cleanup, and re-queueing
- `/api/admin/resume-needs-review` — lists the unread resumes with the reason
  and re-queues them
- `RESUME_PARSE_MODELS` — one list of models known to still exist

---

## 2. The pipeline board

### What the pipeline was

A vertical list of very tall cards with a row of stage chips above it that
**filtered** the list. The component's own comment called it a "Mini-Kanban
Pipeline Bar", but it was a filter row: to answer "how many people are at each
stage" you had to click through seven chips one at a time.

Each card rendered 12–20 lines. The fit score appeared **twice**, the call state
**three times**, plus a WhatsApp thread button, a metrics bar, a pre-screen
verdict with its bullet list, collected info with provenance chips, and a strip
of 9 buttons. Nothing stood out.

### What it is now

- **Eight columns** — Applied, AI Screen, HR Review, Shortlist, Client Review,
  Interview, Offer, Hired — each with its own count.
- **One card, six lines** — name, role, fit score, and **one** status pill
  saying the single most urgent thing about that candidate right now.
- **Drag to move stages**, through the same confirmation path as the old stage
  dropdown. A dedicated strip rejects a candidate by drag.
- **Three filters, not eight.** Search, source, "needs attention".
- **The detail modal** carries everything else, in the order a recruiter reads
  a candidate: who → what needs attention → what the AI found → how to reach
  them → what to do next.

### Bugs fixed along the way

- **`hr_review` and `client_review` had no column.** They were in the stage
  model and the Today board counted them, but candidates in those stages were
  invisible on the pipeline.
- **The client's verdict was fetched and thrown away** — `clientDecisions`
  travelled all the way from the API and was never rendered. It is now the
  highest-priority status on the card.
- **The participant query pulled transcripts.** `select(*)` fetched
  `transcript_raw`, `call_payload_json` and `cost_breakdown` for every
  participant on the job.
- **"Time in stage" was "time since applied"** — now derived from the real
  `stage_changed` events.
- **Three candidate search functions were completely broken** (see below).
- **Three deep-links pointed at values that do not exist** — the job list's
  badges landed on an empty list or on unfiltered everything.

### The search functions

Three of the four candidate search functions raised an error on **every call**.
`search_candidates` and `search_candidates_by_skills` are called from the admin
search UI, so searching by role or skill was broken.

Three separate bugs, one per function:

1. **`current_role` is a PostgreSQL keyword.** Like `current_user`, an unquoted
   reference resolves to the *session role* — which returns the string
   `"postgres"` — not to the column. Every filter on `current_role` matched
   nothing. The search-vector trigger had the same problem, so every
   candidate's search vector contained "postgres" instead of their job title.

   ```sql
   select count(*) from candidates where current_role ilike '%manager%';
   -- 0 rows
   select count(*) from candidates where "current_role" ilike '%manager%';
   -- 2122 rows
   ```

2. **`technical_skills` was migrated from `text[]` to `jsonb`** — the functions
   still called `unnest()` on it.

3. **`candidates` has no `created_at` column** (it has `uploaded_at`).

---

## Still to do

- **Deploy.** All three repos are pushed; the Vercel env vars from the earlier
  session (Redis, QStash ×4, `CRON_SECRET`) are still needed for the cache,
  QStash scheduling and the journey watchdog to be live.
- **Deploy the resume worker** so the lock reaper and the retry actually run in
  production.
- The 2 remaining unread resumes are a PDF and a legacy `.doc` — they need a
  human, which is what `/api/admin/resume-needs-review` is for.
