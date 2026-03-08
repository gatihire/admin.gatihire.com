"use client"

import { useMemo, useState, useEffect } from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { Input } from "@/components/ui/input"
import { Loader2, ArrowLeft, Calendar, ExternalLink, Eye, Link2, Mail, MessageSquare, RotateCw, Save, User, Pencil, Plus, Sparkles, Send, MessageCircle, CheckCircle, XCircle, Clock, ExternalLinkIcon } from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Label } from "@/components/ui/label"
import { cachedFetchJson, getBoardAppBaseUrl, getBoardJobApplyUrl, invalidateSessionCache, normalizeExternalUrl } from "@/lib/utils"

const CandidatePreviewDialogDynamic = dynamic(() => import("./candidate-preview-dialog").then(m => m.CandidatePreviewDialog), {
  ssr: false,
})

interface Job {
  id: string
  title: string
  location: string
  status: string
  description: string
  created_at: string
  client_id?: string | null
  client_name?: string | null
  industry?: string | null
  employment_type?: string | null
  is_external_link?: boolean | null
  source?: string | null
}

type Client = {
  id: string
  name: string
  slug: string
  website: string
  company_type: string | null
  location: string | null
  about: string | null
  logo_url: string | null
  primary_contact_name: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
}

interface Application {
  id: string
  candidate_id: string
  status: string
  applied_at: string
  notes: string
  source?: string
  match_score?: number
  candidates: {
    name: string
    email: string
    current_role: string
    location: string
    // Add other candidate fields as needed for preview
    [key: string]: any
  }
}

interface JobInvite {
  id: string
  candidate_id?: string | null
  email: string
  token: string
  status: string
  sent_at: string | null
  opened_at: string | null
  responded_at: string | null
  applied_at: string | null
  rejected_at: string | null
  created_at: string | null
}

type InterviewRound = {
  id: string
  job_id: string
  name: string
  sort_order: number
}

type InterviewEntry = {
  id: string
  round_id: string
  application_id: string
  status: string
  scheduled_at: string | null
  notes: string | null
  updated_at: string | null
}

interface JobDetailsProps {
  job: Job
  onBack: () => void
  initialTab?: string
}

const STATUS_COLUMNS = [
  { id: "applied", label: "Applied", color: "bg-blue-100 text-blue-800" },
  { id: "shortlist", label: "Shortlist", color: "bg-indigo-100 text-indigo-800" },
  { id: "screening", label: "Screening", color: "bg-yellow-100 text-yellow-800" },
  { id: "interview", label: "Interview", color: "bg-purple-100 text-purple-800" },
  { id: "offer", label: "Offer", color: "bg-green-100 text-green-800" },
  { id: "hired", label: "Hired", color: "bg-emerald-100 text-emerald-800" },
  { id: "rejected", label: "Rejected", color: "bg-red-100 text-red-800" }
]

export function JobDetails({ job, onBack, initialTab }: JobDetailsProps) {
  const router = useRouter()
  const [applications, setApplications] = useState<Application[]>([])
  const [loading, setLoading] = useState(true)
  const [invites, setInvites] = useState<JobInvite[]>([])
  const { toast } = useToast()
  const [activeStage, setActiveStage] = useState<string>(initialTab || "all")
  const [selectedCandidate, setSelectedCandidate] = useState<any | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [pendingStageChange, setPendingStageChange] = useState<null | {
    applicationId: string
    from: string
    to: string
    candidateName: string
  }>(null)
  const [clientOpen, setClientOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [invitePhone, setInvitePhone] = useState("")
  const [inviteSendWhatsapp, setInviteSendWhatsapp] = useState(true)
  const [inviteCreating, setInviteCreating] = useState(false)
  const [inviteResendingId, setInviteResendingId] = useState<string | null>(null)

  const [inviteStatusFilter, setInviteStatusFilter] = useState<string>("all")
  const [inviteActivityFilter, setInviteActivityFilter] = useState<string>("all")
  const [inviteProfileFilter, setInviteProfileFilter] = useState<string>("all")

  const [interviewRounds, setInterviewRounds] = useState<InterviewRound[]>([])
  const [interviewRoundId, setInterviewRoundId] = useState<string>("")
  const [interviewsByKey, setInterviewsByKey] = useState<Record<string, InterviewEntry>>({})
  const [interviewLoading, setInterviewLoading] = useState(false)

  const [interviewDraftByKey, setInterviewDraftByKey] = useState<Record<string, { notes: string; scheduledAtLocal: string }>>({})
  const [interviewDraftSavingByKey, setInterviewDraftSavingByKey] = useState<Record<string, true>>({})

  const [roundEditorOpen, setRoundEditorOpen] = useState(false)
  const [roundEditorMode, setRoundEditorMode] = useState<"create" | "rename">("create")
  const [roundEditorRoundId, setRoundEditorRoundId] = useState<string | null>(null)
  const [roundEditorName, setRoundEditorName] = useState<string>("")
  const [roundEditorSaving, setRoundEditorSaving] = useState(false)
  const [roundDeleteOpen, setRoundDeleteOpen] = useState(false)
  const [roundDeleteSaving, setRoundDeleteSaving] = useState(false)

  const [interviewStatusFilter, setInterviewStatusFilter] = useState<string>("all")

  const [candidateAiById, setCandidateAiById] = useState<Record<string, { summary: string; expanded: boolean; visible: boolean }>>({})
  const [candidateAiLoadingById, setCandidateAiLoadingById] = useState<Record<string, true>>({})
  
  // State for notes editing
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteContent, setNoteContent] = useState("")

  // Outreach data state
  const [outreachCandidates, setOutreachCandidates] = useState<any[]>([])
  const [outreachStats, setOutreachStats] = useState<any>(null)
  const [outreachLoading, setOutreachLoading] = useState(false)

  useEffect(() => {
    fetchApplications()
    fetchOutreachData()
  }, [job.id])

  useEffect(() => {
    cachedFetchJson<{ invites: JobInvite[] }>(`internal:job-invites:${job.id}`, `/api/job-invites?jobId=${job.id}`, undefined, {
      ttlMs: 5 * 60_000,
    })
      .then((d) => setInvites(Array.isArray(d?.invites) ? d.invites : []))
      .catch((e: any) => {
        setInvites([])
        toast({ title: "Invites failed", description: e?.message || "Failed to load invites", variant: "destructive" })
      })
  }, [job.id])

  const fetchOutreachData = async () => {
    if (job.is_external_link) return // Don't fetch outreach for external link jobs
    
    setOutreachLoading(true)
    try {
      const res = await fetch(`/api/jobs/${job.id}/outreach`)
      if (res.ok) {
        const data = await res.json()
        setOutreachCandidates(data.candidates || [])
        setOutreachStats(data.stats || null)
      }
    } catch (error) {
      console.error("Failed to fetch outreach data", error)
    } finally {
      setOutreachLoading(false)
    }
  }

  const fetchInterviewData = async (opts?: { force?: boolean }) => {
    setInterviewLoading(true)
    try {
      const data = await cachedFetchJson<{ rounds: InterviewRound[]; interviews: InterviewEntry[] }>(
        `internal:job-interviews:${job.id}`,
        `/api/jobs/${job.id}/interviews`,
        undefined,
        { ttlMs: 3 * 60_000, force: Boolean(opts?.force) },
      )

      const rounds = Array.isArray(data?.rounds) ? (data.rounds as InterviewRound[]) : []
      const interviews = Array.isArray(data?.interviews) ? (data.interviews as InterviewEntry[]) : []

      setInterviewRounds(rounds)
      if (!interviewRoundId || !rounds.some((r) => r.id === interviewRoundId)) {
        setInterviewRoundId(rounds[0]?.id || "")
      }

      const map: Record<string, InterviewEntry> = {}
      const drafts: Record<string, { notes: string; scheduledAtLocal: string }> = {}
      for (const it of interviews) {
        if (!it?.round_id || !it?.application_id) continue
        map[`${it.round_id}:${it.application_id}`] = it
        drafts[`${it.round_id}:${it.application_id}`] = {
          notes: String(it?.notes || ""),
          scheduledAtLocal: toDateTimeLocal((it as any)?.scheduled_at || null),
        }
      }
      setInterviewsByKey(map)
      setInterviewDraftByKey(drafts)
    } catch (e: any) {
      setInterviewRounds([])
      setInterviewsByKey({})
      setInterviewDraftByKey({})
      toast({ title: "Interview failed", description: e?.message || "Failed to load", variant: "destructive" })
    } finally {
      setInterviewLoading(false)
    }
  }

  useEffect(() => {
    if (activeStage !== "interview") return
    fetchInterviewData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStage, job.id])

  const openCreateRound = () => {
    setRoundEditorMode("create")
    setRoundEditorRoundId(null)

    const used = new Set<number>()
    for (const r of interviewRounds) {
      const m = String(r.name || "").match(/\bround\s*(\d+)\b/i)
      if (m?.[1]) {
        const n = Number(m[1])
        if (Number.isFinite(n)) used.add(n)
      }
    }

    const nextNum = used.size ? Math.max(...Array.from(used)) + 1 : interviewRounds.length + 1
    setRoundEditorName(`Round ${nextNum}`)
    setRoundEditorOpen(true)
  }

  const openRenameRound = (round: InterviewRound) => {
    setRoundEditorMode("rename")
    setRoundEditorRoundId(round.id)
    setRoundEditorName(round.name)
    setRoundEditorOpen(true)
  }

  const saveRoundEditor = async () => {
    const name = roundEditorName.trim()
    if (!name) return
    setRoundEditorSaving(true)
    try {
      if (roundEditorMode === "create") {
        const res = await fetch(`/api/jobs/${job.id}/interview-rounds`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name })
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || "Failed to create round")
        invalidateSessionCache(`internal:job-interviews:${job.id}`)
        await fetchInterviewData({ force: true })
        if (data?.round?.id) setInterviewRoundId(data.round.id)
      } else {
        const id = roundEditorRoundId
        if (!id) return
        const res = await fetch(`/api/jobs/${job.id}/interview-rounds`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, name })
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || "Failed to rename")
        invalidateSessionCache(`internal:job-interviews:${job.id}`)
        await fetchInterviewData({ force: true })
      }

      setRoundEditorOpen(false)
    } catch (e: any) {
      toast({ title: "Round update failed", description: e?.message || "Failed", variant: "destructive" })
    } finally {
      setRoundEditorSaving(false)
    }
  }

  const deleteRound = async () => {
    const id = roundEditorRoundId
    if (!id) return
    setRoundDeleteSaving(true)
    try {
      const res = await fetch(`/api/jobs/${job.id}/interview-rounds`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to delete")
      setRoundDeleteOpen(false)
      setRoundEditorOpen(false)
      await fetchInterviewData()
    } catch (e: any) {
      toast({ title: "Delete failed", description: e?.message || "Failed", variant: "destructive" })
    } finally {
      setRoundDeleteSaving(false)
    }
  }

  const upsertInterview = async (
    applicationId: string,
    roundId: string,
    patch: Partial<Pick<InterviewEntry, "status" | "notes" | "scheduled_at">>
  ) => {
    try {
      const res = await fetch(`/api/jobs/${job.id}/interviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, roundId, ...patch })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to update")
      const it = data?.interview as InterviewEntry | undefined
      if (it?.round_id && it?.application_id) {
        setInterviewsByKey((prev) => ({ ...prev, [`${it.round_id}:${it.application_id}`]: it }))
        setInterviewDraftByKey((prev) => ({
          ...prev,
          [`${it.round_id}:${it.application_id}`]: {
            notes: String(it?.notes || ""),
            scheduledAtLocal: toDateTimeLocal((it as any)?.scheduled_at || null),
          }
        }))
      }
      if (patch.status === "move_next") {
        await fetchInterviewData()
      }
    } catch (e: any) {
      toast({ title: "Interview update failed", description: e?.message || "Failed", variant: "destructive" })
    }
  }

  const inviteBase = getBoardAppBaseUrl()
  const inviteLink = (token: string) => `${inviteBase}/invite/${token}`

  const publicApplyUrl = getBoardJobApplyUrl(job.id)

  const filteredInvites = invites.filter((inv) => {
    if (inviteStatusFilter !== "all" && String(inv.status || "").toLowerCase() !== inviteStatusFilter) return false
    if (inviteActivityFilter === "opened" && !inv.opened_at) return false
    if (inviteActivityFilter === "not_opened" && inv.opened_at) return false
    if (inviteActivityFilter === "applied" && !inv.applied_at) return false
    if (inviteActivityFilter === "not_applied" && inv.applied_at) return false
    if (inviteProfileFilter === "linked" && !inv.candidate_id) return false
    if (inviteProfileFilter === "not_linked" && inv.candidate_id) return false
    return true
  })

  const interviewApps = applications.filter((a) => a.status === "interview")

  const toDateTimeLocal = (iso: string | null) => {
    if (!iso) return ""
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const fromDateTimeLocal = (v: string) => {
    if (!v) return null
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }

  const inviteBadgeClass = (status: string) => {
    switch (status) {
      case "sent":
        return "bg-gray-50 text-gray-700 border-gray-200"
      case "opened":
        return "bg-blue-50 text-blue-700 border-blue-200"
      case "applied":
        return "bg-green-50 text-green-700 border-green-200"
      case "rejected":
        return "bg-red-50 text-red-700 border-red-200"
      default:
        return "bg-gray-50 text-gray-700 border-gray-200"
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "sent":
        return "📤"
      case "opened":
        return "👁️"
      case "applied":
        return "✅"
      case "rejected":
        return "❌"
      default:
        return "📊"
    }
  }

  const messageStatusBadge = (status: string, type: "email" | "whatsapp") => {
    const baseClasses = "px-2 py-1 rounded-full text-xs font-medium border"
    switch (status) {
      case "pending":
        return `${baseClasses} bg-yellow-50 text-yellow-700 border-yellow-200`
      case "sent":
        return `${baseClasses} bg-blue-50 text-blue-700 border-blue-200`
      case "delivered":
        return `${baseClasses} bg-green-50 text-green-700 border-green-200`
      case "opened":
        return `${baseClasses} bg-purple-50 text-purple-700 border-purple-200`
      case "failed":
        return `${baseClasses} bg-red-50 text-red-700 border-red-200`
      default:
        return `${baseClasses} bg-gray-50 text-gray-700 border-gray-200`
    }
  }

  const getMessageIcon = (type: "email" | "whatsapp", status: string) => {
    if (type === "email") {
      return <Mail className="h-4 w-4" />
    } else {
      return <MessageCircle className="h-4 w-4" />
    }
  }

  const createInvite = async () => {
    const email = inviteEmail.trim()
    if (!email) return
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      toast({ title: "Invalid email", description: "Enter a valid email address.", variant: "destructive" })
      return
    }
    const phoneRaw = invitePhone.trim()
    const phone = phoneRaw ? phoneRaw.replace(/\s+/g, "") : ""
    if (phone && !/^\+?\d{8,15}$/.test(phone)) {
      toast({ title: "Invalid phone", description: "Enter a valid WhatsApp number.", variant: "destructive" })
      return
    }
    const sendWhatsapp = inviteSendWhatsapp && Boolean(phone)
    setInviteCreating(true)
    try {
      const res = await fetch("/api/job-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, email, phone: phone || undefined, sendWhatsapp })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to create invite")
      setInviteEmail("")
      setInvitePhone("")
      if (data?.emailError) {
        toast({ title: "Invite created, email failed", description: String(data.emailError), variant: "destructive" })
      } else {
        const parts = [data?.emailSent ? "Email sent." : "Invite link ready."]
        if (data?.whatsappSent) {
          parts.push("WhatsApp sent.")
        } else if (data?.whatsappError) {
          parts.push("WhatsApp failed.")
        }
        toast({
          title: data?.created === false ? "Invite already exists" : "Invite created",
          description: parts.join(" "),
        })
      }
      invalidateSessionCache(`internal:job-invites:${job.id}`)
      const refreshed = await cachedFetchJson<{ invites: JobInvite[] }>(
        `internal:job-invites:${job.id}`,
        `/api/job-invites?jobId=${job.id}`,
        undefined,
        { force: true },
      )
      setInvites(Array.isArray(refreshed?.invites) ? refreshed.invites : invites)
      if (data?.link) {
        try {
          await navigator.clipboard.writeText(data.link)
        } catch {
          // ignore
        }
      }
    } catch (e: any) {
      toast({ title: "Invite failed", description: e.message || "Failed", variant: "destructive" })
    } finally {
      setInviteCreating(false)
    }
  }

  const resendInvite = async (email: string, inviteId: string) => {
    setInviteResendingId(inviteId)
    try {
      const res = await fetch("/api/job-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, email, resend: true })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to resend")
      if (data?.emailError) {
        toast({ title: "Resend failed", description: String(data.emailError), variant: "destructive" })
      } else {
        toast({ title: "Resent", description: data?.emailSent ? "Invite email resent." : "Invite link ready." })
      }
      invalidateSessionCache(`internal:job-invites:${job.id}`)
      const refreshed = await cachedFetchJson<{ invites: JobInvite[] }>(
        `internal:job-invites:${job.id}`,
        `/api/job-invites?jobId=${job.id}`,
        undefined,
        { force: true },
      )
      setInvites(Array.isArray(refreshed?.invites) ? refreshed.invites : invites)
    } catch (e: any) {
      toast({ title: "Resend failed", description: e?.message || "Failed", variant: "destructive" })
    } finally {
      setInviteResendingId(null)
    }
  }

  useEffect(() => {
    if (!job.client_id) {
      setClient(null)
      return
    }
    cachedFetchJson<any[]>(`internal:clients:list`, "/api/clients", undefined, {
      ttlMs: 10 * 60_000,
    })
      .then((rows) => {
        const found = Array.isArray(rows) ? rows.find((c: any) => c.id === job.client_id) : null
        setClient(found || null)
      })
      .catch(() => setClient(null))
  }, [job.client_id])

  const clientLabel = useMemo(() => {
    return (job.client_id && client?.name) || job.client_name || null
  }, [client?.name, job.client_id, job.client_name])

  const fetchApplications = async (opts?: { force?: boolean }) => {
    try {
      const data = await cachedFetchJson<Application[]>(
        `internal:applications:job:${job.id}`,
        `/api/applications?jobId=${job.id}`,
        undefined,
        { ttlMs: 5 * 60_000, force: Boolean(opts?.force) },
      )
      setApplications(Array.isArray(data) ? data : [])
    } catch (error) {
      console.error("Failed to fetch applications", error)
      toast({ title: "Applications failed", description: (error as any)?.message || "Failed", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  const updateStatus = async (applicationId: string, newStatus: string) => {
    // Optimistic update
    setApplications(prev => prev.map(app => 
      app.id === applicationId ? { ...app, status: newStatus } : app
    ))

    try {
      const res = await fetch(`/api/applications/${applicationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus })
      })

      if (!res.ok) throw new Error("Failed to update status")
      
      toast({
        title: "Status Updated",
        description: `Candidate moved to ${newStatus}`,
      })
      invalidateSessionCache(`internal:applications:job:${job.id}`)
      invalidateSessionCache(`internal:job-interviews:${job.id}`)

      if (newStatus === "interview") {
        setActiveStage("interview")
        setInterviewRoundId("")
        window.setTimeout(() => {
          fetchInterviewData({ force: true })
        }, 0)
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update status",
        variant: "destructive",
      })
      fetchApplications({ force: true }) // Revert on error
    }
  }

  const shouldConfirmStageChange = (from: string, to: string) => {
    const needs = new Set(["screening", "interview", "offer"])
    return needs.has(from) || needs.has(to)
  }

  const stageLabel = (id: string) => {
    const found = STATUS_COLUMNS.find((s) => s.id === id)
    return found?.label || id
  }

  const requestStageChange = (app: Application, to: string) => {
    const from = String(app.status || "")
    if (!to || to === from) return
    if (shouldConfirmStageChange(from, to)) {
      setPendingStageChange({
        applicationId: app.id,
        from,
        to,
        candidateName: String(app.candidates?.name || "Candidate")
      })
      return
    }
    updateStatus(app.id, to)
  }

  const handleNoteEdit = (app: Application) => {
    setEditingNoteId(app.id)
    setNoteContent(app.notes || "")
  }

  const saveNote = async (applicationId: string) => {
    try {
        // Optimistic update
        setApplications(prev => prev.map(app => 
            app.id === applicationId ? { ...app, notes: noteContent } : app
        ))
        setEditingNoteId(null)

        const res = await fetch(`/api/applications/${applicationId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notes: noteContent })
        })

        if (!res.ok) throw new Error("Failed to update note")
        
        toast({
            title: "Note Saved",
            description: "Candidate notes updated successfully",
        })
        invalidateSessionCache(`internal:applications:job:${job.id}`)
    } catch (error) {
        toast({
            title: "Error",
            description: "Failed to save note",
            variant: "destructive",
        })
        fetchApplications({ force: true }) // Revert
    }
  }

  const openPreview = async (app: Application) => {
      // Use existing candidate data, but fetch more if needed
      // Here we assume app.candidates has enough info, or the dialog handles partial data
      // We can also fetch fresh data like in job-matches-client
      setSelectedCandidate(app.candidates)
  }

  const toggleCandidateAi = async (candidateId: string, force?: boolean) => {
    if (!candidateId) return
    const existing = candidateAiById[candidateId]
    if (!force && existing?.summary) {
      setCandidateAiById((prev) => ({
        ...prev,
        [candidateId]: { ...prev[candidateId], visible: !prev[candidateId].visible }
      }))
      return
    }

    setCandidateAiLoadingById((prev) => ({ ...prev, [candidateId]: true }))
    try {
      const res = await fetch("/api/matches/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, candidateId, force: !!force })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to generate analysis")
      setCandidateAiById((prev) => ({
        ...prev,
        [candidateId]: { summary: String(data?.summary || ""), expanded: false, visible: true }
      }))
    } catch (e: any) {
      toast({ title: "AI analysis failed", description: e?.message || "Failed", variant: "destructive" })
    } finally {
      setCandidateAiLoadingById((prev) => {
        const next = { ...prev }
        delete next[candidateId]
        return next
      })
    }
  }

  if (loading) {
    return <div className="flex justify-center p-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h2 className="text-2xl font-bold">{job.title}</h2>
          <div className="flex gap-2 text-sm text-gray-500">
            {clientLabel ? (
              <button className="inline-flex items-center gap-2 text-blue-600 hover:underline" onClick={() => setClientOpen(true)}>
                {client?.logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={client.logo_url} alt="Logo" className="h-5 w-5 rounded border bg-white object-cover" />
                ) : null}
                {clientLabel}
              </button>
            ) : null}
            {clientLabel ? <span>•</span> : null}
            <span>{job.industry || ""}</span>
            <span>•</span>
            <span>{job.location}</span>
            <span>•</span>
            <Badge variant="outline">{String(job.employment_type || "").replace(/_/g, " ")}</Badge>
            <Badge className={job.status === 'open' ? 'bg-green-500' : 'bg-gray-500'}>
              {job.status}
            </Badge>
            {(job as any).is_external_link && (
              <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200">
                External Link
              </Badge>
            )}
            {(job as any).source && (
              <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                {(job as any).source === 'truckinzy' ? 'Truckinzy' : 'Employee'} Side
              </Badge>
            )}
            <a 
                href={publicApplyUrl}
                target="_blank" 
                rel="noopener noreferrer"
                className="ml-2 flex items-center gap-1 text-blue-600 hover:underline"
            >
                View Public Page <ExternalLink className="h-3 w-3" />
            </a>
            {!job.is_external_link && (
              <Button
                variant="outline"
                size="sm"
                className="ml-2"
                onClick={() => window.open(`/jobs/${job.id}/outreach`, "_blank")}
              >
                <Send className="mr-2 h-4 w-4" />
                Outreach Dashboard
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={clientOpen} onOpenChange={setClientOpen}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>{client?.name || clientLabel || "Client"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            {client?.logo_url ? (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={client.logo_url} alt="Logo" className="h-14 w-14 rounded-xl border bg-white object-cover" />
                <div className="text-sm text-muted-foreground">Company logo</div>
              </div>
            ) : null}
            {client?.website ? (
              <a
                href={normalizeExternalUrl(client.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                {client.website}
              </a>
            ) : null}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs font-medium text-muted-foreground">Company type</div>
                <div>{client?.company_type || "—"}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">Location</div>
                <div>{client?.location || "—"}</div>
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground">About</div>
              <div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{client?.about || "—"}</div>
            </div>
            <div className="rounded-lg border bg-gray-50 p-4">
              <div className="text-sm font-semibold">Primary contact</div>
              <div className="mt-2 text-sm text-muted-foreground">
                <div>{client?.primary_contact_name || "—"}</div>
                <div>{client?.primary_contact_email || "—"}</div>
                <div>{client?.primary_contact_phone || "—"}</div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingStageChange} onOpenChange={(open) => {
        if (!open) setPendingStageChange(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm stage change</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingStageChange
                ? `Move ${pendingStageChange.candidateName} from ${stageLabel(pendingStageChange.from)} to ${stageLabel(pendingStageChange.to)}?`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingStageChange(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!pendingStageChange) return
                const payload = pendingStageChange
                setPendingStageChange(null)
                updateStatus(payload.applicationId, payload.to)
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-2">
          <div
            className={`cursor-pointer rounded-lg border p-3 flex flex-col items-center justify-center transition-all ${
              activeStage === "all" 
                ? "bg-blue-50 border-blue-500 ring-1 ring-blue-500" 
                : "bg-white hover:border-blue-200 hover:bg-blue-50/50"
            }`}
            onClick={() => setActiveStage("all")}
          >
            <span className={`text-xs font-medium mb-1 ${activeStage === "all" ? "text-blue-700" : "text-gray-500"}`}>
                All
            </span>
            <span className={`text-lg font-bold ${activeStage === "all" ? "text-blue-700" : "text-gray-900"}`}>
                {applications.length}
            </span>
          </div>

          {STATUS_COLUMNS.map((column) => {
            const count = applications.filter((a) => a.status === column.id).length
            const isActive = activeStage === column.id
            // Parse color classes to get border/text colors roughly matching the badge style
            let activeClass = "bg-gray-50 border-gray-500 ring-1 ring-gray-500"
            let textClass = "text-gray-700"
            
            if (column.id === 'applied') { activeClass = "bg-blue-50 border-blue-500 ring-1 ring-blue-500"; textClass = "text-blue-700"; }
            else if (column.id === 'shortlist') { activeClass = "bg-indigo-50 border-indigo-500 ring-1 ring-indigo-500"; textClass = "text-indigo-700"; }
            else if (column.id === 'screening') { activeClass = "bg-yellow-50 border-yellow-500 ring-1 ring-yellow-500"; textClass = "text-yellow-700"; }
            else if (column.id === 'interview') { activeClass = "bg-purple-50 border-purple-500 ring-1 ring-purple-500"; textClass = "text-purple-700"; }
            else if (column.id === 'offer') { activeClass = "bg-green-50 border-green-500 ring-1 ring-green-500"; textClass = "text-green-700"; }
            else if (column.id === 'hired') { activeClass = "bg-emerald-50 border-emerald-500 ring-1 ring-emerald-500"; textClass = "text-emerald-700"; }
            else if (column.id === 'rejected') { activeClass = "bg-red-50 border-red-500 ring-1 ring-red-500"; textClass = "text-red-700"; }

            return (
              <div
                key={column.id}
                className={`cursor-pointer rounded-lg border p-3 flex flex-col items-center justify-center transition-all ${
                  isActive ? activeClass : "bg-white hover:bg-gray-50"
                }`}
                onClick={() => setActiveStage(column.id)}
              >
                <span className={`text-xs font-medium mb-1 ${isActive ? textClass : "text-gray-500"}`}>
                    {column.label}
                </span>
                <span className={`text-lg font-bold ${isActive ? textClass : "text-gray-900"}`}>
                    {count}
                </span>
              </div>
            )
          })}

          <div
            className={`cursor-pointer rounded-lg border p-3 flex flex-col items-center justify-center transition-all ${
              activeStage === "invites" ? "bg-blue-50 border-blue-500 ring-1 ring-blue-500" : "bg-white hover:border-blue-200 hover:bg-blue-50/50"
            }`}
            onClick={() => setActiveStage("invites")}
          >
            <span className={`text-xs font-medium mb-1 ${activeStage === "invites" ? "text-blue-700" : "text-gray-500"}`}>Invites</span>
            <span className={`text-lg font-bold ${activeStage === "invites" ? "text-blue-700" : "text-gray-900"}`}>
              {invites.length + (outreachCandidates?.length || 0)}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          {activeStage === "invites" ? (
            <div className="grid gap-4">
            {/* Outreach Stats Card */}
            {!job.is_external_link && outreachStats && (
              <Card className="shadow-sm border-blue-100 bg-gradient-to-r from-blue-50 to-indigo-50">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-bold text-blue-900 text-lg">📧 Outreach Campaign</div>
                      <div className="text-sm text-blue-700">Candidate outreach and messaging status</div>
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="text-center bg-white rounded-lg p-3 shadow-sm">
                        <div className="font-bold text-blue-900 text-lg">{outreachStats.total_outreached || 0}</div>
                        <div className="text-blue-600 font-medium">Outreached</div>
                      </div>
                      <div className="text-center bg-white rounded-lg p-3 shadow-sm">
                        <div className="font-bold text-green-700 text-lg">{outreachStats.responded || 0}</div>
                        <div className="text-green-600 font-medium">Responded</div>
                      </div>
                      <div className="text-center bg-white rounded-lg p-3 shadow-sm">
                        <div className="font-bold text-purple-700 text-lg">{outreachStats.messages_sent || 0}</div>
                        <div className="text-purple-600 font-medium">Messages</div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Create Invite Card */}
            <Card className="shadow-sm border-indigo-100 bg-gradient-to-br from-white to-indigo-50">
              <CardContent className="p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center">
                        <Mail className="h-4 w-4 text-indigo-600" />
                      </div>
                      <div className="font-bold text-lg text-indigo-900">Invite Candidates to Apply</div>
                    </div>
                    <div className="text-sm text-indigo-700 bg-indigo-100/50 rounded-lg p-3">
                      {job.is_external_link 
                        ? "Create invite links for external job opportunities"
                        : "🎯 Flow: Send outreach → Candidate receives message → Applies via unique link"
                      }
                    </div>
                  </div>
                  <div className="flex w-full flex-col gap-3 sm:w-auto">
                    <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
                      <div className="relative w-full sm:w-[320px]">
                        <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-indigo-400" />
                        <Input
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          placeholder="Enter candidate email address"
                          className="pl-9 border-indigo-200 focus:ring-indigo-500"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault()
                              createInvite()
                            }
                          }}
                        />
                      </div>
                      <div className="relative w-full sm:w-[240px]">
                        <MessageCircle className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-indigo-400" />
                        <Input
                          type="tel"
                          inputMode="tel"
                          value={invitePhone}
                          onChange={(e) => setInvitePhone(e.target.value)}
                          placeholder="WhatsApp number (optional)"
                          className="pl-9 border-indigo-200 focus:ring-indigo-500"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault()
                              createInvite()
                            }
                          }}
                        />
                      </div>
                      <Button
                        onClick={createInvite}
                        disabled={!inviteEmail.trim() || inviteCreating}
                        className="shrink-0 bg-indigo-600 hover:bg-indigo-700 text-white"
                      >
                        {inviteCreating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                        Create Invite
                      </Button>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-indigo-700">
                      <input
                        type="checkbox"
                        checked={inviteSendWhatsapp}
                        onChange={(e) => setInviteSendWhatsapp(e.target.checked)}
                        disabled={!invitePhone.trim()}
                        className="h-4 w-4 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      Send WhatsApp if a phone number is provided
                    </label>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Outreach Candidates Section */}
            {!job.is_external_link && outreachCandidates.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between bg-gradient-to-r from-purple-50 to-pink-50 rounded-lg p-4 border border-purple-100">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-purple-100 flex items-center justify-center">
                      <MessageCircle className="h-5 w-5 text-purple-600" />
                    </div>
                    <div>
                      <h3 className="font-bold text-lg text-purple-900">Outreach Candidates</h3>
                      <p className="text-sm text-purple-700">Candidates contacted via email and WhatsApp</p>
                    </div>
                  </div>
                  <Badge variant="outline" className="bg-purple-100 text-purple-800 border-purple-200 px-3 py-1">
                    {outreachCandidates.length} candidates
                  </Badge>
                </div>
                
                {outreachCandidates.map((candidate) => (
                  <Card key={candidate.id} className="shadow-sm border-purple-100 hover:shadow-md transition-shadow">
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-3 mb-3">
                            <div className="h-12 w-12 rounded-full bg-gradient-to-br from-purple-100 to-pink-100 flex items-center justify-center">
                              <span className="text-lg font-bold text-purple-700">
                                {candidate.name?.split(" ").map((n: string) => n[0]).join("").toUpperCase() || "CN"}
                              </span>
                            </div>
                            <div className="flex-1">
                              <div className="font-bold text-lg text-gray-900">{candidate.name}</div>
                              <div className="text-sm text-gray-600">{candidate.current_role}</div>
                            </div>
                            <Badge variant="outline" className={candidate.responded ? "bg-green-50 text-green-700 border-green-200 px-3 py-1" : "bg-gray-50 text-gray-700 border-gray-200 px-3 py-1"}>
                              {candidate.responded ? "✅ Responded" : "⏳ No Response"}
                            </Badge>
                          </div>
                          
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 p-3 bg-gray-50 rounded-lg">
                            <div className="flex items-center gap-2">
                              <Mail className="h-4 w-4 text-gray-500" />
                              <span className="text-sm text-gray-700">{candidate.email}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <MessageCircle className="h-4 w-4 text-gray-500" />
                              <span className="text-sm text-gray-700">{candidate.phone}</span>
                            </div>
                          </div>

                          {/* Message Status with Gmail/WhatsApp Icons */}
                          {candidate.messages && candidate.messages.length > 0 && (
                            <div className="space-y-3">
                              <div className="flex items-center gap-2">
                                <div className="text-sm font-bold text-gray-900">📨 Message Status:</div>
                                <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                                  {candidate.messages.length} messages sent
                                </Badge>
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {candidate.messages.map((message: any) => (
                                  <Card key={message.id} className="bg-white border-2 shadow-sm">
                                    <CardContent className="p-3">
                                      <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                          {message.type === "email" ? (
                                            <Mail className="h-4 w-4 text-blue-600" />
                                          ) : (
                                            <MessageCircle className="h-4 w-4 text-green-600" />
                                          )}
                                          <span className="font-medium text-gray-900">
                                            {message.type === "email" ? "Gmail" : "WhatsApp"}
                                          </span>
                                        </div>
                                        <Badge variant="outline" className={messageStatusBadge(message.status, message.type)}>
                                          {message.status}
                                        </Badge>
                                      </div>
                                      <div className="text-xs text-gray-600">
                                        {message.opened_at && (
                                          <div className="flex items-center gap-1">
                                            <Eye className="h-3 w-3" />
                                            <span>Opened {formatDistanceToNow(new Date(message.opened_at), { addSuffix: true })}</span>
                                          </div>
                                        )}
                                        {message.sent_at && (
                                          <div className="flex items-center gap-1">
                                            <Clock className="h-3 w-3" />
                                            <span>Sent {formatDistanceToNow(new Date(message.sent_at), { addSuffix: true })}</span>
                                          </div>
                                        )}
                                      </div>
                                    </CardContent>
                                  </Card>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                        
                        <div className="flex flex-col gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-10 bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                            onClick={() => {
                              const link = candidate.messages?.[0]?.unique_link || "#"
                              window.open(link, "_blank", "noopener,noreferrer")
                            }}
                          >
                            <ExternalLinkIcon className="mr-2 h-4 w-4" />
                            View Application
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-10 bg-green-50 hover:bg-green-100 text-green-700 border-green-200"
                            onClick={() => {
                              // Resend message functionality could be added here
                              toast({ title: "Resend feature", description: "Resend functionality coming soon!" })
                            }}
                          >
                            <RotateCw className="mr-2 h-4 w-4" />
                            Resend Message
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Email Invites Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-gradient-to-r from-blue-50 to-cyan-50 rounded-lg p-4 border border-blue-100">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                    <Mail className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg text-blue-900">📧 Email Invites</h3>
                    <p className="text-sm text-blue-700">Tracked invite links sent via email</p>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                  <div className="w-full sm:w-[170px]">
                    <Select value={inviteStatusFilter} onValueChange={setInviteStatusFilter}>
                      <SelectTrigger className="h-9 border-blue-200">
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All statuses</SelectItem>
                        <SelectItem value="sent">Sent</SelectItem>
                        <SelectItem value="opened">Opened</SelectItem>
                        <SelectItem value="applied">Applied</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                        <SelectItem value="expired">Expired</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="w-full sm:w-[170px]">
                    <Select value={inviteActivityFilter} onValueChange={setInviteActivityFilter}>
                      <SelectTrigger className="h-9 border-blue-200">
                        <SelectValue placeholder="Activity" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All activity</SelectItem>
                        <SelectItem value="opened">Opened</SelectItem>
                        <SelectItem value="not_opened">Not opened</SelectItem>
                        <SelectItem value="applied">Applied</SelectItem>
                        <SelectItem value="not_applied">Not applied</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="w-full sm:w-[170px]">
                    <Select value={inviteProfileFilter} onValueChange={setInviteProfileFilter}>
                      <SelectTrigger className="h-9 border-blue-200">
                        <SelectValue placeholder="Profile" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All profiles</SelectItem>
                        <SelectItem value="linked">Linked</SelectItem>
                        <SelectItem value="not_linked">Not linked</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Badge variant="outline" className="bg-blue-100 text-blue-800 border-blue-200 px-3 py-1">
                    {filteredInvites.length} invites
                  </Badge>
                </div>
              </div>

            {!filteredInvites.length ? (
              <div className="text-center py-12 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg bg-gradient-to-b from-gray-50 to-white">
                <div className="flex flex-col items-center">
                  <div className="h-16 w-16 rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center mb-4">
                    <Mail className="h-8 w-8 text-blue-500" />
                  </div>
                  <p className="text-gray-600 font-medium mb-2">No email invites yet</p>
                  <p className="text-gray-500 text-sm max-w-md">
                    {job.is_external_link 
                      ? "Create invite links for external job opportunities" 
                      : "Create your first invite above to generate a tracked invite link"
                    }
                  </p>
                </div>
              </div>
            ) : (
              filteredInvites.map((inv) => (
                <Card key={inv.id} className="shadow-sm hover:shadow-md transition-shadow border-blue-100">
                  <CardContent className="p-6 space-y-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-3 mb-3">
                          <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center">
                            <Mail className="h-5 w-5 text-blue-600" />
                          </div>
                          <div className="font-bold text-lg text-gray-900 truncate">{inv.email}</div>
                          <Badge variant="outline" className={`${inviteBadgeClass(inv.status || "sent")} px-3 py-1 text-sm`}>
                            {getStatusIcon(inv.status || "sent")} {(inv.status || "sent").toUpperCase()}
                          </Badge>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                          <div className="flex items-center gap-2 p-2 bg-blue-50 rounded-lg">
                            <div className="h-6 w-6 rounded-full bg-blue-100 flex items-center justify-center">
                              <Send className="h-3 w-3 text-blue-600" />
                            </div>
                            <div>
                              <div className="font-medium text-blue-900">Sent</div>
                              <div className="text-blue-700 text-xs">{inv.sent_at ? formatDistanceToNow(new Date(inv.sent_at), { addSuffix: true }) : "—"}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 p-2 bg-green-50 rounded-lg">
                            <div className="h-6 w-6 rounded-full bg-green-100 flex items-center justify-center">
                              <Eye className="h-3 w-3 text-green-600" />
                            </div>
                            <div>
                              <div className="font-medium text-green-900">Opened</div>
                              <div className="text-green-700 text-xs">{inv.opened_at ? formatDistanceToNow(new Date(inv.opened_at), { addSuffix: true }) : "Not opened"}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 p-2 bg-purple-50 rounded-lg">
                            <div className="h-6 w-6 rounded-full bg-purple-100 flex items-center justify-center">
                              <CheckCircle className="h-3 w-3 text-purple-600" />
                            </div>
                            <div>
                              <div className="font-medium text-purple-900">Applied</div>
                              <div className="text-purple-700 text-xs">{inv.applied_at ? formatDistanceToNow(new Date(inv.applied_at), { addSuffix: true }) : "Not applied"}</div>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 text-xs text-gray-500 bg-gray-50 rounded-lg p-3">
                          <div className="flex items-center gap-1">
                            <span className="font-medium text-gray-700">Profile:</span>
                            <Badge variant="outline" className={inv.candidate_id ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-700 border-gray-200"}>
                              {inv.candidate_id ? "✅ Linked" : "⏳ Not linked"}
                            </Badge>
                          </div>
                          {inv.rejected_at && (
                            <div className="flex items-center gap-1">
                              <span className="font-medium text-gray-700">Rejected:</span>
                              <span>{formatDistanceToNow(new Date(inv.rejected_at), { addSuffix: true })}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-10 bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200"
                          onClick={async () => {
                            const link = inviteLink(inv.token)
                            try {
                              await navigator.clipboard.writeText(link)
                              toast({ title: "✅ Copied invite link", description: "Link copied to clipboard" })
                            } catch {
                              toast({ title: "❌ Copy failed", description: link, variant: "destructive" })
                            }
                          }}
                        >
                          <Link2 className="mr-2 h-4 w-4" />
                          Copy Link
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          className="h-10 bg-green-50 hover:bg-green-100 text-green-700 border-green-200"
                          disabled={inviteResendingId === inv.id}
                          onClick={() => resendInvite(inv.email, inv.id)}
                        >
                          {inviteResendingId === inv.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
                          Resend
                        </Button>

                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-10 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200"
                          onClick={() => window.open(inviteLink(inv.token), "_blank", "noopener,noreferrer")}
                        >
                          <ExternalLink className="mr-2 h-4 w-4" />
                          Open
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
            </div>
          </div>
        ) : null}
        {activeStage === "interview" ? (
            <>
              <Dialog open={roundEditorOpen} onOpenChange={setRoundEditorOpen}>
                <DialogContent className="sm:max-w-[520px]">
                  <DialogHeader>
                    <DialogTitle>{roundEditorMode === "create" ? "Add interview round" : "Rename round"}</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3">
                    <div className="grid gap-2">
                      <Label>Round name</Label>
                      <Input value={roundEditorName} onChange={(e) => setRoundEditorName(e.target.value)} />
                    </div>
                  </div>
                  <DialogFooter>
                    {roundEditorMode === "rename" ? (
                      <Button
                        variant="destructive"
                        onClick={() => setRoundDeleteOpen(true)}
                        disabled={roundEditorSaving}
                      >
                        Delete
                      </Button>
                    ) : null}
                    <Button variant="outline" onClick={() => setRoundEditorOpen(false)} disabled={roundEditorSaving}>
                      Cancel
                    </Button>
                    <Button onClick={saveRoundEditor} disabled={roundEditorSaving || !roundEditorName.trim()}>
                      {roundEditorSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <AlertDialog open={roundDeleteOpen} onOpenChange={setRoundDeleteOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this round?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently remove the round and all interview data inside it. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={roundDeleteSaving}>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={deleteRound} disabled={roundDeleteSaving}>
                      {roundDeleteSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <div className="grid gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {interviewRounds.map((r) => {
                      const active = r.id === interviewRoundId
                      const roundTotal = interviewApps.filter((app) => Boolean(interviewsByKey[`${r.id}:${app.id}`])).length
                      return (
                        <div key={r.id} className={`flex items-center rounded-full border ${active ? "bg-purple-50 border-purple-300" : "bg-white"}`}>
                          <button
                            type="button"
                            className={`px-3 py-1 text-sm ${active ? "text-purple-800" : "text-gray-700"}`}
                            onClick={() => setInterviewRoundId(r.id)}
                          >
                            {r.name} <span className="text-xs text-muted-foreground">({roundTotal})</span>
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-full"
                            onClick={() => openRenameRound(r)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )
                    })}
                    <Button variant="outline" size="sm" className="h-8 flex-shrink-0" onClick={openCreateRound}>
                      <Plus className="mr-2 h-4 w-4" />
                      Round
                    </Button>
                  </div>
                  <Button variant="outline" size="sm" className="h-8" onClick={() => fetchInterviewData({ force: true })} disabled={interviewLoading}>
                    {interviewLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Refresh
                  </Button>
                </div>

                {!interviewRoundId ? (
                  <div className="text-sm text-muted-foreground">No rounds available.</div>
                ) : interviewApps.length === 0 ? (
                  <div className="text-center py-12 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg bg-gray-50/50">
                    No candidates in Interview stage.
                  </div>
                ) : (
                  (() => {
                    const STATUS_OPTIONS = [
                      { id: "pending", label: "Pending" },
                      { id: "waitlist", label: "Waitlist" },
                      { id: "on_hold", label: "On-Hold" },
                      { id: "passed", label: "Passed" },
                      { id: "move_next", label: "Move to Next Round" },
                      { id: "rejected", label: "Reject" },
                    ] as const

                    const TOOLTIP_BY_STATUS: Record<string, string> = {
                      all: "Show all candidates in this round, regardless of round status.",
                      pending: "Not evaluated yet in this round.",
                      waitlist: "Keep as backup for later review.",
                      on_hold: "Paused for now (availability / internal decision pending).",
                      passed: "Passed this round and ready for the next step.",
                      move_next: "Move forward: creates an entry in the next round and keeps this round status.",
                      rejected: "Rejected for this round (do not move forward).",
                    }

                    const appsInRound = interviewApps.filter((app) => Boolean(interviewsByKey[`${interviewRoundId}:${app.id}`]))

                    const counts: Record<string, number> = {
                      all: appsInRound.length,
                      pending: 0,
                      waitlist: 0,
                      on_hold: 0,
                      passed: 0,
                      move_next: 0,
                      rejected: 0,
                    }

                    for (const app of appsInRound) {
                      const entry = interviewsByKey[`${interviewRoundId}:${app.id}`]
                      const s = String(entry?.status || "pending")
                      if (typeof counts[s] === "number") counts[s] += 1
                      else counts.pending += 1
                    }

                    const filtered = interviewStatusFilter === "all"
                      ? appsInRound
                      : appsInRound.filter((app) => {
                          const entry = interviewsByKey[`${interviewRoundId}:${app.id}`]
                          return String(entry?.status || "pending") === interviewStatusFilter
                        })

                    return (
                      <div className="grid gap-3">
                        <TooltipProvider>
                          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-2">
                            <Button
                              variant={interviewStatusFilter === "all" ? "default" : "outline"}
                              size="sm"
                              className="h-8"
                              onClick={() => setInterviewStatusFilter("all")}
                            >
                              <span className="inline-flex items-center gap-1">
                                All
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      className="inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none opacity-80"
                                      aria-label="All filter info"
                                    >
                                      !
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>{TOOLTIP_BY_STATUS.all}</TooltipContent>
                                </Tooltip>
                              </span>
                              <span className="ml-2 text-xs opacity-80">{counts.all}</span>
                            </Button>
                            {STATUS_OPTIONS.map((s) => (
                              <Button
                                key={s.id}
                                variant={interviewStatusFilter === s.id ? "default" : "outline"}
                                size="sm"
                                className="h-8"
                                onClick={() => setInterviewStatusFilter(s.id)}
                              >
                                <span className="inline-flex items-center gap-1">
                                  {s.label}
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span
                                        className="inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none opacity-80"
                                        aria-label={`${s.label} filter info`}
                                      >
                                        !
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>{TOOLTIP_BY_STATUS[s.id]}</TooltipContent>
                                  </Tooltip>
                                </span>
                                <span className="ml-2 text-xs opacity-80">{counts[s.id]}</span>
                              </Button>
                            ))}
                          </div>
                        </TooltipProvider>

                        <div className="grid gap-2">
                          {filtered.map((app) => {
                            const entry = interviewsByKey[`${interviewRoundId}:${app.id}`]
                            const status = String(entry?.status || "pending")
                            const draftKey = `${interviewRoundId}:${app.id}`
                            const draft = interviewDraftByKey[draftKey] || { notes: String(entry?.notes || ""), scheduledAtLocal: toDateTimeLocal((entry as any)?.scheduled_at || null) }
                            return (
                              <Card key={app.id} className="shadow-sm border-gray-200">
                                <CardContent className="p-4">
                                  <div className="grid gap-4">
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                      <div className="flex items-center gap-3 min-w-0">
                                        <Avatar className="h-9 w-9 border border-gray-200">
                                          <AvatarFallback className="bg-purple-100 text-purple-700">
                                            {app.candidates?.name?.substring(0, 2).toUpperCase() || "CN"}
                                          </AvatarFallback>
                                        </Avatar>
                                        <div className="min-w-0">
                                          <div className="font-medium text-sm truncate">{app.candidates?.name || "Candidate"}</div>
                                          <div className="text-xs text-muted-foreground truncate">{app.candidates?.current_role || ""}</div>
                                        </div>
                                      </div>

                                      <div className="flex flex-wrap items-center gap-2">
                                        <Button variant="outline" size="sm" className="h-8" onClick={() => openPreview(app)}>
                                          <Eye className="h-4 w-4 mr-2" /> View
                                        </Button>
                                        <Select value={app.status} onValueChange={(val) => requestStageChange(app, val)}>
                                          <SelectTrigger className="h-8 w-36">
                                            <SelectValue />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {STATUS_COLUMNS.map((s) => (
                                              <SelectItem key={s.id} value={s.id}>
                                                {s.label}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="h-8"
                                          disabled={!!interviewDraftSavingByKey[draftKey]}
                                          onClick={async () => {
                                            setInterviewDraftSavingByKey((prev) => ({ ...prev, [draftKey]: true }))
                                            try {
                                              await upsertInterview(app.id, interviewRoundId, {
                                                notes: draft.notes,
                                                scheduled_at: draft.scheduledAtLocal ? fromDateTimeLocal(draft.scheduledAtLocal) : null,
                                              } as any)
                                            } finally {
                                              setInterviewDraftSavingByKey((prev) => {
                                                const next = { ...prev }
                                                delete next[draftKey]
                                                return next
                                              })
                                            }
                                          }}
                                        >
                                          {interviewDraftSavingByKey[draftKey] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                                          Save
                                        </Button>
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
                                      <div className="grid gap-1 md:col-span-3">
                                        <div className="text-xs font-medium text-muted-foreground">Round status</div>
                                        <Select value={status} onValueChange={(v) => upsertInterview(app.id, interviewRoundId, { status: v })}>
                                          <SelectTrigger className="h-8">
                                            <SelectValue />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="pending">Pending</SelectItem>
                                            <SelectItem value="waitlist">Waitlist</SelectItem>
                                            <SelectItem value="on_hold">On-Hold</SelectItem>
                                            <SelectItem value="passed">Passed</SelectItem>
                                            <SelectItem value="move_next">Move to Next Round</SelectItem>
                                            <SelectItem value="rejected">Reject</SelectItem>
                                          </SelectContent>
                                        </Select>
                                      </div>

                                      <div className="grid gap-1 md:col-span-3">
                                        <div className="text-xs font-medium text-muted-foreground">Interview date & time</div>
                                        <Input
                                          type="datetime-local"
                                          value={draft.scheduledAtLocal}
                                          onChange={(e) =>
                                            setInterviewDraftByKey((prev) => ({
                                              ...prev,
                                              [draftKey]: { ...draft, scheduledAtLocal: e.target.value }
                                            }))
                                          }
                                          className="h-8"
                                        />
                                      </div>

                                      <div className="grid gap-1 md:col-span-6">
                                        <div className="text-xs font-medium text-muted-foreground">Notes</div>
                                        <Textarea
                                          value={draft.notes}
                                          onChange={(e) =>
                                            setInterviewDraftByKey((prev) => ({
                                              ...prev,
                                              [draftKey]: { ...draft, notes: e.target.value }
                                            }))
                                          }
                                          className="min-h-[38px] resize-none"
                                          placeholder="Add notes…"
                                        />
                                      </div>
                                    </div>
                                  </div>
                                </CardContent>
                              </Card>
                            )
                          })}

                          {filtered.length === 0 ? (
                            <div className="text-center py-10 text-gray-400 text-sm border border-dashed rounded-lg bg-gray-50/40">
                              No candidates
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )
                  })()
                )}
              </div>
            </>
          ) : null}
        </div>

          {activeStage !== "interview" ? (
            <>
              {(activeStage === "all" ? applications : applications.filter((a) => a.status === activeStage)).map((app) => (
                <Card
                  key={app.id}
                  className={`shadow-sm hover:shadow-md transition-shadow ${app.status === "pending" ? "bg-yellow-50 border-yellow-200" : ""}`}
                >
                  <CardContent className="p-4 space-y-4">
                    <div className="flex justify-between items-start">
                      <div className="flex gap-3">
                        <Avatar className="h-10 w-10 border border-gray-200">
                          <AvatarFallback className="bg-blue-100 text-blue-700">
                            {app.candidates?.name?.substring(0, 2).toUpperCase() || "CN"}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium text-base flex items-center gap-2">
                            {app.candidates?.name}
                            {app.match_score !== undefined && app.match_score !== null && (
                              <Badge variant="outline" className={`text-xs font-normal ${
                                app.match_score >= 0.8 ? "bg-green-50 text-green-700 border-green-200" :
                                app.match_score >= 0.6 ? "bg-yellow-50 text-yellow-700 border-yellow-200" :
                                "bg-gray-50 text-gray-700 border-gray-200"
                              }`}>
                                {Math.round(app.match_score * 100)}% Match
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm text-gray-500">
                            {app.candidates?.current_role || "No role specified"}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="h-8"
                          onClick={() => openPreview(app)}
                        >
                          <Eye className="h-4 w-4 mr-2" />
                          View Profile
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8"
                          disabled={!!candidateAiLoadingById[app.candidate_id]}
                          onClick={() => toggleCandidateAi(app.candidate_id)}
                        >
                          {candidateAiLoadingById[app.candidate_id] ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                          AI
                        </Button>
                        <Select value={app.status} onValueChange={(val) => requestStageChange(app, val)}>
                          <SelectTrigger className="h-8 w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_COLUMNS.map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                <div className="grid grid-cols-2 gap-4 text-xs text-gray-500">
                    <div className="flex items-center gap-1">
                        <span className="font-medium text-gray-700">Source:</span>
                        <span className="capitalize px-2 py-0.5 bg-gray-100 rounded text-gray-600">
                            {app.source?.replace('_', ' ') || 'Unknown'}
                        </span>
                    </div>
                    <div className="flex items-center gap-1 justify-end">
                        <Calendar className="h-3.5 w-3.5" />
                        Applied: {format(new Date(app.applied_at), "MMM d, yyyy")}
                    </div>
                </div>

                {/* Notes Section */}
                <div className="pt-3 border-t border-gray-100">
                    <div className="flex items-center gap-2 mb-2">
                        <MessageSquare className="h-3.5 w-3.5 text-gray-400" />
                        <span className="text-xs font-medium text-gray-700">Notes</span>
                    </div>
                    
                    {editingNoteId === app.id ? (
                        <div className="space-y-2">
                            <Textarea 
                                value={noteContent}
                                onChange={(e) => setNoteContent(e.target.value)}
                                placeholder="Add notes about this candidate..."
                                className="min-h-[80px] text-sm"
                            />
                            <div className="flex justify-end gap-2">
                                <Button 
                                    variant="ghost" 
                                    size="sm" 
                                    onClick={() => setEditingNoteId(null)}
                                    className="h-7 text-xs"
                                >
                                    Cancel
                                </Button>
                                <Button 
                                    size="sm" 
                                    onClick={() => saveNote(app.id)}
                                    className="h-7 text-xs bg-blue-600 hover:bg-blue-700"
                                >
                                    <Save className="h-3 w-3 mr-1" />
                                    Save Note
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div 
                            className="bg-gray-50 rounded p-3 text-sm text-gray-600 cursor-pointer hover:bg-gray-100 transition-colors min-h-[40px]"
                            onClick={() => handleNoteEdit(app)}
                        >
                            {app.notes ? (
                                <p className="whitespace-pre-wrap">{app.notes}</p>
                            ) : (
                                <p className="text-gray-400 italic">Click to add notes...</p>
                            )}
                        </div>
                    )}
                </div>

                {candidateAiById[app.candidate_id]?.summary && candidateAiById[app.candidate_id]?.visible ? (
                  <div className="rounded-lg border bg-purple-50/40 p-3">
                    <div className="text-xs font-semibold text-purple-700 mb-1">AI Analysis</div>
                    <div className="text-sm text-gray-700 whitespace-pre-wrap">
                      {candidateAiById[app.candidate_id].expanded
                        ? candidateAiById[app.candidate_id].summary
                        : candidateAiById[app.candidate_id].summary.length > 260
                          ? candidateAiById[app.candidate_id].summary.slice(0, 260) + "…"
                          : candidateAiById[app.candidate_id].summary}
                    </div>
                    {candidateAiById[app.candidate_id].summary.length > 260 ? (
                      <div className="mt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() =>
                            setCandidateAiById((prev) => ({
                              ...prev,
                              [app.candidate_id]: { ...prev[app.candidate_id], expanded: !prev[app.candidate_id].expanded }
                            }))
                          }
                        >
                          {candidateAiById[app.candidate_id].expanded ? "View less" : "View more"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
                </Card>
              ))}

              {(activeStage === "all" ? applications.length === 0 : applications.filter((a) => a.status === activeStage).length === 0) && (
                <div className="text-center py-12 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg bg-gray-50/50">
                  <div className="flex flex-col items-center">
                    <div className="h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                      <User className="h-5 w-5 text-gray-400" />
                    </div>
                    <p>No candidates in this stage</p>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

      {selectedCandidate && (
        <CandidatePreviewDialogDynamic
          candidate={selectedCandidate}
          isOpen={!!selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
          jobId={job.id}
          showRelevanceScore={false}
        />
      )}
    </div>
  )
}
