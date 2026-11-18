import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

/**
 * Global provider health.
 *
 * The 16–18 November outage happened because nothing in the system knew that
 * the voice provider had stopped accepting calls. Every placement failed, each
 * request returned a generic error to a recruiter who had already moved on,
 * and 24 candidates were marked `failed` as if they had ignored us.
 *
 * A provider-wide failure is not per-candidate state, so it cannot live on a
 * participant row. It is one switch that every surface can read: calls are
 * paused, and here is why. Placements still record their own error, so the
 * candidates who were never dialled can be retried once the switch clears.
 */

const KEY = "provider:bolna:balance_paused"
const CACHE_TTL_MS = 15_000

export interface ProviderPause {
  paused: boolean
  reason?: string
  since?: string
}

let cache: { at: number; value: ProviderPause } | null = null

/** Read the pause switch. Tolerates a missing table so a not-yet-migrated
 *  environment degrades to "not paused" instead of crashing call placement. */
export async function getProviderPause(force = false): Promise<ProviderPause> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value

  try {
    const { data, error } = await supabaseAdmin
      .from("system_flags")
      .select("value, updated_at")
      .eq("key", KEY)
      .maybeSingle()

    if (error) {
      cache = { at: Date.now(), value: { paused: false } }
      return cache.value
    }

    const value = (data?.value || {}) as Record<string, unknown>
    const paused = !!data && value.paused === true
    const result: ProviderPause = paused
      ? {
          paused: true,
          reason: typeof value.reason === "string" ? value.reason : "Voice provider is unavailable",
          since: typeof value.since === "string" ? value.since : (data?.updated_at as string | undefined),
        }
      : { paused: false }

    cache = { at: Date.now(), value: result }
    return result
  } catch {
    cache = { at: Date.now(), value: { paused: false } }
    return cache.value
  }
}

/** Pause every outbound call until a human fixes the provider account. */
export async function pauseCallsForBalance(reason: string): Promise<void> {
  const since = new Date().toISOString()
  cache = { at: Date.now(), value: { paused: true, reason, since } }

  try {
    const { error } = await supabaseAdmin.from("system_flags").upsert(
      { key: KEY, value: { paused: true, reason, since }, updated_at: since },
      { onConflict: "key" }
    )
    if (error) {
      logger.error("Could not persist provider pause flag", { error: error.message })
      return
    }
    logger.error("Outbound calls paused — voice provider rejected the placement", { reason })
  } catch (err: any) {
    logger.error("Could not persist provider pause flag", { error: err?.message })
  }
}

/**
 * Clear the switch after a placement succeeds again.
 *
 * Called only when the in-process cache says we were paused, so the happy path
 * does not pay for a write per call.
 */
export async function clearProviderPauseIfPaused(): Promise<void> {
  const current = await getProviderPause()
  if (!current.paused) return

  cache = { at: Date.now(), value: { paused: false } }
  try {
    const { error } = await supabaseAdmin.from("system_flags").delete().eq("key", KEY)
    if (error) {
      logger.error("Could not clear provider pause flag", { error: error.message })
      return
    }
    logger.info("Outbound calls resumed — provider accepted a placement again")
  } catch (err: any) {
    logger.error("Could not clear provider pause flag", { error: err?.message })
  }
}
