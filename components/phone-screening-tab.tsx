"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Phone, Loader2, Play, Clock, CheckCircle, XCircle, AlertCircle,
  PhoneCall, UserCheck, UserX, RefreshCw, Eye, ChevronRight
} from "lucide-react"
import { PhoneScreeningCandidateSelector } from "./phone-screening-candidate-selector"
import { PhoneScreeningResultsSheet } from "./phone-screening-results-sheet"

interface Campaign {
  id: string
  job_id: string
  created_by: string
  total_candidates: number
  status: string
  created_at: string
  updated_at: string
}

interface Participant {
  id: string
  campaign_id: string
  candidate_id: string
  job_id: string
  status: string
  origin?: string
  ai_score: number | null
  ai_recommendation: string | null
  call_duration_seconds: number | null
  scheduled_call_at?: string | null
  callback_preference?: string | null
  review_status?: string | null
  created_at: string
  candidates: {
    id: string
    name: string
    email: string
    phone: string
    current_role: string
  }
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: "Pending", color: "bg-zinc-100 text-zinc-600 border-zinc-200", icon: Clock },
  whatsapp_sent: { label: "WhatsApp Sent", color: "bg-blue-50 text-blue-600 border-blue-200", icon: Phone },
  whatsapp_delivered: { label: "Delivered", color: "bg-blue-50 text-blue-600 border-blue-200", icon: Phone },
  whatsapp_read: { label: "Read", color: "bg-blue-50 text-blue-700 border-blue-200", icon: Phone },
  interested: { label: "Interested", color: "bg-green-50 text-green-600 border-green-200", icon: CheckCircle },
  call_me_now: { label: "Call Now", color: "bg-green-50 text-green-600 border-green-200", icon: PhoneCall },
  calling: { label: "Calling", color: "bg-yellow-50 text-yellow-600 border-yellow-200", icon: PhoneCall },
  in_progress: { label: "In Progress", color: "bg-blue-50 text-blue-600 border-blue-200", icon: Phone },
  call_scheduled: { label: "Call Scheduled", color: "bg-amber-50 text-amber-600 border-amber-200", icon: Clock },
  completed: { label: "Completed", color: "bg-green-50 text-green-600 border-green-200", icon: CheckCircle },
  failed: { label: "Failed", color: "bg-orange-50 text-orange-600 border-orange-200", icon: AlertCircle },
  not_interested: { label: "Not Interested", color: "bg-red-50 text-red-600 border-red-200", icon: UserX },
  unreachable: { label: "Unreachable", color: "bg-red-50 text-red-600 border-red-200", icon: XCircle },
  needs_manual_followup: { label: "Needs Follow-up", color: "bg-orange-50 text-orange-600 border-orange-200", icon: AlertCircle },
  rescheduled: { label: "Rescheduled", color: "bg-amber-50 text-amber-600 border-amber-200", icon: RefreshCw },
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending
  const Icon = config.icon
  return (
    <Badge variant="outline" className={`gap-1.5 px-3 py-1 text-[11px] font-bold tracking-wide ${config.color}`}>
      <Icon className="h-3.5 w-3.5" />
      {config.label}
    </Badge>
  )
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "--"
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

export function PhoneScreeningTab({ jobId }: { jobId: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [participantsLoading, setParticipantsLoading] = useState(false)
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [selectedParticipantId, setSelectedParticipantId] = useState<string | null>(null)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [allCampaignParticipants, setAllCampaignParticipants] = useState<Record<string, Participant[]>>({})

  const fetchCampaigns = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/phone-screening/campaigns?jobId=${jobId}`)
      if (res.ok) {
        const data = await res.json()
        setCampaigns(data)
        if (data.length > 0 && !activeCampaignId) {
          setActiveCampaignId(data[0].id)
        }
      }
    } catch {
      /* noop */
    } finally {
      setLoading(false)
    }
  }, [jobId, activeCampaignId])

  useEffect(() => {
    fetchCampaigns()
  }, [fetchCampaigns])

  useEffect(() => {
    if (campaigns.length === 0) return
    const fetchAll = async () => {
      const map: Record<string, Participant[]> = {}
      await Promise.all(
        campaigns.map(async (c) => {
          try {
            const res = await fetch(`/api/phone-screening/participants?campaignId=${c.id}`)
            if (res.ok) map[c.id] = await res.json()
          } catch { /* noop */ }
        })
      )
      setAllCampaignParticipants(map)
    }
    fetchAll()
  }, [campaigns])

  const fetchParticipants = useCallback(async (campaignId: string) => {
    setParticipantsLoading(true)
    try {
      const res = await fetch(`/api/phone-screening/participants?campaignId=${campaignId}`)
      if (res.ok) {
        setParticipants(await res.json())
      }
    } catch {
      /* noop */
    } finally {
      setParticipantsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeCampaignId) {
      fetchParticipants(activeCampaignId)
    }
  }, [activeCampaignId, fetchParticipants])

  const handleViewResults = (participantId: string) => {
    setSelectedParticipantId(participantId)
    setResultsOpen(true)
  }

  const pollInterval = activeCampaignId && participants.some(
    (p) => ["scheduled", "call_scheduled", "calling", "in_progress", "failed"].includes(p.status)
  )

  useEffect(() => {
    if (!pollInterval || !activeCampaignId) return
    const interval = setInterval(() => fetchParticipants(activeCampaignId), 5000)
    return () => clearInterval(interval)
  }, [pollInterval, activeCampaignId, fetchParticipants])

  const campaignStats = (campaignId: string) => {
    const campParticipants = campaignId === activeCampaignId ? participants : (allCampaignParticipants[campaignId] || [])
    return {
      total: campParticipants.length,
      completed: campParticipants.filter((p) => p.status === "completed").length,
      inProgress: campParticipants.filter((p) => ["calling", "in_progress", "call_scheduled"].includes(p.status)).length,
      failed: campParticipants.filter((p) => ["failed", "unreachable", "not_interested"].includes(p.status)).length,
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-zinc-800">Phone Screening</h3>
          <p className="text-sm text-zinc-500">AI-powered first-round screening via direct voice calls</p>
        </div>
        <Button onClick={() => setSelectorOpen(true)} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
          <Play className="h-4 w-4" />
          New Screening
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : campaigns.length === 0 ? (
        <Card className="border-dashed border-zinc-300 bg-zinc-50/50 rounded-2xl">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="h-12 w-12 rounded-2xl bg-emerald-100 flex items-center justify-center mb-4">
              <Phone className="h-6 w-6 text-emerald-600" />
            </div>
            <p className="text-zinc-500 font-semibold">No screening campaigns yet</p>
            <p className="text-sm text-zinc-400 mt-1">Click "New Screening" to start your first automated screening</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {campaigns.map((campaign) => {
            const stats = campaignStats(campaign.id)
            const isActive = activeCampaignId === campaign.id
            return (
              <Card
                key={campaign.id}
                className={`rounded-2xl cursor-pointer transition-all border ${
                  isActive ? "border-emerald-300 ring-1 ring-emerald-200" : "border-zinc-200 hover:border-zinc-300"
                }`}
                onClick={() => setActiveCampaignId(campaign.id)}
              >
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${
                        campaign.status === "completed" ? "bg-green-100" : campaign.status === "in_progress" ? "bg-blue-100" : "bg-zinc-100"
                      }`}>
                        <Phone className={`h-5 w-5 ${
                          campaign.status === "completed" ? "text-green-600" : campaign.status === "in_progress" ? "text-blue-600" : "text-zinc-500"
                        }`} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-bold text-zinc-800">Campaign • {formatDate(campaign.created_at)}</p>
                          <Badge className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            campaign.status === "completed"
                              ? "bg-green-100 text-green-700 border-green-200"
                              : campaign.status === "in_progress"
                              ? "bg-blue-100 text-blue-700 border-blue-200"
                              : "bg-zinc-100 text-zinc-600 border-zinc-200"
                          }`}>
                            {campaign.status === "completed" ? "COMPLETED" : campaign.status === "in_progress" ? "IN PROGRESS" : "PENDING"}
                          </Badge>
                        </div>
                        <p className="text-xs text-zinc-500">{campaign.total_candidates} candidates</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2 text-xs font-semibold">
                        <span className="text-green-600">{stats.completed} done</span>
                        {stats.inProgress > 0 && <span className="text-blue-600">{stats.inProgress} active</span>}
                        {stats.failed > 0 && <span className="text-red-600">{stats.failed} failed</span>}
                      </div>
                      <ChevronRight className={`h-4 w-4 text-zinc-400 transition-transform ${isActive ? "rotate-90" : ""}`} />
                    </div>
                  </div>

                  {isActive && (
                    <div className="mt-4 pt-4 border-t border-zinc-100">
                      {participantsLoading ? (
                        <div className="flex justify-center py-4">
                          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {participants.map((p) => (
                            <div
                              key={p.id}
                              className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 hover:bg-zinc-100 transition-colors"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="h-8 w-8 rounded-full bg-zinc-200 flex items-center justify-center flex-shrink-0">
                                  <span className="text-xs font-bold text-zinc-600">
                                    {p.candidates.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()}
                                  </span>
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold text-zinc-800 truncate">{p.candidates.name}</p>
                                    <Badge
                                      variant="outline"
                                      className={`shrink-0 text-[9px] font-bold px-1.5 py-0 rounded-full border-none ${
                                        p.origin === "outbound" ? "bg-violet-100 text-violet-700" : "bg-blue-100 text-blue-700"
                                      }`}
                                    >
                                      {p.origin === "outbound" ? "Outbound" : "Inbound"}
                                    </Badge>
                                  </div>
                                  <p className="text-xs text-zinc-400 truncate">{p.candidates.current_role || "No role specified"}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <StatusBadge status={p.status} />
                                {p.status === "call_scheduled" && p.scheduled_call_at && (
                                  <Badge variant="outline" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border-amber-200 gap-1">
                                    <Clock className="h-3 w-3" />
                                    {formatDate(p.scheduled_call_at)}
                                  </Badge>
                                )}
                                {p.status === "call_scheduled" && p.callback_preference && (
                                  <span className="text-[10px] text-amber-600 max-w-[120px] truncate" title={p.callback_preference}>
                                    "{p.callback_preference}"
                                  </span>
                                )}
                                {p.review_status === "approved" && (
                                  <Badge variant="outline" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border-green-200">
                                    Approved
                                  </Badge>
                                )}
                                {p.review_status === "rejected" && (
                                  <Badge variant="outline" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-600 border-red-200">
                                    Rejected
                                  </Badge>
                                )}
                                {p.status === "completed" && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 text-xs gap-1"
                                    onClick={(e) => { e.stopPropagation(); handleViewResults(p.id) }}
                                  >
                                    <Eye className="h-3.5 w-3.5" />
                                    View
                                  </Button>
                                )}
                                {p.ai_score && (
                                  <span className={`text-sm font-black ${
                                    (p.ai_score || 0) >= 7 ? "text-green-600" : (p.ai_score || 0) >= 4 ? "text-amber-600" : "text-red-600"
                                  }`}>
                                    {p.ai_score}/10
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                          {participants.length === 0 && (
                            <p className="text-sm text-zinc-400 text-center py-4">No participants in this campaign</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <PhoneScreeningCandidateSelector
        jobId={jobId}
        open={selectorOpen}
        onOpenChange={setSelectorOpen}
        onComplete={() => {
          fetchCampaigns()
        }}
      />

      <PhoneScreeningResultsSheet
        participantId={selectedParticipantId}
        open={resultsOpen}
        onOpenChange={setResultsOpen}
      />
    </div>
  )
}
