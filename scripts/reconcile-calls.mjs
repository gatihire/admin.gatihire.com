#!/usr/bin/env node
/**
 * Reconciliation sweep for the AI screening call pipeline.
 *
 * The lesson from the scheduled_at outage: a broken write path fails silently,
 * the API gateway and database both look healthy, and the dashboards report
 * near-100% success while calls simply never happen. Counting errors is not
 * enough — you have to assert that the *outcome* occurred.
 *
 * This script asserts outcomes. It reports, and by default changes nothing.
 *
 * Usage:
 *   node --env-file=.env.local scripts/reconcile-calls.mjs
 *   node --env-file=.env.local scripts/reconcile-calls.mjs --fix-labels
 *
 * Exit code is 1 when any row is found in a broken state, so it can be used as
 * a cron/CI check that alerts when the pipeline stops placing calls.
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  console.error('Run with: node --env-file=.env.local scripts/reconcile-calls.mjs')
  process.exit(2)
}

const db = createClient(url, key)
const applyFix = process.argv.includes('--fix-labels')

/** A booking whose slot has passed by this long with no provider call is stuck. */
const GRACE_MINUTES = 10
const graceCutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000).toISOString()

const { data, error } = await db
  .from('phone_screening_participants')
  .select('id,status,scheduled_call_at,bolna_execution_id,call_attempts,next_retry_at,updated_at,candidates(name)')
  .in('status', ['call_scheduled', 'scheduled'])

if (error) {
  console.error('Query failed:', error.message)
  process.exit(2)
}

const rows = data || []
const stuck = rows.filter(
  (r) => r.scheduled_call_at && r.scheduled_call_at <= graceCutoff && !r.bolna_execution_id,
)

// Booked in the past, provider never accepted the call, and no retry scheduled.
// These are rows HR sees as "Call booked" while no call can ever happen.
const unrecoverable = stuck.filter((r) => !r.next_retry_at)

console.log(`Scanned ${rows.length} booked participant(s).`)
console.log(`  past slot, no provider call  : ${stuck.length}`)
console.log(`  ...and no retry scheduled    : ${unrecoverable.length}`)

if (rows.length === 0) {
  console.log('\nNo booked calls at all. If candidates are tapping slots, that itself is')
  console.log('the outage signal — investigate before assuming things are fine.')
}

if (stuck.length > 0) {
  console.log('\nStuck bookings (booked, slot passed, provider never placed a call):')
  for (const r of stuck) {
    console.log(
      `  ${r.id.slice(0, 8)}  ${r.candidates?.name || '?'}  due=${r.scheduled_call_at}  ` +
        `attempts=${r.call_attempts}  retry=${r.next_retry_at || 'none'}`,
    )
  }
}

if (unrecoverable.length > 0 && applyFix) {
  // Move them to a state the UI already renders honestly ("not confirmed"),
  // rather than leaving a booking that claims a call that will never happen.
  const ids = unrecoverable.map((r) => r.id)
  const { error: fixError } = await db
    .from('phone_screening_participants')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .in('id', ids)
  if (fixError) {
    console.error('\nFailed to relabel stuck rows:', fixError.message)
    process.exit(2)
  }
  console.log(`\nRelabelled ${ids.length} stuck row(s) from call_scheduled to failed.`)
}

if (unrecoverable.length > 0 && !applyFix) {
  console.log('\nRe-run with --fix-labels to move the unrecoverable rows to a state the')
  console.log('UI reports honestly ("Call not confirmed") instead of "Call booked".')
}

process.exit(unrecoverable.length > 0 ? 1 : 0)
