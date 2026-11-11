import { supabaseAdmin } from "@/lib/supabase"
import { CacheNamespace, cacheDeleteNamespace } from "@/lib/cache"

export const JOBS_SEARCH_REV_KEY = "jobs_search_rev"

/**
 * Called after any job mutation.
 *
 * Two caches need busting: the client-side search revision (rows in
 * `app_meta`) and the server-side jobs list cache in Redis. Doing it here means
 * every write path that already calls this helper stays correct without
 * touching each route.
 */
export async function bumpJobsSearchRevision(): Promise<void> {
  await Promise.all([
    supabaseAdmin
      .rpc("increment_app_meta", { p_key: JOBS_SEARCH_REV_KEY, p_delta: 1 })
      .then(
        () => undefined,
        () => undefined, // best-effort; cached entries self-heal via their TTL
      ),
    cacheDeleteNamespace(CacheNamespace.jobs),
  ])
}
