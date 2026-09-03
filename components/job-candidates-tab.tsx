"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PhoneScreeningResultsSheet } from "./phone-screening-results-sheet"
import {
  Loader2, User, MapPin, Briefcase, Eye, Sparkles, Mail, Phone, ChevronDown, ChevronUp,
  PhoneCall, CheckCircle, Clock, UserX, Play, Save, Filter, MessageCircle, Send, CheckCheck
} from "lucide-react"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogAction, AlertDialogCancel
} from "@/components/ui/alert-dialog"
import { formatDistanceToNow } from "date-fns"
import { invalidateSessionCache } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"

interface CandidateData {
  name: string
  email: string
  phone?: string
  current_role: string
  current_company?: string
  total_experience?: string
  location: string
  technical_skills?: string[]
  current_salary?: string
  expected_salary?: string
  resume_text?: string
  [key: string]: any
}

interface Application {
  id: string
  candidate_id: string
  status: string
  applied_at: string
  notes: string
  candidate_notes?: string
  source?: string
  origin?: string
  match_score?: number
  candidates: CandidateData
}

type FilterValue = "all" | "inbound" | "outbound" | "database" | "board-app"
type CallSubFilter = "all" | "pending" | "whatsapp_sent" | "replied" | "calling" | "call_done" | "rejected"

interface CandidateCardProps {
  application: Application
  jobId: string
  callStatus?: string
  aiInfo?: { recommendation?: string; score?: number }
  clientDecision?: string | null
  selected: boolean
  callNowBusy?: boolean
  nudgeBusy?: boolean
  onCallNow?: () => void
  onNudgeStart?: () => void
  onNudgeEnd?: () => void
  onSelect: (id: string) => void
  onViewProfile: (candidate: any) => void
  onViewResults?: (candidateId: string) => void
  onStageChange: (applicationId: string, from: string, to: string, candidateName: string) => void
  onApplicationUpdated: (updated: Application) => void
}

export interface CandidatesTabProps {
  jobId: string
  applications: Application[]
  loading: boolean
  activeStage: string
  activeCallSubFilter?: string
  clientDecisions?: Record<string, string | null> | null
  onStageSelect: (stage: string) => void
  onCallSubFilterChange?: (sub: string) => void
  onStageChange: (applicationId: string, newStage: string, rejectionReason?: string) => void
  onApplicationUpdated: (updated: Application) => void
  onViewProfile: (candidate: any) => void
  onViewResults?: (candidateId: string) => void
  onRefresh: () => void
}

const STATUS_COLUMNS = [
  { id: "applied", label: "Applied", color: "bg-blue-100 text-blue-800" },
  { id: "ai_screen", label: "AI Screen", color: "bg-indigo-100 text-indigo-800" },
  { id: "shortlist", label: "Shortlist", color: "bg-purple-100 text-purple-800" },
  { id: "interview", label: "Interview", color: "bg-cyan-100 text-cyan-800" },
  { id: "offer", label: "Offer", color: "bg-green-100 text-green-800" },
  { id: "hired", label: "Hired", color: "bg-emerald-100 text-emerald-800" },
  { id: "rejected", label: "Rejected", color: "bg-red-100 text-red-800" },
]

const CALL_SUB_SECTIONS = [
  { id: "pending", label: "Pending", hint: "Not yet contacted" },
  { id: "whatsapp_sent", label: "WhatsApp Sent", hint: "Message sent, waiting to be read" },
  { id: "replied", label: "Replied", hint: "Candidate responded Yes" },
  { id: "calling", label: "Calling Now", hint: "AI call in progress" },
  { id: "call_done", label: "Call Done", hint: "Screening complete, review needed" },
  { id: "rejected", label: "Rejected", hint: "Not interested or failed" },
] as const

const CALL_STATUS_COLORS: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-600 border-zinc-200",
  whatsapp_sent: "bg-teal-50 text-teal-700 border-teal-200",
  replied: "bg-green-50 text-green-700 border-green-200",
  calling: "bg-amber-50 text-amber-700 border-amber-200",
  call_done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-600 border-red-200",
}

const CALL_STATUS_ICONS: Record<string, any> = {
  pending: Clock,
  whatsapp_sent: Send,
  replied: MessageCircle,
  calling: PhoneCall,
  call_done: CheckCircle,
  rejected: UserX,
}

const SOURCE_LABELS: Record<string, string> = {
  portal: "GatiHire Portal",
  apna: "Apna",
  naukri: "Naukri",
  workindia: "WorkIndia",
  job_board: "Job Board",
  applied: "Applied",
  candidate_board: "Candidate Board",
  "board-app": "Board App",
  external_outreach: "External Outreach",
  database: "Database Match",
  enhanced_match: "Enhanced Match",
  recruiter_upload: "Recruiter Upload",
}

function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

// Map a participant's screening status → pipeline call sub-section.
function callSubSection(participant: any): string {
  const status = participant?.status
  const review = participant?.review_status
  const delivery = participant?.whatsapp_delivery_status
  const reply = participant?.whatsapp_response || participant?.whatsapp_reply_text

  // Final states first
  if (review === "approved") return "call_done"
  if (review === "rejected") return "rejected"
  if (status === "completed") return "call_done"
  if (["not_interested", "unreachable", "failed", "rejected"].includes(status)) return "rejected"

  // Active call
  if (status === "in_progress" || status === "calling" || status === "call_scheduled") return "calling"

  // WhatsApp lifecycle
  if (reply) return "replied"
  if (status === "whatsapp_sent" || delivery === "delivered" || delivery === "sent" || delivery === "read") return "whatsapp_sent"

  // No contact yet
  return "pending"
}

export function CandidatesTab({ jobId, applications, loading, activeStage, activeCallSubFilter, clientDecisions, onStageSelect, onCallSubFilterChange, onStageChange, onApplicationUpdated, onViewProfile, onRefresh }: CandidatesTabProps) {
  const { toast } = useToast()
  const [pendingStageChange, setPendingStageChange] = useState<{
    applicationId: string; from: string; to: string; candidateName: string
  } | null>(null)
  const [rejectionReason, setRejectionReason] = useState("")
  const [filter, setFilter] = useState<FilterValue>("all")
  const [callSubFilter, setCallSubFilter] = useState<CallSubFilter>(() =>
    activeCallSubFilter && activeCallSubFilter !== "all" ? (activeCallSubFilter as CallSubFilter) : "all"
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [callStatusByCandidate, setCallStatusByCandidate] = useState<Record<string, string>>({})
  const [participantIdByCandidate, setParticipantIdByCandidate] = useState<Record<string, string>>({})
  const [callNowCandidate, setCallNowCandidate] = useState<string | null>(null)
  const [nudgeBusyCandidate, setNudgeBusyCandidate] = useState<string | null>(null)
  const [callMode, setCallMode] = useState<"call_now" | "whatsapp_first">("call_now")
  const [aiInfoByCandidate, setAiInfoByCandidate] = useState<Record<string, { recommendation?: string; score?: number }>>({})
  const [callingStarted, setCallingStarted] = useState(false)
  const [bulkStage, setBulkStage] = useState("ai_screen")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [resultParticipantId, setResultParticipantId] = useState<string | null>(null)

  const fetchParticipants = useCallback(async () => {
    try {
      const res = await fetch(`/api/phone-screening/participants?jobId=${jobId}`)
      if (res.ok) {
        const data = await res.json()
        const map: Record<string, string> = {}
        const idMap: Record<string, string> = {}
        const aiMap: Record<string, { recommendation?: string; score?: number }> = {}
        for (const p of Array.isArray(data) ? data : []) {
          if (p?.candidate_id) {
            if (!map[p.candidate_id]) map[p.candidate_id] = callSubSection(p)
            if (!idMap[p.candidate_id]) idMap[p.candidate_id] = p.id
            aiMap[p.candidate_id] = {
              recommendation: p.ai_recommendation ?? undefined,
              score: p.ai_score != null ? Number(p.ai_score) : undefined,
            }
          }
        }
        setCallStatusByCandidate(map)
        setParticipantIdByCandidate(idMap)
        setAiInfoByCandidate(aiMap)
      }
    } catch {
      /* noop */
    }
  }, [jobId])

  useEffect(() => {
    fetchParticipants()
  }, [fetchParticipants])

  // Poll for status updates when there are active calls
  useEffect(() => {
    const hasActiveCalls = Object.values(callStatusByCandidate).some(
      (s) => s === "calling" || s === "whatsapp_sent" || s === "replied"
    )
    if (!hasActiveCalls) return
    const interval = setInterval(() => {
      fetchParticipants()
    }, 5000)
    return () => clearInterval(interval)
  }, [callStatusByCandidate, fetchParticipants])

  useEffect(() => {
    if (activeCallSubFilter && activeCallSubFilter !== "all") {
      setCallSubFilter(activeCallSubFilter as CallSubFilter)
    }
  }, [activeCallSubFilter])

  const handleStageChange = (appId: string, from: string, to: string, name: string) => {
    if (["interview", "offer", "hired", "rejected"].includes(to) && from !== to) {
      setPendingStageChange({ applicationId: appId, from, to, candidateName: name })
    } else if (to === "shortlist" && from !== to) {
      setPendingStageChange({ applicationId: appId, from, to, candidateName: name })
    } else {
      onStageChange(appId, to)
    }
  }

  const confirmStageChange = () => {
    if (!pendingStageChange) return
    onStageChange(pendingStageChange.applicationId, pendingStageChange.to, pendingStageChange.to === "rejected" ? rejectionReason : undefined)
    setPendingStageChange(null)
    setRejectionReason("")
  }

  const filtered = (activeStage === "all"
    ? applications
    : applications.filter((a) => a.status === activeStage))
    .filter((a) => {
      if (filter === "all") return true
      if (filter === "inbound") return (a.origin || "inbound") === "inbound"
      if (filter === "outbound") return (a.origin || "inbound") === "outbound"
      if (filter === "database") return ["database", "enhanced_match"].includes(a.source || "")
      return a.source === "board-app"
    })
    .filter((a) => {
      if (activeStage !== "ai_screen" || callSubFilter === "all") return true
      return (callStatusByCandidate[a.candidate_id] || "pending") === callSubFilter
    })

  const stageCount = (stageId: string) => applications.filter((a) => a.status === stageId).length

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedApplications = applications.filter((a) => selectedIds.has(a.id))
  const selectedCandidateIds = selectedApplications.map((a) => a.candidate_id)
  const [confirmCallsOpen, setConfirmCallsOpen] = useState(false)
  const inboundCount = selectedApplications.filter((a) => (a.origin || "inbound") === "inbound").length
  const outboundCount = selectedApplications.length - inboundCount

  const startAiCalls = async () => {
    if (selectedCandidateIds.length === 0) return
    setCallingStarted(true)
    try {
      const res = await fetch("/api/phone-screening/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, candidateIds: selectedCandidateIds, callMode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to start screening")

      const triggered = data.callsTriggered || 0
      const failed = data.callsFailed || 0
      const skipped = data.skippedNoPhone?.length || 0
      const nudged = data.nudgeSent || 0

      let description = ""
      if (callMode === "call_now") {
        description = `${triggered} calls placed`
        if (failed > 0) description += `, ${failed} failed`
        if (skipped > 0) description += `, ${skipped} skipped (no phone)`
      } else {
        description = `${nudged} WhatsApp nudges sent`
        if (skipped > 0) description += `, ${skipped} skipped (no phone)`
      }

      toast({
        title: callMode === "call_now" ? "AI calls started" : "WhatsApp outreach started",
        description,
        variant: failed > 0 && triggered === 0 ? "destructive" : "default",
      })

      setSelectedIds(new Set())
      setConfirmCallsOpen(false)
      onRefresh()
      fetchParticipants()
    } catch (err: any) {
      toast({ title: "Failed to start calls", description: err.message, variant: "destructive" })
    } finally {
      setCallingStarted(false)
    }
  }

  const callCandidateNow = async (candidateId: string) => {
    const participantId = participantIdByCandidate[candidateId]
    if (!participantId) {
      toast({ title: "No screening record", description: "This candidate has no phone-screening entry yet", variant: "destructive" })
      return
    }
    setCallNowCandidate(candidateId)
    try {
      const res = await fetch("/api/phone-screening/call-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to place call")
      toast({ title: "Call placed", description: "AI call triggered for this candidate" })
      fetchParticipants()
      onRefresh()
    } catch (err: any) {
      toast({ title: "Failed to place call", description: err.message, variant: "destructive" })
    } finally {
      setCallNowCandidate(null)
    }
  }

  const bulkMove = async () => {
    if (selectedApplications.length === 0) return
    setBulkBusy(true)
    let ok = 0
    let fail = 0
    try {
      for (const app of selectedApplications) {
        const res = await fetch(`/api/applications/${app.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: bulkStage }),
        })
        if (res.ok) ok++
        else fail++
      }
      toast({ title: "Bulk move complete", description: `${ok} moved, ${fail} failed` })
      invalidateSessionCache("internal:applications:", { prefix: true })
      setSelectedIds(new Set())
      onRefresh()
    } finally {
      setBulkBusy(false)
    }
  }

  const bulkReject = async () => {
    if (selectedApplications.length === 0) return
    setBulkBusy(true)
    try {
      for (const app of selectedApplications) {
        await fetch(`/api/applications/${app.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "rejected" }),
        })
      }
      toast({ title: "Rejected", description: `${selectedApplications.length} candidates rejected` })
      invalidateSessionCache("internal:applications:", { prefix: true })
      setSelectedIds(new Set())
      onRefresh()
    } finally {
      setBulkBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-300" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 p-1 bg-zinc-100/80 rounded-xl border border-zinc-200/80 overflow-x-auto no-scrollbar">
        <StageButton
          label="All"
          count={applications.length}
          active={activeStage === "all"}
          color="zinc"
          onClick={() => onStageSelect("all")}
        />
        {STATUS_COLUMNS.map((col) => (
          <StageButton
            key={col.id}
            label={col.label}
            count={stageCount(col.id)}
            active={activeStage === col.id}
            color={col.id}
            onClick={() => onStageSelect(col.id)}
          />
        ))}
        <div className="ml-auto flex items-center gap-1.5 shrink-0 pl-2 border-l border-zinc-200">
          <Filter className="h-3.5 w-3.5 text-zinc-400" />
          <Select value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
            <SelectTrigger className="h-7 w-44 text-xs bg-white rounded-lg border-zinc-200 focus:ring-zinc-300">
              <SelectValue placeholder="Filter candidates" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All candidates</SelectItem>
              <SelectItem value="inbound">Inbound · applied to us</SelectItem>
              <SelectItem value="outbound">Outbound · we sourced</SelectItem>
              <SelectItem value="database">Database matches</SelectItem>
              <SelectItem value="board-app">Board app</SelectItem>
            </SelectContent>
          </Select>
          {filter !== "all" && (
            <button
              className="text-[10px] font-bold text-zinc-400 hover:text-zinc-600 px-1.5 py-1"
              onClick={() => setFilter("all")}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {activeStage === "ai_screen" && (
        <div className="space-y-2 px-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {CALL_SUB_SECTIONS.map((sub) => {
              const count = applications.filter((a) => (callStatusByCandidate[a.candidate_id] || "pending") === sub.id).length
              return (
                <button
                  key={sub.id}
                  onClick={() => {
                    const next = callSubFilter === sub.id ? "all" : sub.id
                    setCallSubFilter(next)
                    onCallSubFilterChange?.(next)
                  }}
                  title={sub.hint}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide transition-all flex items-center gap-1 ${
                    callSubFilter === sub.id
                      ? "bg-cyan-600 text-white shadow-sm"
                      : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                  }`}
                >
                  {sub.label}
                  <span className={`text-[9px] ml-0.5 ${callSubFilter === sub.id ? "text-cyan-200" : "text-zinc-400"}`}>
                    {count}
                  </span>
                </button>
              )
            })}
            {callSubFilter !== "all" && (
              <button className="text-[10px] font-bold text-zinc-400 hover:text-zinc-600 px-2" onClick={() => { setCallSubFilter("all"); onCallSubFilterChange?.("all") }}>
                Clear
              </button>
            )}
          </div>
          <p className="text-[10px] text-zinc-400 leading-relaxed">
            Flow: <span className="font-semibold text-zinc-500">WhatsApp Sent</span> → candidate reads → replies "Yes" → <span className="font-semibold text-zinc-500">AI Call</span> → <span className="font-semibold text-zinc-500">Call Done</span> → you review
          </p>
        </div>
      )}

      {selectedApplications.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-2xl border border-cyan-200 bg-cyan-50/50">
          <span className="text-sm font-bold text-cyan-800">{selectedApplications.length} selected</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 gap-1" onClick={() => setConfirmCallsOpen(true)} disabled={callingStarted || selectedCandidateIds.length === 0}>
              {callingStarted ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {callingStarted ? "Starting..." : `Start AI Calls (${selectedCandidateIds.length})`}
            </Button>
                        <Select value={bulkStage} onValueChange={setBulkStage}>
              <SelectTrigger className="h-8 w-40 text-xs bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ai_screen">AI Screen</SelectItem>
                <SelectItem value="shortlist">Shortlist</SelectItem>
                <SelectItem value="interview">Interview</SelectItem>
                <SelectItem value="applied">Applied</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={bulkMove} disabled={bulkBusy}>
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Move to Stage
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs border-red-200 text-red-600 hover:bg-red-50" onClick={bulkReject} disabled={bulkBusy}>
              Reject
            </Button>
            <Button variant="ghost" size="sm" className="h-8 text-xs text-zinc-500" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-zinc-400 text-sm border-2 border-dashed border-zinc-200 rounded-2xl bg-zinc-50/50">
          <User className="h-8 w-8 mx-auto mb-2 text-zinc-300" />
          <p className="font-semibold">No candidates in this stage</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((app) => (
            <CandidateCard
              key={app.id}
              application={app}
              jobId={jobId}
              callStatus={activeStage === "ai_screen" ? callStatusByCandidate[app.candidate_id] || "pending" : undefined}
              aiInfo={aiInfoByCandidate[app.candidate_id]}
              clientDecision={clientDecisions?.[app.id] ?? null}
              selected={selectedIds.has(app.id)}
              callNowBusy={callNowCandidate === app.candidate_id}
              nudgeBusy={nudgeBusyCandidate === app.candidate_id}
              onCallNow={() => callCandidateNow(app.candidate_id)}
              onNudgeStart={() => setNudgeBusyCandidate(app.candidate_id)}
              onNudgeEnd={() => { setNudgeBusyCandidate(null); fetchParticipants(); onRefresh() }}
              onSelect={() => toggleSelect(app.id)}
              onViewProfile={onViewProfile}
              onViewResults={(candidateId) => {
                const pid = participantIdByCandidate[candidateId]
                if (pid) setResultParticipantId(pid)
              }}
              onStageChange={handleStageChange}
              onApplicationUpdated={onApplicationUpdated}
            />
          ))}
        </div>
      )}

      {pendingStageChange && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setPendingStageChange(null)}>
          <div className="bg-white rounded-2xl p-6 shadow-xl max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg text-zinc-900">Confirm stage change</h3>
            <p className="text-sm text-zinc-500 mt-2">
              Move <strong>{pendingStageChange.candidateName}</strong> from{" "}
              <strong>{pendingStageChange.from}</strong> to{" "}
              <strong>{pendingStageChange.to}</strong>?
              {pendingStageChange.to === "shortlist" && (
                <span className="mt-1 block text-xs text-amber-600">
                  Shortlist is what gets shared with the client — confirm you've reviewed the AI screening verdict first.
                </span>
              )}
            </p>
            {pendingStageChange.to === "rejected" && (
              <div className="mt-4">
                <label className="block text-xs font-semibold text-zinc-600 mb-1">Rejection reason</label>
                <select
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  className="w-full text-sm text-zinc-600 border border-zinc-200 rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  <option value="">Select a reason…</option>
                  <option value="not_qualified">Not qualified for the role</option>
                  <option value="salary_mismatch">Salary expectations too high</option>
                  <option value="location_mismatch">Location / relocation issues</option>
                  <option value="experience_mismatch">Experience doesn't match requirements</option>
                  <option value="skills_mismatch">Required skills not met</option>
                  <option value="culture_fit">Culture fit concerns</option>
                  <option value="no_response">No response / ghosted</option>
                  <option value="withdrawn">Candidate withdrew</option>
                  <option value="duplicate">Duplicate application</option>
                  <option value="other">Other</option>
                </select>
                <p className="text-xs text-zinc-400 mt-1">Optional — helps track rejection patterns</p>
              </div>
            )}
            <div className="flex justify-end gap-2 mt-6">
              <Button variant="outline" size="sm" onClick={() => { setPendingStageChange(null); setRejectionReason("") }}>Cancel</Button>
              <Button size="sm" onClick={confirmStageChange}>Confirm</Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={confirmCallsOpen} onOpenChange={setConfirmCallsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start AI calls for {selectedApplications.length} candidates?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge className="text-[11px] font-bold px-3 py-1 rounded-full bg-blue-100 text-blue-700">
                  {inboundCount} Inbound — already applied
                </Badge>
                <Badge className="text-[11px] font-bold px-3 py-1 rounded-full bg-violet-100 text-violet-700">
                  {outboundCount} Outbound — cold outreach
                </Badge>
              </div>
              <div className="rounded-xl border border-zinc-200 overflow-hidden">
                <div className="grid grid-cols-2">
                  <button
                    type="button"
                    disabled={callingStarted}
                    onClick={() => setCallMode("call_now")}
                    className={`px-3 py-2.5 text-left text-xs transition-all ${
                      callMode === "call_now" ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-300" : "text-zinc-500 hover:bg-zinc-50"
                    }`}
                  >
                    <span className="block font-bold text-[11px] uppercase tracking-wide">Direct call</span>
                    <span className="text-[11px] opacity-80 mt-0.5 block">Bolna calls each candidate now</span>
                  </button>
                  <button
                    type="button"
                    disabled={callingStarted}
                    onClick={() => setCallMode("whatsapp_first")}
                    className={`px-3 py-2.5 text-left text-xs transition-all ${
                      callMode === "whatsapp_first" ? "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-300" : "text-zinc-500 hover:bg-zinc-50"
                    }`}
                  >
                    <span className="block font-bold text-[11px] uppercase tracking-wide">WhatsApp Nudge → Auto Call</span>
                    <span className="text-[11px] opacity-80 mt-0.5 block">WhatsApp first, then automated call when they respond</span>
                  </button>
                </div>
              </div>
              <p className="text-sm">
                {callMode === "call_now"
                  ? "Bolna will call each selected candidate directly. The AI agent introduces the job differently per group: inbound callers are thanked for applying, outbound callers are informed about the opportunity for the first time. If a candidate is unavailable, the agent captures a preferred call-back time and the call is re-dialed automatically."
                  : "Each selected candidate gets a WhatsApp context message first. They respond to opt in; then an automated AI call is placed. Inbound candidates get the shortlist version, outbound the outreach version."}
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={callingStarted}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={startAiCalls} disabled={callingStarted}>
              {callingStarted ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <PhoneCall className="h-3.5 w-3.5 mr-1" />}
              {callingStarted
                ? `Placing ${callMode === "call_now" ? "calls" : "nudges"}...`
                : callMode === "call_now" ? "Start direct calls" : "Send WhatsApp Nudges → Auto Call"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PhoneScreeningResultsSheet
        participantId={resultParticipantId}
        open={!!resultParticipantId}
        onOpenChange={(open) => { if (!open) setResultParticipantId(null) }}
      />
    </div>
  )
}

function StageButton({ label, count, active, color, onClick }: { label: string; count: number; active: boolean; color: string; onClick: () => void }) {
  const colorMap: Record<string, { active: string; inactive: string }> = {
    applied: { active: "bg-blue-600 text-white", inactive: "bg-blue-50 text-blue-600" },
    ai_screen: { active: "bg-indigo-600 text-white", inactive: "bg-indigo-50 text-indigo-600" },
    shortlist: { active: "bg-purple-600 text-white", inactive: "bg-purple-50 text-purple-600" },
    interview: { active: "bg-cyan-600 text-white", inactive: "bg-cyan-50 text-cyan-700" },
    offer: { active: "bg-green-600 text-white", inactive: "bg-green-50 text-green-600" },
    hired: { active: "bg-emerald-600 text-white", inactive: "bg-emerald-50 text-emerald-600" },
    rejected: { active: "bg-red-600 text-white", inactive: "bg-red-50 text-red-600" },
    zinc: { active: "bg-zinc-900 text-white", inactive: "bg-zinc-200/80 text-zinc-600" },
  }
  const c = colorMap[color] || colorMap.zinc
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wide transition-all flex items-center gap-1.5 whitespace-nowrap ${
        active ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200/60" : "text-zinc-500 hover:text-zinc-900 hover:bg-white/60"
      }`}
    >
      {label}
      <span className={`flex items-center justify-center min-w-[20px] h-5 px-1 rounded-md text-[10px] font-black transition-all ${
        active ? `${c.active} shadow-sm` : count > 0 ? c.inactive : "bg-zinc-200/80 text-zinc-600"
      }`}>
        {count}
      </span>
    </button>
  )
}

function OriginBadge({ origin, onToggle, busy }: { origin?: string; onToggle?: () => void; busy?: boolean }) {
  const isOutbound = origin === "outbound"
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!onToggle || busy}
      title={onToggle ? `Click to change to ${isOutbound ? "Inbound" : "Outbound"}` : undefined}
      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border-none shadow-sm inline-flex items-center gap-1 ${
        isOutbound ? "bg-violet-100 text-violet-700" : "bg-blue-100 text-blue-700"
      } ${onToggle ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}
    >
      {busy && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {isOutbound ? "Outbound" : "Inbound"}
      {onToggle && <span className="opacity-60 text-[8px] font-black uppercase">↺</span>}
    </button>
  )
}

function CallStatusBadge({ status }: { status: string }) {
  const color = CALL_STATUS_COLORS[status] || CALL_STATUS_COLORS.to_call
  const Icon = CALL_STATUS_ICONS[status] || Clock
  const label = CALL_SUB_SECTIONS.find((s) => s.id === status)?.label || "To Call"
  return (
    <Badge variant="outline" className={`gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full border ${color}`}>
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  )
}

function CandidateCard({ application, jobId, callStatus, aiInfo, clientDecision, selected, callNowBusy, nudgeBusy, onCallNow, onNudgeStart, onNudgeEnd, onSelect, onViewProfile, onViewResults, onStageChange, onApplicationUpdated }: CandidateCardProps) {
  const c = application.candidates
  const { toast } = useToast()
  const [aiExpanded, setAiExpanded] = useState(false)
  const [aiSummary, setAiSummary] = useState("")
  const [aiLoading, setAiLoading] = useState(false)
  const [notesDraft, setNotesDraft] = useState<string>(application.notes || "")
  const [notesEditing, setNotesEditing] = useState(false)
  const [notesSaving, setNotesSaving] = useState(false)
  const [retagBusy, setRetagBusy] = useState(false)
  const [confirmCallOpen, setConfirmCallOpen] = useState(false)
  const [confirmCallMode, setConfirmCallMode] = useState<"call_now" | "whatsapp_first">("call_now")

  const saveNotes = async () => {
    setNotesSaving(true)
    try {
      const res = await fetch(`/api/applications/${application.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notesDraft.trim() }),
      })
      if (!res.ok) throw new Error("Failed to save notes")
      onApplicationUpdated({ ...application, notes: notesDraft.trim() })
      setNotesEditing(false)
      toast({ title: "Notes saved" })
    } catch {
      toast({ title: "Failed to save notes", variant: "destructive" })
    } finally {
      setNotesSaving(false)
    }
  }

  const toggleOrigin = async () => {
    const next = (application.origin || "inbound") === "inbound" ? "outbound" : "inbound"
    setRetagBusy(true)
    try {
      const res = await fetch(`/api/applications/${application.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: next }),
      })
      if (!res.ok) throw new Error("Failed to update origin")
      onApplicationUpdated({ ...application, origin: next })
      toast({ title: `Marked as ${next === "inbound" ? "Inbound" : "Outbound"}` })
    } catch {
      toast({ title: "Failed to update origin", variant: "destructive" })
    } finally {
      setRetagBusy(false)
    }
  }

  const generateAiSummary = async () => {
    setAiLoading(true)
    try {
      const res = await fetch("/api/matches/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: c.id, jobId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAiSummary(`Failed: ${data?.error || res.status}`)
      } else {
        setAiSummary(data?.summary || "No analysis available")
      }
      setAiExpanded(true)
    } catch {
      setAiSummary("Failed to generate analysis")
    } finally {
      setAiLoading(false)
    }
  }

  const sendWhatsAppNudge = async (mode: "call_now" | "whatsapp_first") => {
    onNudgeStart?.()
    try {
      const res = await fetch("/api/phone-screening/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, candidateIds: [c.id], origin: application.origin || "outbound", createApplication: true, callMode: mode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to start screening")
      toast({
        title: mode === "call_now" ? "AI call started" : "WhatsApp nudge sent → Auto call scheduled",
        description: mode === "call_now"
          ? `Direct call triggered for ${c.name}`
          : `WhatsApp nudge sent to ${c.name}; automated call will follow when they respond`,
      })
      onApplicationUpdated({ ...application, status: "ai_screen" })
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" })
    } finally {
      onNudgeEnd?.()
    }
  }

  return (
    <>
    <Card className={`border border-zinc-200 shadow-sm hover:shadow-md transition-all rounded-2xl overflow-hidden bg-white ${
      selected ? "ring-2 ring-cyan-300 border-cyan-300" : ""
    }`}>
      <CardContent className="p-0">
        <div className="p-5 md:p-6">
          <div className="flex flex-col md:flex-row justify-between items-start gap-6">
            <div className="flex gap-4 flex-1 min-w-0">
              <div className="flex flex-col items-center gap-2 shrink-0">
                <Checkbox
                  checked={selected}
                  onCheckedChange={() => onSelect(application.id)}
                  aria-label={`Select ${c.name}`}
                />
                <Avatar className="h-14 w-14 border-2 border-zinc-100 shadow-sm">
                  <AvatarFallback className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-bold text-lg">
                    {c.name?.substring(0, 2).toUpperCase() || "CN"}
                  </AvatarFallback>
                </Avatar>
              </div>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold text-xl text-zinc-900 truncate">{c.name}</h3>
                  <OriginBadge origin={application.origin} onToggle={toggleOrigin} busy={retagBusy} />
                  {callStatus && <CallStatusBadge status={callStatus} />}
                  {callStatus === "pending" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px] font-bold gap-1 border-teal-200 text-teal-700 bg-teal-50 hover:bg-teal-100"
                      onClick={onCallNow}
                      disabled={callNowBusy}
                    >
                      {callNowBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <PhoneCall className="h-3 w-3" />}
                      Send WhatsApp
                    </Button>
                  )}
                  {callStatus === "replied" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px] font-bold gap-1 border-amber-200 text-amber-700 bg-amber-50 hover:bg-amber-100"
                      onClick={onCallNow}
                      disabled={callNowBusy}
                    >
                      {callNowBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <PhoneCall className="h-3 w-3" />}
                      Start Call
                    </Button>
                  )}
                  {callStatus === "call_done" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px] font-bold gap-1 border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                      onClick={() => onViewResults?.(application.candidate_id)}
                    >
                      <Eye className="h-3 w-3" />
                      View Results
                    </Button>
                  )}
                  {application.match_score !== null && application.match_score !== undefined && (
                    <Badge variant="outline" className={`text-[10px] font-bold px-2 py-0.5 rounded-full border-none shadow-sm ${
                      application.match_score >= 0.8 ? "bg-emerald-100 text-emerald-700" :
                      application.match_score >= 0.6 ? "bg-amber-100 text-amber-700" :
                      "bg-zinc-100 text-zinc-600"
                    }`}>
                      {Math.round(application.match_score * 100)}% Match
                    </Badge>
                  )}
                  <ClientDecisionBadge decision={clientDecision} />
                  <AiScreenBadge info={aiInfo} />
                </div>
                <p className="text-sm text-zinc-500 flex items-center gap-1.5">
                  <Briefcase className="h-3.5 w-3.5 text-zinc-400" />
                  {c.current_role || "No role specified"}
                  {c.current_company && <span>at {c.current_company}</span>}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400 mt-1">
                  <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{c.email}</span>
                  {c.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{c.phone}</span>}
                  <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{c.location || "N/A"}</span>
                </div>
                {(c.current_salary || c.expected_salary) && (
                  <div className="flex flex-wrap gap-3 mt-2 text-xs font-semibold">
                    {c.current_salary && <span className="text-zinc-500">Current: <span className="text-zinc-700">{c.current_salary}</span></span>}
                    {c.expected_salary && <span className="text-zinc-500">Expected: <span className="text-zinc-700">{c.expected_salary}</span></span>}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" className="h-8 text-xs rounded-lg" onClick={() => onViewProfile(c)}>
                <Eye className="h-3.5 w-3.5 mr-1" />
                View
              </Button>
              <Button variant="outline" size="sm" className="h-8 text-xs rounded-lg" onClick={generateAiSummary} disabled={aiLoading}>
                {aiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 text-xs rounded-lg gap-1" disabled={nudgeBusy}>
                    {nudgeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <MessageCircle className="h-3.5 w-3.5 mr-1" />}
                    {nudgeBusy ? "Starting..." : "Nudge"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => { setConfirmCallMode("whatsapp_first"); setConfirmCallOpen(true) }}>
                    <MessageCircle className="h-3.5 w-3.5 mr-2" />
                    WhatsApp Nudge → Auto Call
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setConfirmCallMode("call_now"); setConfirmCallOpen(true) }}>
                    <PhoneCall className="h-3.5 w-3.5 mr-2" />
                    Direct Call (Skip WhatsApp)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Select value={application.status} onValueChange={(val) => onStageChange(application.id, application.status, val, c.name)}>
                <SelectTrigger className="h-8 text-xs rounded-lg w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="applied">Applied</SelectItem>
                  <SelectItem value="ai_screen">AI Screen</SelectItem>
                  <SelectItem value="shortlist">Shortlist</SelectItem>
                  <SelectItem value="interview">Interview</SelectItem>
                  <SelectItem value="offer">Offer</SelectItem>
                  <SelectItem value="hired">Hired</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-zinc-100">
            {application.candidate_notes && (
              <div className="mb-3">
                <p className="text-xs text-zinc-400 font-semibold mb-1">Candidate Notes</p>
                <p className="text-sm text-zinc-500 whitespace-pre-wrap bg-zinc-50/50 p-2 rounded-lg border border-zinc-100">{application.candidate_notes}</p>
              </div>
            )}
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-zinc-400 font-semibold">Recruiter Notes</p>
              {!notesEditing && (
                <button
                  className="text-[10px] font-bold text-blue-600 hover:text-blue-700"
                  onClick={() => {
                    setNotesDraft(application.notes || "")
                    setNotesEditing(true)
                  }}
                >
                  {application.notes ? "Edit" : "Add note"}
                </button>
              )}
            </div>
            {notesEditing ? (
              <div className="space-y-2">
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  rows={2}
                  placeholder="Add internal notes for this candidate..."
                  className="w-full text-sm text-zinc-600 border border-zinc-200 rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="default"
                    className="bg-blue-600 hover:bg-blue-700 h-7 text-xs"
                    onClick={saveNotes}
                    disabled={notesSaving}
                  >
                    {notesSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setNotesEditing(false)} disabled={notesSaving}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : application.notes ? (
              <p className="text-sm text-zinc-600 mt-0.5 whitespace-pre-wrap">{application.notes}</p>
            ) : (
              <p className="text-sm text-zinc-400 italic mt-0.5">Add a note…</p>
            )}
          </div>

          {aiSummary && (
            <div className="mt-3 pt-3 border-t border-zinc-100">
              <button
                className="flex items-center gap-1 text-xs font-bold text-blue-600"
                onClick={() => setAiExpanded(!aiExpanded)}
              >
                {aiExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                AI Analysis
              </button>
              {aiExpanded && (
                <p className="text-sm text-zinc-600 mt-2 leading-relaxed bg-blue-50/50 p-3 rounded-xl border border-blue-100">
                  {aiSummary}
                </p>
              )}
            </div>
          )}

          {application.source && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-zinc-100">
              <Badge variant="outline" className="text-[9px] bg-zinc-50 text-zinc-500 border-zinc-200 font-semibold">
                {formatSourceLabel(application.source)}
              </Badge>
              <span className="text-[10px] text-zinc-400">
                Applied {formatDistanceToNow(new Date(application.applied_at), { addSuffix: true })}
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
    {confirmCallOpen && (
      <AlertDialog open={confirmCallOpen} onOpenChange={setConfirmCallOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmCallMode === "call_now" ? "Start AI call?" : "Send WhatsApp nudge?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmCallMode === "call_now"
                ? `Bolna will directly call ${c.name}. The AI agent will screen them for this role.`
                : `Send a WhatsApp context message to ${c.name}. An automated call will follow when they respond.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setConfirmCallOpen(false)
              sendWhatsAppNudge(confirmCallMode)
            }}>
              {confirmCallMode === "call_now" ? "Call Now" : "Send Nudge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )}
    </>
  )
}

function ClientDecisionBadge({ decision }: { decision: string | null | undefined }) {
  if (!decision || decision === "pending") return null
  if (decision === "approved") {
    return (
      <Badge variant="outline" className="text-[10px] font-bold px-2 py-0.5 rounded-full border-none shadow-sm bg-emerald-100 text-emerald-700">
        Client: Approved
      </Badge>
    )
  }
  if (decision === "rejected") {
    return (
      <Badge variant="outline" className="text-[10px] font-bold px-2 py-0.5 rounded-full border-none shadow-sm bg-red-100 text-red-700">
        Client: Passed
      </Badge>
    )
  }
  return null
}

const AI_VERDICT_META: Record<string, { label: string; className: string }> = {
  advance: { label: "AI: Advance", className: "bg-emerald-100 text-emerald-700" },
  further_review: { label: "AI: Further review", className: "bg-amber-100 text-amber-700" },
  not_a_fit: { label: "AI: Not a fit", className: "bg-red-100 text-red-700" },
}

function AiScreenBadge({ info }: { info?: { recommendation?: string; score?: number } }) {
  if (!info) return null
  const verdict = info.recommendation ? AI_VERDICT_META[info.recommendation] : undefined
  if (!verdict && info.score == null) return null
  return (
    <>
      {verdict && (
        <Badge variant="outline" className={`text-[10px] font-bold px-2 py-0.5 rounded-full border-none shadow-sm ${verdict.className}`}>
          {verdict.label}
        </Badge>
      )}
      {info.score != null && (
        <Badge variant="outline" className="text-[10px] font-bold px-2 py-0.5 rounded-full border-none shadow-sm bg-indigo-50 text-indigo-700">
          AI Score {info.score}/10
        </Badge>
      )}
    </>
  )
}
