"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CalendarCheck, Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { failureToast, readHrActionResponse } from "@/lib/client/hr-action-feedback"
import {
  HR_EXACT_TIME_SOURCE,
  HR_SCHEDULE_REASON_MIN,
  formatIst,
} from "@/lib/hr-exact-schedule-validation"

/** Same flag as the server routes. Off by default: no UI, no request. */
export function hrExactUiEnabled(): boolean {
  const raw = (process.env.NEXT_PUBLIC_ENABLE_HR_EXACT_TIME_SCHEDULING || "").trim().toLowerCase()
  return raw === "1" || raw === "true"
}

const LIVE_STATUSES = ["calling", "in_progress", "in-progress", "initiated", "queued", "ringing"]

function parseContext(participant: any): Record<string, any> | null {
  const ctx = participant?.screening_context
  if (!ctx) return null
  if (typeof ctx === "object") return ctx as Record<string, any>
  try {
    return JSON.parse(ctx)
  } catch {
    return null
  }
}

/** `datetime-local` is a wall-clock value. We treat it as IST, never browser-local time. */
function toIstInputValue(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)
  const part = (type: string) => parts.find((p) => p.type === type)?.value || ""
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`
}

function fromIstInputValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const due = new Date(`${value}:00+05:30`)
  return Number.isFinite(due.getTime()) ? due : null
}

function formatSlot(slot: { scheduledAt?: string; bookedBy?: string | null } | null): string {
  if (!slot?.scheduledAt) return "HR slot"
  const at = new Date(slot.scheduledAt)
  if (!Number.isFinite(at.getTime())) return "HR slot"
  const bookedBy = slot.bookedBy ? ` · ${slot.bookedBy}` : ""
  return `${formatIst(at)} IST${bookedBy}`
}

export function HrExactScheduleControl({
  participant,
  hasPhone,
  onChanged,
}: {
  participant: any | null | undefined
  hasPhone?: boolean
  onChanged?: () => void
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [slotInput, setSlotInput] = useState("")
  const [note, setNote] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const bounds = useMemo(() => {
    const now = Date.now()
    return {
      min: toIstInputValue(new Date(now + 5 * 60 * 1000)),
      max: toIstInputValue(new Date(now + 7 * 24 * 60 * 60 * 1000)),
    }
  }, [open])

  if (!hrExactUiEnabled() || !participant?.id) return null

  const ctx = parseContext(participant)
  const hrSlot = ctx?.hrScheduledSlot as
    | { scheduledAt?: string; messageId?: string | null; bookedBy?: string | null; note?: string | null }
    | undefined
  const isHrSlot =
    participant.booking_source === HR_EXACT_TIME_SOURCE || !!hrSlot?.scheduledAt
  const status = String(participant.status || "").toLowerCase()
  const due = hrSlot?.scheduledAt ? new Date(hrSlot.scheduledAt).getTime() : NaN
  const futureSlot =
    isHrSlot &&
    status === "call_scheduled" &&
    Number.isFinite(due) &&
    due > Date.now()
  const live =
    LIVE_STATUSES.includes(status) ||
    LIVE_STATUSES.includes(String(participant.bolna_status || "").toLowerCase())
  const phoneMissing = hasPhone === false || !participant.candidates?.phone

  const openDialog = () => {
    setSlotInput(toIstInputValue(new Date(Date.now() + 10 * 60 * 1000)))
    setNote("")
    setReason("")
    setError(null)
    setOpen(true)
  }

  const submit = async () => {
    setError(null)
    const dueAt = fromIstInputValue(slotInput)
    if (!dueAt) {
      setError("Choose a valid date and time in IST.")
      return
    }
    const now = Date.now()
    if (
      dueAt.getTime() < now + 5 * 60 * 1000 ||
      dueAt.getTime() > now + 7 * 24 * 60 * 60 * 1000
    ) {
      setError("Pick a slot at least 5 minutes from now and within 7 days.")
      return
    }
    if (reason.trim().length < HR_SCHEDULE_REASON_MIN) {
      setError(`Add a reason of at least ${HR_SCHEDULE_REASON_MIN} characters.`)
      return
    }

    setBusy(true)
    try {
      const res = await fetch(`/api/phone-screening/participants/${participant.id}/schedule-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduledAt: dueAt.toISOString(),
          timezone: "Asia/Kolkata",
          note: note.trim(),
          reason: reason.trim(),
        }),
      })
      const data = await readHrActionResponse<{ scheduledAtIst?: string }>(res, "Could not book the slot")
      toast({
        title: "Exact slot booked",
        description: data.scheduledAtIst
          ? `The AI call will fire at ${data.scheduledAtIst} IST.`
          : "The AI call will fire at the chosen time.",
      })
      setOpen(false)
      onChanged?.()
    } catch (err: any) {
      const feedback = failureToast(err, "Could not book the slot")
      setError(feedback.description)
      toast(feedback)
    } finally {
      setBusy(false)
    }
  }

  const cancelSlot = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/phone-screening/participants/${participant.id}/cancel-schedule`, {
        method: "POST",
      })
      const data = await readHrActionResponse<{ restoredStatus?: string }>(res, "Could not cancel the slot")
      toast({
        title: "Slot cancelled",
        description: data.restoredStatus
          ? `No call will be placed. Row returned to ${data.restoredStatus}.`
          : "No call will be placed.",
      })
      onChanged?.()
    } catch (err: any) {
      toast(failureToast(err, "Could not cancel the slot"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {futureSlot ? (
        <div className="flex items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-indigo-200 bg-indigo-50 text-xs font-semibold text-indigo-700"
            title={` booked by ${hrSlot?.bookedBy || "HR"}${hrSlot?.note ? ` · ${hrSlot.note}` : ""}`}
          >
            <CalendarCheck className="h-3.5 w-3.5" />
            HR slot · {formatSlot(hrSlot || null)}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs rounded-lg"
            disabled={busy}
            onClick={cancelSlot}
            title="Cancel the booked AI call"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Cancel slot"}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2.5 text-xs rounded-lg gap-1"
          disabled={busy || live || phoneMissing}
          onClick={openDialog}
          title={
            phoneMissing
              ? "Add a phone number before booking a call"
              : live
                ? "Wait for the current call to finish"
                : "Book the AI call for an exact time HR agreed with the candidate"
          }
        >
          <CalendarCheck className="h-3.5 w-3.5" />
          {busy ? "Saving…" : "Schedule Call"}
        </Button>
      )}

      <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) setError(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Book an exact AI call time</DialogTitle>
            <DialogDescription>
              All times are India time (IST). The call fires at this exact time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <label htmlFor="hr-slot-datetime" className="text-xs font-semibold text-zinc-600">
                Date and time (IST)
              </label>
              <Input
                id="hr-slot-datetime"
                type="datetime-local"
                value={slotInput}
                min={bounds.min}
                max={bounds.max}
                onChange={(event) => setSlotInput(event.target.value)}
              />
              <p className="text-[11px] text-zinc-400">At least 5 minutes from now, up to 7 days ahead.</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="hr-slot-note" className="text-xs font-semibold text-zinc-600">
                Candidate’s words <span className="font-normal text-zinc-400">(optional)</span>
              </label>
              <Textarea
                id="hr-slot-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="e.g. Candidate said: after 3 pm tomorrow"
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="hr-slot-reason" className="text-xs font-semibold text-zinc-600">
                Why this exact time <span className="text-red-500">*</span>
              </label>
              <Textarea
                id="hr-slot-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. HR spoke to the candidate and they agreed to this time"
                rows={2}
              />
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={submit}
                disabled={busy || reason.trim().length < HR_SCHEDULE_REASON_MIN}
              >
                {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                Book exact slot
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
