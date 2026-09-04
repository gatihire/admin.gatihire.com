"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip"
import { PhoneScreeningResultsSheet } from "./phone-screening-results-sheet"
import { CandidateActivityTimeline } from "./candidate-activity-timeline"
import {
  Loader2, User, MapPin, Briefcase, Eye, Sparkles, Mail, Phone, ChevronDown, ChevronUp,
  PhoneCall, PhoneOff, CheckCircle, Clock, UserX, Play, Save, Filter, MessageCircle, Send,
  AlertCircle, RefreshCw,
} from "lucide-react"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { formatDistanceToNow } from "date-fns"
import { invalidateSessionCache } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"
import { motion, AnimatePresence } from "framer-motion"

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
type CallSubFilter = "all" | "pending" | "whatsapp_sent" | "replied" | "calling" | "call_done" | "no_answer" | "busy" | "disconnected" | "retrying" | "unreachable" | "rejected" | "waitlist" | "on_hold" | "passed" | "move_next"

interface CandidateCardProps {
  application: Application
  jobId: string
  callStatus?: string
  participant?: any
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
  interviewEntry?: InterviewEntry
  interviewDraft?: { notes: string; scheduledAtLocal: string }
  onInterviewUpdate?: (patch: Partial<{ status: string; notes: string; scheduled_at: string | null }>) => void
  onInterviewDraftChange?: (draft: { notes: string; scheduledAtLocal: string }) => void
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
  { id: "applied", label: "Applied", color: "bg-blue-600", lightColor: "bg-blue-50 text-blue-600" },
  { id: "ai_screen", label: "AI Screen", color: "bg-indigo-600", lightColor: "bg-indigo-50 text-indigo-600" },
  { id: "shortlist", label: "Shortlist", color: "bg-purple-600", lightColor: "bg-purple-50 text-purple-600" },
  { id: "interview", label: "Interview", color: "bg-cyan-600", lightColor: "bg-cyan-50 text-cyan-700" },
  { id: "offer", label: "Offer", color: "bg-green-600", lightColor: "bg-green-50 text-green-600" },
  { id: "hired", label: "Hired", color: "bg-emerald-600", lightColor: "bg-emerald-50 text-emerald-600" },
  { id: "rejected", label: "Rejected", color: "bg-red-600", lightColor: "bg-red-50 text-red-600" },
]

const CALL_SUB_SECTIONS = [
  { id: "pending", label: "Pending", hint: "Not yet contacted" },
  { id: "whatsapp_sent", label: "WhatsApp Sent", hint: "Message sent, waiting to be read" },
  { id: "replied", label: "Replied", hint: "Candidate responded Yes" },
  { id: "calling", label: "Calling Now", hint: "AI call in progress" },
  { id: "call_done", label: "Call Done", hint: "Screening complete, review needed" },
  { id: "no_answer", label: "No Answer", hint: "Candidate didn't pick up" },
  { id: "busy", label: "Busy", hint: "Line was busy" },
  { id: "disconnected", label: "Disconnected", hint: "Call dropped mid-conversation" },
  { id: "retrying", label: "Retrying", hint: "Auto-retry scheduled" },
  { id: "unreachable", label: "Unreachable", hint: "All retries exhausted" },
] as const

const CALL_STATUS_COLORS: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-600",
  whatsapp_sent: "bg-teal-50 text-teal-700",
  replied: "bg-green-50 text-green-700",
  calling: "bg-amber-50 text-amber-700",
  call_done: "bg-emerald-50 text-emerald-700",
  no_answer: "bg-orange-50 text-orange-700",
  busy: "bg-orange-50 text-orange-700",
  disconnected: "bg-red-50 text-red-700",
  retrying: "bg-blue-50 text-blue-700",
  unreachable: "bg-red-50 text-red-600",
}

const CALL_STATUS_ICONS: Record<string, any> = {
  pending: Clock,
  whatsapp_sent: Send,
  replied: MessageCircle,
  calling: PhoneCall,
  call_done: CheckCircle,
  no_answer: PhoneOff,
  busy: PhoneOff,
  disconnected: PhoneOff,
  retrying: RefreshCw,
  unreachable: UserX,
}

const INTERVIEW_SUB_SECTIONS = [
  { id: "all", label: "All", hint: "All candidates in interview stage" },
  { id: "pending", label: "Pending", hint: "Awaiting scheduling" },
  { id: "waitlist", label: "Waitlist", hint: "On waitlist" },
  { id: "on_hold", label: "On Hold", hint: "Temporarily paused" },
  { id: "passed", label: "Passed", hint: "Advance to next round or offer" },
  { id: "move_next", label: "Move to Next", hint: "Advance to next round" },
  { id: "rejected", label: "Rejected", hint: "Not advancing" },
] as const

const INTERVIEW_STATUS_COLORS: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-600",
  waitlist: "bg-amber-50 text-amber-700",
  on_hold: "bg-orange-50 text-orange-700",
  passed: "bg-green-50 text-green-700",
  move_next: "bg-blue-50 text-blue-700",
  rejected: "bg-red-50 text-red-600",
}

const INTERVIEW_STATUSES = [
  { value: "pending", label: "Pending", color: "bg-zinc-100 text-zinc-600" },
  { value: "waitlist", label: "Waitlist", color: "bg-amber-100 text-amber-600" },
  { value: "on_hold", label: "On Hold", color: "bg-orange-100 text-orange-600" },
  { value: "passed", label: "Passed", color: "bg-green-100 text-green-600" },
  { value: "move_next", label: "Move to Next Round", color: "bg-blue-100 text-blue-600" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-600" },
]

interface InterviewRound {
  id: string; name: string; sort_order: number
}
interface InterviewEntry {
  id: string; round_id: string; application_id: string
  status: string; scheduled_at: string | null; notes: string | null
}

const SOURCE_LABELS: Record<string, string> = {
  portal: "GatiHire Portal", apna: "Apna", naukri: "Naukri", workindia: "WorkIndia",
  job_board: "Job Board", applied: "Applied", candidate_board: "Candidate Board",
  "board-app": "Board App", external_outreach: "External Outreach",
  database: "Database Match", enhanced_match: "Enhanced Match", recruiter_upload: "Recruiter Upload",
}

function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function toDateTimeLocal(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function callSubSection(participant: any): string {
  const status = participant?.status
  const review = participant?.review_status
  const delivery = participant?.whatsapp_delivery_status
  const reply = participant?.whatsapp_response || participant?.whatsapp_reply_text
  const bolnaStatus = participant?.bolna_status
  const retryCount = participant?.retry_count || 0
  const nextRetryAt = participant?.next_retry_at
  const lastAttemptAt = participant?.last_attempt_at

  // Review takes precedence
  if (review === "approved") return "call_done"
  if (review === "rejected") return "unreachable"

  // Terminal completed
  if (status === "completed") return "call_done"

  // Specific failure statuses
  if (status === "not_interested") return "unreachable"
  if (status === "unreachable") return "unreachable"

  // Auto-timeout: if call has been in calling/in_progress for >3 minutes, treat as no_answer
  if ((status === "calling" || status === "in_progress") && lastAttemptAt) {
    const elapsed = Date.now() - new Date(lastAttemptAt).getTime()
    const THREE_MINUTES = 3 * 60 * 1000
    if (elapsed > THREE_MINUTES) return "no_answer"
  }

  // Bolna-specific failure statuses
  if (bolnaStatus === "no-answer" || (status === "failed" && bolnaStatus === "no-answer")) return "no_answer"
  if (bolnaStatus === "busy" || (status === "failed" && bolnaStatus === "busy")) return "busy"
  if (bolnaStatus === "canceled" || bolnaStatus === "stopped") return "disconnected"

  // Generic failed with retry pending
  if (status === "failed" && nextRetryAt) return "retrying"
  if (status === "failed") return "unreachable"

  // Active call states
  if (status === "in_progress" || status === "calling" || status === "call_scheduled") return "calling"

  // WhatsApp states
  if (reply) return "replied"
  if (status === "whatsapp_sent" || delivery === "delivered" || delivery === "sent" || delivery === "read") return "whatsapp_sent"

  return "pending"
}

function interviewSubSection(entry: InterviewEntry | undefined): string {
  if (!entry) return "pending"
  return entry.status || "pending"
}

const NEXT_ACTION_CONFIG: Record<string, { label: string; cta: string; icon: any; color: string; action: string } | null> = {
  applied: { label: "New application — review candidate profile", cta: "View Profile", icon: Eye, color: "bg-blue-50 border-blue-200 text-blue-800", action: "view_profile" },
  ai_screen: { label: "Screening complete — review call results and AI verdict", cta: "View Results", icon: CheckCircle, color: "bg-indigo-50 border-indigo-200 text-indigo-800", action: "view_results" },
  shortlist: { label: "Shortlisted — share with client or schedule interview", cta: "Share Shortlist", icon: Send, color: "bg-purple-50 border-purple-200 text-purple-800", action: "share" },
  interview: { label: "Interview stage — schedule or review feedback", cta: "Schedule", icon: Clock, color: "bg-cyan-50 border-cyan-200 text-cyan-800", action: "schedule" },
  offer: { label: "Offer pending — follow up with candidate", cta: "View Offer", icon: CheckCircle, color: "bg-green-50 border-green-200 text-green-800", action: "view_offer" },
  hired: null,
  rejected: null,
}

function getActionForCard(application: Application, callStatus?: string, participant?: any): { label: string; cta: string; icon: any; color: string; action: string } | null {
  // If there's an active call sub-status, use that for more specific action
  if (application.status === "ai_screen" && callStatus) {
    if (callStatus === "call_done") return { label: "Screening complete — review call results and AI verdict", cta: "View Results", icon: CheckCircle, color: "bg-emerald-50 border-emerald-200 text-emerald-800", action: "view_results" }
    if (callStatus === "calling") return { label: "AI call in progress — results will appear shortly", cta: "Calling...", icon: PhoneCall, color: "bg-amber-50 border-amber-200 text-amber-800", action: "view_results" }
    if (callStatus === "whatsapp_sent") return { label: "WhatsApp sent — waiting for candidate to respond", cta: "Waiting", icon: Send, color: "bg-teal-50 border-teal-200 text-teal-800", action: "view_results" }
    if (callStatus === "replied") return { label: "Candidate replied — ready to start AI call", cta: "Start Call", icon: PhoneCall, color: "bg-green-50 border-green-200 text-green-800", action: "start_call" }
    if (callStatus === "no_answer") {
      const retryCount = participant?.retry_count || 0
      const nextRetry = participant?.next_retry_at
      const retryIn = nextRetry ? formatRetryTime(nextRetry) : "15 min"
      return { label: `No answer — auto-retry in ${retryIn} (attempt ${retryCount}/2)`, cta: "Retry Now", icon: PhoneCall, color: "bg-orange-50 border-orange-200 text-orange-800", action: "retry_now" }
    }
    if (callStatus === "busy") {
      const retryCount = participant?.retry_count || 0
      return { label: `Line busy — auto-retry in 15 min (attempt ${retryCount}/2)`, cta: "Retry Now", icon: PhoneCall, color: "bg-orange-50 border-orange-200 text-orange-800", action: "retry_now" }
    }
    if (callStatus === "disconnected") return { label: "Call dropped — partial transcript available", cta: "View Partial", icon: AlertCircle, color: "bg-red-50 border-red-200 text-red-800", action: "view_results" }
    if (callStatus === "retrying") {
      const retryCount = participant?.retry_count || 0
      const nextRetry = participant?.next_retry_at
      const retryIn = nextRetry ? formatRetryTime(nextRetry) : "soon"
      return { label: `Retrying — attempt ${retryCount + 1}/2 in ${retryIn}`, cta: "Retrying...", icon: RefreshCw, color: "bg-blue-50 border-blue-200 text-blue-800", action: "" }
    }
    if (callStatus === "unreachable") return { label: "All retries exhausted — needs manual follow-up", cta: "Manual Follow-up", icon: UserX, color: "bg-red-50 border-red-200 text-red-800", action: "manual_followup" }
  }
  const config = NEXT_ACTION_CONFIG[application.status]
  if (!config) return null
  return config
}

function formatRetryTime(nextRetryAt: string): string {
  const diff = new Date(nextRetryAt).getTime() - Date.now()
  if (diff <= 0) return "now"
  const minutes = Math.ceil(diff / 60000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
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
  const [participantDataByCandidate, setParticipantDataByCandidate] = useState<Record<string, any>>({})
  const [callNowCandidate, setCallNowCandidate] = useState<string | null>(null)
  const [nudgeBusyCandidate, setNudgeBusyCandidate] = useState<string | null>(null)
  const [callMode, setCallMode] = useState<"call_now" | "whatsapp_first">("call_now")
  const [aiInfoByCandidate, setAiInfoByCandidate] = useState<Record<string, { recommendation?: string; score?: number }>>({})
  const [callingStarted, setCallingStarted] = useState(false)
  const [bulkStage, setBulkStage] = useState("ai_screen")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [resultParticipantId, setResultParticipantId] = useState<string | null>(null)

  // Interview state
  const [interviewRounds, setInterviewRounds] = useState<InterviewRound[]>([])
  const [interviewsByKey, setInterviewsByKey] = useState<Record<string, InterviewEntry>>({})
  const [selectedInterviewRound, setSelectedInterviewRound] = useState("")
  const [interviewLoading, setInterviewLoading] = useState(false)
  const [interviewDrafts, setInterviewDrafts] = useState<Record<string, { notes: string; scheduledAtLocal: string }>>({})

  const fetchParticipants = useCallback(async () => {
    try {
      const res = await fetch(`/api/phone-screening/participants?jobId=${jobId}`)
      if (res.ok) {
        const data = await res.json()
        const map: Record<string, string> = {}
        const idMap: Record<string, string> = {}
        const aiMap: Record<string, { recommendation?: string; score?: number }> = {}
        const pDataMap: Record<string, any> = {}
        for (const p of Array.isArray(data) ? data : []) {
          if (p?.candidate_id) {
            if (!map[p.candidate_id]) map[p.candidate_id] = callSubSection(p)
            if (!idMap[p.candidate_id]) idMap[p.candidate_id] = p.id
            if (!pDataMap[p.candidate_id]) pDataMap[p.candidate_id] = p
            aiMap[p.candidate_id] = {
              recommendation: p.ai_recommendation ?? undefined,
              score: p.ai_score != null ? Number(p.ai_score) : undefined,
            }
          }
        }
        setCallStatusByCandidate(map)
        setParticipantIdByCandidate(idMap)
        setParticipantDataByCandidate(pDataMap)
        setAiInfoByCandidate(aiMap)
      }
    } catch { /* noop */ }
  }, [jobId])

  useEffect(() => { fetchParticipants() }, [fetchParticipants])

  // Auto-timeout: re-evaluate call statuses every 30 seconds for 3-min timeout
  useEffect(() => {
    const hasCalling = Object.values(callStatusByCandidate).some((s) => s === "calling")
    if (!hasCalling) return
    const interval = setInterval(() => {
      // Re-evaluate by triggering a state update
      setCallStatusByCandidate((prev) => ({ ...prev }))
    }, 30000)
    return () => clearInterval(interval)
  }, [callStatusByCandidate])

  const fetchInterviews = useCallback(async () => {
    setInterviewLoading(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/interviews`)
      if (!res.ok) return
      const data = await res.json()
      const rounds = (data.rounds || []) as InterviewRound[]
      setInterviewRounds(rounds)
      if (!selectedInterviewRound && rounds.length > 0) setSelectedInterviewRound(rounds[0].id)
      const map: Record<string, InterviewEntry> = {}
      const draftMap: Record<string, { notes: string; scheduledAtLocal: string }> = {}
      for (const it of (data.interviews || []) as any[]) {
        if (!it.round_id || !it.application_id) continue
        map[`${it.round_id}:${it.application_id}`] = {
          id: it.id, round_id: it.round_id, application_id: it.application_id,
          status: it.status, scheduled_at: it.scheduled_at, notes: it.notes,
        }
        draftMap[`${it.round_id}:${it.application_id}`] = {
          notes: String(it.notes || ""),
          scheduledAtLocal: it.scheduled_at ? toDateTimeLocal(it.scheduled_at) : "",
        }
      }
      setInterviewsByKey(map)
      setInterviewDrafts(draftMap)
    } catch { /* noop */ } finally { setInterviewLoading(false) }
  }, [jobId, selectedInterviewRound])

  useEffect(() => { if (activeStage === "interview") fetchInterviews() }, [activeStage, fetchInterviews])

  const upsertInterview = useCallback(async (
    applicationId: string,
    patch: Partial<{ status: string; notes: string; scheduled_at: string | null }>
  ) => {
    if (!selectedInterviewRound) return
    try {
      const res = await fetch(`/api/jobs/${jobId}/interviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, roundId: selectedInterviewRound, ...patch }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Failed to update")
      const it = data?.interview as InterviewEntry | undefined
      if (it?.round_id && it?.application_id) {
        setInterviewsByKey((prev) => ({ ...prev, [`${it.round_id}:${it.application_id}`]: it }))
      }
      if (patch.status === "move_next") setTimeout(() => fetchInterviews(), 300)
      if (patch.status) toast({ title: "Interview updated", description: `Status: ${patch.status}` })
    } catch (err: any) {
      toast({ title: "Failed to update interview", description: err.message, variant: "destructive" })
    }
  }, [jobId, selectedInterviewRound, fetchInterviews, toast])

  useEffect(() => {
    const hasActiveCalls = Object.values(callStatusByCandidate).some(
      (s) => s === "calling" || s === "whatsapp_sent" || s === "replied" || s === "retrying" || s === "no_answer" || s === "busy"
    )
    if (!hasActiveCalls) return
    const interval = setInterval(() => fetchParticipants(), 5000)
    return () => clearInterval(interval)
  }, [callStatusByCandidate, fetchParticipants])

  useEffect(() => {
    if (activeCallSubFilter && activeCallSubFilter !== "all") setCallSubFilter(activeCallSubFilter as CallSubFilter)
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

  const filtered = (activeStage === "all" ? applications : applications.filter((a) => a.status === activeStage))
    .filter((a) => {
      if (filter === "all") return true
      if (filter === "inbound") return (a.origin || "inbound") === "inbound"
      if (filter === "outbound") return (a.origin || "inbound") === "outbound"
      if (filter === "database") return ["database", "enhanced_match"].includes(a.source || "")
      return a.source === "board-app"
    })
    .filter((a) => {
      if (activeStage === "interview" && callSubFilter !== "all" && selectedInterviewRound) {
        const entry = interviewsByKey[`${selectedInterviewRound}:${a.id}`]
        return interviewSubSection(entry) === callSubFilter
      }
      if (activeStage !== "ai_screen" || callSubFilter === "all") return true
      return (callStatusByCandidate[a.candidate_id] || "pending") === callSubFilter
    })

  const stageCount = (stageId: string) => applications.filter((a) => a.status === stageId).length
  const interviewApps = activeStage === "interview" ? applications.filter((a) => a.status === "interview") : []
  const interviewAppCount = interviewApps.length

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
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
        body: JSON.stringify({ jobId, candidateIds: selectedCandidateIds, callMode, createApplication: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to start screening")
      const triggered = data.callsTriggered || 0
      const failed = data.callsFailed || 0
      const skipped = data.skippedNoPhone?.length || 0
      const nudged = data.nudgeSent || 0
      let description = ""
      if (callMode === "call_now") {
        description = `${triggered} calls placed`; if (failed > 0) description += `, ${failed} failed`; if (skipped > 0) description += `, ${skipped} skipped (no phone)`
      } else {
        description = `${nudged} WhatsApp nudges sent`; if (skipped > 0) description += `, ${skipped} skipped (no phone)`
      }
      toast({ title: callMode === "call_now" ? "AI calls started" : "WhatsApp outreach started", description, variant: failed > 0 && triggered === 0 ? "destructive" : "default" })
      setSelectedIds(new Set()); setConfirmCallsOpen(false)
      invalidateSessionCache(`internal:applications:job:${jobId}`); onRefresh(); fetchParticipants()
    } catch (err: any) {
      toast({ title: "Failed to start calls", description: err.message, variant: "destructive" })
    } finally { setCallingStarted(false) }
  }

  const callCandidateNow = async (candidateId: string) => {
    const participantId = participantIdByCandidate[candidateId]
    if (!participantId) { toast({ title: "No screening record", description: "This candidate has no phone-screening entry yet", variant: "destructive" }); return }
    setCallNowCandidate(candidateId)
    try {
      const res = await fetch("/api/phone-screening/call-now", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to place call")
      toast({ title: "Call placed", description: "AI call triggered for this candidate" }); fetchParticipants(); onRefresh()
    } catch (err: any) {
      toast({ title: "Failed to place call", description: err.message, variant: "destructive" })
    } finally { setCallNowCandidate(null) }
  }

  const bulkMove = async () => {
    if (selectedApplications.length === 0) return; setBulkBusy(true)
    let ok = 0, fail = 0
    try {
      for (const app of selectedApplications) {
        const res = await fetch(`/api/applications/${app.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: bulkStage }) })
        if (res.ok) ok++; else fail++
      }
      toast({ title: "Bulk move complete", description: `${ok} moved, ${fail} failed` })
      invalidateSessionCache("internal:applications:", { prefix: true }); setSelectedIds(new Set()); onRefresh()
    } finally { setBulkBusy(false) }
  }

  const bulkReject = async () => {
    if (selectedApplications.length === 0) return; setBulkBusy(true)
    try {
      for (const app of selectedApplications) {
        await fetch(`/api/applications/${app.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected" }) })
      }
      toast({ title: "Rejected", description: `${selectedApplications.length} candidates rejected` })
      invalidateSessionCache("internal:applications:", { prefix: true }); setSelectedIds(new Set()); onRefresh()
    } finally { setBulkBusy(false) }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {/* Mini-kanban skeleton */}
        <div className="flex items-center gap-3 p-4 bg-white rounded-2xl border border-zinc-200">
          {STATUS_COLUMNS.map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-6 w-16 rounded-lg" />
              <Skeleton className="h-5 w-5 rounded-md" />
            </div>
          ))}
        </div>
        {/* Card skeletons */}
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="border border-zinc-200 rounded-2xl overflow-hidden">
              <CardContent className="p-5">
                <div className="flex gap-4">
                  <Skeleton className="h-12 w-12 rounded-xl shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-4 w-60" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-10 w-10 rounded-full shrink-0" />
                </div>
                <Skeleton className="h-12 w-full mt-4 rounded-xl" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* ── Mini-Kanban Pipeline Bar ── */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-wrap items-center gap-3 p-4 bg-white rounded-2xl border border-zinc-200 shadow-sm"
        >
          {STATUS_COLUMNS.map((col) => {
            const count = stageCount(col.id)
            const active = activeStage === col.id
            return (
              <button
                key={col.id}
                onClick={() => onStageSelect(active ? "all" : col.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                  active
                    ? `${col.color} text-white shadow-md`
                    : count > 0 ? "bg-zinc-50 text-zinc-700 hover:bg-zinc-100 border border-zinc-200" : "text-zinc-400"
                }`}
              >
                <span>{col.label}</span>
                <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-md text-[10px] font-bold ${
                  active ? "bg-white/20 text-white" : count > 0 ? "bg-zinc-200/80 text-zinc-600" : "bg-zinc-100 text-zinc-400"
                }`}>
                  {count}
                </span>
              </button>
            )
          })}
          {activeStage !== "all" && (
            <button onClick={() => onStageSelect("all")} className="text-xs font-semibold text-zinc-400 hover:text-zinc-600 ml-1">
              Clear
            </button>
          )}
        </motion.div>

        {/* ── Source Filter Bar ── */}
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          <Filter className="h-3.5 w-3.5 text-zinc-400" />
          <Select value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
            <SelectTrigger className="h-7 w-44 text-xs bg-white rounded-lg border-zinc-200">
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
            <button className="text-xs font-semibold text-zinc-400 hover:text-zinc-600 px-1.5 py-1" onClick={() => setFilter("all")}>
              Clear
            </button>
          )}
        </div>

        {/* ── AI Screen Sub-Filters ── */}
        {activeStage === "ai_screen" && (
          <div className="space-y-2 px-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {CALL_SUB_SECTIONS.map((sub) => {
                const count = applications.filter((a) => (callStatusByCandidate[a.candidate_id] || "pending") === sub.id).length
                return (
                  <button
                    key={sub.id}
                    onClick={() => { const next = callSubFilter === sub.id ? "all" : sub.id; setCallSubFilter(next); onCallSubFilterChange?.(next) }}
                    title={sub.hint}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide transition-all flex items-center gap-1 ${
                      callSubFilter === sub.id ? "bg-cyan-600 text-white shadow-sm" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                    }`}
                  >
                    {sub.label}
                    <span className={`text-[10px] ml-0.5 ${callSubFilter === sub.id ? "text-cyan-200" : "text-zinc-400"}`}>{count}</span>
                  </button>
                )
              })}
              {callSubFilter !== "all" && (
                <button className="text-xs font-semibold text-zinc-400 hover:text-zinc-600 px-2" onClick={() => { setCallSubFilter("all"); onCallSubFilterChange?.("all") }}>Clear</button>
              )}
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Flow: <span className="font-semibold text-zinc-500">WhatsApp Sent</span> → candidate reads → replies "Yes" → <span className="font-semibold text-zinc-500">AI Call</span> → <span className="font-semibold text-zinc-500">Call Done</span> → you review
              {callSubFilter === "no_answer" && <span className="ml-2 text-orange-600">• No answer — auto-retry in 15 min</span>}
              {callSubFilter === "busy" && <span className="ml-2 text-orange-600">• Line busy — auto-retry in 15 min</span>}
              {callSubFilter === "disconnected" && <span className="ml-2 text-red-600">• Call dropped — partial transcript available</span>}
              {callSubFilter === "retrying" && <span className="ml-2 text-blue-600">• Auto-retry scheduled</span>}
              {callSubFilter === "unreachable" && <span className="ml-2 text-red-600">• All retries exhausted — manual follow-up needed</span>}
            </p>
          </div>
        )}

        {/* ── Interview Sub-Filters ── */}
        {activeStage === "interview" && (
          <div className="space-y-3 px-1">
            {interviewRounds.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-bold text-zinc-400 uppercase mr-1">Round:</span>
                {interviewRounds.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedInterviewRound(r.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      selectedInterviewRound === r.id ? "bg-purple-600 text-white shadow-sm" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                    }`}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {INTERVIEW_SUB_SECTIONS.map((sub) => {
                const count = sub.id === "all" ? interviewAppCount : interviewApps.filter((a) => {
                  const entry = interviewsByKey[`${selectedInterviewRound}:${a.id}`]
                  return interviewSubSection(entry) === sub.id
                }).length
                return (
                  <button
                    key={sub.id}
                    onClick={() => { const next = callSubFilter === sub.id ? "all" : sub.id; setCallSubFilter(next); onCallSubFilterChange?.(next) }}
                    title={sub.hint}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide transition-all flex items-center gap-1 ${
                      callSubFilter === sub.id ? "bg-purple-600 text-white shadow-sm" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                    }`}
                  >
                    {sub.label}
                    <span className={`text-[10px] ml-0.5 ${callSubFilter === sub.id ? "text-purple-200" : "text-zinc-400"}`}>{count}</span>
                  </button>
                )
              })}
              {callSubFilter !== "all" && (
                <button className="text-xs font-semibold text-zinc-400 hover:text-zinc-600 px-2" onClick={() => { setCallSubFilter("all"); onCallSubFilterChange?.("all") }}>Clear</button>
              )}
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Flow: <span className="font-semibold text-zinc-500">Pending</span> → schedule → <span className="font-semibold text-zinc-500">Interview</span> → <span className="font-semibold text-zinc-500">Passed/Rejected</span> → next stage
            </p>
          </div>
        )}

        {/* ── Bulk Action Bar ── */}
        <AnimatePresence>
          {selectedApplications.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap items-center gap-2 p-3 rounded-2xl border border-cyan-200 bg-cyan-50/50">
                <span className="text-sm font-bold text-cyan-800">{selectedApplications.length} selected</span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 gap-1" onClick={() => setConfirmCallsOpen(true)} disabled={callingStarted || selectedCandidateIds.length === 0}>
                    {callingStarted ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    {callingStarted ? "Starting..." : `Start AI Calls (${selectedCandidateIds.length})`}
                  </Button>
                  <Select value={bulkStage} onValueChange={setBulkStage}>
                    <SelectTrigger className="h-8 w-40 text-xs bg-white"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ai_screen">AI Screen</SelectItem>
                      <SelectItem value="shortlist">Shortlist</SelectItem>
                      <SelectItem value="interview">Interview</SelectItem>
                      <SelectItem value="applied">Applied</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={bulkMove} disabled={bulkBusy}>
                    {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Move to Stage
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs border-red-200 text-red-600 hover:bg-red-50" onClick={bulkReject} disabled={bulkBusy}>Reject</Button>
                  <Button variant="ghost" size="sm" className="h-8 text-xs text-zinc-500" onClick={() => setSelectedIds(new Set())}>Clear</Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Empty State ── */}
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-zinc-400 text-sm border-2 border-dashed border-zinc-200 rounded-2xl bg-zinc-50/50">
            <User className="h-8 w-8 mx-auto mb-2 text-zinc-300" />
            <p className="font-semibold">No candidates in this stage</p>
          </div>
        ) : (
          /* ── Candidate Cards ── */
          <div className="space-y-3">
            <AnimatePresence mode="popLayout">
              {filtered.map((app, index) => (
                <motion.div
                  key={app.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -20, transition: { duration: 0.2 } }}
                  transition={{ delay: index * 0.03, duration: 0.25, ease: "easeOut" }}
                >
                   <CandidateCard
                    application={app}
                    jobId={jobId}
                    callStatus={activeStage === "ai_screen" ? callStatusByCandidate[app.candidate_id] || "pending" : undefined}
                    participant={participantDataByCandidate[app.candidate_id]}
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
                    interviewEntry={activeStage === "interview" ? interviewsByKey[`${selectedInterviewRound}:${app.id}`] : undefined}
                    interviewDraft={activeStage === "interview" ? interviewDrafts[`${selectedInterviewRound}:${app.id}`] : undefined}
                    onInterviewUpdate={activeStage === "interview" ? (patch) => upsertInterview(app.id, patch) : undefined}
                    onInterviewDraftChange={activeStage === "interview" ? (draft) => {
                      setInterviewDrafts((prev) => ({ ...prev, [`${selectedInterviewRound}:${app.id}`]: draft }))
                    } : undefined}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

        {/* ── Stage Change Confirmation (Premium AlertDialog) ── */}
        <AlertDialog open={!!pendingStageChange} onOpenChange={(open) => { if (!open) { setPendingStageChange(null); setRejectionReason("") } }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg">Confirm stage change</AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                <p>
                  Move <strong>{pendingStageChange?.candidateName}</strong> from{" "}
                  <strong>{pendingStageChange?.from}</strong> to{" "}
                  <strong>{pendingStageChange?.to}</strong>?
                </p>
                {pendingStageChange?.to === "shortlist" && (
                  <span className="block text-sm text-amber-600 font-medium">
                    Shortlist is what gets shared with the client — confirm you've reviewed the AI screening verdict first.
                  </span>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {pendingStageChange?.to === "rejected" && (
              <div className="px-6 pb-2">
                <label className="block text-sm font-semibold text-zinc-600 mb-1.5">Rejection reason</label>
                <Select value={rejectionReason} onValueChange={setRejectionReason}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select a reason..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="not_qualified">Not qualified for the role</SelectItem>
                    <SelectItem value="salary_mismatch">Salary expectations too high</SelectItem>
                    <SelectItem value="location_mismatch">Location / relocation issues</SelectItem>
                    <SelectItem value="experience_mismatch">Experience doesn't match requirements</SelectItem>
                    <SelectItem value="skills_mismatch">Required skills not met</SelectItem>
                    <SelectItem value="culture_fit">Culture fit concerns</SelectItem>
                    <SelectItem value="no_response">No response / ghosted</SelectItem>
                    <SelectItem value="withdrawn">Candidate withdrew</SelectItem>
                    <SelectItem value="duplicate">Duplicate application</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmStageChange}>Confirm</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* ── Bulk Call Confirmation ── */}
        <AlertDialog open={confirmCallsOpen} onOpenChange={setConfirmCallsOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Start AI calls for {selectedApplications.length} candidates?</AlertDialogTitle>
              <AlertDialogDescription className="space-y-3">
                <div className="flex flex-wrap gap-2 pt-1">
                  <Badge className="text-xs font-bold px-3 py-1 rounded-full bg-blue-100 text-blue-700">{inboundCount} Inbound</Badge>
                  <Badge className="text-xs font-bold px-3 py-1 rounded-full bg-violet-100 text-violet-700">{outboundCount} Outbound</Badge>
                </div>
                <div className="rounded-xl border border-zinc-200 overflow-hidden">
                  <div className="grid grid-cols-2">
                    <button
                      type="button" disabled={callingStarted} onClick={() => setCallMode("call_now")}
                      className={`px-3 py-2.5 text-left text-xs transition-all ${callMode === "call_now" ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-300" : "text-zinc-500 hover:bg-zinc-50"}`}
                    >
                      <span className="block font-bold text-xs uppercase tracking-wide">Direct call</span>
                      <span className="text-xs opacity-80 mt-0.5 block">Bolna calls each candidate now</span>
                    </button>
                    <button
                      type="button" disabled={callingStarted} onClick={() => setCallMode("whatsapp_first")}
                      className={`px-3 py-2.5 text-left text-xs transition-all ${callMode === "whatsapp_first" ? "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-300" : "text-zinc-500 hover:bg-zinc-50"}`}
                    >
                      <span className="block font-bold text-xs uppercase tracking-wide">WhatsApp Nudge → Auto Call</span>
                      <span className="text-xs opacity-80 mt-0.5 block">WhatsApp first, then automated call when they respond</span>
                    </button>
                  </div>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={callingStarted}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={startAiCalls} disabled={callingStarted}>
                {callingStarted ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <PhoneCall className="h-3.5 w-3.5 mr-1" />}
                {callingStarted ? "Starting..." : callMode === "call_now" ? "Start direct calls" : "Send WhatsApp Nudges"}
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
    </TooltipProvider>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   CANDIDATE CARD — Premium Redesign
   ═══════════════════════════════════════════════════════════════════ */

function CandidateCard({ application, jobId, callStatus, participant, aiInfo, clientDecision, selected, callNowBusy, nudgeBusy, onCallNow, onNudgeStart, onNudgeEnd, onSelect, onViewProfile, onViewResults, onStageChange, onApplicationUpdated, interviewEntry, interviewDraft, onInterviewUpdate, onInterviewDraftChange }: CandidateCardProps) {
  const c = application.candidates
  const { toast } = useToast()
  const [notesDraft, setNotesDraft] = useState<string>(application.notes || "")
  const [notesEditing, setNotesEditing] = useState(false)
  const [notesSaving, setNotesSaving] = useState(false)
  const [retagBusy, setRetagBusy] = useState(false)
  const [confirmCallOpen, setConfirmCallOpen] = useState(false)
  const [confirmCallMode, setConfirmCallMode] = useState<"call_now" | "whatsapp_first">("call_now")
  const [detailsExpanded, setDetailsExpanded] = useState(false)

  const nextAction = useMemo(() => getActionForCard(application, callStatus, participant), [application.status, callStatus, participant])
  const aiScore = aiInfo?.score
  const hasMatchScore = application.match_score !== null && application.match_score !== undefined

  const saveNotes = async () => {
    setNotesSaving(true)
    try {
      const res = await fetch(`/api/applications/${application.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notesDraft.trim() }),
      })
      if (!res.ok) throw new Error("Failed to save notes")
      onApplicationUpdated({ ...application, notes: notesDraft.trim() })
      setNotesEditing(false)
      toast({ title: "Notes saved" })
    } catch { toast({ title: "Failed to save notes", variant: "destructive" }) }
    finally { setNotesSaving(false) }
  }

  const toggleOrigin = async () => {
    const next = (application.origin || "inbound") === "inbound" ? "outbound" : "inbound"
    setRetagBusy(true)
    try {
      const res = await fetch(`/api/applications/${application.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: next }),
      })
      if (!res.ok) throw new Error("Failed to update origin")
      onApplicationUpdated({ ...application, origin: next })
      toast({ title: `Marked as ${next === "inbound" ? "Inbound" : "Outbound"}` })
    } catch { toast({ title: "Failed to update origin", variant: "destructive" }) }
    finally { setRetagBusy(false) }
  }

  const sendWhatsAppNudge = async (mode: "call_now" | "whatsapp_first") => {
    onNudgeStart?.()
    try {
      const res = await fetch("/api/phone-screening/trigger", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, candidateIds: [c.id], origin: application.origin || "outbound", createApplication: true, callMode: mode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to start screening")
      toast({
        title: mode === "call_now" ? "AI call started" : "WhatsApp nudge sent",
        description: mode === "call_now" ? `Direct call triggered for ${c.name}` : `WhatsApp nudge sent to ${c.name}`,
      })
      onApplicationUpdated({ ...application, status: "ai_screen" })
    } catch (err: any) { toast({ title: "Failed", description: err.message, variant: "destructive" }) }
    finally { onNudgeEnd?.() }
  }

  const handleNextAction = () => {
    if (!nextAction) return
    if (nextAction.action === "view_profile") onViewProfile(c)
    else if (nextAction.action === "view_results") onViewResults?.(application.candidate_id)
    else if (nextAction.action === "share") toast({ title: "Use Share Shortlist from job header" })
    else if (nextAction.action === "schedule") toast({ title: "Schedule interview from the interview section" })
    else if (nextAction.action === "start_call") onCallNow?.()
    else if (nextAction.action === "retry_now") onCallNow?.()
    else if (nextAction.action === "manual_followup") toast({ title: "Manual follow-up required", description: "Please contact the candidate directly" })
  }

  return (
    <>
      <Card className={`border shadow-sm hover:shadow-md transition-all duration-200 rounded-2xl overflow-hidden bg-white group ${
        selected ? "ring-2 ring-cyan-300 border-cyan-300" : "border-zinc-200 hover:border-zinc-300"
      }`}>
        <CardContent className="p-0">
          <div className="p-5">
            {/* ── Row 1: Checkbox + Avatar + Name + AI Score ── */}
            <div className="flex items-start gap-4">
              <div className="flex flex-col items-center gap-2 shrink-0">
                <Checkbox checked={selected} onCheckedChange={() => onSelect(application.id)} aria-label={`Select ${c.name}`} />
                <Avatar className="h-12 w-12 border-2 border-zinc-100 shadow-sm">
                  <AvatarFallback className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-bold text-sm">
                    {c.name?.substring(0, 2).toUpperCase() || "CN"}
                  </AvatarFallback>
                </Avatar>
              </div>

              {/* Name + role + location */}
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-lg text-zinc-900 truncate">{c.name}</h3>
                  {application.origin && (
                    <button
                      type="button"
                      onClick={toggleOrigin}
                      disabled={retagBusy}
                      title={`Click to toggle origin`}
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full cursor-pointer transition-all ${
                        application.origin === "outbound" ? "bg-violet-100 text-violet-700 hover:bg-violet-200" : "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      }`}
                    >
                      {retagBusy ? <Loader2 className="h-2.5 w-2.5 animate-spin inline" /> : application.origin === "outbound" ? "Outbound" : "Inbound"}
                    </button>
                  )}
                </div>
                <p className="text-sm text-zinc-500 flex items-center gap-1.5">
                  <Briefcase className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                  <span className="truncate">{c.current_role || "No role specified"}{c.current_company ? ` at ${c.current_company}` : ""}</span>
                </p>
                <div className="flex items-center gap-1 text-xs text-zinc-400">
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span>{c.location || "N/A"}</span>
                  {c.total_experience && <span className="text-zinc-300 mx-1">·</span>}
                  {c.total_experience && <span>{c.total_experience}yr exp</span>}
                </div>
                {/* Key Metrics — always visible */}
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  {c.current_salary && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-500">
                      Current: <span className="text-zinc-700">{c.current_salary}</span>
                    </span>
                  )}
                  {c.expected_salary && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-500">
                      Expected: <span className="text-zinc-700">{c.expected_salary}</span>
                    </span>
                  )}
                  {application.source && (
                    <Badge variant="outline" className="text-[10px] font-semibold px-1.5 py-0 rounded-full bg-zinc-50 text-zinc-500 border-zinc-200">
                      {formatSourceLabel(application.source)}
                    </Badge>
                  )}
                  <span className="text-[10px] text-zinc-400">
                    Applied {formatDistanceToNow(new Date(application.applied_at), { addSuffix: true })}
                  </span>
                </div>
              </div>
            </div>

            {/* ── Row 2: Next Action Card ── */}
            {nextAction && (
              <div className={`mt-4 p-3 rounded-xl border flex items-center justify-between gap-3 ${nextAction.color}`}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <nextAction.icon className="h-4 w-4 shrink-0 opacity-70" />
                  <span className="text-xs font-medium truncate">{nextAction.label}</span>
                </div>
                {nextAction.cta && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs font-bold shrink-0 bg-white/80 hover:bg-white border-current/20"
                    onClick={handleNextAction}
                  >
                    {nextAction.cta}
                  </Button>
                )}
              </div>
            )}

            {/* ── Row 3: Action Buttons ── */}
            <div className="flex items-center gap-1.5 mt-4 pt-3 border-t border-zinc-100">
              {/* Eye button */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 w-8 p-0 rounded-lg" onClick={() => onViewProfile(c)}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View profile</TooltipContent>
              </Tooltip>

              {/* AI Analysis button — shows match score or AI screening score */}
              {(aiScore != null || application.match_score != null) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                        (aiScore ?? 0) >= 7 || (application.match_score ?? 0) >= 0.7
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100" :
                        (aiScore ?? 0) >= 4 || (application.match_score ?? 0) >= 0.4
                          ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100" :
                        "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                      }`}
                      onClick={() => onViewResults?.(application.candidate_id)}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {aiScore != null ? `${aiScore}/10` : `${Math.round((application.match_score || 0) * 100)}%`}
                      {aiInfo?.recommendation && (
                        <span className="capitalize ml-0.5">{aiInfo.recommendation.replace(/_/g, " ")}</span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{aiScore != null ? "View AI screening analysis" : "View match analysis"}</TooltipContent>
                </Tooltip>
              )}

              {/* Phone number — actual value, click to copy */}
              {c.phone && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-zinc-200 bg-white text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition-colors cursor-pointer"
                      onClick={() => { navigator.clipboard.writeText(c.phone || ""); toast({ title: "Phone copied" }) }}
                    >
                      <Phone className="h-3.5 w-3.5 text-zinc-400" />
                      {c.phone}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Click to copy phone</TooltipContent>
                </Tooltip>
              )}

              {/* Email — actual value, click to copy */}
              {c.email && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-zinc-200 bg-white text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition-colors cursor-pointer"
                      onClick={() => { navigator.clipboard.writeText(c.email || ""); toast({ title: "Email copied" }) }}
                    >
                      <Mail className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                      {c.email}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Click to copy email</TooltipContent>
                </Tooltip>
              )}

              {/* Nudge dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs rounded-lg gap-1" disabled={nudgeBusy}>
                    {nudgeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
                    Nudge
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => { setConfirmCallMode("whatsapp_first"); setConfirmCallOpen(true) }}>
                    <MessageCircle className="h-3.5 w-3.5 mr-2" />WhatsApp Nudge → Auto Call
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setConfirmCallMode("call_now"); setConfirmCallOpen(true) }}>
                    <PhoneCall className="h-3.5 w-3.5 mr-2" />Direct Call (Skip WhatsApp)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Stage selector (compact) */}
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

              {/* Details expand */}
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 rounded-lg text-zinc-400 hover:text-zinc-600"
                onClick={() => setDetailsExpanded(!detailsExpanded)}
              >
                {detailsExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </div>

            {/* ── Expandable Details ── */}
            <AnimatePresence>
              {detailsExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className="overflow-hidden"
                >
                  <div className="mt-3 pt-3 border-t border-zinc-100 space-y-3">
                    {/* Candidate notes */}
                    {application.candidate_notes && (
                      <div>
                        <p className="text-xs text-zinc-400 font-semibold mb-1">Candidate Notes</p>
                        <p className="text-sm text-zinc-500 whitespace-pre-wrap bg-zinc-50/50 p-2 rounded-lg border border-zinc-100">{application.candidate_notes}</p>
                      </div>
                    )}

                    {/* Recruiter notes */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-zinc-400 font-semibold">Recruiter Notes</p>
                        {!notesEditing && (
                          <button className="text-xs font-semibold text-blue-600 hover:text-blue-700" onClick={() => { setNotesDraft(application.notes || ""); setNotesEditing(true) }}>
                            {application.notes ? "Edit" : "Add note"}
                          </button>
                        )}
                      </div>
                      {notesEditing ? (
                        <div className="space-y-2">
                          <textarea
                            value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={2}
                            placeholder="Add internal notes for this candidate..."
                            className="w-full text-sm text-zinc-600 border border-zinc-200 rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-blue-400"
                          />
                          <div className="flex gap-2">
                            <Button size="sm" variant="default" className="bg-blue-600 hover:bg-blue-700 h-7 text-xs" onClick={saveNotes} disabled={notesSaving}>
                              {notesSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setNotesEditing(false)} disabled={notesSaving}>Cancel</Button>
                          </div>
                        </div>
                      ) : application.notes ? (
                        <p className="text-sm text-zinc-600 mt-0.5 whitespace-pre-wrap">{application.notes}</p>
                      ) : (
                        <p className="text-sm text-zinc-400 italic mt-0.5">Add a note...</p>
                      )}
                    </div>

                    {/* Interview section */}
                    {interviewEntry && onInterviewUpdate && (
                      <div className="space-y-3 pt-2 border-t border-zinc-100">
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-zinc-400 font-semibold">Interview Status</p>
                          <Badge variant="outline" className={`text-xs font-bold px-2 py-0.5 rounded-full border-none ${
                            INTERVIEW_STATUS_COLORS[interviewEntry.status] || INTERVIEW_STATUS_COLORS.pending
                          }`}>
                            {interviewEntry.status?.replace(/_/g, " ") || "pending"}
                          </Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] font-bold uppercase text-zinc-400">Status</label>
                            <Select value={interviewEntry.status || "pending"} onValueChange={(v) => onInterviewUpdate({ status: v })}>
                              <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {INTERVIEW_STATUSES.map((s) => (<SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <label className="text-[10px] font-bold uppercase text-zinc-400">Schedule</label>
                            <input
                              type="datetime-local"
                              value={interviewDraft?.scheduledAtLocal || ""}
                              onChange={(e) => onInterviewDraftChange?.({ notes: interviewDraft?.notes || "", scheduledAtLocal: e.target.value })}
                              className="w-full h-8 text-xs mt-1 border border-zinc-200 rounded-md px-2"
                            />
                            {interviewDraft?.scheduledAtLocal && interviewDraft.scheduledAtLocal !== toDateTimeLocal(interviewEntry.scheduled_at) && (
                              <Button size="sm" variant="outline" className="h-6 text-[10px] mt-1"
                                onClick={() => onInterviewUpdate({ scheduled_at: new Date(interviewDraft.scheduledAtLocal).toISOString() })}>
                                Save Time
                              </Button>
                            )}
                          </div>
                        </div>
                        <div>
                          <label className="text-[10px] font-bold uppercase text-zinc-400">Notes</label>
                          <Textarea
                            value={interviewDraft?.notes || ""}
                            onChange={(e) => onInterviewDraftChange?.({ notes: e.target.value, scheduledAtLocal: interviewDraft?.scheduledAtLocal || "" })}
                            className="h-8 text-xs mt-1 min-h-[30px]" placeholder="Interview notes..."
                          />
                          {interviewDraft?.notes !== undefined && interviewDraft.notes !== (interviewEntry.notes || "") && (
                            <Button size="sm" variant="outline" className="h-6 text-[10px] mt-1"
                              onClick={() => onInterviewUpdate({ notes: interviewDraft.notes })}>
                              Save Notes
                            </Button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Activity timeline */}
                    <CandidateActivityTimeline jobId={jobId} candidateId={application.candidate_id} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </CardContent>
      </Card>

      {/* ── Individual Call Confirm Dialog ── */}
      <AlertDialog open={confirmCallOpen} onOpenChange={setConfirmCallOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmCallMode === "call_now" ? "Start AI call?" : "Send WhatsApp nudge?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmCallMode === "call_now"
                ? `Bolna will directly call ${c.name}. The AI agent will screen them for this role.`
                : `Send a WhatsApp context message to ${c.name}. An automated call will follow when they respond.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmCallOpen(false); sendWhatsAppNudge(confirmCallMode) }}>
              {confirmCallMode === "call_now" ? "Call Now" : "Send Nudge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
