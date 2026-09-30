// Maps the 07 WhatsApp-collected screening fields into the user_data placeholders
// the Bolna prompt realies on ({already_collected_*}). Used both when the call
// payload is first built and (authoritatively) at call-placement time, since
// info_data only exists after the candidate replies on WhatsApp.

export const ALREADY_COLLECTED_KEY_MAP: Record<string, string> = {
  current_ctc: "already_collected_current_ctc",
  expected_ctc: "already_collected_expected_ctc",
  notice_period: "already_collected_notice_period",
  total_experience: "already_collected_total_experience",
  location: "already_collected_location",
  willing_to_relocate: "already_collected_willing_to_relocate",
  reason_for_switching: "already_collected_reason_for_switching",
}

/**
 * The two fields we never ask for on WhatsApp: they come from the resume, are
 * trusted as-is, and are kept OUT of info_data so the "collected on WhatsApp"
 * count never includes data the candidate was never asked to confirm.
 */
export const RESUME_ONLY_KEYS = ["total_experience", "location"] as const

export function buildResumeInfo(candidate: {
  total_experience?: string | number | null
  location?: string | null
}): Record<string, unknown> {
  const info: Record<string, unknown> = {}
  if (candidate.total_experience != null && String(candidate.total_experience) !== "") {
    info.total_experience = String(candidate.total_experience)
  }
  if (candidate.location) info.location = String(candidate.location)
  return info
}

export function buildAlreadyCollectedUserData(
  infoData: Record<string, unknown> | null | undefined,
  /**
   * Resume-sourced values for the fields we never ask on WhatsApp. Without this
   * overlay the AI would see "Not provided on WhatsApp" for total experience and
   * current location and start asking for them on the call.
   */
  resumeInfo?: Record<string, unknown> | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const data = infoData && typeof infoData === "object" ? infoData : {}
  const resume = resumeInfo && typeof resumeInfo === "object" ? resumeInfo : {}
  for (const [key, promptKey] of Object.entries(ALREADY_COLLECTED_KEY_MAP)) {
    const value = data[key] ?? resume[key]
    out[promptKey] = value !== undefined && value !== null && value !== "" ? String(value) : "Not provided on WhatsApp"
  }
  return out
}