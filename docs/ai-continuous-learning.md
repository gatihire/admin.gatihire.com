# AI Continuous Learning Loop

The screening agent doesn't stay static — it learns from every call and compounds that knowledge weekly, so it becomes a **generalist HR** that handles any role/any client better over time. This document explains the three-layered learning loop and how to operate it.

## The Loop (3 layers)

```
┌─────────────────────────────────────────────────────────────────┐
│  EVERY CALL (real-time)                                          │
│  Transcript + answers + score ──► evaluateCallQuality()          │
│      └─ rule-based metrics (missing answers, aborted, sentiment) │
│      └─ Gemini classifies issues + positives + lessons           │
│      └─ writes ai_learning_events + call_quality_metrics         │
└─────────────────────────────────────────────────────────────────┘
                             │  (accumulates all week)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  EVERY WEEK (cron: GET /api/ai-learning/weekly-review)           │
│  Pull 7 days of metrics + events + sample transcripts            │
│      └─ Gemini synthesizes a new Playbook version                │
│         (rules, prompt_override, qa_examples, summary)           │
│      └─ inserts ai_playbook_versions, supersedes the old one     │
│      └─ (optional) extracts fine-tune rows from transcripts      │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  NEXT CALL                                                        │
│  Answer webhook reads the active playbook                         │
│      └─ formatPlaybookForAgent() ─► injected into agent context  │
│         as ai_playbook (lessons learned + Q&A guidance)           │
└─────────────────────────────────────────────────────────────────┘
```

## 1. Per-call learning (real-time)

Triggered automatically inside the transcript webhook after every completed call (`evaluateCallQuality` in `lib/ai-learning.ts`). It is idempotent — one evaluation per participant.

**Rule-based metrics** (always computed, no AI cost):
- Agent/candidate turn counts, avg candidate answer length
- Missing key answers (salary, notice period, reason for switching, etc.)
- Aborted calls (< 60s or ≤ 1 candidate turn)
- Negative sentiment count

**AI classification** (Gemini, only if `GEMINI_API_KEY` set):
- Issues with category + severity + transcript evidence + a one-line lesson
- Positive patterns worth keeping
- Fallback to rule-based-only if Gemini fails

Output → `ai_learning_events` (per-issue rows) + `call_quality_metrics` (one row per call).

## 2. Weekly batch learning (the Playbook)

`GET /api/ai-learning/weekly-review` aggregates the week and writes a new `ai_playbook_versions` row (increments `version`, supersedes the old `active`). Each version contains:
- **rules** — reusable, job-agnostic instructions ("when a candidate asks about company background, mention the industry + client type")
- **prompt_override** — prose appended to the agent's system prompt
- **qa_examples** — best-practice answers to real questions candidates asked
- **stats** — calls reviewed, top issues, avg quality score

`GET /api/ai-learning/weekly-review?dryRun=1` previews the synthesis without writing.
`GET /api/ai-learning/weekly-review?extractFineTune=1` also extracts training rows.

## 3. Playbook application

On every outbound call, the **Bolna call trigger** loads the active playbook (cached 60s) and
injects it into the call context as `ai_playbook` (see `lib/bolna.ts`). The Bipul prompt's
"LESSONS LEARNED FROM RECENT CALLS" section then steers behavior for the next candidates. If a
playbook was passed at call-trigger time (`?playbook=`), that takes precedence.

> Note: the legacy Plivo answer webhook (`app/api/phone-screening/webhook/answer/route.ts`) is
> dormant — the live voice path is Bolna. Keep playbook injection in `lib/bolna.ts` in sync.

## 4. Fine-tuning your own LLM (path to custom GenAI)

You currently use Bolna's hosted agent. To eventually run your **own trained LLM** (avoid
provider lock-in and the agent margin):

1. Weekly, run `GET /api/ai-learning/weekly-review?extractFineTune=1`.
2. This merges per-call transcript lines into turn pairs (`ai` → `assistant`, `candidate` → `user`) in `ai_fine_tune_rows` (`lib/ai-learning.ts` → `extractFineTuneRows`).
3. Export rows as chat-format JSONL and fine-tune your model (e.g. via OpenRouter/Gemini tuning or a self-hosted stack).
4. TTS/STT stays with a provider (Gnani, Bolna, etc.) — only the LLM brain becomes yours.

## Data model (migration `20260801_ai_continuous_learning.sql`)

| Table | Purpose |
|-------|---------|
| `ai_learning_events` | Per-call issues/lessons/positives |
| `call_quality_metrics` | Aggregated per-call quality (UNIQUE participant) |
| `ai_playbook_versions` | Versioned weekly playbooks (only `active` is used) |
| `ai_fine_tune_rows` | Extracted training examples |

## Scheduling

The weekly review is a low-frequency job (QStash max delay is 24h, so an occasional external
scheduler is the right tool here — Vercel Cron, cron-job.org, or a Fly machine). Note that
**phone-screening** retries/callbacks no longer need any scheduler — they self-schedule via
QStash delayed publishes from the execution webhook.

| Endpoint | Cadence | Purpose |
|----------|---------|---------|
| `GET /api/ai-learning/weekly-review` | Weekly (e.g. Mon 02:00) | Generate new playbook version |
| `GET /api/ai-learning/weekly-review?extractFineTune=1` | Weekly | + extract fine-tune rows |

Protect the review endpoint with an optional header:

```env
AI_LEARNING_CRON_SECRET=your-long-random-secret
```

```
curl -H "x-cron-secret: $AI_LEARNING_CRON_SECRET" \
     "https://admin.gatihire.com/api/ai-learning/weekly-review?extractFineTune=1"
```

If `AI_LEARNING_CRON_SECRET` is unset, the endpoint is open — set it in production.

## Operator views

`GET /api/ai-learning/summary` (admin auth) returns the current active playbook plus the last 7 days of metrics and learning events — handy for a "AI Learning" panel in the UI later.

## Agent prompt guidance

In the **Bolna** prompt (Bipul, `lib/bolna.ts`), reference the injected context so the playbook is actually used:

```
## Learning Context
You are given an ai_playbook field containing lessons learned from recent calls.
If present, follow those lessons and use the provided Q&A guidance when candidates
ask those questions. The playbook is general HR knowledge and overrides nothing
about the job-specific screening script — it refines HOW you handle conversations.
```
