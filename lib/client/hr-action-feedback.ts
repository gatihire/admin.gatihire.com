/**
 * Client-safe helpers for HR nudge / call buttons.
 *
 * The old handlers threw `new Error(data.error || ...)` for every non-2xx
 * response, so a rotated Supabase session (401) looked identical to a provider
 * hiccup and HR got a vague "Failed" toast — or, on some screens, no toast at
 * all. Centralise the status-aware copy here so every action says what happened.
 */

export type HrActionResult = {
  at: string
  action: string
  status: string
  text: string
  detail?: string
}

export class HrActionError extends Error {
  status: number
  data: any

  constructor(status: number, data: any, fallback: string) {
    super(String(data?.error || data?.message || fallback))
    this.name = "HrActionError"
    this.status = status
    this.data = data
  }
}

/** Parse an HR action response, throwing a typed error on any non-2xx status. */
export async function readHrActionResponse<T = any>(
  res: Response,
  fallback: string
): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new HrActionError(res.status, data, fallback)
  return data as T
}

/** Toast copy for a failed action, including the one failure HR must recognise. */
export function failureToast(err: any, fallbackTitle: string): {
  title: string
  description: string
  variant: "destructive"
} {
  const status = err instanceof HrActionError ? err.status : Number(err?.status || 0)
  if (status === 401) {
    return {
      title: "Session expired — please log in again",
      description: "Your nudge/call was not sent. Log in and click it once more.",
      variant: "destructive",
    }
  }
  if (status === 403) {
    return {
      title: "No permission for this action",
      description: "Ask an admin for outreach/calling access, then try again.",
      variant: "destructive",
    }
  }
  if (status === 409) {
    const reason = String(err?.data?.reason || "")
    const alreadyCalling = reason === "already_calling" || /already in progress/i.test(err?.message || "")
    return {
      title: alreadyCalling ? "Call already in progress" : fallbackTitle,
      description: err?.message || "This action was refused. Open the candidate's result to see why.",
      variant: "destructive",
    }
  }
  return {
    title: fallbackTitle,
    description: err?.message || "The action could not be completed. Please try again.",
    variant: "destructive",
  }
}

/**
 * Toast copy for a completed action. Uses the server-written note so the time
 * and result match the timestamp stored on the candidate's thread.
 */
export function actionToast(
  action: "nudge" | "call",
  result?: HrActionResult | null,
  fallback?: string
): { title: string; description: string; variant?: "destructive" } {
  const failed = result?.status === "failed"
  const title =
    action === "nudge"
      ? failed ? "Nudge was not sent" : "Nudged"
      : failed ? "Call was not placed" : result?.status === "deferred" ? "Call scheduled" : "Call started"
  return {
    title,
    description: result?.text || fallback || "Recorded on the candidate's conversation.",
    ...(failed ? { variant: "destructive" as const } : {}),
  }
}
