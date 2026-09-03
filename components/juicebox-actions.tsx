"use client"

import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Loader2, PhoneCall, Sparkles, Trash2 } from "lucide-react"

export const STATUS_STYLES: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-600 border-zinc-200",
  enriching: "bg-amber-50 text-amber-600 border-amber-200",
  enriched: "bg-emerald-50 text-emerald-600 border-emerald-200",
  failed: "bg-red-50 text-red-600 border-red-200",
}

export function experienceText(months: number | null): string {
  if (months == null) return "—"
  const years = months / 12
  return years >= 1 ? `${years.toFixed(1)} yrs` : `${months} mo`
}

export async function downloadJuiceboxResume(jobId: string, profileId: string): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}/juicebox/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error || "Download failed")
  }
  const blob = await res.blob()
  const disposition = res.headers.get("Content-Disposition") || ""
  const match = /filename="([^"]+)"/.exec(disposition)
  const filename = match?.[1] || "resume.html"
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

interface JuiceboxEnrichDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  busy: boolean
  contactTypes: string[]
  onContactTypesChange: React.Dispatch<React.SetStateAction<string[]>>
  onConfirm: () => void
}

export function JuiceboxEnrichDialog({
  open, onOpenChange, count, busy, contactTypes, onContactTypesChange, onConfirm,
}: JuiceboxEnrichDialogProps) {
  const options = [
    { key: "phone", label: "Phone only" },
    { key: "email", label: "Email only" },
    { key: "both", label: "Phone + email" },
  ]
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-500" />
            Enrich {count} profile(s)
          </DialogTitle>
          <DialogDescription>
            thepeakai.com will look up contact info from the LinkedIn id. Results are cached forever and never re-fetched.
            <span className="mt-1 block text-xs text-zinc-500">
              Credits: ~9 per phone lookup, ~9 per email lookup. Check <code className="rounded bg-zinc-100 px-1">/api/balance</code> after running.
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs font-bold text-zinc-600 uppercase tracking-wider">Contact type</Label>
          {options.map((opt) => {
            const checked =
              opt.key === "both"
                ? contactTypes.includes("phone") && contactTypes.includes("email")
                : contactTypes.includes(opt.key)
            return (
              <button
                key={opt.key}
                type="button"
                className={`w-full flex items-center gap-3 rounded-xl border-2 p-3 text-left transition-all ${
                  checked ? "border-violet-500 bg-violet-50/60" : "border-zinc-200 hover:border-zinc-300"
                }`}
                onClick={() => {
                  if (opt.key === "both") {
                    onContactTypesChange(checked ? [] : ["phone", "email"])
                  } else {
                    onContactTypesChange((prev: string[]) => {
                      const next = checked ? prev.filter((t) => t !== opt.key) : [...prev, opt.key]
                      return next.length === 0 ? ["phone"] : next
                    })
                  }
                }}
              >
                <span className={`h-4 w-4 rounded border-2 shrink-0 ${checked ? "bg-violet-500 border-violet-500" : "border-zinc-300"}`} />
                <span className="text-sm font-medium text-zinc-700">{opt.label}</span>
              </button>
            )
          })}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button size="sm" className="bg-violet-600 hover:bg-violet-700" onClick={onConfirm} disabled={busy || count === 0 || contactTypes.length === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
            {busy ? "Enriching..." : "Enrich now"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface JuiceboxCallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  busy: boolean
  onConfirm: () => void
}

export function JuiceboxCallDialog({ open, onOpenChange, count, busy, onConfirm }: JuiceboxCallDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PhoneCall className="h-5 w-5 text-emerald-500" />
            Assign {count} profile(s) to AI calls
          </DialogTitle>
          <DialogDescription>
            Enriched profiles with a phone number will get a Bolna outbound screening call (Hinglish default). Candidates without a phone are skipped and listed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={onConfirm} disabled={busy || count === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <PhoneCall className="h-4 w-4 mr-1.5" />}
            {busy ? "Triggering..." : `Trigger ${count} call(s)`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface JuiceboxDeleteConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  onConfirm: () => void
}

export function JuiceboxDeleteConfirm({ open, onOpenChange, busy, onConfirm }: JuiceboxDeleteConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o ? true : false) }}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Remove profile?</DialogTitle>
          <DialogDescription>
            This deletes the Juicebox profile and its cached contacts. Candidates already materialized for calls are not affected.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Trash2 className="h-4 w-4 mr-1.5" />}
            Remove
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
