"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2, Search, User, Phone as PhoneIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"

interface CandidateItem {
  id: string
  name: string
  email: string
  phone: string
  current_role: string
  current_company: string
  source: string
  origin?: string
}

interface PhoneScreeningCandidateSelectorProps {
  jobId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

export function PhoneScreeningCandidateSelector({
  jobId,
  open,
  onOpenChange,
  onComplete,
}: PhoneScreeningCandidateSelectorProps) {
  const [candidates, setCandidates] = useState<CandidateItem[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState("")
  const [originFilter, setOriginFilter] = useState<"all" | "inbound" | "outbound">("all")
  const [callMode, setCallMode] = useState<"call_now" | "whatsapp_first">("call_now")
  const { toast } = useToast()

  const fetchCandidates = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/phone-screening/candidates?jobId=${jobId}`)
      if (res.ok) {
        const data = await res.json()
        setCandidates(data)
      }
    } catch {
      /* noop */
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    if (!open) return
    setSelectedIds(new Set())
    setSearchQuery("")
    setOriginFilter("all")
    fetchCandidates()
  }, [open, fetchCandidates])

  const toggleCandidate = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map((c) => c.id)))
    }
  }

  const filtered = candidates.filter((c) => {
    if (originFilter !== "all" && (c.origin || "inbound") !== originFilter) return false
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.current_role || "").toLowerCase().includes(q)
    )
  })

  const handleSubmit = async () => {
    if (selectedIds.size === 0) return
    setSubmitting(true)
    try {
      const res = await fetch("/api/phone-screening/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, candidateIds: Array.from(selectedIds), origin: "outbound", callMode }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to start screening")

      toast({
        title: callMode === "call_now" ? "Screening started" : "WhatsApp outreach sent",
        description:
          callMode === "call_now"
            ? `Direct calls triggered for ${data.callsTriggered || 0} candidates`
            : `WhatsApp outreach sent to ${data.nudgeSent || 0} candidates`,
      })

      onOpenChange(false)
      onComplete()
    } catch (err: any) {
      toast({
        title: "Failed to start screening",
        description: err.message,
        variant: "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }

  const hasPhone = (phone: string | null | undefined) => Boolean(phone && phone.replace(/\D/g, "").length >= 10)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Start Phone Screening</DialogTitle>
          <DialogDescription>
            Select candidates to call immediately with the AI screener
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <Input
            placeholder="Search candidates..."
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-1">
          {(["all", "inbound", "outbound"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setOriginFilter(f)}
              className={`px-3 py-1 rounded-lg text-[10px] font-black tracking-widest uppercase transition-all ${
                originFilter === f
                  ? f === "outbound"
                    ? "bg-violet-600 text-white"
                    : f === "inbound"
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
              }`}
            >
              {f === "all" ? "All" : f === "inbound" ? "Inbound" : "Outbound"}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-zinc-400 text-center py-8">No candidates found</p>
          ) : (
            <>
              <div className="flex items-center gap-2 px-1 py-2 border-b border-zinc-100">
                <Checkbox
                  checked={selectedIds.size === filtered.length && filtered.length > 0}
                  onCheckedChange={toggleAll}
                  id="select-all"
                />
                <Label htmlFor="select-all" className="text-xs font-semibold text-zinc-500 cursor-pointer">
                  Select All ({filtered.length})
                </Label>
                {selectedIds.size > 0 && (
                  <Badge variant="secondary" className="ml-auto text-xs">
                    {selectedIds.size} selected
                  </Badge>
                )}
              </div>

              {filtered.map((c) => (
                <div
                  key={c.id}
                  className={`flex items-center gap-3 p-3 rounded-xl transition-colors cursor-pointer ${
                    selectedIds.has(c.id) ? "bg-emerald-50" : "hover:bg-zinc-50"
                  }`}
                  onClick={() => toggleCandidate(c.id)}
                >
                  <Checkbox checked={selectedIds.has(c.id)} />
                  <div className="h-8 w-8 rounded-full bg-zinc-200 flex items-center justify-center flex-shrink-0">
                    <User className="h-4 w-4 text-zinc-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-zinc-800 truncate">{c.name}</p>
                      <Badge
                        variant="outline"
                        className={`shrink-0 text-[9px] font-bold px-1.5 py-0 rounded-full border-none ${
                          c.origin === "outbound" ? "bg-violet-100 text-violet-700" : "bg-blue-100 text-blue-700"
                        }`}
                      >
                        {c.origin === "outbound" ? "Outbound" : "Inbound"}
                      </Badge>
                    </div>
                    <p className="text-xs text-zinc-400 truncate">{c.current_role || "No role"}{c.current_company ? ` at ${c.current_company}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {hasPhone(c.phone) ? (
                      <Badge variant="outline" className="text-[10px] bg-green-50 text-green-600 border-green-200 gap-1">
                        <PhoneIcon className="h-3 w-3" />
                        Phone
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] bg-red-50 text-red-400 border-red-200">
                        No phone
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <DialogFooter className="flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center rounded-lg border border-zinc-200 overflow-hidden text-[11px] font-bold">
            <button
              type="button"
              onClick={() => setCallMode("call_now")}
              className={`px-3 py-2 ${callMode === "call_now" ? "bg-emerald-600 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"}`}
            >
              Direct call
            </button>
            <button
              type="button"
              onClick={() => setCallMode("whatsapp_first")}
              className={`px-3 py-2 ${callMode === "whatsapp_first" ? "bg-teal-600 text-white" : "bg-white text-zinc-500 hover:bg-zinc-50"}`}
            >
              WhatsApp nudge
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={selectedIds.size === 0 || submitting}
              className="bg-emerald-600 hover:bg-emerald-700 gap-2"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {callMode === "call_now" ? "Start Calls" : "Send WhatsApp"} ({selectedIds.size})
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
