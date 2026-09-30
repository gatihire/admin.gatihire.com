// Single source of truth for "what actually happened on this call?".
//
// The pipeline card, the AI Screen filters, the candidate timeline, the root
// cause analytics and the results sheet all used to derive call state
// independently — and two of them guessed from elapsed wall-clock time (a call
// sitting 3+ minutes was reported as "failed", and a missing provider status was
// printed as "no answer"). HR was shown states the telephony provider had never
// confirmed.
//
// This module derives a state ONLY from data we actually hold:
//   - a Bolna execution id proves we placed the call and the provider accepted it
//   - a provider status (bolna_status) proves what happened on the call
// No state is ever inferred from how long a row has been sitting in a status.

export type CallTruthState =
  | "not_placed"        // nothing placed from our side, and we know why
  | "awaiting_provider" // call accepted by Bolna, provider has not reported yet
  | "ringing"           // provider says the call is being placed
  | "answered"          // provider says someone picked up and is talking
  | "completed"         // conversation finished normally
  | "voicemail"         // answered by a voicemail/IVR, not a human
  | "no_answer"         // provider rang out with nobody picking up
  | "busy"              // line was busy
  | "partial"           // hung up mid-conversation, no full result
  | "our_side_failed"   // failed before/at the carrier — our/provider fault
  | "rejected"          // Bolna rejected the call (credits, invalid number…)
  | "scheduled"         // a call is booked but its time hasn't arrived
  | "retry_pending"     // call failed, a retry is booked
  | "needs_review"      // finished but the AI/HR must look at it

export interface CallTruth {
  state: CallTruthState
  /** Short label for cards/filters. */
  label: string
  /** One line a human can act on, e.g. "Rang out · attempt 1 of 2 · retry 4:30pm". */
  detail: string
  /** Bucket used by the existing AI Screen sub-section filters. */
  bucket: "pending" | "waiting" | "engaged" | "calling" | "done" | "failed" | "review"
  /** Terminal = no further call will happen on its own. */
  terminal: boolean
  /** True only when Bolna has confirmed this state. */
  providerConfirmed: boolean
  tone: "neutral" | "info" | "progress" | "success" | "warning" | "danger"
  /** Icons/colors keyed by state so every surface renders identically. */
  toneClasses: string
  dotClasses: string
}

const TONE: Record<
  CallTruth["tone"],
  { toneClasses: string; dotClasses: string }
> = {
  neutral: { toneClasses: "text-zinc-600", dotClasses: "bg-zinc-400" },
  info: { toneClasses: "text-blue-700", dotClasses: "bg-blue-500" },
  progress: { toneClasses: "text-indigo-700", dotClasses: "bg-indigo-500 animate-pulse" },
  success: { toneClasses: "text-emerald-700", dotClasses: "bg-emerald-500" },
  warning: { toneClasses: "text-amber-700", dotClasses: "bg-amber-500" },
  danger: { toneClasses: "text-red-700", dotClasses: "bg-red-500" },
}

function fmtTime(iso?: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
}

function fmtDuration(seconds?: number | null): string {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return ""
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return m > 0 ? `${m}m ${r}s` : `${r}s`
}

function truth(
  state: CallTruthState,
  label: string,
  detail: string,
  opts: Partial<Omit<CallTruth, "state" | "label" | "detail">> = {}
): CallTruth {
  const tone = opts.tone ?? "neutral"
  return {
    state,
    label,
    detail,
    bucket: opts.bucket ?? "pending",
    terminal: opts.terminal ?? false,
    providerConfirmed: opts.providerConfirmed ?? false,
    tone,
    toneClasses: TONE[tone].toneClasses,
    dotClasses: TONE[tone].dotClasses,
  }
}

const MAX_ATTEMPTS_DEFAULT = 2

export function getMaxAttempts(p?: { max_call_attempts?: number | null } | null): number {
  const n = Number(p?.max_call_attempts)
  return Number.isFinite(n) && n >= 1 ? Math.min(3, n) : MAX_ATTEMPTS_DEFAULT
}

/**
 * Bolna spells some statuses with hyphens and (depending on the surface) some
 * with underscores, plus a couple of aliases. Normalise once so no surface has
 * to know about the variants — otherwise "in_progress" would silently render as
 * "awaiting outcome".
 */
function normalizeStatus(raw: unknown): string {
  const s = String(raw || "").trim().toLowerCase()
  if (!s) return ""
  switch (s) {
    case "in_progress": return "in-progress"
    case "inprogress": return "in-progress"
    case "no_answer": return "no-answer"
    case "noanswer": return "no-answer"
    case "balance_low": return "balance-low"
    case "cancel": return "canceled"
    case "cancelled": return "canceled"
    case "hangup": return "stopped"
    case "cancel_by_agent": return "canceled"
    case "queued":
    case "initiated":
    case "ringing":
    case "completed":
    case "busy":
    case "stopped":
    case "failed":
    case "error":
      return s
    default: return s
  }
}

/**
 * Derive the real call state. `p` is a `phone_screening_participants` row
 * (joined candidate data optional). Pure — safe to call from render.
 */
export function getCallTruth(p: any): CallTruth {
  if (!p) {
    return truth("not_placed", "No call placed", "Not started yet", { tone: "neutral", bucket: "pending" })
  }

  const status = String(p.status || "")
  const bolnaStatus = normalizeStatus(p.bolna_status)
  const executionId = p.bolna_execution_id || null
  const attempts = Number(p.call_attempts || 0)
  const maxAttempts = getMaxAttempts(p)
  const retryAt = p.next_retry_at as string | null
  const scheduledAt = p.scheduled_call_at as string | null
  const duration = p.call_duration_seconds ?? p.conversation_duration ?? null
  const voicemail = p.call_voicemail === true
  const hangupReason = p.call_hangup_reason || p.call_disconnect_reason || ""
  const carrier = p.carrier || ""

  // ── 1. Provider-confirmed outcomes. Highest priority: these are facts. ──
  if (bolnaStatus === "completed") {
    const dur = fmtDuration(duration)
    if (voicemail) {
      return truth(
        "voicemail",
        "Went to voicemail",
        `Call placed · answered by voicemail, not a person${dur ? ` · ${dur}` : ""}`,
        { tone: "warning", bucket: "failed", terminal: true, providerConfirmed: true }
      )
    }
    return truth(
      "completed",
      "Call completed",
      `Picked up and screened${dur ? ` · ${dur}` : ""}${carrier ? ` · ${carrier}` : ""}`,
      { tone: "success", bucket: "done", terminal: true, providerConfirmed: true }
    )
  }

  if (bolnaStatus === "in-progress") {
    return truth(
      "answered",
      "On the call now",
      "Picked up — conversation in progress",
      { tone: "progress", bucket: "calling", providerConfirmed: true }
    )
  }

  if (bolnaStatus === "no-answer") {
    const retry = retryAt ? ` · retry ${fmtTime(retryAt)}` : ""
    return truth(
      "no_answer",
      "Didn’t pick up",
      `Rang out, nobody answered · attempt ${attempts} of ${maxAttempts}${retry}`,
      { tone: "warning", bucket: attempts >= maxAttempts ? "failed" : "calling", terminal: attempts >= maxAttempts, providerConfirmed: true }
    )
  }

  if (bolnaStatus === "busy") {
    const retry = retryAt ? ` · retry ${fmtTime(retryAt)}` : ""
    return truth(
      "busy",
      "Line busy",
      `Number was busy · attempt ${attempts} of ${maxAttempts}${retry}`,
      { tone: "warning", bucket: attempts >= maxAttempts ? "failed" : "calling", terminal: attempts >= maxAttempts, providerConfirmed: true }
    )
  }

  // ── 2. Failed / partial. Distinguish our fault from theirs. ──
  if (bolnaStatus === "stopped" || bolnaStatus === "canceled") {
    return truth(
      "partial",
      "Call cut off",
      hangupReason
        ? `Hung up mid-conversation (${hangupReason})`
        : "Call stopped before it finished",
      { tone: "warning", bucket: "review", providerConfirmed: true }
    )
  }

  if (bolnaStatus === "failed" || bolnaStatus === "error") {
    const detail =
      p.callback_preference?.startsWith("Bolna error")
        ? p.callback_preference.replace("Bolna error: ", "")
        : hangupReason || "Failed before the candidate was reached"
    return truth(
      "our_side_failed",
      "Failed on our side",
      `${detail} — the candidate was never reached`,
      { tone: "danger", bucket: "failed", providerConfirmed: true }
    )
  }

  if (bolnaStatus === "balance-low") {
    return truth(
      "our_side_failed",
      "No call credit",
      "Bolna account has insufficient balance — no call was made",
      { tone: "danger", bucket: "failed", providerConfirmed: true }
    )
  }

  if (status === "failed_partial" || p.call_is_partial === true) {
    return truth(
      "partial",
      "Dropped mid-call",
      "Call ended before the screening finished — transcript is partial",
      { tone: "warning", bucket: "review", providerConfirmed: true }
    )
  }

  // ── 3. Call accepted by Bolna but no outcome reported yet. ──
  // We KNOW the call was placed (execution id exists). We do NOT know if the
  // candidate picked up — so say exactly that, never more.
  if (executionId) {
    if (bolnaStatus === "ringing" || bolnaStatus === "initiated") {
      return truth(
        "ringing",
        "Calling now",
        `Placed at ${fmtTime(p.last_attempt_at) || "—"} — provider is connecting`,
        { tone: "progress", bucket: "calling", providerConfirmed: true }
      )
    }
    if (bolnaStatus === "queued") {
      return truth(
        "awaiting_provider",
        "Call placed — awaiting outcome",
        `Placed at ${fmtTime(p.last_attempt_at) || "—"} · the provider hasn’t reported back yet`,
        { tone: "info", bucket: "calling" }
      )
    }
    return truth(
      "awaiting_provider",
      "Call placed — awaiting outcome",
      `Placed at ${fmtTime(p.last_attempt_at) || "—"} · the provider hasn’t reported back yet`,
      { tone: "info", bucket: "calling" }
    )
  }

  // ── 4. No execution id: we never got a call accepted by the provider. ──
  // Be explicit about why, because "waiting" vs "broken" is exactly what HR
  // could not tell apart before.
  if (status === "call_scheduled" || status === "scheduled") {
    const due = scheduledAt || p.scheduled_at
    if (due && new Date(due).getTime() <= Date.now()) {
      return truth(
        "not_placed",
        "Call missed — not placed",
        `Was due ${fmtTime(due) || "earlier"} but no call was placed. Retry or call now.`,
        { tone: "danger", bucket: "failed" }
      )
    }
    return truth(
      "scheduled",
      "Call booked",
      `Call scheduled for ${fmtTime(due) || "a chosen slot"}`,
      { tone: "info", bucket: "engaged" }
    )
  }

  if (status === "failed" && retryAt) {
    return truth(
      "retry_pending",
      "Retry booked",
      `Attempt ${attempts} of ${maxAttempts} failed · retry ${fmtTime(retryAt)}`,
      { tone: "info", bucket: "calling" }
    )
  }

  if (status === "failed" || status === "unreachable") {
    // attempts > 0 without an execution id is legacy/ambiguous data: we know
    // something was tried, but the provider never confirmed a call was placed.
    // Say "not confirmed" rather than claiming either way.
    return truth(
      "not_placed",
      attempts > 0 ? "Call not confirmed" : "No call placed",
      attempts > 0
        ? `An attempt was logged but the provider never confirmed a call was placed, and no retry is scheduled`
        : `No call was placed for this candidate`,
      { tone: "danger", bucket: "failed", terminal: true }
    )
  }

  if (status === "needs_review" || status === "needs_manual_followup" || p.needs_manual_followup) {
    return truth(
      "not_placed",
      "No call placed",
      "Screening was flagged for a human — no call placed yet",
      { tone: "warning", bucket: "review" }
    )
  }

  // ── 5. Still waiting on the candidate. No call is due yet — that is correct,
  // not broken, and the UI must not imply a call is imminent. ──
  if (status === "whatsapp_sent" || status === "whatsapp_delivered" || status === "whatsapp_read") {
    return truth(
      "not_placed",
      "Waiting for reply",
      `WhatsApp sent ${fmtTime(p.whatsapp_sent_at) || ""} · no reply yet, so no call`.trim(),
      { tone: "neutral", bucket: "waiting" }
    )
  }

  if (status === "info_requested") {
    return truth(
      "not_placed",
      "Waiting for details",
      "Sent a details request on WhatsApp · no call until they respond",
      { tone: "neutral", bucket: "waiting" }
    )
  }

  if (status === "interested" || status === "info_received") {
    return truth(
      "not_placed",
      "Ready — call not yet placed",
      "Candidate is ready to be called, but no call has been placed yet",
      { tone: "warning", bucket: "engaged" }
    )
  }

  if (status === "pending") {
    return truth("not_placed", "No call placed", "Not started yet", { tone: "neutral", bucket: "pending" })
  }

  if (status === "not_interested") {
    return truth("not_placed", "Not interested", "Candidate declined — no call made", { tone: "neutral", bucket: "failed", terminal: true })
  }

  // Completed rows whose provider status we never captured (legacy data).
  if (status === "completed") {
    const dur = fmtDuration(duration)
    return truth(
      "completed",
      "Call completed",
      `Screening completed${dur ? ` · ${dur}` : ""} · provider status not recorded`,
      { tone: "success", bucket: "done", terminal: true }
    )
  }

  return truth(
    "not_placed",
    "No call placed",
    `No call placed yet · status “${status}”`,
    { tone: "neutral", bucket: "pending" }
  )
}

/** Filter chips for the AI Screen stage, in the order a recruiter reads them. */
export const CALL_TRUTH_FILTERS: Array<{ id: string; label: string; hint: string; match: (t: CallTruth) => boolean }> = [
  { id: "all", label: "All", hint: "Every candidate in AI Screen", match: () => true },
  {
    id: "no_call",
    label: "No call",
    hint: "Nudged or approved but no call was ever placed — needs action",
    match: (t) => t.state === "not_placed" && t.bucket !== "waiting" && t.bucket !== "pending",
  },
  {
    id: "awaiting",
    label: "Awaiting outcome",
    hint: "Call placed with the provider, but they have not reported back yet",
    match: (t) => t.state === "awaiting_provider" || t.state === "ringing",
  },
  { id: "answered", label: "On call", hint: "Currently on a call", match: (t) => t.state === "answered" },
  { id: "completed", label: "Completed", hint: "Call picked up and finished", match: (t) => t.state === "completed" },
  {
    id: "no_answer",
    label: "No answer",
    hint: "Rang out, voicemail, or busy",
    match: (t) => t.state === "no_answer" || t.state === "busy" || t.state === "voicemail",
  },
  {
    id: "partial",
    label: "Partial",
    hint: "Cut off mid-call — transcript is incomplete",
    match: (t) => t.state === "partial",
  },
  {
    id: "failed",
    label: "Failed",
    hint: "Failed on our side — the candidate was never reached",
    match: (t) => t.state === "our_side_failed" || t.state === "rejected",
  },
  { id: "review", label: "Needs review", hint: "Needs a human decision", match: (t) => t.bucket === "review" },
]

/**
 * Bucket mapping for the pre-existing sub-section model (pending / waiting /
 * engaged / calling / done / failed / review) so the legacy filter chips and
 * analytics keep working without guessing.
 */
export function callTruthBucket(p: any): CallTruth["bucket"] {
  return getCallTruth(p).bucket
}
