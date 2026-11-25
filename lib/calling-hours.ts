/**
 * When we are allowed to dial a candidate.
 *
 * On 25 Nov a candidate told HR she had been called at 02:50. The journey
 * watchdog had re-dialled a row parked by the provider wallet outage, and the
 * sweep runs every ten minutes around the clock — nothing between "the row is
 * due" and "Bolna is asked to dial" ever asked what time it was for the person
 * receiving the call.
 *
 * The product plan already says 10:00–19:00 IST, Monday–Saturday (§9 of
 * `docs/ai-call-quality-plan.md`); this module is that rule in one place so the
 * automatic placement path, the watchdog and any future scheduler all agree.
 *
 * It is a guard on AUTOMATIC dialling, not a ban on phones ringing outside
 * those hours. An explicit HR "Call Now"/"Retry" or a candidate who asks to be
 * called passes `bypassCallingHours` through the placement path; nothing the
 * system decides on its own (watchdog, outreach escalation, QStash retry) does.
 *
 * India has never observed DST, so a fixed +05:30 offset is exact and avoids
 * the cost and the pitfalls of an Intl round-trip on every placement.
 */

const IST_OFFSET_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000

function envHour(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 && raw <= 23 ? Math.round(raw) : fallback
}

/** Inclusive start, exclusive end, in IST. */
const START_HOUR = envHour("CALL_WINDOW_START_HOUR", 10)
const END_HOUR = envHour("CALL_WINDOW_END_HOUR", 19)
/** 0 = Sunday … 6 = Saturday. */
const DEFAULT_DAYS = [1, 2, 3, 4, 5, 6] as const

function offDays(): number[] {
  const raw = (process.env.CALL_WINDOW_DAYS || "").trim()
  if (!raw) return [...DEFAULT_DAYS]
  const days = raw
    .split(",")
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  return days.length > 0 ? days : [...DEFAULT_DAYS]
}

/** The same instant, shifted so that UTC getters read as IST wall-clock values. */
function istClock(at: Date): Date {
  return new Date(at.getTime() + IST_OFFSET_MS)
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

export function callingWindowLabel(): string {
  const start = `${pad(START_HOUR)}:00`
  const end = `${pad(END_HOUR)}:00`
  return `${start}–${end} IST, Monday–Saturday`
}

/** True when a call placed at this instant would ring the candidate during their day. */
export function isWithinCallingHours(at: Date = new Date()): boolean {
  const ist = istClock(at)
  if (!offDays().includes(ist.getUTCDay())) return false
  const hour = ist.getUTCHours()
  // 19:00 exactly is outside: the window is [start, end).
  return hour >= START_HOUR && hour < END_HOUR
}

/**
 * The next instant a call is allowed, at or after `from`.
 *
 * Returns the next permitted day's start when `from` is outside the window.
 * Walks at most eight days, so an all-days-disabled misconfiguration returns
 * something a week out rather than throwing inside a webhook.
 */
export function nextCallingWindowStart(from: Date = new Date()): Date {
  if (isWithinCallingHours(from)) return from
  const ist = istClock(from)
  const days = offDays()

  for (let offset = 0; offset <= 8; offset++) {
    // Build the candidate day in IST wall-clock terms, then convert back to UTC.
    const dayBase = Date.UTC(
      ist.getUTCFullYear(),
      ist.getUTCMonth(),
      ist.getUTCDate() + offset,
      START_HOUR,
      0,
      0,
      0
    )
    const candidate = new Date(dayBase - IST_OFFSET_MS)
    if (candidate.getTime() <= from.getTime()) continue
    if (!days.includes(istClock(candidate).getUTCDay())) continue
    return candidate
  }

  // Unreachable with a sane configuration; never leave a caller with no date.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000)
}
