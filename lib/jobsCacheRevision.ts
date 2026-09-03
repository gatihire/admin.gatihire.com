import { supabaseAdmin } from "@/lib/supabase"

export const JOBS_SEARCH_REV_KEY = "jobs_search_rev"

export async function bumpJobsSearchRevision(): Promise<void> {
  try {
    await supabaseAdmin.rpc("increment_app_meta", { p_key: JOBS_SEARCH_REV_KEY, p_delta: 1 })
  } catch {
    // best-effort; cached entries self-heal via their TTL
  }
}