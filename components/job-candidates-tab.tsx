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
import { PrescreenReviewModal, type ReviewCandidate } from "./prescreen-review-modal"
import { CandidateActivityTimeline } from "./candidate-activity-timeline"
import { CandidateTimeline } from "./candidate-timeline"
import { CandidateMetricsBar } from "./candidate-metrics-bar"
import { CollectedInfoView, PreScreenVerdict } from "./candidate-collected-info"
import { RootCauseAnalytics } from "./root-cause-analytics"
import {
  Loader2, User, MapPin, Briefcase, Eye, Sparkles, Mail, Phone, ChevronDown, ChevronUp,
  PhoneCall, PhoneOff, CheckCircle, CheckCheck, Check, Clock, UserX, Play, Save, Filter, MessageCircle, Send,
  AlertCircle, RefreshCw, BrainCircuit, ShieldCheck, Upload, Download,
} from "lucide-react"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"

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
type CallSubFilter = "all" | "pending" | "waiting" | "engaged" | "calling" | "done" | "failed" | "review" | "rejected" | "waitlist" | "on_hold" | "passed" | "move_next"

interface CandidateCardProps {
  application: Application
  jobId: string
  callStatus?: string
  participant?: any
  aiInfo?: { recommendation?: string; score?: number }
  clientDecision?: string | null
  selected: boolean
  isNew?: boolean
  fitScore?: number
  callNowBusy?: boolean
  nudgeBusy?: boolean
  onCallNow?: () => void
  onNudgeStart?: () => void
  onNudgeEnd?: () => void
  onSelect: (id: string) => void
  onViewProfile: (candidate: any, application?: Application, participant?: any, aiInfo?: { recommendation?: string; score?: number }, fitScore?: number | null) => void
  onViewResults?: (candidateId: string) => void
  onReviewInfo?: () => void
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
  participants?: Record<string, any> | null
  fitScores?: Record<string, number | null> | null
  missingFitCount?: number
  backfillRunning?: boolean
  onStageSelect: (stage: string) => void
  onCallSubFilterChange?: (sub: string) => void
  onStageChange: (applicationId: string, newStage: string, rejectionReason?: string) => void
  onApplicationUpdated: (updated: Application) => void
  onViewProfile: (candidate: any, application?: Application, participant?: any, aiInfo?: { recommendation?: string; score?: number }, fitScore?: number | null) => void
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
  { id: "pending", label: "Pending", hint: "Not yet contacted", icon: "clock" },
  { id: "waiting", label: "Waiting", hint: "WhatsApp sent or info requested — waiting for response", icon: "send" },
  { id: "engaged", label: "Engaged", hint: "Candidate replied or info collected — ready to call", icon: "message" },
  { id: "review", label: "Review", hint: "AI prescreen flagged — needs HR decision before scheduling", icon: "shield" },
  { id: "calling", label: "Calling", hint: "AI call in progress or auto-retry scheduled", icon: "phone" },
  { id: "done", label: "Done", hint: "Screening complete — review results", icon: "check" },
  { id: "failed", label: "Failed", hint: "No answer / busy / disconnected — manual follow-up needed", icon: "alert" },
] as const

const CALL_STATUS_COLORS: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-600",
  waiting: "bg-amber-50 text-amber-700",
  engaged: "bg-green-50 text-green-700",
  calling: "bg-blue-50 text-blue-700",
  done: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
}

const CALL_STATUS_ICONS: Record<string, any> = {
  pending: Clock,
  waiting: Send,
  engaged: MessageCircle,
  calling: PhoneCall,
  done: CheckCircle,
  failed: AlertCircle,
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
  "board-app": "Talent Portal", external_outreach: "External Outreach",
  database: "Database Match", enhanced_match: "Enhanced Match", recruiter_upload: "Recruiter Upload",
  linkedin: "LinkedIn",
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
  const infoRequestSentAt = participant?.info_request_sent_at
  const infoReceivedAt = participant?.info_received_at
  const whatsappSentAt = participant?.whatsapp_sent_at

  // ── DONE (terminal success) ──
  if (review === "approved") return "done"
  if (status === "completed") return "done"

  // ── FAILED (terminal failure) ──
  if (review === "rejected") return "failed"
  if (status === "not_interested") return "failed"
  if (status === "unreachable") return "failed"
  if (status === "failed_partial") return "failed"  // partial call, needs review
  if (status === "failed" && !nextRetryAt) return "failed"  // no retry = terminal
  if (bolnaStatus === "canceled" || bolnaStatus === "stopped") return "failed"

  // ── CALLING (active call or retrying) ──
  if (status === "in_progress" || status === "calling" || status === "call_scheduled") return "calling"
  if (status === "failed" && nextRetryAt) return "calling"  // has retry = still trying
  if (bolnaStatus === "no-answer" || bolnaStatus === "busy") {
    // Call failed but may retry
    if (nextRetryAt) return "calling"
    return "failed"  // no more retries
  }
  // Auto-timeout: if call has been in calling/in_progress for >3 minutes
  if ((status === "calling" || status === "in_progress") && lastAttemptAt) {
    const elapsed = Date.now() - new Date(lastAttemptAt).getTime()
    const THREE_MINUTES = 3 * 60 * 1000
    if (elapsed > THREE_MINUTES) {
      return nextRetryAt ? "calling" : "failed"
    }
  }

  // ── ENGAGED (replied or info received) ──
  if (reply) return "engaged"
  if (status === "info_received" || infoReceivedAt) return "engaged"
  if (status === "interested" || status === "call_me_now") return "engaged"

  // ── WAITING (sent but no reply yet) ──
  if (status === "info_requested" || infoRequestSentAt) return "waiting"
  if (status === "whatsapp_sent" || delivery === "delivered" || delivery === "sent" || delivery === "read") return "waiting"
  if (whatsappSentAt) return "waiting"

  // ── NEEDS REVIEW (AI prescreen flagged for HR) ──
  if (status === "needs_review") return "review"

  // ── PENDING ──
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

function buildReviewCandidate(participant: any, application: Application): ReviewCandidate {
  const c = participant?.candidates || {}
  const job = participant?.jobs || {}
  // Prefer structured fields collected via WhatsApp (info_data), fall back to candidate columns
  const info = participant?.info_data || {}
  const checks = participant?.prescreen_reason
    ? participant.prescreen_reason.split("; ").map((r: string) => {
        const [field, detail] = r.split(" (")
        const detailClean = detail?.replace(/\)$/, "") || r
        const isFail = r.includes("mismatch") || r.includes("insufficient") || r.includes("long") || r.includes("overqualified") || r.includes("below_range") || r.includes("above_range")
        const isPass = r.includes("passed") || r.includes("within") || r.includes("same city") || r.includes("willing") || r.includes("acceptable")
        return { field: field.replace(/_/g, " "), verdict: isFail ? "fail" as const : isPass ? "pass" as const : "review" as const, detail: detailClean }
      })
    : []

  return {
    participantId: participant?.id || "",
    candidateId: application.candidate_id,
    name: c.name || "Candidate",
    currentRole: c.current_role || null,
    currentCompany: c.current_company || null,
    phone: c.phone || null,
    email: c.email || null,
    currentCtc: (info.current_ctc as string) || c.current_ctc || null,
    expectedCtc: (info.expected_ctc as string) || c.expected_ctc || null,
    totalExperience: (info.total_experience as string) || c.total_experience_years || null,
    noticePeriod: (info.notice_period as string) || c.notice_period || null,
    location: (info.location as string) || c.location_preference || c.location || null,
    willingToRelocate: (info.willing_to_relocate != null ? /^(yes|y|true|1)$/i.test(String(info.willing_to_relocate)) : null) ?? c.willing_to_relocate ?? null,
    reasonForSwitching: (info.reason_for_switching as string) || c.reason_for_switching || null,
    aiPrescreenDecision: participant?.prescreen_decision || null,
    aiPrescreenReason: participant?.prescreen_reason || null,
    checks,
    jobTitle: job.title || null,
    jobSalaryMin: job.salary_min || null,
    jobSalaryMax: job.salary_max || null,
    jobExpMin: job.experience_min_years || null,
    jobExpMax: job.experience_max_years || null,
    jobCity: job.city || null,
    infoReceivedAt: participant?.info_received_at || null,
  }
}

function getActionForCard(application: Application, callStatus?: string, participant?: any): { label: string; cta: string; icon: any; color: string; action: string | null } | null {
  // If there's an active call sub-status, use that for more specific action
  if (application.status === "ai_screen" && callStatus) {
    // DONE
    if (callStatus === "done") return { label: "Screening complete — review call results and AI verdict", cta: "View Results", icon: CheckCircle, color: "bg-emerald-50 border-emerald-200 text-emerald-800", action: "view_results" }
    
    // FAILED
    if (callStatus === "failed") {
      const bolnaStatus = participant?.bolna_status
      const retryCount = participant?.retry_count || 0
      if (participant?.call_is_partial) return { label: "Call disconnected mid-conversation — partial transcript captured. Review what was recorded.", cta: "Review Partial", icon: AlertCircle, color: "bg-orange-50 border-orange-200 text-orange-800", action: "view_results" }
      if (bolnaStatus === "no-answer") return { label: `No answer after ${retryCount} attempt${retryCount !== 1 ? "s" : ""} — needs manual follow-up`, cta: "Manual Follow-up", icon: UserX, color: "bg-red-50 border-red-200 text-red-800", action: "manual_followup" }
      if (bolnaStatus === "busy") return { label: `Line busy after ${retryCount} attempt${retryCount !== 1 ? "s" : ""} — needs manual follow-up`, cta: "Manual Follow-up", icon: UserX, color: "bg-red-50 border-red-200 text-red-800", action: "manual_followup" }
      return { label: "Call failed — needs manual follow-up", cta: "Manual Follow-up", icon: UserX, color: "bg-red-50 border-red-200 text-red-800", action: "manual_followup" }
    }
    
    // CALLING
    if (callStatus === "calling") {
      const nextRetry = participant?.next_retry_at
      const retryCount = participant?.retry_count || 0
      if (nextRetry) {
        return { label: `Auto-retry in ${formatRetryTime(nextRetry)} (attempt ${retryCount + 1}/2)`, cta: "Retrying...", icon: RefreshCw, color: "bg-blue-50 border-blue-200 text-blue-800", action: null }
      }
      return { label: "AI call in progress — results will appear shortly", cta: "In Progress", icon: PhoneCall, color: "bg-amber-50 border-amber-200 text-amber-800", action: null }
    }
    
    // ENGAGED
    if (callStatus === "engaged") {
      const reply = participant?.whatsapp_response || participant?.whatsapp_reply_text
      if (reply) return { label: `Candidate replied "${reply}" — ready to start AI call`, cta: "Start Call", icon: PhoneCall, color: "bg-green-50 border-green-200 text-green-800", action: "start_call" }
      return { label: "Info collected — ready to start AI call", cta: "Start Call", icon: PhoneCall, color: "bg-green-50 border-green-200 text-green-800", action: "start_call" }
    }
    
    // WAITING
    if (callStatus === "waiting") {
      const sentAt = participant?.whatsapp_sent_at || participant?.info_request_sent_at
      if (sentAt) {
        const elapsed = formatRetryTime(sentAt) // This shows time since sent
        return { label: `Waiting for candidate response — sent ${elapsed} ago`, cta: "Waiting", icon: Send, color: "bg-amber-50 border-amber-200 text-amber-800", action: null }
      }
      return { label: "WhatsApp sent — waiting for candidate to respond", cta: "Waiting", icon: Send, color: "bg-amber-50 border-amber-200 text-amber-800", action: null }
    }

    // REVIEW (AI prescreen flagged for HR)
    if (callStatus === "review") {
      return { label: "AI prescreen flagged — needs your review before scheduling", cta: "Review Info", icon: ShieldCheck, color: "bg-amber-50 border-amber-200 text-amber-800", action: "review_info" }
    }
    
    // PENDING
    if (callStatus === "pending") return { label: "Not yet contacted — ready to start screening", cta: "Start Screening", icon: Play, color: "bg-zinc-50 border-zinc-200 text-zinc-800", action: "start_call" }
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

export function CandidatesTab({ jobId, applications, loading, activeStage, activeCallSubFilter, clientDecisions, participants: participantsProp, fitScores: fitScoresProp, missingFitCount = 0, backfillRunning = false, onStageSelect, onCallSubFilterChange, onStageChange, onApplicationUpdated, onViewProfile, onRefresh }: CandidatesTabProps) {
  const { toast } = useToast()
  const [pendingStageChange, setPendingStageChange] = useState<{
    applicationId: string; from: string; to: string; candidateName: string
  } | null>(null)
  const [rejectionReason, setRejectionReason] = useState("")
  const [filter, setFilter] = useState<FilterValue>("all")
  const [allViewTab, setAllViewTab] = useState<"inbound" | "outbound">("inbound")
  const [callSubFilter, setCallSubFilter] = useState<CallSubFilter>(() =>
    activeCallSubFilter && activeCallSubFilter !== "all" ? (activeCallSubFilter as CallSubFilter) : "all"
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [callNowCandidate, setCallNowCandidate] = useState<string | null>(null)
  const [nudgeBusyCandidate, setNudgeBusyCandidate] = useState<string | null>(null)
  const [callingStarted, setCallingStarted] = useState(false)
  const [bulkStage, setBulkStage] = useState("ai_screen")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkNudgeMode, setBulkNudgeMode] = useState<"call_now" | "collect_info_first">("collect_info_first")
  const [resultParticipantId, setResultParticipantId] = useState<string | null>(null)

  // Prescreen review state
  const [reviewCandidate, setReviewCandidate] = useState<ReviewCandidate | null>(null)
  const [reviewList, setReviewList] = useState<ReviewCandidate[]>([])
  const [reviewIndex, setReviewIndex] = useState(0)

  // Interview state
  const [interviewRounds, setInterviewRounds] = useState<InterviewRound[]>([])
  const [interviewsByKey, setInterviewsByKey] = useState<Record<string, InterviewEntry>>({})
  const [selectedInterviewRound, setSelectedInterviewRound] = useState("")
  const [interviewLoading, setInterviewLoading] = useState(false)
  const [interviewDrafts, setInterviewDrafts] = useState<Record<string, { notes: string; scheduledAtLocal: string }>>({})

  // Viewed candidates (local only)
  const [viewedCandidates, setViewedCandidates] = useState<Set<string>>(new Set())

  // Compute derived maps from participants prop (single source of truth)
  const [participantsLocal, setParticipantsLocal] = useState<Record<string, any> | null>(null)

  const activeParticipants = participantsLocal || participantsProp || {}

  const participantMaps = useMemo(() => {
    const map: Record<string, string> = {}
    const idMap: Record<string, string> = {}
    const aiMap: Record<string, { recommendation?: string; score?: number }> = {}
    const pDataMap: Record<string, any> = {}
    for (const [cid, p] of Object.entries(activeParticipants)) {
      if (!p) continue
      map[cid] = callSubSection(p)
      idMap[cid] = p.id
      pDataMap[cid] = p
      aiMap[cid] = {
        recommendation: p.ai_recommendation ?? undefined,
        score: p.ai_score != null ? Number(p.ai_score) : undefined,
      }
    }
    return { map, idMap, aiMap, pDataMap }
  }, [activeParticipants])

  const callStatusByCandidate = participantMaps.map
  const participantIdByCandidate = participantMaps.idMap
  const participantDataByCandidate = participantMaps.pDataMap
  const aiInfoByCandidate = participantMaps.aiMap

  // Fit scores: normalize from prop (null → not present)
  const [fitScoresLocal, setFitScoresLocal] = useState<Record<string, number | null> | null>(null)
  const fitScores = useMemo(() => {
    const source = fitScoresLocal || fitScoresProp || {}
    const out: Record<string, number> = {}
    for (const [id, score] of Object.entries(source)) {
      if (score != null) out[id] = score
    }
    return out
  }, [fitScoresLocal, fitScoresProp])

  // Lightweight polling for participants during active calls only
  const fetchParticipants = useCallback(async () => {
    try {
      const res = await fetch(`/api/phone-screening/participants?jobId=${jobId}`)
      if (res.ok) {
        const data = await res.json()
        const map: Record<string, any> = {}
        for (const p of Array.isArray(data) ? data : []) {
          if (p?.candidate_id && !map[p.candidate_id]) {
            map[p.candidate_id] = p
          }
        }
        setParticipantsLocal(map)
      }
    } catch { /* noop */ }
  }, [jobId])

  // Auto-timeout: re-evaluate call statuses every 30 seconds for 3-min timeout
  useEffect(() => {
    const hasCalling = Object.values(callStatusByCandidate).some((s) => s === "calling")
    if (!hasCalling) return
    const interval = setInterval(() => {
      setParticipantsLocal(prev => prev ? { ...prev } : null)
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
    const interval = setInterval(() => fetchParticipants(), 10000)
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

  const baseFiltered = activeStage === "all"
    ? applications
    : activeStage === "ai_screen"
      ? applications.filter((a) => !!callStatusByCandidate[a.candidate_id] && a.status === "ai_screen")
      : applications.filter((a) => a.status === activeStage)

  const filtered = baseFiltered
    .filter((a) => {
      if (activeStage === "all") {
        if (allViewTab === "inbound") return (a.origin || "inbound") === "inbound"
        if (allViewTab === "outbound") return (a.origin || "inbound") === "outbound"
        return true
      }
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
      const participant = participantDataByCandidate[a.candidate_id]
      return callSubSection(participant) === callSubFilter
    })
    .sort((a, b) => {
      // Sort by fit_score descending (best first), then by applied_at descending
      const scoreA = fitScores[a.candidate_id] ?? -1
      const scoreB = fitScores[b.candidate_id] ?? -1
      if (scoreB !== scoreA) return scoreB - scoreA
      return new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime()
    })

  const stageCount = (stageId: string) => {
    if (stageId === "ai_screen") return applications.filter((a) => !!callStatusByCandidate[a.candidate_id] && a.status === "ai_screen").length
    return applications.filter((a) => a.status === stageId).length
  }
  const totalFilteredCount = filtered.length
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
        body: JSON.stringify({
          jobId,
          candidateIds: selectedCandidateIds,
          callMode: bulkNudgeMode,
          createApplication: true,
          campaignConfig: {
            nudgeHours: 4,
            escalateHours: 8,
            maxCallAttempts: 2,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to start screening")
      const triggered = data.callsTriggered || 0
      const failed = data.callsFailed || 0
      const skipped = data.skippedNoPhone?.length || 0
      const nudged = data.nudgeSent || 0
      const deduped = data.dedupedCount || 0
      let description = ""
      if (bulkNudgeMode === "call_now") {
        description = `${triggered} calls placed`; if (failed > 0) description += `, ${failed} failed`; if (skipped > 0) description += `, ${skipped} skipped (no phone)`
      } else {
        description = `${nudged} info requests sent`; if (skipped > 0) description += `, ${skipped} skipped (no phone)`
      }
      if (deduped > 0) description += ` (${deduped} updated existing)`
      const title = bulkNudgeMode === "call_now" ? "AI calls started" : "WhatsApp info requests sent"
      toast({ title, description, variant: failed > 0 && triggered === 0 ? "destructive" : "default" })
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
          <button
            onClick={() => onStageSelect("all")}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeStage === "all"
                ? "bg-zinc-900 text-white shadow-md"
                : "bg-zinc-50 text-zinc-700 hover:bg-zinc-100 border border-zinc-200"
            }`}
          >
            <span>All</span>
            <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-md text-[10px] font-bold ${
              activeStage === "all" ? "bg-white/20 text-white" : "bg-zinc-200/80 text-zinc-600"
            }`}>
              {applications.length}
            </span>
          </button>
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
        </motion.div>

        {/* ── All View: Inbound / Outbound Tabs ── */}
        {activeStage === "all" && (
          <div className="flex flex-wrap items-center gap-1.5 px-1">
            <span className="text-xs font-bold text-zinc-400 uppercase mr-1">View:</span>
            <button
              onClick={() => setAllViewTab("inbound")}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wide transition-all ${
                allViewTab === "inbound"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
              }`}
            >
              Inbound <span className="ml-1 text-[10px] opacity-70">(applied to us)</span>
            </button>
            <button
              onClick={() => setAllViewTab("outbound")}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wide transition-all ${
                allViewTab === "outbound"
                  ? "bg-violet-600 text-white shadow-sm"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
              }`}
            >
              Outbound <span className="ml-1 text-[10px] opacity-70">(we sourced)</span>
            </button>
          </div>
        )}

        {/* ── Source Filter Bar (for non-All stages) ── */}
        {activeStage !== "all" && (
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
                <SelectItem value="board-app">Talent Portal</SelectItem>
              </SelectContent>
            </Select>
            {filter !== "all" && (
              <button className="text-xs font-semibold text-zinc-400 hover:text-zinc-600 px-1.5 py-1" onClick={() => setFilter("all")}>
                Clear
              </button>
            )}
          </div>
        )}

        {/* ── AI Screen Sub-Filters ── */}
        {activeStage === "ai_screen" && (
          <div className="space-y-2 px-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {CALL_SUB_SECTIONS.map((sub) => {
                const count = (activeStage === "ai_screen" ? baseFiltered : applications.filter((a) => a.status === activeStage))
                  .filter((a) => {
                    const participant = participantDataByCandidate[a.candidate_id]
                    return callSubSection(participant) === sub.id
                  }).length
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
              <span className="font-semibold text-zinc-500">Pending</span> → <span className="font-semibold text-zinc-500">Waiting</span> → <span className="font-semibold text-zinc-500">Engaged</span> → <span className="font-semibold text-zinc-500">Calling</span> → <span className="font-semibold text-zinc-500">Done</span>
              {callSubFilter === "waiting" && <span className="ml-2 text-amber-600">• Waiting for candidate to respond</span>}
              {callSubFilter === "engaged" && <span className="ml-2 text-green-600">• Candidate ready to call</span>}
              {callSubFilter === "calling" && <span className="ml-2 text-blue-600">• AI call in progress or retrying</span>}
              {callSubFilter === "done" && <span className="ml-2 text-emerald-600">• Screening complete — review results</span>}
              {callSubFilter === "failed" && <span className="ml-2 text-red-600">• Needs manual follow-up</span>}
            </p>
          </div>
        )}

        {/* ── Root Cause Analytics ── */}
        {activeStage === "ai_screen" && (
          <div className="px-1">
            <RootCauseAnalytics participants={Object.values(participantDataByCandidate)} />
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
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* Direct nudge buttons with tooltips */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        className="h-8 text-xs bg-teal-600 hover:bg-teal-700 text-white gap-1"
                        onClick={() => { setBulkNudgeMode("collect_info_first"); setConfirmCallsOpen(true) }}
                        disabled={callingStarted || selectedCandidateIds.length === 0}
                      >
                        {callingStarted ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
                        WhatsApp First
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p className="font-semibold">WhatsApp First (auto)</p>
                      <p className="text-xs opacity-80">The system auto-picks the message by candidate flow: portal applicants → shortlist + schedule, external resumes → 7-field info ask, outbound → outreach.</p>
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-1"
                        onClick={() => { setBulkNudgeMode("call_now"); setConfirmCallsOpen(true) }}
                        disabled={callingStarted || selectedCandidateIds.length === 0}
                      >
                        {callingStarted ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PhoneCall className="h-3.5 w-3.5" />}
                        Call Now
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p className="font-semibold">Call Now (Skip WhatsApp)</p>
                      <p className="text-xs opacity-80">Bolna AI calls each candidate immediately. No WhatsApp pre-nudge.</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* Bulk review buttons — only show when review candidates are selected */}
                  {selectedApplications.some(a => callSubSection(participantDataByCandidate[a.candidate_id]) === "review") && (
                    <>
                      <div className="w-px h-5 bg-cyan-300 mx-0.5" />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            className="h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white gap-1"
                            onClick={async () => {
                              const reviewIds = selectedApplications
                                .filter(a => callSubSection(participantDataByCandidate[a.candidate_id]) === "review")
                                .map(a => participantDataByCandidate[a.candidate_id]?.id)
                                .filter(Boolean)
                              if (reviewIds.length === 0) return
                              setBulkBusy(true)
                              try {
                                const res = await fetch("/api/phone-screening/review", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ actions: reviewIds.map((id: string) => ({ participantId: id, decision: "approved" })) }),
                                })
                                const data = await res.json()
                                if (!res.ok) throw new Error(data.error || "Failed to approve")
                                toast({ title: "Approved", description: data.message })
                                setSelectedIds(new Set())
                                fetchParticipants(); onRefresh()
                              } catch (err: any) {
                                toast({ title: "Failed", description: err.message, variant: "destructive" })
                              } finally { setBulkBusy(false) }
                            }}
                            disabled={bulkBusy}
                          >
                            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                            Approve Selected
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="font-semibold">Bulk Approve</p>
                          <p className="text-xs opacity-80">Approve all selected candidates awaiting HR review. Schedule links sent via WhatsApp.</p>
                        </TooltipContent>
                      </Tooltip>
                    </>
                  )}

                  <div className="w-px h-5 bg-cyan-300 mx-0.5" />

                  <Select value={bulkStage} onValueChange={setBulkStage}>
                    <SelectTrigger className="h-8 w-40 text-xs bg-white"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ai_screen">AI Screen</SelectItem>
                      <SelectItem value="shortlist">Shortlist</SelectItem>
                      <SelectItem value="interview">Interview</SelectItem>
                      <SelectItem value="applied">Applied</SelectItem>
                    </SelectContent>
                  </Select>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700 text-white gap-1"
                        onClick={() => {
                          const params = new URLSearchParams()
                          if (activeStage && activeStage !== "all") params.set("stage", activeStage)
                          if (filter && filter !== "all") params.set("origin", filter)
                          window.open(`/api/jobs/${jobId}/pipeline/export?${params.toString()}`, "_blank")
                        }}
                        disabled={filtered.length === 0}
                      >
                        <Download className="h-3.5 w-3.5 mr-1" />
                        Export Excel
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-semibold">Export to Excel</p>
                      <p className="text-xs opacity-80">Download candidate list with name, email, phone, job title, resume link, and pipeline stage.</p>
                    </TooltipContent>
                  </Tooltip>
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
            {/* ── Select All Bar ── */}
            {filtered.length > 0 && (
              <div className="flex items-center gap-2 px-1 py-1">
                <Checkbox
                  checked={selectedIds.size === filtered.length && filtered.length > 0}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setSelectedIds(new Set(filtered.map(a => a.id)))
                    } else {
                      setSelectedIds(new Set())
                    }
                  }}
                />
                <span className="text-xs text-zinc-500">
                  {selectedIds.size > 0
                    ? `${selectedIds.size} of ${filtered.length} selected`
                    : `Select all ${filtered.length} candidates`}
                </span>
                {selectedIds.size > 0 && (
                  <button
                    className="text-xs text-zinc-400 hover:text-zinc-600 ml-auto"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
            {backfillRunning && missingFitCount > 0 && (
              <div className="flex items-center gap-2 px-4 py-2.5 mb-3 bg-purple-50 border border-purple-200 rounded-xl text-sm text-purple-700">
                <BrainCircuit className="h-4 w-4 animate-pulse text-purple-500" />
                <span className="font-medium">AI is analyzing {missingFitCount} candidate{missingFitCount > 1 ? "s" : ""} and ranking by fit score...</span>
              </div>
            )}
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
                    isNew={app.status === "applied" && !participantDataByCandidate[app.candidate_id] && !viewedCandidates.has(app.candidate_id)}
                    fitScore={fitScores[app.candidate_id]}
                    callNowBusy={callNowCandidate === app.candidate_id}
                    nudgeBusy={nudgeBusyCandidate === app.candidate_id}
                    onCallNow={() => callCandidateNow(app.candidate_id)}
                    onNudgeStart={() => setNudgeBusyCandidate(app.candidate_id)}
                    onNudgeEnd={() => { setNudgeBusyCandidate(null); fetchParticipants(); onRefresh() }}
                    onSelect={() => toggleSelect(app.id)}
                    onViewProfile={(c, app2, part, ai, fs) => {
                      setViewedCandidates(prev => new Set([...prev, app.candidate_id]))
                      onViewProfile(c, app2, part, ai, fs)
                    }}
                    onViewResults={(candidateId) => {
                      const pid = participantIdByCandidate[candidateId]
                      if (pid) setResultParticipantId(pid)
                    }}
                    onReviewInfo={() => {
                      const participant = participantDataByCandidate[app.candidate_id]
                      if (!participant) return
                      const reviewData = buildReviewCandidate(participant, app)
                      // Find all review candidates for navigation
                      const allReview = filtered
                        .filter((a) => callSubSection(participantDataByCandidate[a.candidate_id]) === "review")
                        .map((a) => buildReviewCandidate(participantDataByCandidate[a.candidate_id], a))
                      setReviewList(allReview)
                      const idx = allReview.findIndex(r => r.participantId === reviewData.participantId)
                      setReviewIndex(idx >= 0 ? idx : 0)
                      setReviewCandidate(reviewData)
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
              <AlertDialogTitle>Start screening for {selectedApplications.length} candidates?</AlertDialogTitle>
              <AlertDialogDescription className="space-y-3">
                <div className="flex flex-wrap gap-2 pt-1">
                  <Badge className="text-xs font-bold px-3 py-1 rounded-full bg-blue-100 text-blue-700">{inboundCount} Inbound</Badge>
                  <Badge className="text-xs font-bold px-3 py-1 rounded-full bg-violet-100 text-violet-700">{outboundCount} Outbound</Badge>
                </div>
                <div className="rounded-xl border border-zinc-200 overflow-hidden">
                  <div className="grid grid-cols-2">
                    <button
                      type="button" disabled={callingStarted} onClick={() => setBulkNudgeMode("collect_info_first")}
                      className={`px-3 py-2.5 text-left text-xs transition-all ${bulkNudgeMode === "collect_info_first" ? "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-300" : "text-zinc-500 hover:bg-zinc-50"}`}
                    >
                      <span className="block font-bold text-xs uppercase tracking-wide">WhatsApp First</span>
                      <span className="text-xs opacity-80 mt-0.5 block">System auto-picks per flow: portal → shortlist, external → 7-field, outbound → outreach</span>
                    </button>
                    <button
                      type="button" disabled={callingStarted} onClick={() => setBulkNudgeMode("call_now")}
                      className={`px-3 py-2.5 text-left text-xs transition-all ${bulkNudgeMode === "call_now" ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-300" : "text-zinc-500 hover:bg-zinc-50"}`}
                    >
                      <span className="block font-bold text-xs uppercase tracking-wide">Call Now</span>
                      <span className="text-xs opacity-80 mt-0.5 block">Outbound only — Bolna AI calls immediately, no WhatsApp</span>
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-zinc-400 leading-tight">
                  For inbound candidates the system auto-picks the message (shortlist for portal applicants, 7-field for external resumes) regardless of the selection above; only outbound candidates honor it.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={callingStarted}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={startAiCalls} disabled={callingStarted}>
                {callingStarted ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <PhoneCall className="h-3.5 w-3.5 mr-1" />}
                {callingStarted ? "Starting..." : bulkNudgeMode === "call_now" ? "Start calls now" : "Send WhatsApp info request"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <PhoneScreeningResultsSheet
          participantId={resultParticipantId}
          open={!!resultParticipantId}
          onOpenChange={(open) => { if (!open) setResultParticipantId(null) }}
        />

        <PrescreenReviewModal
          candidate={reviewCandidate}
          open={!!reviewCandidate}
          onClose={() => setReviewCandidate(null)}
          onReviewed={() => { fetchParticipants(); onRefresh() }}
          totalCount={reviewList.length}
          currentIndex={reviewIndex}
          onNext={() => { const next = reviewIndex + 1; if (next < reviewList.length) { setReviewIndex(next); setReviewCandidate(reviewList[next]) } }}
          onPrev={() => { const prev = reviewIndex - 1; if (prev >= 0) { setReviewIndex(prev); setReviewCandidate(reviewList[prev]) } }}
        />
      </div>
    </TooltipProvider>
  )
}

/* ═══════════════════════════════════════════════════════════════════
   CANDIDATE CARD — Premium Redesign
   ═══════════════════════════════════════════════════════════════════ */

function CandidateCard({ application, jobId, callStatus, participant, aiInfo, clientDecision, selected, isNew, fitScore, callNowBusy, nudgeBusy, onCallNow, onNudgeStart, onNudgeEnd, onSelect, onViewProfile, onViewResults, onReviewInfo, onStageChange, onApplicationUpdated, interviewEntry, interviewDraft, onInterviewUpdate, onInterviewDraftChange }: CandidateCardProps) {
  const c = application.candidates
  const { toast } = useToast()
  const [notesDraft, setNotesDraft] = useState<string>(application.notes || "")
  const [notesEditing, setNotesEditing] = useState(false)
  const [notesSaving, setNotesSaving] = useState(false)
  const [retagBusy, setRetagBusy] = useState(false)
  const [confirmCallOpen, setConfirmCallOpen] = useState(false)
  const [confirmCallMode, setConfirmCallMode] = useState<"call_now" | "collect_info_first">("call_now")
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

  const sendWhatsAppNudge = async (mode: "call_now" | "collect_info_first") => {
    onNudgeStart?.()
    try {
      const res = await fetch("/api/phone-screening/trigger", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          candidateIds: [c.id],
          origin: application.origin || "outbound",
          createApplication: true,
          callMode: mode,
          campaignConfig: { nudgeHours: 4, escalateHours: 8, maxCallAttempts: 2 },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to start screening")
      const title = mode === "call_now" ? "AI call started" : "Info request sent"
      const desc = mode === "call_now" ? `Direct call triggered for ${c.name}` : `WhatsApp info request sent to ${c.name}`
      toast({ title, description: desc })
      onApplicationUpdated({ ...application, status: "ai_screen" })
    } catch (err: any) { toast({ title: "Failed", description: err.message, variant: "destructive" }) }
    finally { onNudgeEnd?.() }
  }

  const handleNextAction = () => {
    if (!nextAction) return
    if (nextAction.action === "view_profile") onViewProfile(c, application, participant, aiInfo, fitScore)
    else if (nextAction.action === "view_results") onViewResults?.(application.candidate_id)
    else if (nextAction.action === "share") toast({ title: "Use Share Shortlist from job header" })
    else if (nextAction.action === "schedule") toast({ title: "Schedule interview from the interview section" })
    else if (nextAction.action === "start_call") onCallNow?.()
    else if (nextAction.action === "retry_now") onCallNow?.()
    else if (nextAction.action === "manual_followup") toast({ title: "Manual follow-up required", description: "Please contact the candidate directly" })
    else if (nextAction.action === "review_info") onReviewInfo?.()
  }

  return (
    <>
      <Card className={`border shadow-sm hover:shadow-md transition-all duration-200 rounded-2xl overflow-hidden bg-white group ${
        selected ? "ring-2 ring-cyan-300 border-cyan-300" :
        isNew ? "ring-2 ring-amber-300 border-amber-300 bg-amber-50/30" :
        "border-zinc-200 hover:border-zinc-300"
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
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-lg text-zinc-900 truncate">{c.name}</h3>
                  {isNew && (
                    <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-[10px] font-bold">
                      New
                    </Badge>
                  )}
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
                  {fitScore != null && (
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                      fitScore >= 70 ? "bg-purple-50 text-purple-700 border-purple-200" :
                      fitScore >= 40 ? "bg-amber-50 text-amber-700 border-amber-200" :
                      "bg-rose-50 text-rose-600 border-rose-200"
                    }`}>
                      <BrainCircuit className="h-3 w-3" />{fitScore}%
                    </span>
                  )}
                </div>
                <p className="text-sm text-zinc-600 flex items-center gap-1.5 leading-snug">
                  <Briefcase className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                  <span className="truncate">{c.current_role || "No role specified"}{c.current_company ? ` at ${c.current_company}` : ""}</span>
                </p>
                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3 shrink-0" />{c.location || "N/A"}</span>
                  {c.total_experience && <span className="text-zinc-300">|</span>}
                  {c.total_experience && <span className="font-medium text-zinc-500">{c.total_experience} experience</span>}
                </div>
                {/* Key Metrics — always visible */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                  {(c.current_salary || c.expected_salary || c.notice_period) && (
                    <div className="flex items-center gap-2 text-[11px]">
                      {c.current_salary && (
                        <span className="text-zinc-400">Current: <span className="font-semibold text-zinc-700">{c.current_salary}</span></span>
                      )}
                      {c.expected_salary && (
                        <span className="text-zinc-400">Expected: <span className="font-semibold text-zinc-700">{c.expected_salary}</span></span>
                      )}
                      {c.notice_period && (
                        <span className="text-zinc-400">Notice: <span className="font-semibold text-zinc-700">{c.notice_period}</span></span>
                      )}
                    </div>
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
                {/* WhatsApp Status Badge + Metrics */}
                {participant && (
                  <div className="mt-2">
                    <div className="flex items-center gap-1.5">
                      <Badge
                        className={`text-[10px] font-semibold px-2 py-0.5 ${
                          callStatus === "done" ? "bg-green-100 text-green-700 border-green-200" :
                          callStatus === "engaged" ? "bg-emerald-100 text-emerald-700 border-emerald-200" :
                          callStatus === "calling" ? "bg-blue-100 text-blue-700 border-blue-200" :
                          callStatus === "waiting" ? "bg-amber-100 text-amber-700 border-amber-200" :
                          callStatus === "failed" ? "bg-red-100 text-red-700 border-red-200" :
                          "bg-zinc-100 text-zinc-600 border-zinc-200"
                        }`}
                      >
                        {callStatus === "done" && <CheckCircle className="h-3 w-3 mr-1" />}
                        {callStatus === "engaged" && <MessageCircle className="h-3 w-3 mr-1" />}
                        {callStatus === "calling" && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                        {callStatus === "waiting" && <Send className="h-3 w-3 mr-1" />}
                        {callStatus === "failed" && <AlertCircle className="h-3 w-3 mr-1" />}
                        <span className="capitalize">{(callStatus || "pending").replace(/_/g, " ")}</span>
                      </Badge>
                      {participant.whatsapp_delivery_status && (
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${
                          participant.whatsapp_delivery_status === "read" ? "text-green-600 border-green-200" :
                          participant.whatsapp_delivery_status === "delivered" ? "text-blue-600 border-blue-200" :
                          participant.whatsapp_delivery_status === "sent" ? "text-zinc-500 border-zinc-200" :
                          "text-red-500 border-red-200"
                        }`}>
                          {participant.whatsapp_delivery_status === "read" && <CheckCheck className="h-3 w-3 mr-0.5" />}
                          {participant.whatsapp_delivery_status === "delivered" && <Check className="h-3 w-3 mr-0.5" />}
                          <span className="capitalize">{participant.whatsapp_delivery_status}</span>
                        </Badge>
                      )}
                    </div>
                    {/* Metrics Bar */}
                    <CandidateMetricsBar participant={participant} callStatus={callStatus || "pending"} />
                  </div>
                )}

                {/* Structured reply: fields ingested via Gemini */}
                {participant && participant.info_data && Object.keys(participant.info_data).length > 0 && (
                  <div className="mt-3 space-y-2">
                    {participant.screening_context?.preScreenResult && (
                      <PreScreenVerdict result={participant.screening_context.preScreenResult} />
                    )}
                    <CollectedInfoView infoData={participant.info_data} compact fallback={application.candidates} />
                  </div>
                )}
              </div>
            </div>

            {/* ── Row 2: Next Action Card ── */}
            {nextAction && (
              <div className={`mt-4 p-3 rounded-xl border flex items-center justify-between gap-3 ${nextAction.color}`}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <nextAction.icon className="h-4 w-4 shrink-0 opacity-70" />
                  <span className="text-xs font-medium truncate">{nextAction.label}</span>
                </div>
                {nextAction.action ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs font-bold shrink-0 bg-white/80 hover:bg-white border-current/20"
                    onClick={handleNextAction}
                  >
                    {nextAction.cta}
                  </Button>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/50 border border-current/20">
                    <Clock className="h-3 w-3" /> {nextAction.cta} — auto-updating
                  </span>
                )}
              </div>
            )}

            {/* ── Row 3: Action Buttons ── */}
            <div className="flex items-center gap-1.5 mt-4 pt-3 border-t border-zinc-100">
              {/* Eye button */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 w-8 p-0 rounded-lg" onClick={() => onViewProfile(c, application, participant, aiInfo, fitScore)}>
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

              {/* Fit Score button — always visible */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                      fitScore == null ? "border-zinc-200 bg-zinc-50 text-zinc-400" :
                      fitScore >= 70
                        ? "border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100" :
                      fitScore >= 40
                        ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100" :
                      "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                    }`}
                    onClick={() => onViewProfile(c, application, participant, aiInfo, fitScore)}
                  >
                    <BrainCircuit className="h-3.5 w-3.5" />
                    {fitScore != null ? `${fitScore}%` : "—"}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{fitScore != null ? "View JD fit analysis" : "Fit score pending"}</TooltipContent>
              </Tooltip>

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
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => { setConfirmCallMode("collect_info_first"); setConfirmCallOpen(true) }} className="flex flex-col items-start gap-0.5 py-2">
                    <span className="flex items-center gap-2 font-semibold text-xs"><MessageCircle className="h-3.5 w-3.5 text-teal-500" /> WhatsApp First</span>
                    <span className="text-[11px] text-zinc-400 leading-snug">System auto-picks: shortlist (portal) / 7-field ask (external) / outreach (outbound).</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setConfirmCallMode("call_now"); setConfirmCallOpen(true) }} className="flex flex-col items-start gap-0.5 py-2">
                    <span className="flex items-center gap-2 font-semibold text-xs"><PhoneCall className="h-3.5 w-3.5 text-emerald-500" /> Call Now</span>
                    <span className="text-[11px] text-zinc-400 leading-snug">Outbound only. Skip WhatsApp, Bolna AI calls immediately.</span>
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

                    {/* AI Screening Context */}
                    {participant?.screening_context && (
                      <div className="p-3 rounded-xl bg-blue-50/50 border border-blue-100">
                        <div className="flex items-center gap-2 mb-2">
                          <BrainCircuit className="h-4 w-4 text-blue-600" />
                          <p className="text-xs font-bold text-blue-700">Screening Context</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div>
                            <span className="text-zinc-400">Role:</span>
                            <span className="ml-1 text-zinc-600">{participant.screening_context.jobTitle}</span>
                          </div>
                          <div>
                            <span className="text-zinc-400">Salary:</span>
                            <span className="ml-1 text-zinc-600">{participant.screening_context.salaryRange || "N/A"}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Activity Timeline */}
                    {participant && (
                      <CandidateTimeline
                        participant={participant}
                        candidateName={c.name || "Candidate"}
                      />
                    )}

                    {/* AI Generated Questions */}
                    {participant?.generated_questions && (
                      <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-100">
                        <p className="text-xs font-bold text-zinc-500 mb-2">Questions AI Will Ask</p>
                        <ol className="space-y-1">
                          {participant.generated_questions.split("\n").filter((q: string) => q.trim()).slice(0, 3).map((q: string, i: number) => (
                            <li key={i} className="text-[11px] text-zinc-600 flex gap-1">
                              <span className="text-zinc-400">{i + 1}.</span> {q.replace(/^\d+\.\s*/, "")}
                            </li>
                          ))}
                        </ol>
                        {participant.generated_questions.split("\n").filter((q: string) => q.trim()).length > 3 && (
                          <button className="text-[10px] text-blue-500 hover:text-blue-600 mt-1" onClick={() => onViewProfile(c, application, participant, aiInfo, fitScore)}>
                            View all →
                          </button>
                        )}
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
            <AlertDialogTitle>{confirmCallMode === "call_now" ? "Start AI call?" : "WhatsApp first?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmCallMode === "call_now"
                ? `Bolna will directly call ${c.name}. The AI agent will screen them for this role. (Applies only if this is an outbound candidate.)`
                : `The system sends the right WhatsApp message for ${c.name} based on how they joined: portal applicants get the shortlist + schedule invite, external resumes get the 7-field info ask, outbound candidates get outreach.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmCallOpen(false); sendWhatsAppNudge(confirmCallMode) }}>
              {confirmCallMode === "call_now" ? "Call Now" : "Send WhatsApp"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
