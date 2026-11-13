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
import { PipelineKanban, type PipelineViewMode } from "./job-pipeline-kanban"
import { PipelineDetailModal, type PipelineDetailData } from "./job-pipeline-detail-modal"
import { deriveCardStatus, type PipelineCardData } from "./job-pipeline-card"
import {
  PIPELINE_COLUMNS,
  resolveStage,
  stageLabelSafe,
  stageNeedsConfirmation,
  type PipelineStageId,
} from "./job-pipeline-stages"
import { CandidateActivityTimeline } from "./candidate-activity-timeline"
import { CandidateTimeline } from "./candidate-timeline"
import { CandidateMetricsBar } from "./candidate-metrics-bar"
import { CollectedInfoView, PreScreenVerdict } from "./candidate-collected-info"
import { supabase } from "@/lib/supabase"
import { WhatsAppThreadTimeline } from "./whatsapp-thread-timeline"
import { getCallTruth, CALL_TRUTH_FILTERS } from "@/lib/call-truth"
import { formatAge } from "@/lib/dispatch/engine"
import { RootCauseAnalytics } from "./root-cause-analytics"
import {
  Loader2, User, MapPin, Briefcase, Eye, Sparkles, Mail, Phone, ChevronDown, ChevronUp,
  PhoneCall, PhoneOff, CalendarCheck, CheckCircle, CheckCheck, Check, Clock, UserX, Play, Save, Filter, MessageCircle, Send,
  AlertCircle, RefreshCw, BrainCircuit, ShieldCheck, Upload, Download, Search, X, Columns3, List,
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
/** AI Screen chips are driven by call-truth ids (see CALL_TRUTH_FILTERS) plus the
 *  interview-stage sub-sections, which use their own vocabulary. */
type CallSubFilter = string

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
  verifyBusy?: boolean
  onCallNow?: () => void
  onVerifyStatus?: () => void
  onNudgeStart?: () => void
  onNudgeEnd?: () => void
  onSelect: (id: string) => void
  onViewProfile: (candidate: any, application?: Application, participant?: any, aiInfo?: { recommendation?: string; score?: number }, fitScore?: number | null) => void
  onViewResults?: (candidateId: string) => void
  onReviewInfo?: () => void
  onStageChange: (applicationId: string, from: string, to: string, candidateName: string) => void
  onApplicationUpdated: (updated: Application) => void
  /** Refetch participants so a message sent from the thread shows up in the card. */
  onRefreshParticipants?: () => void
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
  pipelinePage?: number
  pipelinePerPage?: number
  pipelineTotal?: number
  onPipelinePageChange?: (page: number) => void
  onStageSelect: (stage: string) => void
  onCallSubFilterChange?: (sub: string) => void
  onStageChange: (applicationId: string, newStage: string, rejectionReason?: string) => void
  onApplicationUpdated: (updated: Application) => void
  onViewProfile: (candidate: any, application?: Application, participant?: any, aiInfo?: { recommendation?: string; score?: number }, fitScore?: number | null) => void
  onViewResults?: (candidateId: string) => void
  onRefresh: () => void
  /**
   * When each candidate entered their current stage, keyed by application id.
   * Without it the kanban can only say "applied 3 days ago", which says
   * nothing about how long they have been STUCK where they are.
   */
  stageEnteredAt?: Record<string, string>
  /** Open the full profile sidebar. */
  onOpenFullProfile?: (candidate: any, application?: Application, participant?: any, aiInfo?: { recommendation?: string; score?: number }, fitScore?: number | null) => void
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

// The old "Pending / Waiting / Engaged / Calling / Done / Failed" chips are gone:
// they were derived from wall-clock time and from statuses the provider had not
// confirmed. Call-truth filters (lib/call-truth.ts) replace them.

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

// Bucket for the AI Screen stage. Every decision comes from real provider data
// via getCallTruth — never from how long a row has been sitting in a status.
function callSubSection(participant: any): string {
  const review = participant?.review_status
  const truth = getCallTruth(participant)

  // A rejection is HR's terminal answer and outranks whatever the call did.
  if (review === "rejected") return "failed"

  // Approval used to return "done" unconditionally, which claimed a screening
  // had happened when it had not:
  //
  //   Call: Line busy
  //   Number was busy · attempt 2 of 2
  //   Screening complete — review call results and AI verdict / View Results
  //
  // Approving someone is a decision to call them, not evidence that a call ever
  // connected — and the two sit side by side on the same card, so the recruiter
  // reads a green "complete" next to a red "busy, 2 of 2" and cannot tell which
  // one is true. The call state decides the bucket.
  //
  // The one thing approval does change is what "nothing has happened" means. An
  // approved candidate with no call placed has just been asked when they would
  // like to talk; rendering that as pending would show "Not yet contacted —
  // ready to start screening / Start Screening" and invite someone to restart a
  // screening that is already agreed.
  if (review === "approved") {
    return truth.bucket === "pending" ? "waiting" : truth.bucket
  }

  return truth.bucket
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

/**
 * One-line, recruiter-readable summary of what the candidate just submitted.
 *
 * Prefers the parsed info_data, which is what the pre-screen actually screened,
 * and falls back to parsing the stored reply only when info_data is empty. Never
 * echoes the raw value: `whatsapp_response` on the flow-form path is a JSON
 * blob, and putting it in a status card told the recruiter nothing.
 */
function summarizeCollectedReply(participant: any): string | null {
  const info = participant?.info_data
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const keys = Object.keys(info).filter((k) => info[k] !== null && info[k] !== undefined && info[k] !== "")
    if (keys.length) {
      return `${keys.length} detail${keys.length === 1 ? "" : "s"} received`
    }
  }

  // Fallback for rows where only the reply text was kept. Parse, don't echo.
  const raw = participant?.whatsapp_response || participant?.whatsapp_reply_text
  if (!raw) return null
  const text = String(raw).trim()
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      const n = Object.keys(parsed).filter((k) => parsed[k] !== null && parsed[k] !== "").length
      if (n) return `${n} detail${n === 1 ? "" : "s"} received`
    } catch { /* not JSON after all */ }
    return "Details received"
  }
  const snippet = text.length > 60 ? `${text.slice(0, 57)}…` : text
  return snippet ? `Replied "${snippet}"` : null
}

function buildReviewCandidate(participant: any, application: Application): ReviewCandidate {
  const c = participant?.candidates || {}
  const job = participant?.jobs || {}

  // Hand the modal the raw collected info plus its provenance map, rather than
  // flattened per-field values. The modal has to be able to tell HR "this came
  // from their application" vs "they said this on WhatsApp" — and it must not
  // invent a WhatsApp transcript, because most of these values never crossed
  // WhatsApp at all.
  return {
    participantId: participant?.id || "",
    candidateId: application.candidate_id,
    name: c.name || "Candidate",
    currentRole: c.current_role || null,
    currentCompany: c.current_company || null,
    phone: c.phone || null,
    email: c.email || null,
    infoData: participant?.info_data || null,
    infoSources: participant?.info_sources || null,
    resumeFallback: {
      total_experience: c.total_experience_years ?? c.total_experience ?? null,
      location: c.location_preference || c.location || null,
    },
    preScreenResult: participant?.screening_context?.preScreenResult || null,
    aiSuggestsRejection:
      participant?.ai_suggests_rejection ?? participant?.screening_context?.aiSuggestsRejection ?? null,
    aiSuggestsRejectionAt:
      participant?.ai_suggests_rejection_at ?? participant?.screening_context?.aiSuggestsRejectionAt ?? null,
    jobTitle: job.title || null,
    jobSalaryMin: job.salary_min || null,
    jobSalaryMax: job.salary_max || null,
    jobSalaryType: job.salary_type || null,
    jobExpMin: job.experience_min_years || null,
    jobExpMax: job.experience_max_years || null,
    jobCity: job.city || null,
    infoReceivedAt: participant?.info_received_at || null,
    // Interest on WhatsApp no longer schedules anything (the AI records it and
    // stops). This is what puts the recruiter's decision back in front of them
    // instead of leaving the candidate waiting on a queue nobody was shown.
    interestNeedsApproval:
      participant?.screening_context?.interestNeedsApproval === true,
    interestFlaggedAt: participant?.screening_context?.interestFlaggedAt || null,
    participantStatus: participant?.status || null,
    scheduledCallAt: participant?.scheduled_call_at || null,
    awaitingScheduleDecision: participant?.screening_context?.awaitingScheduleDecision === true,
    clarificationQuestion: participant?.clarification_question || null,
    clarificationAskedAt: participant?.clarification_asked_at || null,
    // Drives the "Replied" badge and un-replied-first queue ordering, so the
    // recruiter can see who is waiting on them without opening every thread.
    clarificationAnsweredAt: participant?.clarification_answered_at || null,
    clarificationAnswer: participant?.screening_context?.clarification_answer || null,
    // The thread itself. The review decision depends on what the candidate
    // actually said, and the extracted fields alone do not show it — a field the
    // model read as `clarify: yes` looks identical to one the candidate meant as
    // their CTC. Reading the raw thread from here keeps that judgement with the
    // person who has to make it.
    whatsappHistory: participant?.whatsapp_history || null,
  }
}

function getActionForCard(application: Application, callStatus?: string, participant?: any): { label: string; cta: string; icon: any; color: string; action: string | null } | null {
  // "Candidate said they're interested" is the one thing on this board that only
  // a person can unblock, so it outranks the status-derived action below. The
  // candidate has already been told we're passing it to the team; until someone
  // acts on that they are waiting on us and nothing else will move.
  // Read off the participant row, not `application`. The flag is written into
  // screening_context, and threading a new field through Application meant it was
  // declared but never populated — so this branch was dead and the button never
  // appeared, while the typechecker was satisfied.
  const interestNeedsApproval =
    participant?.screening_context?.interestNeedsApproval === true

  if (application.status === "ai_screen" && interestNeedsApproval) {
    return {
      // Named "Send Call Options", not "Approve": the review modal's approve
      // books a call outright, while this only asks the candidate to choose a
      // time. Two green approvals that mean different things is exactly the
      // confusion that led here.
      label:
        "Candidate said they're interested — nothing is scheduled. Send call options so they can pick a time.",
      cta: "Send Call Options",
      icon: CalendarCheck,
      color: "bg-emerald-50 border-emerald-200 text-emerald-800",
      action: "offer_schedule",
    }
  }

  // If there's an active call sub-status, use that for more specific action
  if (application.status === "ai_screen" && callStatus) {
    // DONE
    if (callStatus === "done") return { label: "Screening complete — review call results and AI verdict", cta: "View Results", icon: CheckCircle, color: "bg-emerald-50 border-emerald-200 text-emerald-800", action: "view_results" }
    
    // FAILED
    if (callStatus === "failed") {
      const bolnaStatus = participant?.bolna_status
      const retryCount = participant?.retry_count || 0
      const hasCallData = !!(participant?.recording_url || participant?.call_ended_at || participant?.bolna_execution_id)
      if (participant?.call_is_partial) return { label: "1st screening incomplete (call disconnected mid-conversation). Review transcript and send call again.", cta: "Send Call Again", icon: RefreshCw, color: "bg-orange-50 border-orange-200 text-orange-800", action: "retry_now" }
      // If we have call data but screening wasn't completed properly, let HR review and retry
      if (hasCallData) return { label: "1st screening incomplete (call ended before proper screening). Review and send call again.", cta: "Send Call Again", icon: RefreshCw, color: "bg-orange-50 border-orange-200 text-orange-800", action: "retry_now" }
      if (bolnaStatus === "no-answer") return { label: `No answer after ${retryCount} attempt${retryCount !== 1 ? "s" : ""} — needs follow-up`, cta: "Send Call Again", icon: RefreshCw, color: "bg-red-50 border-red-200 text-red-800", action: "retry_now" }
      if (bolnaStatus === "busy") return { label: `Line busy after ${retryCount} attempt${retryCount !== 1 ? "s" : ""} — needs follow-up`, cta: "Send Call Again", icon: RefreshCw, color: "bg-red-50 border-red-200 text-red-800", action: "retry_now" }
      return { label: "Call failed — send call again or follow up on WhatsApp", cta: "Send Call Again", icon: RefreshCw, color: "bg-red-50 border-red-200 text-red-800", action: "retry_now" }
    }
    
    // CALLING
    if (callStatus === "calling") {
      const nextRetry = participant?.next_retry_at
      const retryCount = participant?.retry_count || 0
      if (nextRetry) {
        return { label: `Auto-retry in ${formatRetryTime(nextRetry)} (attempt ${retryCount + 1}/2)`, cta: "Retrying...", icon: RefreshCw, color: "bg-blue-50 border-blue-200 text-blue-800", action: null }
      }
      const bolnaStatus = participant?.bolna_status
      const executionId = participant?.bolna_execution_id
      if (executionId && (bolnaStatus === "failed" || bolnaStatus === "error" || bolnaStatus === "stopped" || bolnaStatus === "canceled")) {
        return { label: "Call not connected — needs manual follow-up", cta: "Manual Follow-up", icon: UserX, color: "bg-red-50 border-red-200 text-red-800", action: "manual_followup" }
      }
      if (executionId && !bolnaStatus) {
        return { label: "Call placed — awaiting provider response", cta: "In Progress", icon: PhoneCall, color: "bg-amber-50 border-amber-200 text-amber-800", action: null }
      }
      return { label: "AI call in progress — results will appear shortly", cta: "In Progress", icon: PhoneCall, color: "bg-amber-50 border-amber-200 text-amber-800", action: null }
    }
    
    // ENGAGED
    if (callStatus === "engaged") {
      // Was `Candidate replied "${reply}"`. On the inbound resume-upload path
      // whatsapp_response holds the flow form's response_json, so the card
      // rendered the raw blob:
      //   Candidate replied "{"current_ctc":"5","expected_ctc":"6",…}" — ready
      // to start AI call
      // That is storage format, not a message. It said nothing a recruiter can
      // act on and buried the actual state — they had submitted their details.
      const summary = summarizeCollectedReply(participant)
      if (summary) {
        return { label: `${summary} — ready to start AI call`, cta: "Start Call", icon: PhoneCall, color: "bg-green-50 border-green-200 text-green-800", action: "start_call" }
      }
      return { label: "Info collected — ready to start AI call", cta: "Start Call", icon: PhoneCall, color: "bg-green-50 border-green-200 text-green-800", action: "start_call" }
    }
    
    // WAITING
    if (callStatus === "waiting") {
      // Approved and now waiting on them, not on us: the picker has been sent
      // and nothing further happens until they choose a time.
      if (participant?.review_status === "approved") {
        return {
          label: "Approved — waiting for the candidate to pick a call time",
          cta: "Awaiting their time",
          icon: Clock,
          color: "bg-amber-50 border-amber-200 text-amber-800",
          action: null,
        }
      }
      const sentAt = participant?.whatsapp_sent_at || participant?.info_request_sent_at
      if (sentAt) {
        const elapsed = formatElapsedSince(sentAt)
        return { label: `Waiting for candidate response — sent ${elapsed}`, cta: "Waiting", icon: Send, color: "bg-amber-50 border-amber-200 text-amber-800", action: null }
      }
      return { label: "WhatsApp sent — waiting for candidate to respond", cta: "Waiting", icon: Send, color: "bg-amber-50 border-amber-200 text-amber-800", action: null }
    }

    // REVIEW (AI prescreen flagged for HR, or incomplete call screening)
    if (callStatus === "review") {
      const vj: any = participant?.verdict_json && typeof participant.verdict_json === "string" ? (() => { try { return JSON.parse(participant.verdict_json) } catch { return null } })() : participant?.verdict_json
      const cls = vj?._classification_outcome || participant?.classification_outcome
      const isIncompleteCall = !!(
        participant?.call_is_partial ||
        cls === "not_screened" || cls === "interrupted" ||
        ((participant?.bolna_execution_id || participant?.call_ended_at || participant?.recording_url) &&
          (participant?.status === "failed_partial" || participant?.status === "failed" || participant?.bolna_status === "stopped" || participant?.bolna_status === "canceled"))
      )
      if (isIncompleteCall) {
        return {
          label: "1st screening incomplete (call ended/couldn't complete). Send call again.",
          cta: "Send Call Again",
          icon: RefreshCw,
          color: "bg-orange-50 border-orange-200 text-orange-800",
          action: "retry_now",
        }
      }
      const aiSaysReject = participant?.screening_context?.aiSuggestsRejection
      if (aiSaysReject) {
        return {
          label: "AI suggests this candidate may not be a fit — the candidate has NOT been told anything. Confirm before rejecting.",
          cta: "Review & Decide",
          icon: ShieldCheck,
          color: "bg-red-50 border-red-200 text-red-800",
          action: "review_info",
        }
      }
      return { label: "AI prescreen flagged — needs your review before scheduling", cta: "Review Info", icon: ShieldCheck, color: "bg-amber-50 border-amber-200 text-amber-800", action: "review_info" }
    }

    // PENDING
    if (callStatus === "pending") return { label: "Not yet contacted — ready to start screening", cta: "Start Screening", icon: Play, color: "bg-zinc-50 border-zinc-200 text-zinc-800", action: "start_call" }
  }
  const config = NEXT_ACTION_CONFIG[application.status]
  if (!config) return null
  return config
}

/**
 * Time counting DOWN to a future moment — "in 25 min". Used for retries and
 * booked call slots.
 */
function formatRetryTime(nextRetryAt: string): string {
  const diff = new Date(nextRetryAt).getTime() - Date.now()
  if (diff <= 0) return "now"
  const minutes = Math.ceil(diff / 60000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * Time ELAPSED since a past moment — "2h ago".
 *
 * This was the same function as formatRetryTime, which is why the waiting state
 * rendered "Waiting for candidate response — sent now ago": it was counting
 * down to a timestamp in the past, immediately hit the `diff <= 0` branch, and
 * returned "now". Every waiting card showed the same useless string.
 */
function formatElapsedSince(pastIso: string): string {
  const then = new Date(pastIso).getTime()
  if (Number.isNaN(then)) return "recently"
  const diff = Date.now() - then
  if (diff < 0) return "just now"
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "moments ago"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rem = minutes % 60
    return rem ? `${hours}h ${rem}m ago` : `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return days === 1 ? "yesterday" : `${days} days ago`
}

export function CandidatesTab({ jobId, applications, loading, activeStage, activeCallSubFilter, clientDecisions, participants: participantsProp, fitScores: fitScoresProp, missingFitCount = 0, backfillRunning = false, pipelinePage = 1, pipelinePerPage = 100, pipelineTotal, onPipelinePageChange, onStageSelect, onCallSubFilterChange, onStageChange, onApplicationUpdated, onViewProfile, onRefresh, stageEnteredAt, onOpenFullProfile }: CandidatesTabProps) {
  const { toast } = useToast()
  const [pendingStageChange, setPendingStageChange] = useState<{
    applicationId: string; from: string; to: string; candidateName: string
  } | null>(null)
  // The default has to be one of the Select's options. It used to be
  // "Not a good fit", which is not in the list — so the trigger showed an
  // empty "Select a reason..." placeholder while "Not a good fit" was
  // what actually got written to the row.
  const [rejectionReason, setRejectionReason] = useState("not_qualified")
  const [filter, setFilter] = useState<FilterValue>("all")
  //
  // TWO separate sub-filter states.
  //
  // These used to share ONE variable, which meant switching between the
  // AI Screen stage and the Interview stage carried a stale filter id
  // across: pick "No call placed" on AI Screen, go to Interview, and the
  // list was filtered by an interview-section id that happened to match
  // nothing — or matched everything.
  //
  // The AI-Screen filter is seeded from the URL (?callsub=). The interview
  // one is NOT, because the same URL param is used for both.
  const [callSubFilter, setCallSubFilter] = useState<CallSubFilter>(() =>
    activeCallSubFilter && activeCallSubFilter !== "all" ? (activeCallSubFilter as CallSubFilter) : "all"
  )
  const [interviewSubFilter, setInterviewSubFilter] = useState<string>("all")
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

  // ── Pipeline board ──────────────────────────────────────────────────────
  //
  // The board is the DEFAULT view. The old default was a vertical list of
  // very tall cards filtered by a row of stage chips — to answer "how many
  // people are at each stage" you had to click through seven chips one at a
  // time. A kanban shows the shape of the pipeline at a glance.
  //
  // The board is the default, but the list is kept: some recruiters scan
  // left-to-right down one column and genuinely prefer a list. Their choice
  // is remembered per browser.
  const [viewMode, setViewMode] = useState<PipelineViewMode>(() => {
    if (typeof window === "undefined") return "list"
    try {
      return window.localStorage.getItem("gatihire.pipeline.view") === "board" ? "board" : "list"
    } catch {
      return "list"
    }
  })
  const [detailApplicationId, setDetailApplicationId] = useState<string | null>(null)

  // ── The one filter bar ─────────────────────────────────────────────────
  //
  // The old page had EIGHT filter dimensions across four stacked bars:
  // stage chips, inbound/outbound tabs, a source dropdown, 11 call-truth
  // chips, an interview round picker, 7 interview sub-section chips, a
  // bulk-stage dropdown and a bulk-nudge toggle. Up to four of them were
  // visible at once, and two of them (the call-truth chips and the interview
  // chips) shared ONE state variable — so switching between the AI Screen
  // and Interview stages carried a stale filter id across.
  //
  // The board needs three things and no more:
  //   - a way to find one person (search)
  //   - a way to split sourced vs applied (origin)
  //   - a way to surface "who needs me right now" (needs attention)
  //
  // Everything else is either visible on the card or lives in the modal.
  const [boardSearch, setBoardSearch] = useState("")
  const [boardNeedsAttention, setBoardNeedsAttention] = useState(false)

  /** Statuses that mean "this candidate is waiting on a human". */
  const ATTENTION_STATUS_IDS = useMemo(
    () => new Set([
      "call_failed",
      "call_partial",
      "no_answer",
      "not_placed",
      "needs_review",
      "client_pending",
      "no_screening",
    ]),
    [],
  )

  // A stable callback — the board memoises its cards, and a new arrow
  // function on every render meant every card re-rendered anyway.
  const openPipelineDetail = useCallback((id: string) => setDetailApplicationId(id), [])

  const changeViewMode = (mode: PipelineViewMode) => {
    setViewMode(mode)
    try {
      window.localStorage.setItem("gatihire.pipeline.view", mode)
    } catch {
      // Private browsing — the preference just will not stick.
    }
  }

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
      const res = await fetch(`/api/phone-screening/participants?jobId=${jobId}&fields=pipeline`)
      if (!res.ok) {
        // This used to be swallowed. The cost was visible in production: the
        // endpoint 500'd on a bad column in its select, so the pipeline quietly
        // kept stale data with no call status and "View Results" had no
        // participant to open — and nothing anywhere said why.
        const detail = await res.text().catch(() => "")
        console.error("[fetchParticipants] participants API failed", res.status, detail)
        toast({
          title: "Screening data failed to load",
          description: `The participants service returned ${res.status}. Call status and results may be stale.`,
          variant: "destructive",
        })
        return
      }
      const data = await res.json()
      const map: Record<string, any> = {}
      for (const p of Array.isArray(data) ? data : []) {
        if (p?.candidate_id && !map[p.candidate_id]) {
          map[p.candidate_id] = p
        }
      }
      setParticipantsLocal(map)
    } catch (err) {
      console.error("[fetchParticipants] request failed", err)
    }
  }, [jobId, toast])

  // Manual refresh. The pipeline payload is served from a 30s session cache, so
  // a plain refetch would hand back the same rows the recruiter is looking at;
  // onRefresh forces past that cache. Call status lives in a separate endpoint
  // from the applications list, so both must be pulled or the cards keep showing
  // a stale "calling"/"no reply" state next to a fresh list.
  const [refreshing, setRefreshing] = useState(false)
  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([fetchParticipants(), onRefresh()])
    } finally {
      setRefreshing(false)
    }
  }, [fetchParticipants, onRefresh])

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

  // Live updates for the screening board.
  //
  // This replaces a 10s poll that only ran while a call was active. Two problems
  // with that: it was blind exactly when it mattered most — a candidate replying
  // on WhatsApp sets no call status, so a hold appearing or a reply landing went
  // unnoticed until the recruiter happened to hit Refresh — and it burned a
  // request every 10s while it ran.
  //
  // Subscribing to this job's participant rows means a reply, a status change or
  // a pre-screen hold lands on the board as it happens. Only the fields this
  // board renders are asked for, so the event is cheap.
  //
  // Gated on visibility, deliberately: the requirement is "live while the
  // recruiter is looking at it". A hidden tab has no use for a subscription, so
  // it drops it entirely and refetches once on return. That also means a
  // backgrounded board costs nothing rather than quietly polling.
  useEffect(() => {
    if (!jobId) return
    if (typeof document !== "undefined" && document.hidden) return

    let cancelled = false
    let debounce: ReturnType<typeof setTimeout> | null = null

    const channel = supabase
      .channel(`screening-board:${jobId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "phone_screening_participants",
          filter: `job_id=eq.${jobId}`,
        },
        () => {
          if (cancelled) return
          // A single webhook can write the row several times in a row; coalesce.
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            if (!cancelled) void fetchParticipants()
          }, 300)
        }
      )
      .subscribe()

    const onVisible = () => {
      if (document.visibilityState === "visible" && !cancelled) void fetchParticipants()
    }
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      cancelled = true
      if (debounce) clearTimeout(debounce)
      document.removeEventListener("visibilitychange", onVisible)
      void supabase.removeChannel(channel)
    }
  }, [jobId, fetchParticipants])

  useEffect(() => {
    if (activeCallSubFilter && activeCallSubFilter !== "all") setCallSubFilter(activeCallSubFilter as CallSubFilter)
  }, [activeCallSubFilter])

  const handleStageChange = (appId: string, from: string, to: string, name: string) => {
    // One rule, from the shared stage model — not a list hardcoded here.
    // The two lists had already drifted: the shared model wanted
    // client_review to be confirmed, the inline list did not, so a drag
    // into Client Review moved the candidate silently.
    if (from !== to && stageNeedsConfirmation(to)) {
      setPendingStageChange({ applicationId: appId, from, to, candidateName: name })
    } else {
      try {
        onStageChange(appId, to)
      } catch (e) {
        console.error("Stage change failed", e)
      }
    }
  }

  /**
   * Move a candidate by dropping their card on another column.
   *
   * It goes through the SAME confirmation path as the old stage dropdown, so
   * a drag into Interview / Offer / Hired / Shortlist still asks the
   * recruiter to confirm, and a drag that matters is never silent.
   */
  const handleKanbanMove = (appId: string, toStage: PipelineStageId | "rejected") => {
    const app = applications.find((a) => a.id === appId)
    if (!app) return
    const name = (app.candidates as any)?.name || "candidate"
    handleStageChange(appId, String(app.status || "applied"), toStage, name)
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
      ? applications.filter((a) => !!callStatusByCandidate[a.candidate_id] && resolveStage(a.status) === "ai_screen")
      : resolveStage(activeStage) != null
        ? applications.filter((a) => resolveStage(a.status) === activeStage)
        : applications.filter((a) => a.status === activeStage)

  /**
   * The source filter — one definition, used by the board and the list.
   *
   * It used to live inline in the list filter chain only, so the board had
   * to reimplement it (and did it slightly differently). Two implementations
   * of one filter is how they drift apart.
   */
  const appById = useMemo(
    () => new Map(applications.map((a) => [a.id as string, a])),
    [applications],
  )

  const matchesSourceFilter = useCallback(
    (applicationId: string, value: FilterValue) => {
      if (value === "all") return true
      // A Map, not applications.find() — this runs once per card per
      // render, and find() made it O(applications^2).
      const app = appById.get(applicationId)
      if (!app) return true
      if (value === "inbound") return (app.origin || "inbound") === "inbound"
      if (value === "outbound") return (app.origin || "inbound") === "outbound"
      if (value === "database") return ["database", "enhanced_match"].includes(app.source || "")
      return app.source === "board-app"
    },
    [appById],
  )

  const filtered = baseFiltered
    .filter((a) => matchesSourceFilter(a.id, filter))
    // The search box and the "needs attention" toggle sit above BOTH views,
    // so they have to apply to the list too — otherwise clicking them in
    // list mode does nothing.
    .filter((a) => {
      if (!boardSearch.trim()) return true
      const q = boardSearch.trim().toLowerCase()
      const c: any = a.candidates || {}
      return (
        String(c.name || "").toLowerCase().includes(q) ||
        String(c.current_role || "").toLowerCase().includes(q) ||
        String(c.current_company || "").toLowerCase().includes(q)
      )
    })
    .filter((a) => {
      if (boardNeedsAttention) {
        const truth = getCallTruth(participantDataByCandidate[a.candidate_id])
        const st = deriveCardStatus({
          clientDecision: clientDecisions?.[a.id] ?? null,
          callTruth: truth,
          aiRecommendation: aiInfoByCandidate[a.candidate_id]?.recommendation ?? null,
          aiScore: aiInfoByCandidate[a.candidate_id]?.score ?? null,
          hasParticipant: !!participantDataByCandidate[a.candidate_id],
        })
        if (!ATTENTION_STATUS_IDS.has(st.id)) return false
      }
      if (activeStage === "interview" && interviewSubFilter !== "all" && selectedInterviewRound) {
        const entry = interviewsByKey[`${selectedInterviewRound}:${a.id}`]
        return interviewSubSection(entry) === interviewSubFilter
      }
      if (activeStage !== "ai_screen" || callSubFilter === "all") return true
      const t = getCallTruth(participantDataByCandidate[a.candidate_id])
      return CALL_TRUTH_FILTERS.find((f) => f.id === callSubFilter)?.match(t) ?? true
    })
    .sort((a, b) => {
      // Answered clarifications float to the top of the AI Screen stage.
      //
      // Sorting by fit_score only meant a recruiter scanning the queue could not
      // tell who was waiting on them. The signal already exists (the webhook sets
      // clarification_answered_at) but nothing in the list surfaced it, so an
      // answered candidate could sit below an unanswered one indefinitely. Only
      // applies to ai_screen — reordering the pipeline stages themselves would be
      // wrong, since applied_at is the correct order for those.
      if (activeStage === "ai_screen") {
        const replied = (id: string) => {
          const p = participantDataByCandidate[id]
          return p?.clarification_asked_at && p?.clarification_answered_at ? 1 : 0
        }
        const diff = replied(b.candidate_id) - replied(a.candidate_id)
        if (diff !== 0) return diff
      }

      // Sort by fit_score descending (best first), then by applied_at descending
      const scoreA = fitScores[a.candidate_id] ?? -1
      const scoreB = fitScores[b.candidate_id] ?? -1
      if (scoreB !== scoreA) return scoreB - scoreA
      return new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime()
    })

  /**
   * How long a candidate has been sitting in their current stage.
   *
   * `applied_at` is NOT this. A candidate who applied three weeks ago and
   * moved to Shortlist yesterday has been in Shortlist for ONE day, and
   * showing "3 weeks" there made every column look equally stale. The
   * stage_entered_at map comes from the candidate_activity stage_changed
   * events, so it is the real waiting time.
   */
  const stageAgeHours = useMemo(() => {
    const out: Record<string, number> = {}
    const now = Date.now()
    for (const app of applications) {
      const enteredAt = stageEnteredAt?.[app.id] || app.applied_at
      if (!enteredAt) {
        out[app.id] = 0
        continue
      }
      const ms = now - new Date(enteredAt).getTime()
      out[app.id] = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 3_600_000)) : 0
    }
    return out
  }, [applications, stageEnteredAt])

  /**
   * The kanban's view of the pipeline: one compact card per candidate.
   *
   * This deliberately does NOT reuse the big CandidateCard. That card
   * renders 12-20 lines (fit score twice, call state three times, plus the
   * WhatsApp thread, metrics bar, pre-screen verdict and collected info).
   * On a board it becomes a wall. The detail modal carries all of it.
   */
  const { pipelineCards, rejectedPipelineCards } = useMemo(() => {
    const out: Array<PipelineCardData & { stage: PipelineStageId }> = []
    const rejected: Array<PipelineCardData & { stage: PipelineStageId }> = []
    for (const app of applications) {
      const c: any = app.candidates || {}
      const participant = participantDataByCandidate[app.candidate_id] || null
      const truth = participant ? getCallTruth(participant) : null
      const aiInfo = aiInfoByCandidate[app.candidate_id]

      // resolveStage maps legacy names onto the current model and returns
      // null for `rejected` — a rejected candidate is out of the pipeline,
      // not sitting in Applied. They are collected separately below.
      const resolved = resolveStage(String(app.status || "applied"))
      const stage = (resolved ?? "rejected") as PipelineStageId
      const bucket = resolved ? out : rejected

      bucket.push({
        applicationId: app.id,
        candidateId: app.candidate_id,
        stage,
        name: c.name || "Unnamed candidate",
        role: c.current_role || "",
        company: c.current_company || "",
        location: c.location || "",
        experience: c.total_experience || "",
        fitScore: fitScores[app.candidate_id] ?? null,
        status: deriveCardStatus({
          clientDecision: clientDecisions?.[app.id] ?? null,
          callTruth: truth,
          aiRecommendation: aiInfo?.recommendation ?? null,
          aiScore: aiInfo?.score ?? null,
          hasParticipant: !!participant,
        }),
        ageLabel: formatAge(stageAgeHours[app.id] ?? 0),
        selected: selectedIds.has(app.id),
        isNew:
          app.status === "applied" &&
          !participant &&
          !viewedCandidates.has(app.candidate_id),
        clientDecision: clientDecisions?.[app.id] ?? null,
      } as PipelineCardData & { stage: PipelineStageId })
    }
    return { pipelineCards: out, rejectedPipelineCards: rejected }
  }, [
    applications,
    participantDataByCandidate,
    aiInfoByCandidate,
    fitScores,
    clientDecisions,
    stageAgeHours,
    selectedIds,
    viewedCandidates,
  ])

  /** The board's cards, after the three filters. */
  const filteredPipelineCards = useMemo(() => {
    const q = boardSearch.trim().toLowerCase()
    return pipelineCards.filter((card) => {
      if (!matchesSourceFilter(card.applicationId, filter)) return false
      if (boardNeedsAttention && !ATTENTION_STATUS_IDS.has(card.status.id)) return false
      if (!q) return true
      return (
        card.name.toLowerCase().includes(q) ||
        card.role.toLowerCase().includes(q) ||
        card.company.toLowerCase().includes(q)
      )
    })
  }, [pipelineCards, boardSearch, boardNeedsAttention, filter, applications, ATTENTION_STATUS_IDS])

  /**
   * The rejected candidates, with the SAME filters applied as the columns.
   *
   * They used to be passed through unfiltered, so typing a name into the
   * board search narrowed the columns to one card while the strip below
   * still rendered all 1,111 rejected candidates.
   */
  const filteredRejectedCards = useMemo(() => {
    const q = boardSearch.trim().toLowerCase()
    return rejectedPipelineCards.filter((card) => {
      if (!matchesSourceFilter(card.applicationId, filter)) return false
      if (!q) return true
      return (
        card.name.toLowerCase().includes(q) ||
        card.role.toLowerCase().includes(q) ||
        card.company.toLowerCase().includes(q)
      )
    })
  }, [rejectedPipelineCards, boardSearch, filter, matchesSourceFilter])

  /** The candidate whose card was clicked, shaped for the detail modal. */
  const detailData: PipelineDetailData | null = useMemo(() => {
    if (!detailApplicationId) return null
    const app = applications.find((a) => a.id === detailApplicationId)
    if (!app) return null
    const c: any = app.candidates || {}
    const participant = participantDataByCandidate[app.candidate_id] || null
    const ai = aiInfoByCandidate[app.candidate_id]

    return {
      applicationId: app.id,
      name: c.name || "Unnamed candidate",
      email: c.email || "",
      phone: c.phone || c.phone_e164 || "",
      role: c.current_role || "",
      company: c.current_company || "",
      location: c.location || "",
      experience: c.total_experience || "",
      summary: c.summary || "",
      fitScore: fitScores[app.candidate_id] ?? null,
      aiScore: ai?.score ?? null,
      aiRecommendation: ai?.recommendation ?? null,
      // The RESOLVED stage, not the raw status. A legacy row still on
      // "screening" shows in the HR Review column, so the modal must say
      // HR Review too — otherwise the "Move to Shortlist" button vanishes
      // (nextStage("screening") is null) and the recruiter has no forward
      // action at all.
      stage: resolveStage(String(app.status || "applied")) ?? "rejected",
      appliedAgo: app.applied_at ? formatDistanceToNow(new Date(app.applied_at), { addSuffix: true }) : "",
      ageLabel: formatAge(stageAgeHours[app.id] ?? 0),
      clientDecision: clientDecisions?.[app.id] ?? null,
      participant,
      notes: app.notes || "",
    }
  }, [
    detailApplicationId,
    applications,
    participantDataByCandidate,
    aiInfoByCandidate,
    fitScores,
    clientDecisions,
    stageAgeHours,
  ])

  const stageCount = (stageId: string) => {
    if (stageId === "ai_screen") return applications.filter((a) => !!callStatusByCandidate[a.candidate_id] && a.status === "ai_screen").length
    return applications.filter((a) => a.status === stageId).length
  }
  const totalFilteredCount = filtered.length
  const interviewApps = activeStage === "interview" ? applications.filter((a) => a.status === "interview") : []
  const interviewAppCount = interviewApps.length

  // useCallback so the memoised board cards are not re-rendered on every
  // parent render.
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }, [])

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
      if (data.callPlaced === false) {
        toast({ title: "No call was placed", description: "The provider did not accept the call. Use Verify to check the provider status.", variant: "destructive" })
      } else {
        toast({
          title: "Call accepted by the provider",
          description: data.executionId
            ? `Execution ${String(data.executionId).slice(0, 12)}… — awaiting the outcome`
            : "Placed — awaiting the outcome",
        })
      }
      fetchParticipants(); onRefresh()
    } catch (err: any) {
      toast({ title: "Call was not placed", description: err.message, variant: "destructive" })
    } finally { setCallNowCandidate(null) }
  }

  /**
   * Send the WhatsApp info request for one candidate.
   *
   * The card's own nudge button used the "collect info first" mode: the
   * candidate gets a message asking for their details and the AI screen
   * continues from there. The modal uses the same path so both entry
   * points behave identically.
   */
  const nudgeCandidate = async (candidateId: string) => {
    const participantId = participantIdByCandidate[candidateId]
    if (!participantId) {
      toast({ title: "No screening record", description: "This candidate has no phone-screening entry yet", variant: "destructive" })
      return
    }
    // The candidate's REAL origin. Forcing "outbound" here made the
    // trigger route send the outbound talent-outreach template instead of
    // a details request — while the toast said the candidate had been
    // asked for their details.
    const app = applications.find((a) => a.candidate_id === candidateId)
    const origin = app?.origin || "outbound"
    setNudgeBusyCandidate(candidateId)
    try {
      const res = await fetch("/api/phone-screening/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          candidateIds: [candidateId],
          origin,
          createApplication: true,
          callMode: "collect_info_first",
          campaignConfig: { nudgeHours: 4, escalateHours: 8, maxCallAttempts: 2 },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to send WhatsApp")
      toast({
        title: "WhatsApp sent",
        description:
          origin === "inbound"
            ? "The candidate has been asked for their details."
            : "The candidate has been nudged to respond.",
      })
      fetchParticipants()
      onRefresh()
    } catch (err: any) {
      toast({ title: "WhatsApp was not sent", description: err.message, variant: "destructive" })
    } finally {
      setNudgeBusyCandidate(null)
    }
  }

  // Re-poll the telephony provider for one participant so HR sees the real
  // outcome instead of waiting on a webhook (or a stale "awaiting" badge).
  const [verifyCandidate, setVerifyCandidate] = useState<string | null>(null)
  const verifyCallStatus = async (candidateId: string) => {
    const participantId = participantIdByCandidate[candidateId]
    if (!participantId) { toast({ title: "No screening record", description: "This candidate has no phone-screening entry yet", variant: "destructive" }); return }
    setVerifyCandidate(candidateId)
    try {
      const res = await fetch("/api/phone-screening/reconcile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not verify")
      if (data.success) {
        toast({ title: "Provider confirmed", description: `Reported status: ${data.status}` })
      } else if (data.noExecutionFound) {
        toast({ title: "No call was placed", description: data.message, variant: "destructive" })
      } else if (data.inProgress) {
        toast({ title: "Call still open at the provider", description: data.message })
      } else if (data.dryRun) {
        toast({ title: "Dry run", description: data.message })
      } else {
        toast({ title: "No terminal status yet", description: data.message || "The provider has not reported an outcome" })
      }
      fetchParticipants(); onRefresh()
    } catch (err: any) {
      toast({ title: "Could not verify with provider", description: err.message, variant: "destructive" })
    } finally { setVerifyCandidate(null) }
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
        {/* ── Pipeline header ───────────────────────────────────────────────
            One row. Search, origin, and "needs attention" — the three things
            a recruiter actually filters by. The stage chips are GONE from the
            board because the board IS the stages: eight columns, each with
            its own count. */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              value={boardSearch}
              onChange={(e) => setBoardSearch(e.target.value)}
              placeholder="Search name, role or company…"
              aria-label="Search candidates"
              className="h-8 w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-7 text-xs text-zinc-800 placeholder:text-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            {boardSearch && (
              <button
                type="button"
                onClick={() => setBoardSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Origin / source — one dropdown for every source there is */}
          <Select value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
            <SelectTrigger className="h-8 w-[190px] rounded-lg border-zinc-200 text-xs dark:border-zinc-700 dark:bg-zinc-900">
              <SelectValue placeholder="All candidates" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All candidates</SelectItem>
              <SelectItem value="inbound">Inbound · applied to us</SelectItem>
              <SelectItem value="outbound">Outbound · we sourced</SelectItem>
              <SelectItem value="database">Database matches</SelectItem>
              <SelectItem value="board-app">Talent Portal</SelectItem>
            </SelectContent>
          </Select>

          {/* Needs attention */}
          <button
            type="button"
            onClick={() => setBoardNeedsAttention((v) => !v)}
            aria-pressed={boardNeedsAttention}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
              boardNeedsAttention
                ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            <AlertCircle className="h-3.5 w-3.5" />
            Needs attention
            {boardNeedsAttention && (
              <span className="rounded bg-amber-200/70 px-1 text-[10px] font-bold tabular-nums dark:bg-amber-900">
                {filteredPipelineCards.length}
              </span>
            )}
          </button>

          {/* Clear */}
          {(boardSearch || filter !== "all" || boardNeedsAttention) && (
            <button
              type="button"
              onClick={() => {
                setBoardSearch("")
                setFilter("all")
                setBoardNeedsAttention(false)
              }}
              className="rounded-lg px-2 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Clear
            </button>
          )}

          {/* ── View switch + refresh ──────────────────────────────────────
              These live here, not inside the board, so they are visible in
              BOTH views. When the toggle lived inside the board component,
              switching to List unmounted the board — and with it the only
              way back to the board. Clicking "List" was a one-way door. */}
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900">
              <button
                type="button"
                onClick={() => changeViewMode("board")}
                aria-pressed={viewMode === "board"}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === "board"
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                <Columns3 className="h-3.5 w-3.5" />
                Board
              </button>
              <button
                type="button"
                onClick={() => changeViewMode("list")}
                aria-pressed={viewMode === "list"}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === "list"
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                <List className="h-3.5 w-3.5" />
                List
              </button>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="Refresh candidates and call status"
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>

        {/* ── Board mode: the kanban ───────────────────────────────────── */}
        {viewMode === "board" && (
          <PipelineKanban
            cards={filteredPipelineCards as any}
            // The UNFILTERED cards — the column counts are the size of each
            // stage, not the number of cards the filters happen to leave
            // visible. A board whose counts move when you type in a search
            // box cannot tell you which stage is backed up.
            allCards={pipelineCards as any}
            onOpen={openPipelineDetail}
            onToggleSelect={toggleSelect}
            onMoveStage={handleKanbanMove}
            selectedIds={selectedIds}
            focusStage={activeStage !== "all" ? activeStage : null}
            rejectedCards={filteredRejectedCards as any}
            emptyState={
              <div className="py-12 text-center text-sm text-zinc-400">
                <User className="mx-auto mb-2 h-8 w-8 text-zinc-300" />
                <p className="font-semibold">Nothing here</p>
                <p className="mt-1 text-xs">Try clearing the filters.</p>
              </div>
            }
          />
        )}

        {/* ── List mode: the old filter set + the detailed list ────────── */}
        {viewMode === "list" && (
          <>
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
          {/*
            No Refresh button here — the header above the board has one,
            and it is visible in BOTH views. This one only existed in list
            mode, so the same page had two Refresh buttons that did the
            same thing.
          */}
        </motion.div>

        {/* ── AI Screen Call-Outcome Filters ── */}
        {activeStage === "ai_screen" && (
          <div className="space-y-2 px-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {CALL_TRUTH_FILTERS.map((sub) => {
                const count = baseFiltered.filter((a) => {
                  const t = getCallTruth(participantDataByCandidate[a.candidate_id])
                  return sub.match(t)
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
              Every badge reflects what the call provider actually reported — a call is only shown as placed once the provider accepted it, and an outcome is only shown once the provider confirmed it.
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
                    onClick={() => { const next = interviewSubFilter === sub.id ? "all" : sub.id; setInterviewSubFilter(next) }}
                    title={sub.hint}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide transition-all flex items-center gap-1 ${
                      interviewSubFilter === sub.id ? "bg-purple-600 text-white shadow-sm" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                    }`}
                  >
                    {sub.label}
                    <span className={`text-[10px] ml-0.5 ${interviewSubFilter === sub.id ? "text-purple-200" : "text-zinc-400"}`}>{count}</span>
                  </button>
                )
              })}
              {interviewSubFilter !== "all" && (
                <button className="text-xs font-semibold text-zinc-400 hover:text-zinc-600 px-2" onClick={() => setInterviewSubFilter("all")}>Clear</button>
              )}
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Flow: <span className="font-semibold text-zinc-500">Pending</span> → schedule → <span className="font-semibold text-zinc-500">Interview</span> → <span className="font-semibold text-zinc-500">Passed/Rejected</span> → next stage
            </p>
          </div>
        )}

          </>
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

        {/* ── List mode body: the detailed candidate list ─────────── */}
        {viewMode === "list" && (
          <>
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
                      verifyBusy={verifyCandidate === app.candidate_id}
                      onCallNow={() => callCandidateNow(app.candidate_id)}
                      onVerifyStatus={() => verifyCallStatus(app.candidate_id)}
                      onNudgeStart={() => setNudgeBusyCandidate(app.candidate_id)}
                      onNudgeEnd={() => { setNudgeBusyCandidate(null); fetchParticipants(); onRefresh() }}
                      onRefreshParticipants={() => { fetchParticipants(); onRefresh() }}
                      onSelect={() => toggleSelect(app.id)}
                      onViewProfile={(c, app2, part, ai, fs) => {
                        setViewedCandidates(prev => new Set([...prev, app.candidate_id]))
                        onViewProfile(c, app2, part, ai, fs)
                      }}
                      onViewResults={(candidateId) => {
                        const pid = participantIdByCandidate[candidateId]
                        if (pid) {
                          setResultParticipantId(pid)
                          return
                        }
                        // The button used to do nothing at all when the screening
                        // row wasn't loaded, which reads as a broken page rather
                        // than "there is nothing to show yet".
                        toast({
                          title: "No screening record for this candidate yet",
                          description: "The call hasn't produced a result row. Refresh, or start a screening first.",
                          variant: "destructive",
                        })
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
          </>
        )}

        {/* ── Stage Change Confirmation (Premium AlertDialog) ── */}
        <AlertDialog open={!!pendingStageChange} onOpenChange={(open) => { if (!open) { setPendingStageChange(null); setRejectionReason("") } }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg">Confirm stage change</AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                <p>
                  Move <strong>{pendingStageChange?.candidateName}</strong> from{" "}
                  <strong>{stageLabelSafe(pendingStageChange?.from || "")}</strong> to{" "}
                  <strong>{stageLabelSafe(pendingStageChange?.to || "")}</strong>?
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
          onReviewed={() => { fetchParticipants(); onRefresh() }}
        />

        {/* ── Pipeline detail modal ───────────────────────────────────────
            The card shows who / how good a match / what needs attention.
            This shows everything else, in the order a recruiter reads it. */}
        <PipelineDetailModal
          open={!!detailApplicationId}
          onOpenChange={(open) => { if (!open) setDetailApplicationId(null) }}
          data={detailData}
          busy={nudgeBusyCandidate !== null || callNowCandidate !== null}
          onMoveStage={(toStage) => {
            if (!detailApplicationId) return
            handleKanbanMove(detailApplicationId, toStage)
            setDetailApplicationId(null)
          }}
          onCallNow={() => {
            const app = applications.find((a) => a.id === detailApplicationId)
            if (!app) return
            // The real handler — setting the busy flag on its own placed no
            // call, left the candidate permanently "busy", and made the
            // button look broken.
            void callCandidateNow(app.candidate_id)
          }}
          onNudge={() => {
            const app = applications.find((a) => a.id === detailApplicationId)
            if (!app) return
            void nudgeCandidate(app.candidate_id)
          }}
          onViewResults={() => {
            const app = applications.find((a) => a.id === detailApplicationId)
            if (!app) return
            const p = participantDataByCandidate[app.candidate_id]
            if (p?.id) setResultParticipantId(p.id)
            else toast({ title: "No screening recorded yet", description: "This candidate has not had a screening call.", variant: "default" })
          }}
          onOpenFullProfile={() => {
            const app = applications.find((a) => a.id === detailApplicationId)
            if (!app) return
            const p = participantDataByCandidate[app.candidate_id]
            const ai = aiInfoByCandidate[app.candidate_id]
            if (onOpenFullProfile) {
              onOpenFullProfile(app.candidates, app, p, ai, fitScores[app.candidate_id] ?? null)
            } else {
              onViewProfile(app.candidates, app, p, ai, fitScores[app.candidate_id] ?? null)
            }
            setDetailApplicationId(null)
          }}
        />

        <PrescreenReviewModal
          candidate={reviewCandidate}
          open={!!reviewCandidate}
          onClose={() => setReviewCandidate(null)}
          onReviewed={() => { fetchParticipants(); onRefresh() }}
          // A message sent from inside the modal changes the participant row, so
          // the object held in reviewCandidate is stale. Rebuild it from the
          // refetched participant, or the thread the recruiter just replied in
          // would keep showing the pre-reply history until the queue was reopened.
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

function CandidateCard({ application, jobId, callStatus, participant, aiInfo, clientDecision, selected, isNew, fitScore, callNowBusy, nudgeBusy, verifyBusy, onCallNow, onVerifyStatus, onNudgeStart, onNudgeEnd, onSelect, onViewProfile, onViewResults, onReviewInfo, onStageChange, onApplicationUpdated, onRefreshParticipants, interviewEntry, interviewDraft, onInterviewUpdate, onInterviewDraftChange }: CandidateCardProps) {
  const c = application.candidates
  const { toast } = useToast()
  const [notesDraft, setNotesDraft] = useState<string>(application.notes || "")
  const [notesEditing, setNotesEditing] = useState(false)
  const [notesSaving, setNotesSaving] = useState(false)
  const [retagBusy, setRetagBusy] = useState(false)
  const [confirmCallOpen, setConfirmCallOpen] = useState(false)
  const [confirmCallMode, setConfirmCallMode] = useState<"call_now" | "collect_info_first">("call_now")
  const [detailsExpanded, setDetailsExpanded] = useState(false)

  // "Replied and waiting on you".
  //
  // The recruiter arrives from the per-job "Replied — Need You" tile, so the
  // filter has already done the work of narrowing the board. What it cannot do
  // is tell them *why* this row is here once the list is longer than one screen,
  // or that the candidate is now idle waiting on them rather than still typing.
  // The badge is that at-a-glance answer, and it is deliberately louder than the
  // amber "AI flagged" treatment so the two are never confused: amber means the
  // bot is unsure, this means the human is the next step.
  const repliedWaiting = useMemo(() => {
    if (application.status !== "ai_screen") return false
    if (callStatus === "replied") return true
    if (!participant) return false
    if (participant?.screening_context?.interestNeedsApproval === true) return true
    return ["needs_review", "info_review_pending", "clarification_requested"].includes(participant.status)
  }, [application.status, callStatus, participant?.status])

  const nextAction = useMemo(() => getActionForCard(application, callStatus, participant), [application.status, callStatus, participant])
  const callTruth = useMemo(() => getCallTruth(participant), [participant])
  const aiScore = aiInfo?.score
  const hasMatchScore = application.match_score !== null && application.match_score !== undefined
  // A completed call must always lead somewhere: even if its score isn't stored
  // yet, the pill stays visible so "View Results" is reachable in every stage.
  const callCompleted =
    participant?.bolna_status === "completed" || participant?.status === "completed" || callStatus === "done"

  const saveNotes = async () => {
    if (notesSaving) return
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

  const [offeringSlot, setOfferingSlot] = useState(false)

  /**
   * Send the slot picker on the recruiter's authority.
   *
   * Deliberately not routed through onCallNow. That places a call; this sends
   * the candidate a choice of times, and the call happens only if they pick one.
   * They are different commitments and the UI must not blur them — the whole
   * point of the eligibility gate is that scheduling is never implicit.
   */
  const offerScheduleSlot = async () => {
    const participantId = participant?.id
    if (!participantId || offeringSlot) return
    setOfferingSlot(true)
    try {
      const res = await fetch(`/api/phone-screening/participants/${participantId}/offer-schedule`, {
        method: "POST",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({
          title: "Couldn't send the slot picker",
          description: data.error || "Please try again.",
          variant: "destructive",
        })
        return
      }
      toast({
        title: "Slot picker sent",
        description: "The candidate can now choose a time. No call is booked until they pick one.",
      })
      onRefreshParticipants?.()
    } catch (err: any) {
      toast({ title: "Couldn't send the slot picker", description: err?.message, variant: "destructive" })
    } finally {
      setOfferingSlot(false)
    }
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
    else if (nextAction.action === "offer_schedule") void offerScheduleSlot()
  }

  return (
    <>
      <Card className={`border shadow-sm hover:shadow-md transition-all duration-200 rounded-2xl overflow-hidden bg-white group ${
        selected ? "ring-2 ring-cyan-300 border-cyan-300" :
        repliedWaiting ? "ring-2 ring-emerald-400 border-emerald-300" :
        isNew ? "ring-2 ring-amber-300 border-amber-300 bg-amber-50/30" :
        "border-zinc-200 hover:border-zinc-300"
      }`}>
        {repliedWaiting && (
          <div className="flex items-center gap-2 bg-emerald-500 px-4 py-1.5 text-[11px] font-semibold text-white">
            <MessageCircle className="h-3.5 w-3.5 shrink-0" />
            {participant?.screening_context?.interestNeedsApproval === true
              ? "Said they're interested — your call whether to offer a slot"
              : "Replied — waiting on you"}
          </div>
        )}
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
                    {/* Call truth — states exactly what happened, sourced from the provider */}
                    {participant && (
                      <div className="mt-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold bg-white ${callTruth.toneClasses} border-current/25`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${callTruth.dotClasses}`} />
                            {callTruth.label}
                          </span>
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
                        <p className="mt-1 text-[11px] leading-snug text-zinc-500">{callTruth.detail}</p>
                        {participant.bolna_execution_id && (
                          <p className="mt-0.5 text-[10px] font-mono text-zinc-400">
                            execution {String(participant.bolna_execution_id).slice(0, 12)}…
                          </p>
                        )}
                        {participant.classification_outcome === "not_screened" && (
                          <div className="mt-1 inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[9px] font-semibold">
                            Call not completed — needs to be recalled
                          </div>
                        )}
                        <WhatsAppThreadTimeline
                          history={participant.whatsapp_history}
                          candidateName={participant.candidates?.name}
                          participantId={participant.id}
                          onSent={onRefreshParticipants}
                          infoData={participant.info_data}
                          infoSources={participant.info_sources}
                          resumeFallback={application.candidates}
                          preScreenResult={participant.screening_context?.preScreenResult}
                          roleLabel={
                            participant.jobs?.title
                              ? `${participant.jobs.title}${participant.jobs.client_name ? ` · ${participant.jobs.client_name}` : ""}`
                              : null
                          }
                        />
                        <CandidateMetricsBar participant={participant} callStatus={callStatus || "pending"} />
                      </div>
                    )}

                {/* Structured reply: fields ingested via Gemini */}
                {participant && participant.info_data && Object.keys(participant.info_data).length > 0 && (
                  <div className="mt-3 space-y-2">
                    {participant.screening_context?.preScreenResult && (
                      <PreScreenVerdict result={participant.screening_context.preScreenResult} />
                    )}
                    <CollectedInfoView
                      infoData={participant.info_data}
                      infoSources={participant.info_sources}
                      compact
                      fallback={application.candidates}
                    />
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
                    disabled={callNowBusy}
                    onClick={handleNextAction}
                  >
                    {callNowBusy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                    {callNowBusy ? "Calling…" : nextAction.cta}
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

              {/* Verify with the call provider — re-poll for the real outcome */}
              {participant && application.status === "ai_screen" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 p-0 rounded-lg"
                      disabled={verifyBusy}
                      onClick={() => onVerifyStatus?.()}
                    >
                      {verifyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Check the call provider for the real outcome</TooltipContent>
                </Tooltip>
              )}

              {/* AI Analysis button — shows match score, AI screening score, or a results entry point */}
              {(aiScore != null || hasMatchScore || callCompleted) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                        (aiScore ?? 0) >= 7 || (application.match_score ?? 0) >= 0.7
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100" :
                        (aiScore ?? 0) >= 4 || (application.match_score ?? 0) >= 0.4
                          ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100" :
                        "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100"
                      }`}
                      onClick={() => onViewResults?.(application.candidate_id)}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {aiScore != null ? `${aiScore}/10` :
                       callCompleted ? "View Results" :
                       `${Math.round((application.match_score || 0) * 100)}%`}
                      {aiInfo?.recommendation && (
                        <span className="capitalize ml-0.5">{aiInfo.recommendation.replace(/_/g, " ")}</span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {aiScore != null ? "View AI screening analysis" :
                     callCompleted ? "View call results and AI verdict" :
                     "View match analysis"}
                  </TooltipContent>
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
