import assert from "node:assert/strict"
import { test } from "node:test"
import {
  HR_SCHEDULE_REASON_MIN,
  hrSchedulingEnabled,
  notBeforeSeconds,
  validateHrSlot,
} from "../lib/hr-exact-schedule-validation"

const now = new Date("2026-11-27T10:00:00.000Z") // Friday 15:30 IST

test("HR slots reject invalid, too-soon and too-far times", () => {
  assert.equal(validateHrSlot("not-a-date", "Asia/Kolkata", now).ok, false)
  assert.equal(
    validateHrSlot(new Date(now.getTime() + 60_000).toISOString(), "Asia/Kolkata", now).ok,
    false
  )
  assert.equal(
    validateHrSlot(new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString(), "Asia/Kolkata", now).ok,
    false
  )
})

test("HR slots are allowed on Sunday and after 19:00 IST — HR has consent", () => {
  const sundayMorning = validateHrSlot("2026-11-29T05:30:00.000Z", "Asia/Kolkata", now)
  assert.equal(sundayMorning.ok, true)

  const evening = validateHrSlot("2026-11-27T14:00:00.000Z", "Asia/Kolkata", now) // 19:30 IST
  assert.equal(evening.ok, true)
})

test("notBefore is the exact UTC epoch second QStash needs", () => {
  const due = new Date("2026-11-28T10:00:00.000Z")
  assert.equal(notBeforeSeconds(due), Math.floor(due.getTime() / 1000))
})

test("the feature flag is off unless explicitly enabled", () => {
  const previous = process.env.ENABLE_HR_EXACT_TIME_SCHEDULING
  try {
    delete process.env.ENABLE_HR_EXACT_TIME_SCHEDULING
    assert.equal(hrSchedulingEnabled(), false)
    process.env.ENABLE_HR_EXACT_TIME_SCHEDULING = "0"
    assert.equal(hrSchedulingEnabled(), false)
    process.env.ENABLE_HR_EXACT_TIME_SCHEDULING = "1"
    assert.equal(hrSchedulingEnabled(), true)
  } finally {
    if (previous === undefined) delete process.env.ENABLE_HR_EXACT_TIME_SCHEDULING
    else process.env.ENABLE_HR_EXACT_TIME_SCHEDULING = previous
  }
  assert.equal(HR_SCHEDULE_REASON_MIN, 10)
})
