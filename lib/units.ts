// One canonical money/duration parser for candidate CTC and job salary bands.
//
// ── The bug this exists to fix ───────────────────────────────────────────
// A candidate was auto-rejected for:
//   "Expected: 1140000 LPA, Job range: 40000-70000 LPA"
// His expected CTC was stored as ₹11,40,000 per YEAR. The job band was stored
// as 40,000-70,000 per MONTH. Comparing them directly is a 1000x error, so
// every candidate whose CTC was stored as plain rupees failed the salary check
// and got filtered out automatically.
//
// The old parser was `value.replace(/[^0-9.]/g, "")` then parseFloat:
//   "30% hike"  -> 30      (a percentage read as 30 lakh/yr)
//   "6,50,000"  -> 650000  (Indian grouping read as 6.5 lakh/yr = 65 LPA)
//   "700000"    -> 700000  (7 lakh/yr read as 700000 LPA)
// Each is a confident wrong number, and a wrong number REJECTS a human being.
//
// ── The rule ──────────────────────────────────────────────────────────────
// 1. An explicit unit always wins ("6 LPA", "80K", "1.2 cr", "3 LPA/month").
// 2. A bare rupee figure is converted by magnitude, using ONE threshold for
//    both candidate CTC and job bands so they can never land on different
//    scales:
//        >= 2,00,000  -> annual rupees   (/ 1,00,000)
//        1,000+       -> monthly rupees  (x 12 / 1,00000)
//        <  1,000     -> ambiguous ("9" = 9 LPA or ₹9k/month?) -> null
// 3. Anything we cannot parse with confidence returns null, and a null makes the
//    pre-screen SKIP that check (see lib/pre-screen.ts). Skipping is the safe
//    direction: we might let a strong candidate reach a 5-minute call instead of
//    silently discarding a good human over a units typo.
//
// KNOWN LIMITATION — the 1,000 floor in rule 2. Every job band and every
// candidate CTC in the live database is >= 30,000, so nothing real is affected
// today. But a job whose band were genuinely "8 LPA" would be skipped rather
// than checked. A real `salary_unit` column on `jobs` removes the heuristic
// entirely; until then this is the one place the assumption lives.

const RUPEES_PER_LPA = 100_000

/**
 * Bare numbers below this are read as MONTHLY rupees; at or above it, ANNUAL.
 *
 * ₹2,00,000/year is a implausibly low annual package for any role we hire for,
 * so this threshold is safe for candidate CTC and job bands alike. Using ONE
 * threshold for both sides matters: a band of 80000-150000 must not convert its
 * lower bound as monthly and its upper bound as annual, or the two ends of the
 * same band land on different scales (0.8 vs 18 LPA) and the comparison is
 * nonsense again.
 */
const MONTHLY_UPPER_BOUND = 200_000

/** Below this a bare number is too ambiguous to convert. See rule 2. */
const AMBIGUOUS_FLOOR = 1_000

/** Sanity bounds on an annual package, in LPA. */
const MIN_PLAUSIBLE_LPA = 0.5
const MAX_PLAUSIBLE_LPA = 1_000

/** "per month" and friends — scales whatever unit we resolved. */
const PER_MONTH = /\bper\s*month\b|\/\s*month\b|\bmonthly\b|\bpm\b|\bper\s*mo\b|\bper\s*m\b/

/**
 * Digit grouping. Indian is 3-then-2s with an optional final ",000" group
 * ("6,50,000" = "6" + ",50" + ",000"), so a plain /,/g strip is unsafe —
 * "1,5" must not silently become 15. Only validated groupings are stripped.
 */
const INDIAN_GROUPED = /^\d{1,2}(,\d{2})*(,\d{3})?$/
const WESTERN_GROUPED = /^\d{1,3}(,\d{3})+$/

function stripGrouping(input: string): string {
  if (INDIAN_GROUPED.test(input) || WESTERN_GROUPED.test(input)) {
    return input.replace(/,/g, "")
  }
  return input
}

/** Parse a bare numeric token (digits, optional one dot, optional grouping). */
function parseNumericToken(input: string): number | null {
  const cleaned = stripGrouping(input.replace(/\s+/g, ""))
  if (!/^\d*\.?\d+$/.test(cleaned) || cleaned === "." || cleaned === "") return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function clampToPlausible(lpa: number): number | null {
  if (!Number.isFinite(lpa)) return null
  if (lpa < MIN_PLAUSIBLE_LPA || lpa > MAX_PLAUSIBLE_LPA) return null
  return Math.round(lpa * 100) / 100
}

/**
 * Convert a bare rupee figure to LPA using the magnitude rule. Used for both
 * sides of the salary comparison so they can never end up on different scales.
 */
function rupeesToLpa(n: number): number | null {
  if (n === 0) return 0
  if (n >= MONTHLY_UPPER_BOUND) return clampToPlausible(n / RUPEES_PER_LPA)
  if (n >= AMBIGUOUS_FLOOR) return clampToPlausible((n * 12) / RUPEES_PER_LPA)
  return null
}

/**
 * Normalise any of our money notations to annual LPA.
 *
 *   toLpa("3.90 Lpa")   -> 3.9    explicit unit
 *   toLpa("12lpa")      -> 12     unit attached to the number
 *   toLpa("80K")        -> 0.8
 *   toLpa("80k/month")  -> 9.6
 *   toLpa("1.2 cr")     -> 120
 *   toLpa("3 LPA/month")-> 36
 *   toLpa("700000")     -> 7      bare, >= 1L  => annual rupees
 *   toLpa("40000")      -> 4.8    bare, <  1L  => monthly rupees
 *   toLpa("6,50,000")   -> 6.5
 *   toLpa(40000)        -> 4.8    numbers take the same path as strings
 *   toLpa("30% hike")   -> null   unparseable -> caller skips the check
 *   toLpa("9")          -> null   ambiguous   -> caller skips the check
 *   toLpa(null)         -> null
 */
export function toLpa(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null

  // Numbers are rupee figures from our DB columns and must take the same
  // magnitude path as strings — passing them through unchanged is exactly the
  // 1000x bug this module exists to prevent.
  if (typeof value === "number") {
    return Number.isFinite(value) ? rupeesToLpa(value) : null
  }

  const raw = String(value).trim().toLowerCase()
  if (!raw) return null

  // Resolved by explicit unit, then scaled if it also said "per month".
  const scale = (lpa: number | null): number | null => {
    if (lpa === null) return null
    return PER_MONTH.test(raw) ? clampToPlausible(lpa * 12) : lpa
  }

  const digitsOnly = raw.replace(/[^0-9.,]/g, "")

  // ── Explicit units ─────────────────────────────────────────────────────
  // Note: the unit regexes are \b-anchored but also tested against the raw
  // string, so attached forms ("12lpa", "80k") are handled by testing for the
  // unit substring next to a digit rather than relying on \b alone.
  if (/\b(cr|crore|crores)\b/.test(raw)) {
    const n = parseNumericToken(digitsOnly)
    return n === null ? null : scale(clampToPlausible(n * 100))
  }

  if (/\b(lpa|lps|lakh|lakhs|lac|lacs)\b/.test(raw) || /\d\s*(lpa|lps|lakh|lakhs|lac|lacs)(?![\w])/.test(raw)) {
    const n = parseNumericToken(digitsOnly)
    return n === null ? null : scale(clampToPlausible(n))
  }

  // "80K" / "80 k" / "80k per month". `\bk\b` alone cannot match an attached
  // "k" (no word boundary between "0" and "k"), so anchor on a preceding digit.
  if (/\d\s*k(?![\w])/.test(raw)) {
    const n = parseNumericToken(digitsOnly)
    return n === null ? null : scale(clampToPlausible(n / 100))
  }

  // ── Bare number ────────────────────────────────────────────────────────
  const n = parseNumericToken(digitsOnly)
  if (n === null) return null

  // "80000 per month" is still a rupee figure, so it needs the rupees -> lakhs
  // conversion too; only the monthly multiplier is extra.
  if (PER_MONTH.test(raw)) return clampToPlausible((n * 12) / RUPEES_PER_LPA)

  return rupeesToLpa(n)
}

/**
 * Normalise a JOB salary band to LPA. Jobs in this database mix monthly and
 * annual units in the same column (Sharepal stores 800000-900000 annual; several
 * others store 30000-40000 monthly), so both sides of the salary comparison must
 * go through the same parser.
 *
 * Returns null — meaning "skip the salary check" — rather than a partial band
 * when the data cannot be trusted:
 *  - 0 means "no band" on several jobs.
 *  - A bound that was supplied but did not parse (placeholder text, a "% hike",
 *    a figure under the plausibility floor) invalidates the WHOLE band. Using
 *    only the half that parsed would compare a candidate against a one-sided
 *    range and reject them for a data-quality problem.
 *  - A band whose top is under 1 LPA/yr is placeholder data (we have a real job
 *    stored as 2345-5678), not a salary.
 */
export function jobSalaryBandToLpa(
  rawMin: unknown,
  rawMax: unknown,
): { min: number; max: number } | null {
  const hasMin = rawMin !== null && rawMin !== undefined && rawMin !== "" && Number(rawMin) !== 0
  const hasMax = rawMax !== null && rawMax !== undefined && rawMax !== "" && Number(rawMax) !== 0
  if (!hasMin && !hasMax) return null

  const min = hasMin ? toLpa(rawMin) : null
  const max = hasMax ? toLpa(rawMax) : null
  if (min === null || max === null) return null
  if (min <= 0 || max <= 0) return null
  if (Math.max(min, max) < 1) return null

  // Some rows have the bounds swapped; order them so the check is sane.
  return min <= max ? { min, max } : { min: max, max: min }
}

/** Notice period in days. "Immediate"/"joining now" means 0, not "missing". */
export function toNoticeDays(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null

  const raw = String(value).trim().toLowerCase()
  if (!raw) return null

  if (
    /immediate|joining\s*now|notice\s*waiver|can\s*join|currently\s*unemployed|not\s*working/.test(raw)
  ) {
    return 0
  }

  const n = parseNumericToken(raw.replace(/[^0-9.,]/g, ""))
  if (n === null) return null

  if (/\bmonth(s)?\b|\bpm\b|\bper\s*month\b/.test(raw)) return Math.round(n * 30)
  if (/\byear(s)?\b|\byr\b|\bannum\b/.test(raw)) return Math.round(n * 365)
  if (/\bweek(s)?\b|\bwks?\b/.test(raw)) return Math.round(n * 7)
  // "30 days" / "30" / "1 day" -> already days.
  return Math.round(n)
}

/** Total experience in years. "4.5 yrs", "18 months", "fresher" all handled. */
export function toExperienceYears(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null

  const raw = String(value).trim().toLowerCase()
  if (!raw) return null
  if (/fresher|freshers/.test(raw)) return 0

  const n = parseNumericToken(raw.replace(/[^0-9.,]/g, ""))
  if (n === null) return null

  if (/\bmonth(s)?\b|\bpm\b/.test(raw)) return Math.round((n / 12) * 10) / 10
  return n
}

/**
 * Display helper: a normalised LPA string, or null when we could not parse it —
 * so the UI shows the candidate's original text rather than a number we invented.
 */
export function formatLpaForDisplay(value: unknown): string | null {
  const lpa = toLpa(value)
  if (lpa === null) return null
  return lpa === 0 ? "0 LPA" : `${lpa} LPA`
}
