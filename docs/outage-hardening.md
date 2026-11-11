# Supabase outage hardening (login / logout failures)

## Symptom

On **11 Nov 2026 around 19:15 IST** HR users were logged out and could not sign back in.

Production logs showed:

```
/api/auth/login        Vercel Runtime Timeout Error: Task timed out after 300 seconds
/api/super-admin/me    TypeError: fetch failed  [cause]: HeadersTimeoutError: HTTP/2 headers timeout after 300000
/api/bolna/webhook/execution   Task timed out after 300 seconds
/api/jobs/<id>/pipeline        Task timed out after 300 seconds
```

A direct probe of the Supabase origin returned Cloudflare **522 Connection timed out**, and
`/rest/v1/` queries took ~20s and failed. When the origin recovered, `/auth/v1/health`
answered immediately. Supabase's public status page said "All Systems Operational" during
the incident, so it was project/origin instability, not an announced platform outage.

## Why users were logged out

1. **Middleware treated an unreachable backend as "invalid session".**
   `middleware.ts` validated the cookie token with a 2s timeout. During the outage the fetch
   aborted, `validateAccessToken()` returned `false`, the refresh attempt also timed out, and
   the user was redirected to `/login` — even though their refresh token was still valid.
2. **Nothing failed fast.** Supabase clients used the default Node HTTP timeout (300s), so each
   request held a Vercel function until the platform killed it. Held functions exhausted
   concurrency, which is why unrelated endpoints (pipeline, participants, Bolna webhook) also
   timed out at the same moment.
3. **Login had no outage path.** `/api/auth/login` waited on Supabase, hit the 300s function
   limit, and the browser only saw a network failure — no clear "temporarily unavailable"
   message. Post-login lookups could also reject a valid session.

## What changed

| Area | Change |
| --- | --- |
| `lib/fetch-with-timeout.ts` (new) | `fetchWithTimeout`, `SupabaseUnavailableError`, `isUnavailableError`, `withTimeout`, `throwIfUnavailable`. Adds a hard timeout and classifies infra errors vs credential errors. |
| `lib/supabase.ts` | Both anon and service-role clients use `global.fetch = supabaseFetch` (15s default, 120s for Storage uploads). |
| `middleware.ts` | Token validation is tri-state (`valid` / `invalid` / `unavailable`). Outages **fail open** — the page loads and API routes still enforce auth. Only a genuine 401/403 redirects to `/login`. |
| `lib/internal-auth.ts` | `getUser`, `refreshSession` and every RPC are time-bounded. Credentials-invalid returns `null` (→ 401); backend-down throws `SupabaseUnavailableError` (→ 503 via `authContextErrorResponse`). |
| `app/api/auth/login/route.ts` | 12s cap, returns **503** with a clear message on outage and **429** on rate limit. Post-login permission/metadata/`hr_users` work is best-effort so a valid session is never rejected. |
| `app/api/super-admin/me/route.ts` | Returns 503 on outage, and profile/`last_active_at` failures no longer fail the session call. |
| `app/(internal)/layout.tsx`, `lib/server-internal-permissions.ts` | Permission RPCs time-bounded; outage renders the shell with no permissions instead of hanging the page. |
| `contexts/candidate-context.tsx` | A failed `/api/super-admin/me` no longer wipes loaded permissions; retries with backoff (up to ~5 min). |
| `app/login/page.tsx` | Shows "system temporarily unavailable" for 503, rate-limit text for 429, and a network message for fetch failures. Disables the button while submitting. |

## Compute saturation (the 11 Nov cause)

The Supabase dashboard showed **CPU ≈95%, Memory ≈95%, Compute ≈95%** across the
incident. At that point Postgres cannot accept new sessions, so:

- the dashboard table editor fails with `Connection terminated due to connection timeout`
- Storage returns `544 DatabaseTimeout`
- PostgREST/REST returns Cloudflare `522`
- your app's login/queries fail even though Auth itself is up

A restart clears hung sessions, but **at 95% sustained CPU it will re-saturate**.
The durable fix is a compute upgrade (at least one tier up) plus reducing the
queries that drive CPU. After upgrading, watch **Reports → Database** for a day.

### Load reductions shipped with this change

- `GET /api/jobs/[id]/pipeline` no longer embeds `candidates (*)`. That pulled
  `resume_text`, the 768-dim `embedding` and `search_vector` for every applicant
  — tens of KB per row. It now selects only the card fields; the profile sidebar
  already fetches the full record from `/api/candidates/[id]`.
- `GET /api/bolna/reconcile` no longer runs an extra timing `SELECT` per stuck
  call (timing comes from the target query), and each run is capped at 60 calls
  or 45 seconds so a backlog cannot pin the database. The rest is picked up on
  the next 5-minute run.
- `supabase/migrations/20261111_pipeline_perf_indexes.sql` adds the indexes used
  by the pipeline and reconcile paths. **Run it after the database is healthy.**

## Configuration

Optional env vars (defaults in parentheses):

```
SUPABASE_FETCH_TIMEOUT_MS=15000       # table/RPC/auth requests
SUPABASE_STORAGE_TIMEOUT_MS=120000    # file upload/download only
```

## Operating during a Supabase incident

1. Check the project directly, not just the status page:
   ```bash
   curl -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 30 \
     https://<project-ref>.supabase.co/rest/v1/
   curl -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 30 \
     https://<project-ref>.supabase.co/auth/v1/health
   ```
   A Cloudflare 522/521/524 or multi-second latency means the origin is unhealthy.
2. In the Supabase dashboard check **Reports → Database** for CPU, memory and connection
   saturation around the incident window. Repeated 522s with maxed CPU/connections usually
   mean the project needs a compute upgrade or the connection pooler is exhausted.
3. Confirm `CRON_SECRET` is set in Vercel, otherwise `/api/bolna/reconcile` returns 401 and
   stuck calls are not healed.
4. Users keep their session: they should see errors inside the app, not the login screen.
   Do **not** clear cookies as a first response during an outage.

## Expected status codes

| Situation | Status |
| --- | --- |
| Valid session | 200 |
| Expired/invalid session | 401 |
| Supabase unreachable / timed out | 503 (client keeps cookies) |
| Too many login attempts | 429 |
