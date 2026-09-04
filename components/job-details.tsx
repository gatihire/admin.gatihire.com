"use client"

import { useState, useEffect, useCallback } from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/components/ui/use-toast"
import { ArrowLeft, ExternalLink, Link2, MapPin, Building2, Clock, Send, Share2, Upload, ChevronDown } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { cachedFetchJson, getBoardJobApplyUrl, invalidateSessionCache, normalizeExternalUrl } from "@/lib/utils"

const CandidateProfileSidebarDynamic = dynamic(() => import("./candidate-profile-sidebar").then(m => m.CandidateProfileSidebar), { ssr: false })
const CandidatesTab = dynamic(() => import("./job-candidates-tab").then(m => m.CandidatesTab), { ssr: false })
const SourcingTab = dynamic(() => import("./job-sourcing-tab").then(m => m.SourcingTab), { ssr: false })
const InvitesTab = dynamic(() => import("./job-invites-tab").then(m => m.InvitesTab), { ssr: false })
const ShareShortlistDialog = dynamic(() => import("./shortlist-share-dialog").then(m => m.ShareShortlistDialog), { ssr: false })
const JobUploadDialog = dynamic(() => import("./job-upload-dialog").then(m => m.JobUploadDialog), { ssr: false })

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
  id: string; name: string; slug: string; website: string
  company_type: string | null; location: string | null; about: string | null; logo_url: string | null
  primary_contact_name: string | null; primary_contact_email: string | null; primary_contact_phone: string | null
}

interface Application {
  id: string; candidate_id: string; status: string; applied_at: string; notes: string
  source?: string; match_score?: number
  candidates: { name: string; email: string; current_role: string; location: string; [key: string]: any }
}

type TabId = "pipeline" | "sourcing" | "invites"

const PRIMARY_TAB = { id: "pipeline", label: "Pipeline" } as const
const SECONDARY_TABS = [
  { id: "sourcing", label: "DB Matches" },
  { id: "invites", label: "Invites" },
] as const

const LEGACY_TAB: Record<string, TabId> = {
  candidates: "pipeline", db_matches: "sourcing", juicebox: "sourcing",
  sourcing: "sourcing", invites: "invites",
}

function parseTab(raw: string | null): TabId | null {
  if (!raw) return null
  if (raw in LEGACY_TAB) return LEGACY_TAB[raw]
  if (raw === PRIMARY_TAB.id || SECONDARY_TABS.some((t) => t.id === raw)) return raw as TabId
  return null
}

interface JobDetailsProps {
  job: Job
  onBack: () => void
  initialTab?: string
}

export function JobDetails({ job, onBack, initialTab }: JobDetailsProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [applications, setApplications] = useState<Application[]>([])
  const [applicationLoading, setApplicationLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const t = parseTab(initialTab ?? null)
    return t || "pipeline"
  })
  const [candidateStage, setCandidateStage] = useState<string>("applied")
  const [candidateSubFilter, setCandidateSubFilter] = useState<string>("all")
  const [selectedCandidate, setSelectedCandidate] = useState<any | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [clientOpen, setClientOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [clientDecisions, setClientDecisions] = useState<Record<string, string | null>>({})
  const [sourcingView, setSourcingView] = useState<"db_matches" | "juicebox">("db_matches")

  const clientLabel = job.client_name || client?.name || null
  const publicApplyUrl = getBoardJobApplyUrl(job.id)

  useEffect(() => {
    fetchApplications()
    fetchClientDecisions()
    if (job.client_id) fetchClient()
  }, [job.id])

  const fetchClientDecisions = async () => {
    try {
      const res = await fetch(`/api/jobs/${job.id}/shortlist-share`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) return
      const map: Record<string, string | null> = {}
      for (const s of data.shares || []) {
        for (const c of s.candidates || []) {
          map[c.applicationId] = c.status
        }
      }
      setClientDecisions(map)
    } catch { /* noop */ }
  }

  const fetchClient = async () => {
    try {
      const rows = await cachedFetchJson<any[]>("internal:clients:list", "/api/clients", undefined, { ttlMs: 10 * 60_000 })
      const found = Array.isArray(rows) ? rows.find((c: any) => c.id === job.client_id) : null
      setClient(found || null)
    } catch { setClient(null) }
  }

  const fetchApplications = async (opts?: { force?: boolean }) => {
    setApplicationLoading(true)
    try {
      const data = await cachedFetchJson<Application[]>(
        `internal:applications:job:${job.id}`, `/api/applications?jobId=${job.id}`,
        undefined, { ttlMs: 2 * 60_000, force: Boolean(opts?.force) }
      )
      setApplications(Array.isArray(data) ? data : [])
    } catch {
      toast({ title: "Failed to load candidates", variant: "destructive" })
    } finally {
      setApplicationLoading(false)
    }
  }

  const goToTab = useCallback((tab: TabId) => {
    setActiveTab(tab)
    const params = new URLSearchParams()
    if (tab !== "pipeline") params.set("tab", tab)
    const qs = params.toString()
    router.replace(`/jobs/${job.id}${qs ? `?${qs}` : ""}`, { scroll: false })
  }, [job.id, router])

  const selectStage = useCallback((stage: string) => {
    setActiveTab("pipeline")
    setCandidateStage(stage)
    const params = new URLSearchParams()
    if (stage && stage !== "all") params.set("stage", stage)
    const qs = params.toString()
    router.replace(`/jobs/${job.id}${qs ? `?${qs}` : ""}`, { scroll: false })
  }, [job.id, router])

  const updateStatus = useCallback(async (applicationId: string, newStatus: string, rejectionReason?: string) => {
    setApplications((prev) => prev.map((app) => app.id === applicationId ? { ...app, status: newStatus } : app))
    try {
      const res = await fetch(`/api/applications/${applicationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, rejection_reason: rejectionReason }),
      })
      if (!res.ok) throw new Error("Failed")
      toast({ title: "Status Updated", description: `Moved to ${newStatus}` })
      invalidateSessionCache(`internal:applications:job:${job.id}`)
    } catch {
      toast({ title: "Update failed", variant: "destructive" })
      fetchApplications({ force: true })
    }
  }, [job.id, toast])

  const updateApplication = useCallback((updated: Application) => {
    setApplications((prev) => prev.map((app) => app.id === updated.id ? updated : app))
    invalidateSessionCache(`internal:applications:job:${job.id}`)
  }, [job.id])

  const renderTab = () => {
    switch (activeTab) {
      case "pipeline":
        return (
          <CandidatesTab
            jobId={job.id}
            applications={applications}
            loading={applicationLoading}
            activeStage={candidateStage}
            activeCallSubFilter={candidateSubFilter}
            clientDecisions={clientDecisions}
            onStageSelect={selectStage}
            onCallSubFilterChange={setCandidateSubFilter}
            onStageChange={updateStatus}
            onApplicationUpdated={updateApplication}
            onViewProfile={setSelectedCandidate}
            onRefresh={() => fetchApplications({ force: true })}
          />
        )
      case "sourcing":
        return (
          <SourcingTab
            jobId={job.id}
            jobTitle={job.title}
            view={sourcingView}
            onViewChange={setSourcingView}
            onViewProfile={setSelectedCandidate}
            onCandidateAdded={() => fetchApplications({ force: true })}
          />
        )
      case "invites":
        return <InvitesTab jobId={job.id} />
      default:
        return null
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="p-6 md:p-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="flex items-start gap-4">
              <Button variant="ghost" size="icon" onClick={onBack} className="h-10 w-10 shrink-0 rounded-full border border-zinc-200 bg-white shadow-sm hover:bg-zinc-50 hover:border-zinc-300 transition-all mt-1">
                <ArrowLeft className="h-5 w-5 text-zinc-600" />
              </Button>
              <div className="space-y-1.5">
                <h2 className="text-2xl md:text-3xl font-extrabold text-zinc-900 tracking-tight leading-tight">{job.title}</h2>
                <div className="flex flex-wrap items-center gap-y-2 gap-x-4">
                  {clientLabel && (
                    <button onClick={() => setClientOpen(true)} className="flex items-center gap-2 text-blue-600 hover:text-blue-700 font-bold transition-all bg-blue-50/50 hover:bg-blue-50 px-3 py-1.5 rounded-lg text-sm border border-blue-100/50 shadow-sm">
                      {client?.logo_url ? (<img src={client.logo_url} alt="" className="h-4 w-4 rounded-sm object-contain" />) : (<Building2 className="h-4 w-4" />)}
                      {clientLabel}
                    </button>
                  )}
                  <div className="flex items-center gap-1.5 text-zinc-500 text-sm font-medium"><MapPin className="h-4 w-4 text-zinc-400" />{job.location}</div>
                  <div className="flex items-center gap-1.5 text-zinc-500 text-sm font-medium"><Building2 className="h-4 w-4 text-zinc-400" />{job.industry || "General"}</div>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 px-3 border-zinc-200 shadow-sm bg-white hover:bg-zinc-50 font-bold text-zinc-700 rounded-xl text-xs gap-1.5">
                    Actions <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={() => setUploadOpen(true)}>
                    <Upload className="h-3.5 w-3.5 mr-2" />Upload Resume
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShareOpen(true)} disabled={applications.filter(a => a.status === "shortlist").length === 0}>
                    <Share2 className="h-3.5 w-3.5 mr-2" />Share Shortlist
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { navigator.clipboard.writeText(publicApplyUrl); toast({ title: "Copied", description: "Application link copied" }) }}>
                    <Link2 className="h-3.5 w-3.5 mr-2" />Copy Link
                  </DropdownMenuItem>
                  {!job.is_external_link && (
                    <DropdownMenuItem onClick={() => window.open(`/jobs/${job.id}/outreach`, "_blank")}>
                      <Send className="h-3.5 w-3.5 mr-2" />Outreach
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <a href={publicApplyUrl} target="_blank" rel="noopener noreferrer" className="h-9 px-3 flex items-center gap-1.5 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl text-xs font-bold transition-all shadow-md">
                <ExternalLink className="h-3.5 w-3.5" />Public Page
              </a>
            </div>
          </div>
        </div>
        <div className="px-6 py-4 bg-zinc-50/50 border-t border-zinc-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={`px-3 py-1 text-xs font-bold tracking-wide rounded-full ${job.status === 'open' ? 'bg-emerald-500 text-white' : 'bg-zinc-500 text-white'}`}>{job.status.toUpperCase()}</Badge>
            {job.employment_type && <Badge variant="outline" className="bg-white text-zinc-600 border-zinc-200 px-3 py-1 text-xs font-bold tracking-wide rounded-full">{String(job.employment_type).replace(/_/g, " ").toUpperCase()}</Badge>}
            {job.is_external_link && <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 px-3 py-1 text-xs font-bold tracking-wide rounded-full">EXTERNAL</Badge>}
            {job.source && <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 px-3 py-1 text-xs font-bold tracking-wide rounded-full">{job.source.toUpperCase()}</Badge>}
          </div>
          <div className="text-xs text-zinc-400 font-bold flex items-center gap-2 uppercase tracking-tight">
            <Clock className="h-3.5 w-3.5" />Posted {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-x-auto no-scrollbar">
        <button
          type="button"
          className={`px-5 py-2.5 rounded-xl text-xs font-bold tracking-wide transition-all whitespace-nowrap ${
            activeTab === PRIMARY_TAB.id
              ? "bg-zinc-900 text-white shadow-md"
              : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50"
          }`}
          onClick={() => goToTab(PRIMARY_TAB.id)}
        >
          {PRIMARY_TAB.label} ({applications.length})
        </button>
        <div className="h-6 w-px bg-zinc-200 mx-1 hidden sm:block" />
        {SECONDARY_TABS.map((tab) => {
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              className={`px-5 py-2.5 rounded-xl text-xs font-bold tracking-wide transition-all whitespace-nowrap ${
                active
                  ? "bg-zinc-900 text-white shadow-md"
                  : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50"
              }`}
              onClick={() => goToTab(tab.id as TabId)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      {renderTab()}

      {/* Dialogs */}
      {selectedCandidate && (
        <CandidateProfileSidebarDynamic
          candidate={selectedCandidate}
          isOpen={!!selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
          jobId={job.id}
        />
      )}

      <ShareShortlistDialog jobId={job.id} jobTitle={job.title} open={shareOpen} onOpenChange={setShareOpen} onDecisionsChanged={() => { fetchClientDecisions(); fetchApplications({ force: true }) }} />
      <JobUploadDialog jobId={job.id} jobTitle={job.title} open={uploadOpen} onOpenChange={setUploadOpen} onComplete={() => fetchApplications({ force: true })} />

      {/* Client Sheet */}
      <Sheet open={clientOpen} onOpenChange={setClientOpen}>
        <SheetContent className="sm:max-w-[540px] overflow-y-auto">
          <SheetHeader className="pb-6 border-b">
            <SheetTitle className="text-2xl font-bold">{client?.name || clientLabel || "Client Details"}</SheetTitle>
            <SheetDescription>Full company profile and contact information.</SheetDescription>
          </SheetHeader>
          <div className="py-6 space-y-8">
            <div className="flex items-start gap-5">
              {client?.logo_url ? (<img src={client.logo_url} alt="Logo" className="h-20 w-20 rounded-2xl border bg-white object-contain p-2 shadow-sm" />) : (<div className="h-20 w-20 rounded-2xl border bg-zinc-50 flex items-center justify-center shadow-sm"><Building2 className="h-10 w-10 text-zinc-400" /></div>)}
              <div className="space-y-1">
                <h3 className="text-xl font-semibold text-zinc-900">{client?.name}</h3>
                {client?.website && (<a href={normalizeExternalUrl(client.website)} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline flex items-center gap-1.5"><ExternalLink className="h-3.5 w-3.5" />{client.website.replace(/^https?:\/\//, '')}</a>)}
              </div>
            </div>
            <div className="space-y-3">
              <h4 className="text-sm font-bold uppercase tracking-wider text-zinc-500">About</h4>
              <p className="text-sm text-zinc-600 leading-relaxed whitespace-pre-wrap bg-zinc-50 p-4 rounded-xl border border-zinc-100">{client?.about || "No description provided."}</p>
            </div>
            <div className="space-y-4">
              <h4 className="text-sm font-bold uppercase tracking-wider text-zinc-500">Contact</h4>
              {client?.primary_contact_name && (<div className="flex items-center gap-3 p-3 rounded-xl border border-zinc-100 bg-white"><div className="h-10 w-10 rounded-full bg-blue-50 flex items-center justify-center text-blue-600"><span className="h-5 w-5" /></div><div><div className="text-sm font-medium text-zinc-900">{client.primary_contact_name}</div><div className="text-xs text-zinc-500">Contact Person</div></div></div>)}
              {client?.primary_contact_email && (<div className="flex items-center gap-3 p-3 rounded-xl border border-zinc-100 bg-white"><div className="h-10 w-10 rounded-full bg-green-50 flex items-center justify-center text-green-600"><span className="h-5 w-5" /></div><div><div className="text-sm font-medium text-zinc-900">{client.primary_contact_email}</div><div className="text-xs text-zinc-500">Email</div></div></div>)}
              {client?.primary_contact_phone && (<div className="flex items-center gap-3 p-3 rounded-xl border border-zinc-100 bg-white"><div className="h-10 w-10 rounded-full bg-orange-50 flex items-center justify-center text-orange-600"><span className="h-5 w-5" /></div><div><div className="text-sm font-medium text-zinc-900">{client.primary_contact_phone}</div><div className="text-xs text-zinc-500">Phone</div></div></div>)}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
