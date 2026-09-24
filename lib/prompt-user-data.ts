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

export function buildAlreadyCollectedUserData(infoData: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const data = infoData && typeof infoData === "object" ? infoData : {}
  for (const [key, promptKey] of Object.entries(ALREADY_COLLECTED_KEY_MAP)) {
    const value = data[key]
    out[promptKey] = value !== undefined && value !== null && value !== "" ? String(value) : "Not provided on WhatsApp"
  }
  return out
}