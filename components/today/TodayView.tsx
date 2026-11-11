"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import dynamic from "next/dynamic"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { ToastAction } from "@/components/ui/toast"
import {
  AlarmClock,
  ArrowRight,
  Building2,
  CalendarCheck,
  CalendarClock,
  CheckCircle2,
  Eye,
  FileText,
  Flag,
  Inbox,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Phone,
  PhoneCall,
  RefreshCw,
  Send,
  UserMinus,
  Users,
  UserX,
} from "lucide-react"
import { PhoneScreeningResultsSheet } from "@/components/phone-screening-results-sheet"
import { WhatsAppConversationModal } from "@/components/whatsapp-conversation-modal"

const CandidateProfileSidebar = dynamic(
  () => import("@/components/candidate-profile-sidebar").then((m) => m.CandidateProfileSidebar),
  { ssr: false }
)
import { useToast } from "@/hooks/use-toast"
import { useInternalPermissions } from "@/hooks/use-internal-permissions"
import {
  formatAge,
  kindLabel,
  nextStageFor,
  stageLabel,
  WORK_ITEM_KINDS,
  type WorkItem,
  type WorkItemKind,
  type DispatchStats,
  type RailInterview,
  type RailReady,
  type RailLiveCall,
} from "@/lib/dispatch/engine"

type Scope = "mine" | "team"

interface TodayResponse {
  scope: Scope
  canViewTeam: boolean
  viewer: { id: string; name: string | null; email: string | null }
  generatedAt: string
  stats: DispatchStats
  counts: Record<string, number>
  /** Items on other recruiters' desks when scope=mine (0 otherwise). */
  teamHidden?: number
  /** Companies with waiting-item counts, for the cascading company filter. */
  companies: Array<{ name: string; count: number }>
  /** Roles (job titles) with waiting-item counts, filtered by selected company. */
  roles: Array<{ title: string; count: number }>
  items: WorkItem[]
  rail: {
    interviews: RailInterview[]
    ready: RailReady[]
    live_calls: RailLiveCall[]
  }
}

const SNOOZE_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 4, label: "Later today" },
  { hours: 24, label: "Tomorrow" },
  { hours: 72, label: "In 3 days" },
  { hours: 168, label: "In a week" },
]

const CALL_OUTCOMES = ["connected", "no answer", "busy", "voicemail", "wrong number", "callback booked"]

// Structured interview answers — the form a human fills after speaking to the
// candidate, so every manual conversation leaves the same record behind.
const COMM_RATINGS = ["Excellent", "Good", "Average", "Poor"]
const FIT_RATINGS = ["Strong fit", "Partial fit", "Weak fit"]
const SALARY_CHECKS = ["Within band", "Above band", "Below band", "Not discussed"]
const DECISIONS = ["Advance", "Hold", "Reject"] as const

const PAGE_SIZE = 50

const KIND_STYLE: Record<WorkItemKind, string> = {
  human: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900",
  ghosted: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900/50 dark:text-slate-300 dark:border-slate-700",
  reply: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
  declined: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  resched: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900",
  overdue: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  call: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900",
  hold: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
  client: "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-900",
  shortlist: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  offer: "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900",
}

const KIND_ICON: Record<WorkItemKind, React.ComponentType<{ className?: string }>> = {
  human: PhoneCall,
  ghosted: UserX,
  reply: MessageCircle,
  declined: UserMinus,
  hold: Flag,
  call: Eye,
  resched: CalendarClock,
  client: CheckCircle2,
  overdue: Building2,
  offer: FileText,
  shortlist: Send,
}

const PILL_STYLE: Record<string, string> = {
  default: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  hot: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  info: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  good: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
}

function slaClasses(slaState: WorkItem["slaState"]): string {
  if (slaState === "late") return "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300"
  if (slaState === "warn") return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
  return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return "Good morning"
  if (h < 17) return "Good afternoon"
  return "Good evening"
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function firstName(name: string): string {
  return name.split(" ")[0] || name
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || json?.message || "Action failed")
  return json
}

/**
 * The real handlers the action modal calls. The modal must do exactly what the
 * row buttons do — same endpoints, same confirmations, same outcomes.
 */
interface TodayModalHandlers {
  runPrimary: (item: WorkItem) => void
  openResults: (item: WorkItem) => void
  openConversation: (item: WorkItem) => void
  callNow: (item: WorkItem) => void
  logCall: (item: WorkItem) => void
  advanceTo: (item: WorkItem, stage: string) => void
  openProfile: (item: WorkItem) => void
  remindClient: (item: WorkItem) => void
  nudge: (item: WorkItem) => void
  reject: (item: WorkItem) => void
  close: () => void
}

/**
 * Category-based action fields — renders different inputs depending on what
 * this case actually needs. This is the "what action needs to take place"
 * part of the modal.
 */
function renderActionFields(item: WorkItem, h: TodayModalHandlers): React.ReactNode {
  const kind = item.kind
  const hasScreening = (item.callAttempts ?? 0) > 0 || item.aiScore != null

  // ── CALL: a screening call happened or needs to happen ──
  if (kind === "call") {
    return (
      <div className="space-y-3">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Call action</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => { h.callNow(item); h.close() }}
            className="w-full py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-left text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-300"
          >
            <PhoneCall className="mr-2 h-4 w-4" /> Place call now
          </button>
          <button
            onClick={() => { h.logCall(item) }}
            className="w-full py-2 rounded-lg border border-zinc-200 bg-white text-left text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <Phone className="mr-2 h-4 w-4" /> Log call outcome
          </button>
        </div>
        {item.callAttempts && item.callAttempts > 0 && (
          <p className="text-xs text-zinc-500">
            {item.callAttempts} attempt{item.callAttempts > 1 ? "s" : ""} used
          </p>
        )}
      </div>
    )
  }

  // ── REPLY: candidate replied on WhatsApp, nobody answered yet ──
  if (kind === "reply") {
    return (
      <div className="space-y-3">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Reply action</p>
        <button
          onClick={() => { h.openConversation(item); h.close() }}
          className="w-full py-2.5 rounded-lg border border-emerald-200 bg-emerald-50 text-left text-sm font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
        >
          <MessageCircle className="mr-2 h-4 w-4" /> Reply on WhatsApp
        </button>
        {item.quote && (
          <p className="text-xs italic text-zinc-500 dark:text-zinc-400 border-l-2 border-zinc-200 pl-2">
            “{item.quote}”
          </p>
        )}
        <p className="text-xs text-zinc-500">
          The candidate replied — answer their message to move them forward.
        </p>
      </div>
    )
  }

  // ── REVIEW / DECIDE: screening completed, human verdict needed ──
  if (item.primaryAction === "review" || item.primaryAction === "decide") {
    return (
      <div className="space-y-3">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Review & decision</p>
        {hasScreening && (
          <button
            onClick={() => { h.openResults(item); h.close() }}
            className="w-full py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-left text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-300"
          >
            <Eye className="mr-2 h-4 w-4" /> Open transcript &amp; summary
          </button>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => { h.advanceTo(item, "shortlist"); h.close() }}
            className="w-full py-2 rounded-lg border border-green-200 bg-green-50 text-left text-sm font-medium text-green-700 hover:bg-green-100 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300"
          >
            <CheckCircle2 className="mr-2 h-4 w-4" /> Approve &amp; shortlist
          </button>
          <button
            onClick={() => { h.reject(item); h.close() }}
            className="w-full py-2 rounded-lg border border-red-200 bg-red-50 text-left text-sm font-medium text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
          >
            <UserX className="mr-2 h-4 w-4" /> Reject
          </button>
        </div>
        {hasScreening ? (
          <p className="text-xs text-zinc-500">
            Review the screening transcript and summary before deciding.
          </p>
        ) : (
          <p className="text-xs text-zinc-500">
            No screening call happened yet — read the candidate&apos;s details above, then approve or reject.
          </p>
        )}
      </div>
    )
  }

  // ── HUMAN: AI flagged — human must decide ──
  if (kind === "human") {
    return (
      <div className="space-y-3">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Human decision</p>
        <p className="text-sm text-zinc-700 dark:text-zinc-200">
          The AI could not screen this candidate — a person needs to review and decide.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => { h.openProfile(item); h.close() }}
            className="w-full py-2 rounded-lg border border-blue-200 bg-blue-50 text-left text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300"
          >
            <Eye className="mr-2 h-4 w-4" /> Review profile
          </button>
          <button
            onClick={() => { h.callNow(item); h.close() }}
            className="w-full py-2 rounded-lg border border-zinc-200 bg-white text-left text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <PhoneCall className="mr-2 h-4 w-4" /> Call now
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => { h.advanceTo(item, "shortlist"); h.close() }}
            className="w-full py-2 rounded-lg border border-green-200 bg-green-50 text-left text-sm font-medium text-green-700 hover:bg-green-100 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300"
          >
            <CheckCircle2 className="mr-2 h-4 w-4" /> Approve &amp; shortlist
          </button>
          <button
            onClick={() => { h.reject(item); h.close() }}
            className="w-full py-2 rounded-lg border border-red-200 bg-red-50 text-left text-sm font-medium text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
          >
            <UserX className="mr-2 h-4 w-4" /> Reject
          </button>
        </div>
      </div>
    )
  }

  // ── DECLINED: candidate said not interested ──
  if (kind === "declined") {
    return (
      <div className="space-y-3">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Declined</p>
        <p className="text-sm text-zinc-700 dark:text-zinc-200">
          The candidate declined — mark as rejected and remove from queue.
        </p>
        <button
          onClick={() => { h.reject(item); h.close() }}
          className="w-full py-2 rounded-lg border border-red-200 bg-red-50 text-left text-sm font-medium text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
        >
          <UserX className="mr-2 h-4 w-4" /> Mark rejected
        </button>
      </div>
    )
  }

  // ── SHORTLIST: ready to send to client ──
  if (kind === "shortlist") {
    return (
      <div className="space-y-3">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Send to client</p>
        <p className="text-sm text-zinc-700 dark:text-zinc-200">
          Screening passed — ready to share this candidate with the client.
        </p>
        <button
          onClick={() => { h.runPrimary(item); h.close() }}
          className="w-full py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-left text-sm font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
        >
          <Send className="mr-2 h-4 w-4" /> Share shortlist with client
        </button>
      </div>
    )
  }

  // ── CLIENT: waiting on client decision ──
  if (kind === "client") {
    return (
      <div className="space-y-3">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Client decision</p>
        <p className="text-sm text-zinc-700 dark:text-zinc-200">
          Already sent to the client — waiting on their response.
        </p>
        <button
          onClick={() => { h.remindClient(item); h.close() }}
          className="w-full py-2 rounded-lg border border-blue-200 bg-blue-50 text-left text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300"
        >
          <Phone className="mr-2 h-4 w-4" /> Remind client
        </button>
      </div>
    )
  }

  // ── GHOSTED: no reply ──
  if (kind === "ghosted") {
    return (
      <div className="space-y-3">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Re-engage</p>
        <p className="text-sm text-zinc-700 dark:text-zinc-200">
          No reply yet — nudge them on WhatsApp or call.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => { h.nudge(item); h.close() }}
            className="w-full py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-left text-sm font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
          >
            <MessageCircle className="mr-2 h-4 w-4" /> Nudge on WhatsApp
          </button>
          <button
            onClick={() => { h.callNow(item); h.close() }}
            className="w-full py-2 rounded-lg border border-zinc-200 bg-white text-left text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <PhoneCall className="mr-2 h-4 w-4" /> Call now
          </button>
        </div>
      </div>
    )
  }

  // Default fallback
  return (
    <div className="space-y-3">
      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Action</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-200">
        Review this candidate and decide next steps.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          onClick={() => { h.openProfile(item); h.close() }}
          className="w-full py-2 rounded-lg border border-blue-200 bg-blue-50 text-left text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300"
        >
          <Eye className="mr-2 h-4 w-4" /> Review profile
        </button>
        <button
          onClick={() => { h.reject(item); h.close() }}
          className="w-full py-2 rounded-lg border border-red-200 bg-red-50 text-left text-sm font-medium text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
        >
          <UserX className="mr-2 h-4 w-4" /> Reject
        </button>
      </div>
    </div>
  )
}

/**
 * WhatsApp info collected — what we already know vs what's still missing.
 */
function renderCollectedInfo(item: WorkItem): React.ReactNode {
  const info = (item.infoData || {}) as Record<string, unknown>
  const keys = Object.keys(info).filter((k) => info[k] !== null && info[k] !== undefined && info[k] !== "")

  if (keys.length === 0) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400 italic">
        No WhatsApp details collected yet — ask for current CTC, expected CTC, notice period, and location.
      </p>
    )
  }

  const LABELS: Record<string, string> = {
    current_ctc: "Current CTC",
    expected_ctc: "Expected CTC",
    notice_period: "Notice period",
    total_experience: "Experience",
    location: "Location",
    current_role: "Current role",
    willing_to_relocate: "Willing to relocate",
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
      {keys.map((k) => (
        <div key={k} className="flex items-start gap-2">
          <span className="text-zinc-500 dark:text-zinc-400 shrink-0">
            {LABELS[k] || k.replace(/_/g, " ")}:
          </span>
          <span className="text-zinc-800 dark:text-zinc-200 font-medium break-words">{String(info[k])}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Primary action button for the modal footer — matches what the case needs.
 */
function renderPrimaryAction(item: WorkItem, h: TodayModalHandlers): React.ReactNode {
  const id = item.primaryAction
  const hasScreening = (item.callAttempts ?? 0) > 0 || item.aiScore != null

  if (id === "call") {
    return (
      <Button onClick={() => { h.callNow(item); h.close() }} className="bg-indigo-600 hover:bg-indigo-700">
        <PhoneCall className="mr-2 h-4 w-4" /> Place call now
      </Button>
    )
  }
  if (id === "reply") {
    return (
      <Button onClick={() => { h.openConversation(item); h.close() }} className="bg-emerald-600 hover:bg-emerald-700">
        <MessageCircle className="mr-2 h-4 w-4" /> Reply on WhatsApp
      </Button>
    )
  }
  if (id === "review" || id === "decide") {
    // Only offer the screening transcript when there IS one. A case that never
    // got a call ("no call placed yet") has nothing to review — sending the
    // recruiter to an empty transcript was the bug being fixed here.
    if (!hasScreening) {
      return (
        <Button onClick={() => { h.openProfile(item); h.close() }} className="bg-blue-600 hover:bg-blue-700">
          <Eye className="mr-2 h-4 w-4" /> Review profile
        </Button>
      )
    }
    return (
      <Button onClick={() => { h.openResults(item); h.close() }} className="bg-indigo-600 hover:bg-indigo-700">
        <Eye className="mr-2 h-4 w-4" /> Review screening
      </Button>
    )
  }
  if (id === "schedule" || id === "resched") {
    return (
      <Button onClick={() => { h.runPrimary(item); h.close() }} className="bg-amber-600 hover:bg-amber-700">
        <CalendarCheck className="mr-2 h-4 w-4" /> Schedule interview
      </Button>
    )
  }
  if (id === "share") {
    return (
      <Button onClick={() => { h.runPrimary(item); h.close() }} className="bg-emerald-600 hover:bg-emerald-700">
        <Send className="mr-2 h-4 w-4" /> Share with client
      </Button>
    )
  }
  if (id === "advance") {
    return (
      <Button onClick={() => { h.runPrimary(item); h.close() }} className="bg-green-600 hover:bg-green-700">
        <ArrowRight className="mr-2 h-4 w-4" /> Move to next stage
      </Button>
    )
  }
  if (id === "reject" || id === "drop") {
    return (
      <Button variant="destructive" onClick={() => { h.reject(item); h.close() }}>
        <UserX className="mr-2 h-4 w-4" /> Reject
      </Button>
    )
  }
  if (id === "nudge") {
    return (
      <Button onClick={() => { h.nudge(item); h.close() }} className="bg-blue-600 hover:bg-blue-700">
        <MessageCircle className="mr-2 h-4 w-4" /> Nudge on WhatsApp
      </Button>
    )
  }
  if (id === "remind") {
    return (
      <Button onClick={() => { h.remindClient(item); h.close() }} className="bg-blue-600 hover:bg-blue-700">
        <Phone className="mr-2 h-4 w-4" /> Remind client
      </Button>
    )
  }
  if (id === "log_call") {
    return (
      <Button onClick={() => { h.logCall(item) }} className="bg-zinc-700 hover:bg-zinc-800">
        <Phone className="mr-2 h-4 w-4" /> Log a call
      </Button>
    )
  }

  // No specific action — offer the candidate's profile so the recruiter has
  // something concrete to look at instead of a dead button.
  return (
    <Button onClick={() => { h.openProfile(item); h.close() }} className="bg-zinc-600 hover:bg-zinc-700">
      <Eye className="mr-2 h-4 w-4" /> Review profile
    </Button>
  )
}

function RowMenu({
  disabled,
  extras,
  onCall,
  onCallback,
  onLogCall,
  onSnooze,
  onDone,
}: {
  disabled?: boolean
  /** Kind-specific leftovers (open chat, call now, review…) shown first. */
  extras?: { label: string; onSelect: () => void }[]
  onCall: (outcome: string, hours: number) => void
  onCallback: () => void
  onLogCall: () => void
  onSnooze: (hours: number) => void
  onDone: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} aria-label="More actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {(extras ?? []).map((e) => (
          <DropdownMenuItem key={e.label} onSelect={e.onSelect}>
            {e.label}
          </DropdownMenuItem>
        ))}
        {extras && extras.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuLabel>I called them</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onCall("no answer", 4)}>No answer · hide 4h</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCall("busy", 2)}>Line busy · hide 2h</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCall("wrong number", 168)}>Wrong number · hide 7 days</DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogCall}>
          <Phone className="mr-2 h-3.5 w-3.5" /> Log a call with a note…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>They asked for a call at</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onCallback}>Set a time…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Not now</DropdownMenuLabel>
        {SNOOZE_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.hours} onSelect={() => onSnooze(o.hours)}>
            {o.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDone}>
          <CheckCircle2 className="mr-2 h-3.5 w-3.5" /> Mark as done
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TodayView({ canViewTeam, defaultScope }: { canViewTeam: boolean; defaultScope: Scope }) {
  const router = useRouter()
  const { toast } = useToast()
  const { can } = useInternalPermissions()
  const canManage = can("applications.manage")

  const [data, setData] = useState<TodayResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>(defaultScope)
  const [kindFilter, setKindFilter] = useState<"all" | WorkItemKind>("all")
  const [subfilter, setSubfilter] = useState<"default" | "newest" | "urgent">("default")
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null)
  const [selectedRole, setSelectedRole] = useState<string | null>(null)
  const [includeSnoozed, setIncludeSnoozed] = useState(false)
  const [includeDone, setIncludeDone] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Set<string>>(new Set())

  // Modals
  const [sheetItem, setSheetItem] = useState<WorkItem | null>(null)
  const [profileItem, setProfileItem] = useState<WorkItem | null>(null)
  const [profileParticipant, setProfileParticipant] = useState<any | null>(null)
  const [profileJob, setProfileJob] = useState<any | null>(null)
  const [convoItem, setConvoItem] = useState<WorkItem | null>(null)
  // One interview form serves both "Call manually → post-call" and "Log a call"
  // — the same questions, the same record. `mode` only controls the extras
  // (post-call offers a WhatsApp nudge; manual log does not).
  const [interview, setInterview] = useState<{ item: WorkItem; mode: "post_call" | "log" } | null>(null)
  const [ivOutcome, setIvOutcome] = useState(CALL_OUTCOMES[0])
  const [ivComm, setIvComm] = useState(COMM_RATINGS[1])
  const [ivFit, setIvFit] = useState(FIT_RATINGS[0])
  const [ivSalary, setIvSalary] = useState(SALARY_CHECKS[3])
  const [ivNotice, setIvNotice] = useState("")
  const [ivDecision, setIvDecision] = useState<(typeof DECISIONS)[number] | "">("")
  const [ivNote, setIvNote] = useState("")
  const [ivNudge, setIvNudge] = useState(true)
  const [callbackItem, setCallbackItem] = useState<WorkItem | null>(null)
  const [callbackAt, setCallbackAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)))
  const [dropOpen, setDropOpen] = useState(false)
  const [dropIds, setDropIds] = useState<string[]>([])

  // Category-based action modal — opens with the right fields for this case's
  // kind (call / reply / review / human / declined / hold / shortlist / client…).
  const [actionModalItem, setActionModalItem] = useState<WorkItem | null>(null)

  const load = useCallback(
    async (opts?: { scope?: Scope; includeSnoozed?: boolean; includeDone?: boolean; quiet?: boolean }) => {
      const nextScope = opts?.scope ?? scope
      const nextSnoozed = opts?.includeSnoozed ?? includeSnoozed
      const nextDone = opts?.includeDone ?? includeDone
      if (opts?.quiet) setRefreshing(true)
      else setLoading(true)
      setError(null)
      try {
        const qs = new URLSearchParams({ scope: nextScope })
        if (nextSnoozed) qs.set("includeSnoozed", "true")
        if (nextDone) qs.set("includeDone", "true")
        if (selectedCompany) qs.set("company", selectedCompany)
        if (selectedRole) qs.set("role", selectedRole)
        const res = await fetch(`/api/dispatch/today?${qs.toString()}`, { credentials: "include", cache: "no-store" })
        const json = await res.json().catch(() => null)
        if (!res.ok) throw new Error((json as any)?.error || "Could not load your queue")
        setData(json as TodayResponse)
        setScope((json as TodayResponse).scope)
        setSelected(new Set())
      } catch (e: any) {
        setError(e?.message || "Something went wrong")
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [scope, includeSnoozed, includeDone, selectedCompany, selectedRole]
  )

  useEffect(() => {
    void load({ scope: defaultScope, includeSnoozed: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, defaultScope, selectedCompany, selectedRole])

  // When the company changes, clear the role selection so the role dropdown
  // re-populates for the new company.
  useEffect(() => {
    setSelectedRole(null)
  }, [selectedCompany])

  const items = useMemo(() => data?.items ?? [], [data])
  const counts = useMemo(() => data?.counts ?? {}, [data])
  const rail = data?.rail

  const filtered = useMemo(() => {
    let list = kindFilter === "all" ? items : items.filter((i) => i.kind === kindFilter)
    // ageHours = time waiting, so the newest items have the SMALLEST age.
    if (subfilter === "newest") {
      list = [...list].sort((a, b) => a.ageHours - b.ageHours || a.key.localeCompare(b.key))
    } else if (subfilter === "urgent") {
      // priority is higher = more urgent (same direction as the engine's default sort).
      list = [...list].sort((a, b) => b.priority - a.priority || b.ageHours - a.ageHours)
    }
    return list
  }, [items, kindFilter, subfilter])

  // Paginate so a 150+ item queue never renders as one endless page.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  useEffect(() => setVisibleCount(PAGE_SIZE), [kindFilter, subfilter, scope, includeSnoozed, includeDone, selectedCompany, selectedRole])
  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])

  const teamHidden = data?.teamHidden ?? 0

  // ── plumbing ────────────────────────────────────────────────────────────
  const withPending = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setPending((p) => new Set(p).add(key))
      try {
        await fn()
      } catch (e: any) {
        toast({ title: "Action failed", description: e?.message || "Something went wrong", variant: "destructive" })
      } finally {
        setPending((p) => {
          const n = new Set(p)
          n.delete(key)
          return n
        })
      }
    },
    [toast]
  )

  const applyWorkItems = useCallback(
    async (applicationIds: string[], body: Record<string, any>) => {
      if (applicationIds.length === 0) return
      if (applicationIds.length === 1) {
        await api(`/api/dispatch/work-items/${applicationIds[0]}`, { method: "PATCH", body: JSON.stringify(body) })
      } else {
        await api(`/api/dispatch/work-items`, { method: "POST", body: JSON.stringify({ ...body, applicationIds }) })
      }
      await load({ quiet: true })
    },
    [load]
  )

  const toggleSelected = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  // Only stages that exist as pipeline columns can be deep-linked; anything else
  // (legacy statuses like hr_review) would land the user on an empty board.
  const KNOWN_STAGES = new Set([
    "applied",
    "ai_screen",
    "shortlist",
    "interview",
    "offer",
    "hired",
    "rejected",
  ])
  const jobLink = (item: WorkItem, stage?: string) =>
    `/jobs/${item.jobId}?tab=pipeline${
      stage && KNOWN_STAGES.has(stage) ? `&stage=${stage}` : ""
    }`

  // ── row actions ─────────────────────────────────────────────────────────
  const openResults = (item: WorkItem) => {
    if (!item.participantId) {
      router.push(jobLink(item, item.stage))
      return
    }
    setSheetItem(item)
  }

  // Open the same candidate profile sidebar used in the jobs pipeline, plus the
  // job opening (title/client/description) fetched lazily for the header card.
  const openProfile = (item: WorkItem) => {
    setProfileItem(item)
    setProfileParticipant(null)
    setProfileJob(null)
    if (item.participantId) {
      api(`/api/phone-screening/participants/${item.participantId}`)
        .then((p) => setProfileParticipant(p || null))
        .catch(() => {})
    }
    if (item.jobId) {
      api(`/api/jobs/${item.jobId}`)
        .then((j) => setProfileJob(j || null))
        .catch(() => {})
    }
  }

  // Open the category-based action modal — the fields shown depend on what this
  // case actually needs (call, reply, review, human follow-up, decline, hold…).
  const openActionModal = (item: WorkItem) => {
    setActionModalItem(item)
  }

  const openConversation = (item: WorkItem) => {
    if (!item.participantId) {
      router.push(jobLink(item, item.stage))
      return
    }
    setConvoItem(item)
  }

  const callNow = (item: WorkItem) =>
    withPending(`call:${item.key}`, async () => {
      if (!item.participantId) throw new Error("No screening participant on this application")
      const res = await api(`/api/phone-screening/call-now`, {
        method: "POST",
        body: JSON.stringify({ participantId: item.participantId }),
      })
      if (res?.callPlaced === false) {
        toast({
          title: "Call not placed",
          description: res?.error || res?.reason || "The provider did not accept the call.",
          variant: "destructive",
        })
      } else {
        toast({ title: "Calling now", description: `Placing a call to ${item.candidateName}.` })
        // Offer the interview form right after — outcome, answers, decision.
        openInterview(item, "post_call")
      }
      await load({ quiet: true })
    })

  // ── interview form ──────────────────────────────────────────────────────
  const openInterview = (item: WorkItem, mode: "post_call" | "log") => {
    setIvOutcome(CALL_OUTCOMES[0])
    setIvComm(COMM_RATINGS[1])
    setIvFit(FIT_RATINGS[0])
    setIvSalary(SALARY_CHECKS[3])
    setIvNotice("")
    setIvDecision("")
    setIvNote("")
    setIvNudge(true)
    setInterview({ item, mode })
  }

  /**
   * Save the interview form: always log the call with the structured answers,
   * then act on the decision — Advance moves a stage, Reject drops the
   * application. Nothing here leaves the row as a bare "done".
   */
  const saveInterview = () => {
    if (!interview) return
    const { item, mode } = interview
    return withPending(`iv:${item.key}`, async () => {
      const connected = ivOutcome === "connected"
      const noteParts: string[] = []
      if (connected) {
        noteParts.push(`Communication: ${ivComm}`, `Experience fit: ${ivFit}`, `Salary: ${ivSalary}`)
        if (ivNotice.trim()) noteParts.push(`Notice: ${ivNotice.trim()}`)
        if (ivDecision) noteParts.push(`Decision: ${ivDecision}`)
      }
      if (ivNote.trim()) noteParts.push(ivNote.trim())
      const note = noteParts.join(" · ").slice(0, 1000)
      await applyWorkItems([item.applicationId], { action: "log_call", outcome: ivOutcome, note })

      if (connected && ivDecision === "Advance") {
        const to = nextStageFor(item.stage)
        await api(`/api/applications/${item.applicationId}`, {
          method: "PUT",
          body: JSON.stringify({ status: to, origin: "today" }),
        })
        toast({ title: `Moved to ${stageLabel(to)}`, description: `${item.candidateName} advanced after the call.` })
      } else if (connected && ivDecision === "Reject") {
        await api(`/api/applications/${item.applicationId}`, {
          method: "PUT",
          body: JSON.stringify({ status: "rejected", notes: "Rejected from the Today interview form", origin: "today" }),
        })
        toast({ title: "Rejected", description: `${item.candidateName} is out of the pipeline.` })
      } else {
        toast({ title: "Call logged", description: item.candidateName })
      }

      if (mode === "post_call" && ivNudge && item.participantId) {
        try {
          await nudgeOne(item)
          toast({ title: "Nudge sent", description: `WhatsApp message sent to ${item.candidateName}.` })
        } catch {
          toast({
            title: "Nudge failed",
            description: "The call was logged but the WhatsApp nudge did not go out.",
            variant: "destructive",
          })
        }
      }
      setInterview(null)
      await load({ quiet: true })
    })
  }

  /** Move the candidate one pipeline step forward (the "not done, advance" action). */
  const advanceStage = (item: WorkItem, target?: string) =>
    withPending(`advance:${item.key}`, async () => {
      const to = target || nextStageFor(item.stage)
      await api(`/api/applications/${item.applicationId}`, {
        method: "PUT",
        body: JSON.stringify({ status: to, origin: "today" }),
      })
      toast({
        title: `Moved to ${stageLabel(to)}`,
        description: `${item.candidateName} is one step ahead in ${item.jobTitle}.`,
      })
      await load({ quiet: true })
    })

  const nudgeText = (item: WorkItem) =>
    `Hi ${firstName(item.candidateName)}, following up on your application for ${item.jobTitle}. Do you have a few minutes to chat?`

  const nudgeOne = async (item: WorkItem) => {
    if (!item.participantId) throw new Error("No WhatsApp participant")
    await api(`/api/phone-screening/participants/${item.participantId}/send-message`, {
      method: "POST",
      body: JSON.stringify({ text: nudgeText(item) }),
    })
  }

  const remindClient = (item: WorkItem) =>
    withPending(`remind:${item.key}`, async () => {
      if (!item.shareId) {
        router.push(jobLink(item, "client_review"))
        return
      }
      await api(`/api/jobs/${item.jobId}/shortlist-share`, {
        method: "POST",
        body: JSON.stringify({ resendShareId: item.shareId }),
      })
      toast({ title: "Reminder sent", description: `The client has been nudged about ${item.jobTitle}.` })
      await load({ quiet: true })
    })

  const runPrimary = (item: WorkItem) => {
    switch (item.primaryAction) {
      case "nudge":
        return withPending(`nudge:${item.key}`, async () => {
          await nudgeOne(item)
          toast({ title: "Nudge sent", description: `WhatsApp message sent to ${item.candidateName}.` })
          await load({ quiet: true })
        })
      case "reply":
        return openConversation(item)
      case "review":
      case "decide":
        return openResults(item)
      case "call":
        return callNow(item)
      case "remind":
        return remindClient(item)
      case "schedule":
      case "resched":
        return router.push(jobLink(item, "interview"))
      case "share":
        return router.push(jobLink(item, "shortlist"))
      case "offer":
        return router.push(jobLink(item, "offer"))
      default:
        return router.push(jobLink(item, item.stage))
    }
  }

  /** Dispatch any engine action by id (used by the ⋯ menu leftovers). */
  const runActionById = (item: WorkItem, id: string): void | Promise<void> => {
    switch (id) {
      case item.primaryAction:
        return runPrimary(item)
      case "call":
        return callNow(item)
      case "reply":
        return openConversation(item)
      case "review":
      case "decide":
        return openResults(item)
      case "advance":
        return advanceStage(item)
      case "reject":
        setDropIds([item.applicationId])
        return setDropOpen(true)
      case "done":
        return markDone([item])
      default:
        return runPrimary(item)
    }
  }

  const logCallOutcome = (item: WorkItem, outcome: string, note: string, hours?: number) =>
    withPending(`log:${item.key}`, async () => {
      await applyWorkItems([item.applicationId], { action: "log_call", outcome, note, hours })
      toast({
        title: "Call logged",
        description: hours ? `${item.candidateName} · hidden for ${hours >= 24 ? `${hours / 24}d` : `${hours}h`}.` : item.candidateName,
      })
    })

  const snoozeOne = (item: WorkItem, hours: number) =>
    withPending(`snooze:${item.key}`, async () => {
      await applyWorkItems([item.applicationId], { action: "snooze", hours })
    })

  const setCallback = (item: WorkItem, untilLocal: string) =>
    withPending(`callback:${item.key}`, async () => {
      const when = new Date(untilLocal)
      if (!Number.isFinite(when.getTime())) throw new Error("Pick a valid time")
      await applyWorkItems([item.applicationId], {
        action: "snooze",
        until: when.toISOString(),
        reason: "Callback requested",
      })
      toast({ title: "Callback scheduled", description: `${item.candidateName} · ${when.toLocaleString()}` })
    })

  const dropApplications = (applicationIds: string[], key: string) =>
    withPending(key, async () => {
      await Promise.allSettled(
        applicationIds.map((id) =>
          api(`/api/applications/${id}`, {
            method: "PUT",
            body: JSON.stringify({ status: "rejected", notes: "Dropped from the Today queue" }),
          })
        )
      )
      toast({ title: "Dropped", description: `${applicationIds.length} application(s) rejected.` })
      await load({ quiet: true })
    })

  // ── done / undo ─────────────────────────────────────────────────────────
  // "Done" takes a row off the board without touching the pipeline. It returns
  // by itself the moment the item changes again (a reply, a new decision), so it
  // is safe to clear the things you have handled — and undoable for the ones you
  // clicked by mistake.
  const markDone = (rows: WorkItem[]) =>
    withPending(rows.length === 1 ? `done:${rows[0].key}` : "bulk:done", async () => {
      const ids = rows.map((r) => r.applicationId)
      if (ids.length === 1) {
        await api(`/api/dispatch/work-items/${ids[0]}`, { method: "PATCH", body: JSON.stringify({ action: "done" }) })
      } else {
        await api(`/api/dispatch/work-items`, { method: "POST", body: JSON.stringify({ action: "done", applicationIds: ids }) })
      }
      toast({
        title: ids.length === 1 ? "Marked done" : `${ids.length} marked done`,
        description:
          ids.length === 1
            ? `${rows[0].candidateName} is off your board — it comes back if anything changes.`
            : "They are off your board — they come back if anything changes.",
        action: (
          <ToastAction altText="Undo" onClick={() => void undoDone(ids)}>
            Undo
          </ToastAction>
        ),
      })
      await load({ quiet: true })
    })

  const undoDone = (ids: string[]) =>
    withPending(ids.length === 1 ? `undo:${ids[0]}` : "bulk:undo", async () => {
      if (ids.length === 1) {
        await api(`/api/dispatch/work-items/${ids[0]}`, { method: "PATCH", body: JSON.stringify({ action: "undone" }) })
      } else {
        await api(`/api/dispatch/work-items`, { method: "POST", body: JSON.stringify({ action: "undone", applicationIds: ids }) })
      }
      await load({ quiet: true })
    })

  // ── bulk actions ────────────────────────────────────────────────────────
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.applicationId)), [items, selected])

  const bulkNudge = () =>
    withPending("bulk:nudge", async () => {
      const targets = selectedItems.filter((i) => i.participantId)
      if (targets.length === 0) throw new Error("None of the selected rows have a WhatsApp thread")
      const results = await Promise.allSettled(targets.map((i) => nudgeOne(i)))
      const ok = results.filter((r) => r.status === "fulfilled").length
      toast({
        title: `Nudged ${ok} of ${targets.length}`,
        variant: ok === 0 ? "destructive" : undefined,
      })
      await load({ quiet: true })
    })

  /**
   * Handlers the category-based action modal calls. Every button in the modal
   * must do exactly what the equivalent row button does — same endpoint, same
   * confirmation, same outcome — otherwise the modal is a dead-end and the
   * recruiter falls back to guessing.
   */
  const modalHandlers = useMemo<TodayModalHandlers>(
    () => ({
      runPrimary: (item) => {
        void runPrimary(item)
      },
      openResults: (item) => openResults(item),
      openConversation: (item) => openConversation(item),
      callNow: (item) => {
        void callNow(item)
      },
      logCall: (item) => {
        setActionModalItem(null)
        openInterview(item, "log")
      },
      advanceTo: (item, stage) => {
        void advanceStage(item, stage)
      },
      openProfile: (item) => openProfile(item),
      remindClient: (item) => {
        void remindClient(item)
      },
      nudge: (item) => {
        void withPending(`nudge:${item.key}`, async () => {
          await nudgeOne(item)
          toast({ title: "Nudge sent", description: `WhatsApp message sent to ${item.candidateName}.` })
          await load({ quiet: true })
        })
      },
      reject: (item) => {
        setDropIds([item.applicationId])
        setDropOpen(true)
      },
      close: () => setActionModalItem(null),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load, toast]
  )

  const stats = data?.stats
  const viewerName = data?.viewer?.name || (data?.viewer?.email ? data.viewer.email.split("@")[0] : "")

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {greeting()}
            {viewerName ? `, ${viewerName}` : ""}
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {stats?.waiting
              ? `${stats.waiting} item${stats.waiting === 1 ? "" : "s"} need you across ${stats.open_jobs} open job${stats.open_jobs === 1 ? "" : "s"}.`
              : "Nothing is waiting on you right now."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canViewTeam && (
            <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
              {(["mine", "team"] as Scope[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => load({ scope: s })}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    scope === s
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                      : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                >
                  {s === "mine" ? "My accounts" : "Team"}
                </button>
              ))}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => load({ scope, includeSnoozed, includeDone, quiet: true })} disabled={loading || refreshing}>
            {loading || refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Queue */}
        <div className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Candidates waiting on you</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Every candidate the pipeline says needs a human decision, most urgent first.
              </p>
            </div>
            <div className="flex items-center gap-3">
            </div>
          </div>

          {/* Company / role cascading filter */}
          <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-5 py-3 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/40">
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Filter by</span>
            <div className="flex items-center gap-2 min-w-[200px]">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300 shrink-0">Company</label>
              <select
                value={selectedCompany || ""}
                onChange={(e) => setSelectedCompany(e.target.value || null)}
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 focus:ring-2 focus:ring-blue-500 outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                <option value="">All companies</option>
                {data?.companies?.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.count})
                  </option>
                ))}
              </select>
            </div>
            {selectedCompany && (
              <div className="flex items-center gap-2 min-w-[220px]">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-300 shrink-0">Role</label>
                <select
                  value={selectedRole || ""}
                  onChange={(e) => setSelectedRole(e.target.value || null)}
                  className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 focus:ring-2 focus:ring-blue-500 outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                >
                  <option value="">All roles in {selectedCompany}</option>
                  {data?.roles?.map((r) => (
                    <option key={r.title} value={r.title}>
                      {r.title} ({r.count})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => { setSelectedRole(null); setSelectedCompany(null) }}
                  className="rounded-md p-1 text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
                  title="Clear filters"
                >
                  <span className="sr-only">Clear filters</span>
                  <span className="text-[10px]">×</span>
                </button>
              </div>
            )}
            {!selectedCompany && (
              <span className="text-xs text-zinc-400 dark:text-zinc-500 italic">
                {data?.companies?.length ?? 0} company{data?.companies?.length === 1 ? "" : "s"} with waiting items
              </span>
            )}
          </div>

          {/* Filter chips */}
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
            <Chip active={kindFilter === "all"} onClick={() => setKindFilter("all")} label="All" count={items.length} />
            {/* Every kind renders even at zero — a tab that only appears when
                something is waiting looks like a broken filter otherwise. */}
            {WORK_ITEM_KINDS.map((k) => (
              <Chip
                key={k}
                active={kindFilter === k}
                onClick={() => setKindFilter(k)}
                label={kindLabel(k)}
                count={counts[k] || 0}
              />
            ))}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                aria-pressed={subfilter === "default"}
                onClick={() => setSubfilter("default")}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${subfilter === "default" ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300" : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
              >
                Default
              </button>
              <button
                type="button"
                aria-pressed={subfilter === "newest"}
                onClick={() => setSubfilter("newest")}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${subfilter === "newest" ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300" : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
              >
                Newest
              </button>
              <button
                type="button"
                aria-pressed={subfilter === "urgent"}
                onClick={() => setSubfilter("urgent")}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${subfilter === "urgent" ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300" : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
              >
                Urgent
              </button>
            </div>
            {selected.size > 0 && filtered.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const allOnFilter = filtered.filter((i) => i.selectable).map((i) => i.applicationId)
                  if (allOnFilter.length === selected.size) {
                    setSelected(new Set())
                    return
                  }
                  setSelected(new Set([...Array.from(selected), ...allOnFilter]))
                }}
                className="text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                Select all on this filter
              </button>
            )}
          </div>

          {/* Scope hint: on "My accounts", explain work that exists on other
              recruiters' desks — this is why a Reply/Declined tab can look
              empty while the work is really one click away in Team scope. */}
          {scope === "mine" && teamHidden > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 bg-amber-50/60 px-5 py-2 text-xs text-amber-800 dark:border-zinc-800 dark:bg-amber-950/20 dark:text-amber-300">
              <Users className="h-3.5 w-3.5 shrink-0" />
              <span>
                {teamHidden} more item{teamHidden === 1 ? " is" : "s are"} waiting on other recruiters&apos; desks.
              </span>
              <button
                type="button"
                onClick={() => load({ scope: "team" })}
                className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
              >
                Switch to Team view →
              </button>
            </div>
          )}

          {/* Bulk bar */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 bg-blue-50/60 px-5 py-2.5 dark:border-zinc-800 dark:bg-blue-950/20">
              <span className="text-xs font-medium text-blue-800 dark:text-blue-300">{selected.size} selected</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending.has("bulk:nudge")}
                  onClick={bulkNudge}
                >
                  <MessageCircle className="mr-1.5 h-3.5 w-3.5" /> Nudge on WhatsApp
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending.has("bulk:snooze")}
                  onClick={() =>
                    withPending("bulk:snooze", () =>
                      applyWorkItems(Array.from(selected), { action: "snooze", hours: 24 })
                    )
                  }
                >
                  Snooze 1 day
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending.has("bulk:done")}
                  onClick={() => markDone(selectedItems)}
                >
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Mark done
                </Button>
                {canManage && (
                  <DropConfirm
                    count={selected.size}
                    disabled={pending.has("bulk:drop")}
                    onConfirm={() => dropApplications(Array.from(selected), "bulk:drop")}
                  />
                )}
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            </div>
          )}

          {/* Rows */}
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {loading && !data ? (
              <div className="flex items-center justify-center gap-2 px-5 py-16 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading your queue…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-5 py-16 text-center">
                <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-500" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                  {kindFilter === "all" ? "Nothing waiting here." : "Nothing in this filter."}
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Calls, replies and client decisions land in this list when they need you.
                </p>
              </div>
            ) : (
              visible.map((item) => {
                const Icon = KIND_ICON[item.kind]
                const grouped = (item.groupCount ?? 0) > 1
                const busy =
                  pending.has(`call:${item.key}`) ||
                  pending.has(`nudge:${item.key}`) ||
                  pending.has(`remind:${item.key}`) ||
                  pending.has(`log:${item.key}`) ||
                  pending.has(`iv:${item.key}`) ||
                  pending.has(`advance:${item.key}`) ||
                  pending.has(`snooze:${item.key}`) ||
                  pending.has(`callback:${item.key}`) ||
                  pending.has(`done:${item.key}`) ||
                  pending.has(`undo:${item.applicationId}`)
                const secondary = item.actions
                  .filter((a) => a.id === "advance" || a.id === "reject")
                  .filter(() => canManage)
                const menuExtras = item.actions
                  .filter(
                    (a) =>
                      a.id !== item.primaryAction &&
                      a.id !== "advance" &&
                      a.id !== "reject" &&
                      a.id !== "log_call" &&
                      a.id !== "snooze" &&
                      a.id !== "done"
                  )
                  .map((a) => ({ label: a.label, onSelect: () => runActionById(item, a.id) }))
                return (
                  <div
                    key={item.key}
                    className="flex items-start gap-4 px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30 transition-colors"
                  >
                    {item.selectable ? (
                      <div className="pt-1">
                        <Checkbox
                          checked={selected.has(item.applicationId)}
                          onCheckedChange={(v) => toggleSelected(item.applicationId, v === true)}
                        />
                      </div>
                    ) : (
                      <div className="w-4 pt-1" />
                    )}

                    {/* Kind icon */}
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${KIND_STYLE[item.kind]}`}
                      title={item.kindLabel}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>

                    {/* Left column: who + what stage + why they are here */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span
                          className={`text-sm font-semibold text-zinc-900 dark:text-zinc-50 truncate`}
                          title={item.candidateName}
                        >
                          {item.candidateName}
                        </span>
                        <button
                          type="button"
                          onClick={() => openActionModal(item)}
                          className="shrink-0 p-1 text-zinc-400 hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-400"
                          title="View details & take action"
                          aria-label="View details & take action"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${KIND_STYLE[item.kind]}`}
                        >
                          {item.kindLabel}
                        </span>
                        {item.stage && (
                          <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                            {item.stage.replace(/_/g, " ")}
                          </span>
                        )}
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${slaClasses(item.slaState)}`}>
                          <AlarmClock className="mr-1 inline h-3 w-3 align-[-2px]" />
                          Waiting {formatAge(item.ageHours)}
                        </span>
                        {item.snoozed && (
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            Snoozed
                          </span>
                        )}
                      </div>

                      {/* Company / opening line */}
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                        {item.clientName || ""}{item.jobTitle ? ` · ${item.jobTitle}` : ""}
                      </p>

                      {/* Why this case needs attention — the single most important line */}
                      {item.detail && (
                        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-200 font-medium">
                          {item.detail}
                        </p>
                      )}
                      {item.quote && (
                        <p className="mt-1 text-xs italic text-zinc-500 dark:text-zinc-400 border-l-2 border-zinc-200 pl-2">
                          “{item.quote}”
                        </p>
                      )}
                    </div>

                    {/* Right column: actions — everything on the row, nothing hidden */}
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => runPrimary(item)}
                        disabled={busy}
                        className="font-medium text-zinc-900 dark:text-zinc-100"
                        title={item.detail || item.cta}
                      >
                        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        {item.cta}
                      </Button>
                      {secondary.map((a) => (
                        <Button
                          key={a.id}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          className={a.variant === "danger" ? "text-red-600 hover:text-red-700 dark:text-red-400" : undefined}
                          title={
                            a.id === "advance"
                              ? `Move the candidate to the next stage (${stageLabel(nextStageFor(item.stage))})`
                              : "Reject this application and remove it from the queue"
                          }
                          onClick={() => runActionById(item, a.id)}
                        >
                          {a.id === "advance" ? `Move to ${stageLabel(nextStageFor(item.stage))}` : a.label}
                        </Button>
                      ))}
                      {!grouped && (
                        <RowMenu
                          disabled={busy}
                          extras={menuExtras}
                          onCall={(outcome, hours) =>
                            logCallOutcome(item, outcome, `Logged from Today queue: ${outcome}`, hours)
                          }
                          onCallback={() => {
                            setCallbackItem(item)
                            setCallbackAt(toLocalInput(new Date(Date.now() + 60 * 60 * 1000)))
                          }}
                          onLogCall={() => openInterview(item, "log")}
                          onSnooze={(hours) => snoozeOne(item, hours)}
                          onDone={() => markDone([item])}
                        />
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {filtered.length > visible.length && (
            <div className="border-t border-zinc-100 px-5 py-3 text-center dark:border-zinc-800">
              <Button variant="outline" size="sm" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
                Load more ({visible.length} of {filtered.length} shown)
              </Button>
            </div>
          )}

          {(stats?.with_client ?? 0) > 0 && (
            <div className="border-t border-zinc-100 px-5 py-3 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              {stats!.with_client} candidate{stats!.with_client === 1 ? " is" : "s are"} with clients. Nothing to do until they decide.
            </div>
          )}
        </div>

        {/* Right rail */}
        <aside className="space-y-4">
          <RailCard title="Interviews this week" empty="No interviews booked in the next 7 days.">
            {(rail?.interviews ?? []).map((iv) => (
              <button
                key={iv.applicationId}
                type="button"
                onClick={() => router.push(`/jobs/${iv.jobId}?tab=pipeline&stage=interview`)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
              >
                <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">
                    {iv.candidateName}
                  </span>
                  <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {iv.scheduledAt ? new Date(iv.scheduledAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "Time TBC"}
                    {" · "}
                    {iv.jobTitle}
                  </span>
                </span>
              </button>
            ))}
          </RailCard>

          <RailCard title="Ready to send to the client" empty="Nothing waiting to go to a client.">
            {(rail?.ready ?? []).map((r) => (
              <div key={r.jobId} className="flex items-center justify-between gap-2 px-2 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">{r.jobTitle}</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                    {r.count} candidate{r.count === 1 ? "" : "s"}
                    {r.clientName ? ` · ${r.clientName}` : ""}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push(`/jobs/${r.jobId}?tab=pipeline&stage=shortlist`)}
                >
                  Send
                </Button>
              </div>
            ))}
          </RailCard>

          <RailCard title="On the line" empty="No calls in progress.">
            {(rail?.live_calls ?? []).map((c) => (
              <div key={c.applicationId} className="flex items-start gap-2 px-2 py-2">
                <PhoneCall className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">{c.candidateName}</span>
                  <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {c.callLabel} · {c.jobTitle}
                  </span>
                </span>
              </div>
            ))}
          </RailCard>
        </aside>
      </div>

      {/* Screening results / questions sheet */}
      <PhoneScreeningResultsSheet
        participantId={sheetItem?.participantId ?? null}
        open={!!sheetItem}
        onOpenChange={(open) => !open && setSheetItem(null)}
        onReviewed={() => load({ quiet: true })}
        stageLabel={sheetItem?.stage ?? null}
      />

      {/* Candidate profile sidebar (same view as the jobs pipeline) + job opening */}
      {profileItem && (
        <CandidateProfileSidebar
          candidate={{ id: profileItem.candidateId, name: profileItem.candidateName }}
          application={
            profileItem.applicationId
              ? {
                  id: profileItem.applicationId,
                  candidate_id: profileItem.candidateId,
                  status: profileItem.stage ?? "",
                  notes: "",
                }
              : null
          }
          isOpen={!!profileItem}
          onClose={() => {
            setProfileItem(null)
            setProfileParticipant(null)
            setProfileJob(null)
          }}
          jobId={profileItem.jobId ?? undefined}
          aiInfo={
            profileItem.aiScore != null || profileItem.aiRecommendation
              ? { score: profileItem.aiScore ?? undefined, recommendation: profileItem.aiRecommendation ?? undefined }
              : undefined
          }
          participant={profileParticipant}
          stageLabel={profileItem.stage ?? null}
          jobOpening={
            profileItem.jobTitle || profileItem.clientName || profileJob?.description
              ? {
                  title: profileItem.jobTitle,
                  clientName: profileItem.clientName,
                  description: profileJob?.description ?? null,
                }
              : null
          }
        />
      )}

      {/* WhatsApp conversation */}
      <WhatsAppConversationModal
        history={[]}
        candidateName={convoItem?.candidateName ?? null}
        participantId={convoItem?.participantId ?? null}
        roleLabel={convoItem?.jobTitle ?? null}
        open={!!convoItem}
        onOpenChange={(open) => !open && setConvoItem(null)}
        onSent={() => load({ quiet: true })}
      />

      {/* Category-based action modal — shows the right fields for what this case needs */}
      {actionModalItem && (
        <Dialog open={!!actionModalItem} onOpenChange={(open) => !open && setActionModalItem(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <div>
                  {(() => {
                    const Icon = KIND_ICON[actionModalItem!.kind]
                    const cls = KIND_STYLE[actionModalItem!.kind]
                    return (
                      <>
                        <span className={`h-7 w-7 rounded-full flex items-center justify-center ${cls}`}>
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <div>
                          <span className="text-base font-semibold leading-none">{actionModalItem.candidateName}</span>
                          <p className="text-xs text-zinc-500">
                            {actionModalItem.jobTitle} · {actionModalItem.clientName}
                          </p>
                        </div>
                      </>
                    )
                  })()}
                </div>
              </DialogTitle>
            </DialogHeader>

            <div className="grid grid-cols-1 gap-4 py-3">
              {/* What this case is / why it needs attention */}
              <div className="p-3 rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
                <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">What this case needs</p>
                <p className="text-sm text-zinc-800 dark:text-zinc-100">{actionModalItem.detail}</p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Stage: {actionModalItem.stage.replace(/_/g, " ")} ·
                  Waiting {formatAge(actionModalItem.ageHours)}
                  {/* "Attempt 0" reads like a mistake — only show it once a call
                      has actually been placed. */}
                  {(actionModalItem.callAttempts ?? 0) > 0 && ` · Attempt ${actionModalItem.callAttempts}`}
                  {actionModalItem.aiScore != null && ` · AI score ${actionModalItem.aiScore}/10`}
                </p>
              </div>

              {/* Category-specific fields */}
              {renderActionFields(actionModalItem, modalHandlers)}

              {/* WhatsApp data collected — what we already know vs what's missing */}
              {actionModalItem.participantId && (
                <div className="p-3 rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">WhatsApp info collected</p>
                  {renderCollectedInfo(actionModalItem)}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setActionModalItem(null)}>Close</Button>
              {renderPrimaryAction(actionModalItem, modalHandlers)}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Interview feedback form — shown after a placed call or from "Log a call".
          Captures the outcome, the questions a human asks on the call, and a real
          decision (advance / hold / reject), so no row ends as a bare "done". */}
      <Dialog open={!!interview} onOpenChange={(open) => !open && setInterview(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{interview?.mode === "post_call" ? "Call placed — how did it go?" : "Log an interview call"}</DialogTitle>
            <DialogDescription>
              {interview ? `${interview.item.candidateName} · ${interview.item.jobTitle}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Call outcome</label>
              <select
                value={ivOutcome}
                onChange={(e) => setIvOutcome(e.target.value)}
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {CALL_OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>

            {ivOutcome === "connected" && (
              <>
                <p className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                  Ask these while you talk — the answers are saved to the candidate&apos;s timeline.
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      How is their communication?
                    </label>
                    <select
                      value={ivComm}
                      onChange={(e) => setIvComm(e.target.value)}
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    >
                      {COMM_RATINGS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      Experience fit for this role?
                    </label>
                    <select
                      value={ivFit}
                      onChange={(e) => setIvFit(e.target.value)}
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    >
                      {FIT_RATINGS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      Salary vs the job&apos;s band?
                    </label>
                    <select
                      value={ivSalary}
                      onChange={(e) => setIvSalary(e.target.value)}
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    >
                      {SALARY_CHECKS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      Notice period / availability
                    </label>
                    <input
                      value={ivNotice}
                      onChange={(e) => setIvNotice(e.target.value)}
                      placeholder="e.g. 30 days, immediate"
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    Your decision <span className="text-red-500">*</span>
                  </label>
                  <div className="flex gap-2">
                    {DECISIONS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={ivDecision === d}
                        onClick={() => setIvDecision(d)}
                        className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                          ivDecision === d
                            ? d === "Advance"
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                              : d === "Reject"
                                ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                                : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                            : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        }`}
                      >
                        {d === "Advance" ? `Advance to ${stageLabel(nextStageFor(interview?.item.stage ?? ""))}` : d}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    {ivDecision === "Advance"
                      ? `Saves the call and moves ${interview?.item.candidateName} to ${stageLabel(nextStageFor(interview?.item.stage ?? ""))}.`
                      : ivDecision === "Reject"
                        ? "Saves the call and rejects this application."
                        : ivDecision === "Hold"
                          ? "Saves the call and hides the row for a day — it comes back tomorrow."
                          : "Pick one — a call without a decision stays on the board."}
                  </p>
                </div>
              </>
            )}

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Notes (optional)</label>
              <Textarea value={ivNote} onChange={(e) => setIvNote(e.target.value)} rows={3} placeholder="What was said…" />
            </div>

            {interview?.mode === "post_call" && (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                <Checkbox checked={ivNudge} onCheckedChange={(v) => setIvNudge(v === true)} />
                Also send a WhatsApp nudge with the details after the call
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInterview(null)}>
              Cancel
            </Button>
            <Button
              disabled={!!interview && pending.has(`iv:${interview.item.key}`)}
              onClick={() => void saveInterview()}
            >
              {ivDecision === "Advance" ? "Save & advance" : ivDecision === "Reject" ? "Save & reject" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject confirmation — a rejection is a decision, so it always asks first */}
      <Dialog
        open={dropOpen && dropIds.length > 0}
        onOpenChange={(open) => {
          if (!open) {
            setDropOpen(false)
            setDropIds([])
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {dropIds.length === 1 ? "this candidate" : `${dropIds.length} candidates`}?</DialogTitle>
            <DialogDescription>
              This marks the application as rejected and takes it out of the pipeline. It cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDropOpen(false)
                setDropIds([])
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={dropIds.length > 0 && pending.has("bulk:drop")}
              onClick={() => {
                const ids = dropIds
                setDropOpen(false)
                setDropIds([])
                void dropApplications(ids, ids.length === 1 ? `reject:${ids[0]}` : "bulk:drop")
              }}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Callback time dialog */}
      <Dialog open={!!callbackItem} onOpenChange={(open) => !open && setCallbackItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>They asked for a call at</DialogTitle>
            <DialogDescription>
              {callbackItem ? `${callbackItem.candidateName} · ${callbackItem.jobTitle}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Date &amp; time</label>
            <input
              type="datetime-local"
              value={callbackAt}
              onChange={(e) => setCallbackAt(e.target.value)}
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              The row is hidden until then, so it resurfaces exactly when they asked to be called.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCallbackItem(null)}>
              Cancel
            </Button>
            <Button
              disabled={!!callbackItem && pending.has(`callback:${callbackItem.key}`)}
              onClick={async () => {
                if (!callbackItem) return
                await setCallback(callbackItem, callbackAt)
                setCallbackItem(null)
              }}
            >
              Set
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: number
  accent?: boolean
}) {
  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${
        accent
          ? "border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        <span className={accent ? "text-blue-600 dark:text-blue-300" : ""}>{icon}</span>
        {label}
      </div>
      <div className={`mt-2 text-2xl font-semibold ${accent ? "text-blue-700 dark:text-blue-200" : "text-zinc-900 dark:text-zinc-50"}`}>
        {value}
      </div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
}) {
  // Every kind always renders, even at zero — a tab that disappears looks
  // like a broken filter. Zero-count chips are dimmed but still clickable.
  const empty = count === 0 && !active
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
          : empty
            ? "border-zinc-200 bg-white text-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600"
            : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }`}
    >
      {label}
      <span className="ml-1.5 text-[11px] text-zinc-400">{count}</span>
    </button>
  )
}

function RailCard({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: React.ReactNode
}) {
  const arr = Array.isArray(children) ? children.flat() : children
  const isEmpty = !arr || (Array.isArray(arr) && arr.length === 0)
  return (
    <div className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</h3>
      </div>
      <div className="p-2">
        {isEmpty ? (
          <p className="px-2 py-3 text-xs text-zinc-400 dark:text-zinc-500">{empty}</p>
        ) : (
          arr
        )}
      </div>
    </div>
  )
}

function DropConfirm({
  count,
  disabled,
  onConfirm,
}: {
  count: number
  disabled?: boolean
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="text-red-600 hover:text-red-700 dark:text-red-400"
        disabled={disabled || count === 0}
        onClick={() => setOpen(true)}
      >
        Drop
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Drop {count} application{count === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>This will mark them as rejected and remove them from the queue.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
            >
              Confirm drop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
