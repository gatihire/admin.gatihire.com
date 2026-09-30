import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

/**
 * Detect "this column does not exist".
 *
 * PostgREST reports the same problem two different ways depending on the
 * operation, so all of these have to be covered:
 *   SELECT -> PGRST205 / "column <table>.<col> does not exist"  (SQLSTATE 42703)
 *   UPDATE -> PGRST204 / "Could not find the '<col>' column of '<table>' in the
 *             schema cache"
 */
function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  const code = error.code || ""
  const message = error.message || ""
  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    /does not exist/i.test(message) ||
    /could not find the '.*' column/i.test(message)
  )
}

/**
 * Update one phone_screening_participants row, tolerating a NOT-YET-MIGRATED
 * `info_sources` column.
 *
 * Why this exists: info_sources is an additive column with a default, but until
 * its migration is applied the whole UPDATE is rejected — and because the update
 * also carries status, info_data and the pre-screen result, one missing column
 * silently discards every other field too. Candidates get no call, no recorded
 * answer and no error anywhere.
 *
 * So: try the full patch, and only if the failure is specifically the missing
 * column, retry without it. The provenance map is then simply rebuilt from
 * info_data on the next collection, which is exactly the migration-free default.
 *
 * Any other database error is propagated — it is never safe to ignore a failed
 * write here.
 */
export async function updateParticipant(
  participantId: string,
  patch: Record<string, unknown>,
  opts?: { extraFilter?: { column: string; value: unknown } },
): Promise<void> {
  const run = async (body: Record<string, unknown>) => {
    let q = supabaseAdmin.from("phone_screening_participants").update(body).eq("id", participantId)
    if (opts?.extraFilter) q = q.eq(opts.extraFilter.column, opts.extraFilter.value)
    return q
  }

  const hasInfoSources = Object.prototype.hasOwnProperty.call(patch, "info_sources")

  const { error } = await run(patch)

  if (!error) return

  if (hasInfoSources && isMissingColumnError(error)) {
    logger.warn(
      "info_sources column not migrated — retrying without it so the write is not lost",
      { participantId, error: error.message },
    )
    const rest: Record<string, unknown> = { ...patch }
    delete rest.info_sources
    const { error: retryErr } = await run(rest)
    if (retryErr) {
      logger.error("Participant update failed", { participantId, error: retryErr.message })
      throw new Error(`Participant update failed: ${retryErr.message}`)
    }
    return
  }

  logger.error("Participant update failed", { participantId, error: error.message, code: error.code })
  throw new Error(`Participant update failed: ${error.message}`)
}
