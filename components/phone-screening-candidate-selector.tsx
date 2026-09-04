"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2, Search, User, Phone as PhoneIcon, ChevronDown, ChevronUp, Bot, Briefcase, MapPin, IndianRupee, Clock } from "lucide-react"
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

interface QuestionPreview {
  questions: string[]
  jobTitle: string
  clientName: string
  skillsRequired: string[]
  experienceRange: string
  salaryRange: string
  location: string
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
  const [showPreview, setShowPreview] = useState(false)
  const [previewData, setPreviewData] = useState<QuestionPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
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

  const fetchPreview = useCallback(async () => {
    if (previewData) return // Already loaded
    setPreviewLoading(true)
    try {
      const res = await fetch(`/api/phone-screening/preview-questions?jobId=${jobId}`)
      if (res.ok) {
        const data = await res.json()
        setPreviewData(data)
      }
    } catch {
      /* noop */
    } finally {
      setPreviewLoading(false)
    }
  }, [jobId, previewData])

  useEffect(() => {
    if (!open) return
    setSelectedIds(new Set())
    setSearchQuery("")
    setOriginFilter("all")
    setShowPreview(false)
    setPreviewData(null)
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
      <DialogContent className="sm:max-w-[700px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Start Phone Screening</DialogTitle>
          <DialogDescription>
            Select candidates to call with the AI screener. Preview questions below.
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

        {/* Questions Preview Toggle */}
        <button
          type="button"
          onClick={() => {
            setShowPreview(!showPreview)
            if (!showPreview && !previewData) fetchPreview()
          }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-50 hover:bg-zinc-100 border border-zinc-200 transition-colors text-left"
        >
          <Bot className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-semibold text-zinc-700">
            {showPreview ? "Hide" : "Show"} AI Agent Config & Questions
          </span>
          {showPreview ? (
            <ChevronUp className="h-3.5 w-3.5 text-zinc-400 ml-auto" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400 ml-auto" />
          )}
        </button>

        {/* Questions Preview Panel */}
        {showPreview && (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 space-y-3 max-h-[280px] overflow-y-auto">
            {previewLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                <span className="text-xs text-zinc-500 ml-2">Generating preview questions...</span>
              </div>
            ) : previewData ? (
              <>
                {/* Job Summary */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-1.5 text-zinc-600">
                    <Briefcase className="h-3.5 w-3.5 text-zinc-400" />
                    <span className="font-medium">{previewData.jobTitle}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-zinc-600">
                    <MapPin className="h-3.5 w-3.5 text-zinc-400" />
                    <span>{previewData.location}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-zinc-600">
                    <Clock className="h-3.5 w-3.5 text-zinc-400" />
                    <span>{previewData.experienceRange}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-zinc-600">
                    <IndianRupee className="h-3.5 w-3.5 text-zinc-400" />
                    <span>{previewData.salaryRange}</span>
                  </div>
                </div>

                {/* Skills */}
                {previewData.skillsRequired.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Required Skills</p>
                    <div className="flex flex-wrap gap-1">
                      {previewData.skillsRequired.map((skill) => (
                        <Badge key={skill} variant="outline" className="text-[10px] bg-white text-zinc-600 border-zinc-200">
                          {skill}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Questions */}
                <div>
                  <p className="text-[10px] font-bold text-zinc-400 uppercase mb-2">
                    AI Screening Questions ({previewData.questions.length})
                  </p>
                  <ol className="space-y-1.5">
                    {previewData.questions.map((q, i) => (
                      <li key={i} className="flex gap-2 text-xs text-zinc-700">
                        <span className="font-bold text-emerald-600 shrink-0">{i + 1}.</span>
                        <span>{q}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                {/* Agent Config Note */}
                <div className="pt-2 border-t border-zinc-200">
                  <p className="text-[10px] text-zinc-500 leading-relaxed">
                    <span className="font-semibold">Agent Config:</span> The AI agent will use GPT-4.1-mini for conversation, ElevenLabs (Nila) for voice synthesis, and Deepgram for transcription. Questions are JD-specific and generated per candidate.
                  </p>
                </div>
              </>
            ) : (
              <p className="text-xs text-zinc-500 text-center py-4">Failed to load preview</p>
            )}
          </div>
        )}

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
