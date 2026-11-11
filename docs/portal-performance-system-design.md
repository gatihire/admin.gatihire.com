# Portal performance & resilience — system design

> Scope: `admin.gatihire.com` (Next.js on Vercel + Supabase Postgres).
> Trigger: Supabase Disk IO budget depletion email, 95% CPU / 95% memory,
> Cloudflare 522 on REST, `544 DatabaseTimeout` on Storage, and the dashboard
> failing with `Connection terminated due to connection timeout` (11 Nov).

## 1. What actually broke

The database ran out of two resources at the same time:

| Resource | Observed | Consequence |
| --- | --- | --- |
| CPU | ~95% | queries queue; p95 latency explodes |
| Memory | ~95% | working set no longer fits in page cache |
| Disk IO | budget depleted | every cache miss becomes a disk read; IO wait pushes CPU higher |

Memory is the multiplier. Once the hot set (candidates + participants + TOASTed
JSON/text) no longer fits in RAM, Postgres re-reads it from disk for every list,
count and search. That is what consumed the Disk IO budget, and why the instance
became unresponsive instead of merely slow.

This is not one bad query. It is **many small, repeated, unindexed reads** plus a
few very large `SELECT *` payloads, run continuously by polling clients.

## 2. Current architecture

```
Browser (React)
  │  fetch /api/*  (SWR cache in sessionStorage)
  ▼
Vercel — Next.js route handlers (Node)
  │  supabase-js → HTTPS
  ▼
Supabase gateway
  ├── GoTrue (auth)          ← stayed healthy during the incident
  ├── PostgREST (REST)       ← 522 during the incident
  ├── Storage                ← 544 DatabaseTimeout
  └── Postgres               ← 95% CPU / 95% RAM / IO budget exhausted
        ├── candidates (resume_text, embedding, search_vector)
        ├── phone_screening_participants (transcript_raw, verdict_json, screening_context)
        ├── applications / jobs / analytics_events / outreach_messages
        └── call_transcripts / screening_answers
Vercel Cron ── /api/bolna/reconcile every 5 min
Bolna ── webhooks → /api/bolna/webhook/execution
```

There is **no cache layer, no read replica, no queue, and no rollup table**. Every
page view, poll and dashboard is a live query.

## 3. Code-level findings (what is generating the IO)

| # | Finding | Where | Impact |
| --- | --- | --- | --- |
| 1 | Candidate list used `select('*', { count: 'exact' })` — pulled `resume_text`, 768-dim `embedding`, `search_vector` for every row | `lib/supabase-candidates.ts` | Tens of KB per candidate per page view + full COUNT(*) |
| 2 | Search used 11 × `ILIKE '%term%'`, including `resume_text` | same | Sequential scan + TOAST reads on every keystroke; no index can serve `%...%` |
| 3 | Pipeline embedded `candidates (*)` per applicant | `app/api/jobs/[id]/pipeline` | **fixed** — now explicit card columns |
| 4 | Phone-screening page polled every **5s**, and `failed` kept it polling forever | `components/phone-screening-tab.tsx` | **fixed** — 15s, active calls only, pauses when tab hidden |
| 5 | Participant list returned `*`, including `transcript_raw` (TOAST) on every poll | `/api/phone-screening/participants` | **fixed** — `fields=status&#124;card` projection modes; polling uses status only |
| 6 | Analytics page force-refreshed every **60s**, bypassing its cache | `components/super-admin/SuperAdminAnalytics.tsx` | **fixed** — 5 min + visibility check |
| 7 | Metrics endpoint runs ~48 `COUNT(*)` per call | `app/api/super-admin/metrics` | **fixed** — 60s Redis cache |
| 7b | Candidate list runs an exact `COUNT(*)` on every page — the #1 block reader in `pg_stat_statements` | `lib/supabase-candidates.ts` | **fixed** — `count: 'estimated'` always |
| 8 | Reconcile scanned + healed an unbounded number of rows | `app/api/bolna/reconcile` | **fixed** — 60 rows / 45s per run, no N+1 timing query |
| 9 | Missing composite/date indexes for the dashboard counters | — | **fixed** — two index migrations added |
| 10 | Large mutable JSONB (`verdict_json`, `screening_context`, `whatsapp_history`) on the hottest table | schema | MVCC bloat + TOAST reads on every update/list |

## 4. Design principles

1. **Keep the hot set small.** Anything not needed to render a list must not be
   selected, and ideally not stored on the hot table.
2. **Every request-path query is indexed, projected and bounded.**
3. **No `COUNT(*)` on the request path.** Estimate, cache, or read a rollup.
4. **Poll only what changes**, at the cadence of the thing that changes.
5. **Aggregate on write (or on a schedule), read a small row on demand.**
6. **Fail fast and degrade** rather than holding a function for 300s.

## 5. Target data model

### 5.1 `candidates` — split cold/blob columns

```
candidates                  (hot: list + filters)
  id, name, email, phone_e164, current_role, current_company,
  location, total_experience, status, source, uploaded_at, ...
  search_vector tsvector    (kept: GIN index, never selected by clients)

candidate_documents         (cold: read only when a profile is opened)
  candidate_id PK/FK
  resume_text text          (or original file in Storage)
  parsed_json jsonb

candidate_embeddings        (cold: only job matching)
  candidate_id PK/FK
  embedding vector(768)
```

- List endpoints select only `candidates` columns.
- `/api/candidates/[id]` joins documents/embeddings on demand.
- Owning the resume text in one place also removes the current duplication
  between `resume_text`, `file_url` and parsed JSON.

### 5.2 `phone_screening_participants` — split call payloads

Keep the hot table to what a pipeline card and the reconcile cron need:

```
phone_screening_participants (hot)
  id, campaign_id, candidate_id, job_id,
  status, bolna_status, bolna_execution_id,
  call_attempts, last_attempt_at, next_retry_at, scheduled_call_at,
  call_started_at, call_ended_at, call_duration_seconds,
  ai_score, ai_summary, ai_recommendation,
  needs_manual_followup, call_is_partial, classification flags,
  created_at, updated_at

participant_details (cold, 1:1)
  participant_id PK/FK
  transcript_raw text
  verdict_json jsonb
  screening_context jsonb
  whatsapp_history jsonb
  cost_breakdown jsonb
  call_payload_json jsonb
```

Transcripts already exist in `call_transcripts`; `transcript_raw` is a duplicate
and the single largest column pulled by list endpoints.

> If a schema split is too risky right now, the low-risk equivalent is **explicit
> projections everywhere**: never `select('*')` on these tables in list/poll
> paths. The split is the durable version of the same rule.

### 5.3 Analytics — rollups instead of live scans

```
analytics_events (append-only, partition by month if > ~5M rows)
analytics_daily  (one row per day per metric, refreshed by cron)
```

Dashboard reads `analytics_daily` (≤ 365 rows) instead of running dozens of
`COUNT(*)` over raw events. Keep the live query for the last hour at most.

## 6. Query & API rules

| Rule | Implementation |
| --- | --- |
| Explicit projections | Never `select('*')` for list/poll endpoints |
| Keyset pagination | `WHERE (uploaded_at, id) < (?, ?) ORDER BY uploaded_at DESC, id DESC LIMIT n` — offset pagination degrades on deep pages |
| Cheap counts | `count: 'estimated'` while searching; cache totals for 5 min |
| Search | `search_vector @@ websearch_to_tsquery(...)` with the existing GIN index; trigram only on `name`/`current_company`; remove `resume_text ILIKE` from the hot path |
| Batch joins | Fetch child rows for the visible page only (already done for work experience/education) |
| Bounded lists | Cap at 100–200 rows per request; "all candidates" is a UI aggregation, not an unbounded query |
| Timeouts | 15s query timeout (already), 45s cap per cron run |

## 7. Caching

| Layer | What | TTL |
| --- | --- | --- |
| Browser (`cachedFetchJson`) | lists, job details, permissions | 60s–10min, SWR |
| Server in-memory + Redis | metrics, permissions, analytics, clients, jobs | 60s–120s |
| HTTP | `ETag` + `If-None-Match` on read-only endpoints | version by `updated_at` |

Serverless instances don't share memory, so an in-memory cache is only a burst
absorber. A Redis layer (`lib/cache.ts`, Upstash REST) makes the cache global
across instances.

### 7.1 Redis cache layer (implemented)

`lib/cache.ts` is a thin layer over the existing `lib/redis.ts` client:

| Helper | Behaviour |
| --- | --- |
| `cached(ns, key, ttl, load)` | read-through, single-flight, returns live data on any cache failure |
| `cacheGet` / `cacheSet` | typed get/set, TTL plus 12% jitter so a namespace doesn't expire at once |
| `cacheDeleteNamespace(ns)` | SCAN + DEL for write invalidation (never `KEYS`) |
| `CacheNamespace` / `CacheTtl` | single source of truth for names and TTLs |

Guarantees:

- **No Redis → no-op.** Without `UPSTASH_REDIS_REST_URL` /
  `UPSTASH_REDIS_REST_TOKEN`, every read misses and `cached()` just runs the
  query. The app behaves exactly as before, only slower.
- **Never blocks a request.** Every Redis operation is capped at 1.2s and errors
  are swallowed (logged at most once per 30s).
- **Empty results are not cached**, so a transient DB blip can't pin "no data".

What is cached, and how it is invalidated:

| Namespace | Contents | TTL | Invalidated by |
| --- | --- | --- | --- |
| `perm` | permission keys + field rules per user | 60s | role/permission/field-rule writes (`invalidatePermissionCache()`) |
| `metrics` | dashboard counters, keyed by UTC day | 60s | TTL only |
| `analytics` | overview/jobs/outreach/team, keyed by query string | 120s | TTL only |
| `clients` | clients list | 120s | client create/update/delete |
| `jobs` | jobs list + filters, keyed by resolved owner | 60s | `bumpJobsSearchRevision()` (all job writes) |

Permissions used to cost 5 queries (3 RPCs + 2 table reads) on **every** API
request; that is now once per user per minute.

Required env vars (Vercel + `.env.local`):

```
UPSTASH_REDIS_REST_URL=https://<db>.upstash.io
UPSTASH_REDIS_REST_TOKEN=...
```

`@upstash/redis` speaks the REST protocol only. A `redis://` / `rediss://` TCP
URL will **not** work — that needs `ioredis`, which is not installed.

## 8. Real-time without hammering Postgres

Replace full-row polling with a **status-only** endpoint:

```
GET /api/phone-screening/participants?campaignId=...&fields=status
→ [{ id, status, bolna_status, updated_at }]
```

Poll it every 15s only while a call is live, pause when the tab is hidden, and
stop when no row is non-terminal. **Implemented:** the tab polls `fields=status`
and fetches the full row once when a call leaves `calling`/`in_progress`; the
campaign counters also use `fields=status`, and the card list uses `fields=card`
(no transcripts). The results sheet fetches full detail only when opened. Later,
replace polling with SSE.

## 9. Background work

- Move embeddings, resume parsing, WhatsApp sends and Bolna sync to a queue
  (pgmq, QStash, or a Supabase edge function worker).
- Keep route handlers thin: validate → enqueue → return 202.
- Cron jobs must be **bounded, idempotent and jittered**:
  - reconcile: every 5 min, ≤60 rows / 45s (done)
  - analytics rollup: every 15 min
  - retention/archival: nightly (transcripts > 90 days to Storage)
- Never run a backfill during business hours without a rate limit.

## 10. Reliability

- Global 15s Supabase timeout + 120s Storage timeout (done).
- 401 only for invalid credentials; **503** for infrastructure (done).
- Middleware fail-open on auth-backend outage (done).
- Retry only idempotent reads, with jittered exponential backoff.
- Circuit breaker: after N consecutive timeouts, serve cached data and show a
  banner instead of calling Supabase.
- Observability:
  - Supabase: Disk IO budget, CPU, memory, cache hit ratio, `pg_stat_statements`.
  - Vercel: p95 route latency, 5xx rate, function duration.
  - Alerts: Disk IO budget < 30%, CPU > 70% for 10 min, any 522/544.

## 11. Capacity plan

Sizing rule of thumb: **the hot working set should be ≤ ~25% of RAM**, otherwise
the page cache cannot hold it and disk IO rises. Check the real numbers:

```sql
-- table + index + TOAST size
select relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_size_pretty(pg_relation_size(c.oid))       as heap,
       pg_size_pretty(pg_total_relation_size(c.reltoastrelid)) as toast
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 20;

-- cache hit ratio (should be > 0.99 for OLTP)
select sum(heap_blks_hit) / nullif(sum(heap_blks_hit + heap_blks_read), 0) as ratio
from pg_statio_user_tables;

-- top statements (requires pg_stat_statements)
select calls, round(mean_exec_time::numeric, 2) as mean_ms,
       round(total_exec_time::numeric, 0) as total_ms, left(query, 100) as query
from pg_stat_statements
order by total_exec_time desc
limit 20;

-- unused indexes (remove them: they cost write IO)
select relname, indexrelname, idx_scan
from pg_stat_user_indexes
where idx_scan = 0
order by pg_relation_size(indexrelid) desc;
```

Upgrade compute until: CPU < 60% at peak, cache hit ratio > 99%, and Disk IO
budget stays above ~30% at the end of the day. Consider a read replica only when
reads dominate and the primary is still saturated after the above.

### 11.1 Read replica — decision for current usage

**Not now.** A read replica is the right tool for read *throughput*, not for the
problem this project has.

Reasons:

1. **The bottleneck is per-query cost, not request volume.** Missing projections,
   `ILIKE '%…%'` scans and TOAST reads are expensive on any node. A replica runs
   the same queries with the same (or smaller) CPU/RAM, so it would be slow too.
2. **A replica does not enlarge the primary's Disk IO budget.** Supabase budgets
   are per compute instance. Only upgrading the primary (or reducing its IO)
   fixes the primary's budget.
3. **This app reads through `supabase-js` → PostgREST.** Supabase read replicas
   expose a Postgres connection string; REST traffic does not automatically move
   to them. Using one means direct Postgres/PgBouncer access or a second
   PostgREST deployment — a real architecture change, not a checkbox.
4. **Cost/complexity:** paid add-on, replication lag, and split read/write code
   paths, for a workload that should fit comfortably on one well-indexed node.

**Revisit when all of these are true:**

- the two index migrations are applied and `VACUUM (ANALYZE)` has run;
- list/poll endpoints use projections and caching (largely done);
- the primary still sits above ~70% CPU at peak;
- `pg_stat_statements` shows the remaining load is dominated by read-only
  SELECTs (analytics, search, exports) rather than writes;
- there is a concrete way to route those reads (direct pooler connection or a
  separate read API).

Until then, spend the money on **compute/RAM** first: it raises both the IO
baseline and the page-cache hit ratio, which is exactly what this workload needs.

### 11.2 Clearing the Disk IO budget warning

The budget refills only while demand is at or below baseline, so it can keep
showing "about to deplete" for a while after the incident even though pages load.

1. Confirm the compute upgrade finished and note the new baseline.
2. Apply both index migrations, then `VACUUM (ANALYZE)` the hot tables.
3. Deploy the query/polling fixes.
4. Keep heavy one-off jobs (backfills, re-parsing, embedding rebuilds) paused
   until the budget recovers. If one is needed, rate-limit and run off-peak.
5. Watch `pg_stat_statements` ordered by `shared_blks_read` (disk reads), not
   just by total time — that is what consumes the IO budget.
6. If a single query dominates, optimise it before adding hardware.

### 11.3 Reading pg_stat_statements correctly

`shared_blks_read` is the number of 8 KB blocks Postgres had to fetch because
they were **not** in `shared_buffers`. Multiply by 8 to get KiB. Three traps:

1. **It is cumulative since `stats_reset`, not a rate.** A restart (including a
   compute upgrade) resets it. A snapshot 26 minutes after a restart with `1`
   call per statement says nothing about the outage — divide by `calls` and
   compare against elapsed time before drawing conclusions.
2. **Not every read is physical disk IO.** An OS page-cache hit still counts as
   `shared_blks_read`. For the true table-level picture use
   `pg_statio_user_tables` (`heap_blks_read + idx_blks_read`).
3. **Writes may be invisible at the top.** `shared_blks_written` only counts
   buffers evicted after being dirtied; small writes are absorbed by the WAL and
   checkpoint cycle. Check `shared_blks_dirtied`, `n_dead_tup` and table size
   growth instead.

Useful queries:

```sql
-- 1. Per-call cost, not cumulative totals (needs >= 1h of uptime to mean anything)
select
  left(regexp_replace(query, '\s+', ' ', 'g'), 140) as query,
  calls,
  round((shared_blks_read + shared_blks_written)::numeric / greatest(calls, 1), 0) as blks_per_call,
  round((shared_blks_read * 8.0 / 1024)::numeric, 1) as read_mb,
  round((shared_blks_written * 8.0 / 1024)::numeric, 1) as written_mb,
  round(mean_exec_time::numeric, 1) as mean_ms,
  round(100.0 * shared_blks_hit
        / nullif(shared_blks_hit + shared_blks_read, 0), 1) as cache_hit_pct
from extensions.pg_stat_statements
where calls > 0
  and query not ilike '%pg_stat_statements%'
order by (shared_blks_read + shared_blks_written)::numeric / greatest(calls, 1) desc
limit 25;

-- 2. Which TABLES are actually read from storage
select relname,
       seq_scan,
       idx_scan,
       heap_blks_read,
       idx_blks_read,
       round((heap_blks_read + idx_blks_read) * 8.0 / 1024, 1) as read_mb,
       round(100.0 * (heap_blks_hit + idx_blks_hit)
             / nullif(heap_blks_hit + idx_blks_hit + heap_blks_read + idx_blks_read, 0), 2) as cache_hit_pct
from pg_statio_user_tables
order by (heap_blks_read + idx_blks_read) desc
limit 20;

-- 3. Write amplification / bloat (large JSONB rows updated in place)
select relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1), 1) as dead_pct,
       last_vacuum, last_autovacuum
from pg_stat_user_tables
order by n_dead_tup desc
limit 15;

-- 4. Uptime + reset time, so the numbers above can be interpreted
select stats_reset from extensions.pg_stat_statements_info;
select pg_postmaster_start_time();
```

Rules of thumb: `cache_hit_pct < 99%` means the hot set does not fit in RAM
(upgrade or shrink the working set). A statement with high
`blks_per_call × calls` is worth optimising; a statement with high total but
`1` call is noise.


## 12. Roadmap

### Now (today)
1. **Upgrade compute** (at least 2 tiers if possible). RAM is the fix for the
   cache misses; the Disk IO budget scales with compute.
2. Restart the project after the upgrade.
3. Apply `20261111_pipeline_perf_indexes.sql` and
   `20261111_analytics_and_search_indexes.sql`, then `VACUUM (ANALYZE)` the hot
   tables.
4. Deploy the pushed query/polling fixes.
5. Watch CPU, memory, cache hit ratio and Disk IO budget for 24h.

### Week 1
6. ~~Replace participant-list `SELECT *` with explicit projections~~ — done via
   `fields=status|card`.
7. ~~Add a status-only polling endpoint; drop full-row polling~~ — done (query
   param on the existing endpoint).
8. Switch candidate search from `resume_text ILIKE` to `search_vector` FTS.
9. Cache `/api/super-admin/metrics` response and keep the client at 5 min — done.

### Month 1
10. Split `candidate_documents` / `candidate_embeddings`.
11. Split `participant_details`; archive transcripts > 90 days to Storage.
12. Build `analytics_daily` rollups; point the dashboard at them.
13. ~~Add server cache (Redis) for clients/jobs/permissions~~ — done (`lib/cache.ts`,
    namespaced TTLs + write invalidation, see §7.1).
14. Add slow-query and error alerts.

### Quarter
15. Queue for parsing/embeddings/WhatsApp/Bolna.
16. Keyset pagination everywhere; remove deep offsets.
17. Evaluate read replica and monthly partitioning of `analytics_events`.

## 13. SLOs / acceptance criteria

| Metric | Target |
| --- | --- |
| p95 API latency (list/detail) | < 500 ms |
| p95 login | < 1.5 s |
| 5xx rate | < 0.5% |
| DB CPU at peak | < 60% |
| Cache hit ratio | > 99% |
| Disk IO budget remaining | > 30% at end of day |
| Calls stuck > 10 min | 0 (reconcile) |
| 300s Vercel timeouts | 0 |

## 14. Related

- `docs/outage-hardening.md` — what was changed to survive an outage (timeouts,
  503 vs 401, no mass logout).
- `supabase/migrations/20261111_pipeline_perf_indexes.sql`
- `supabase/migrations/20261111_analytics_and_search_indexes.sql`
