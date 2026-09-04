"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import {
  Loader2, Star, Target, AlertTriangle, CheckCircle, Clock,
  DollarSign, User, Phone as PhoneIcon,
  ExternalLink, ThumbsUp, ThumbsDown, PhoneCall, Play, Pause,
  MessageSquare, BarChart3, Mic, Send, CheckCheck, MessageCircle,
  ArrowDown, CircleDot, Smartphone, Volume2, Download, Bot, Settings
} from "lucide-react"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"

interface TranscriptSegment {
  id: string
  speaker: "ai" | "candidate"
  text: string
  start_time_sec: number | null
  end_time_sec: number | null
}

interface ScreeningAnswer {
  id: string
  question_key: string
  question_text: string
  answer_text: string
  sentiment: string | null
}

interface WhatsAppMessage {
  messageId: string | null
  template: string
  sentAt: string
  status: string
}

interface ParticipantDetail {
  id: string
  status: string
  origin?: string
  ai_score: number | null
  ai_summary: string | null
  ai_recommendation: string | null
  call_duration_seconds: number | null
  call_started_at: string | null
  call_ended_at?: string | null
  scheduled_call_at?: string | null
  recording_url: string | null
  review_status?: string | null
  reviewed_by?: string | null
  review_note?: string | null
  callback_preference?: string | null
  verdict_json?: Record<string, unknown> | string | null
  enriched_summary?: {
    comprehensive_summary?: string
    fit_assessment?: string
    strengths?: string[]
    concerns?: string[]
    salary_analysis?: { current?: string; expected?: string; risk?: string; notes?: string }
    relocation_assessment?: string
    recommended_next_steps?: string
    interview_focus_areas?: string[]
    overall_verdict?: string
    confidence_score?: number
  } | null
  call_cost_cents?: number | null
  cost_breakdown?: Record<string, number> | null
  carrier?: string | null
  hangup_by?: string | null
  ring_duration?: number | null
  call_voicemail?: boolean | null
  whatsapp_sent_at?: string | null
  whatsapp_delivery_status?: string | null
  whatsapp_reply_text?: string | null
  whatsapp_reply_at?: string | null
  whatsapp_history?: WhatsAppMessage[] | null
  call_payload_json?: Record<string, unknown> | null
  generated_questions?: string | null
  screening_context?: {
    jobTitle?: string
    clientName?: string
    origin?: string
    salaryRange?: string
    mustHaveSkills?: string
    experienceRange?: string
    location?: string
  } | null
  candidates: {
    name: string
    email: string
    phone: string
    current_role: string
    current_company: string
    total_experience: string
    location: string
  }
  transcripts: TranscriptSegment[]
  answers: ScreeningAnswer[]
}

function ScoreBadge({ score }: { score: number }) {
  let color: string
  if (score >= 7) color = "bg-green-100 text-green-700 border-green-300"
  else if (score >= 4) color = "bg-amber-100 text-amber-700 border-amber-300"
  else color = "bg-red-100 text-red-700 border-red-300"

  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border ${color}`}>
      <Star className="h-4 w-4 fill-current" />
      <span className="font-black text-lg">{score}</span>
      <span className="text-xs font-semibold opacity-70">/10</span>
    </div>
  )
}

function RecommendationBadge({ recommendation }: { recommendation: string }) {
  const config: Record<string, { label: string; color: string }> = {
    advance: { label: "Advance", color: "bg-green-100 text-green-700 border-green-300" },
    further_review: { label: "Further Review", color: "bg-amber-100 text-amber-700 border-amber-300" },
    not_a_fit: { label: "Not a Fit", color: "bg-red-100 text-red-700 border-red-300" },
  }
  const c = config[recommendation] || { label: recommendation, color: "bg-zinc-100 text-zinc-600" }
  return (
    <Badge variant="outline" className={`gap-1.5 px-3 py-1.5 text-xs font-bold ${c.color}`}>
      <Target className="h-3.5 w-3.5" />
      {c.label}
    </Badge>
  )
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "--"
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

function formatCallTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  })
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function formatCost(cents: number | null | undefined): string {
  if (!cents) return "--"
  return `₹${(cents / 100).toFixed(2)}`
}

type TabId = "transcript" | "whatsapp" | "recording" | "qa" | "jd_fit" | "agent_config"

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "transcript", label: "Transcript", icon: MessageSquare },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { id: "recording", label: "Recording", icon: Mic },
  { id: "qa", label: "Q&A", icon: BarChart3 },
  { id: "jd_fit", label: "JD Fit", icon: Target },
  { id: "agent_config", label: "AI Context", icon: Settings },
]

export function PhoneScreeningResultsSheet({
  participantId,
  open,
  onOpenChange,
}: {
  participantId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<ParticipantDetail | null>(null)
  const [approveStage, setApproveStage] = useState("shortlist")
  const [reviewBusy, setReviewBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>("transcript")
  const [isPlaying, setIsPlaying] = useState(false)
  const [audioProgress, setAudioProgress] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const { toast } = useToast()

  useEffect(() => {
    if (!open || !participantId) return
    setLoading(true)
    setData(null)
    setActiveTab("transcript")
    setIsPlaying(false)
    setAudioProgress(0)

    fetch(`/api/phone-screening/participants/${participantId}`)
      .then((res) => res.json())
      .then((json) => setData(json))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [open, participantId])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTimeUpdate = () => setAudioProgress(audio.currentTime)
    const onLoadedMetadata = () => setAudioDuration(audio.duration)
    const onEnded = () => setIsPlaying(false)
    audio.addEventListener("timeupdate", onTimeUpdate)
    audio.addEventListener("loadedmetadata", onLoadedMetadata)
    audio.addEventListener("ended", onEnded)
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate)
      audio.removeEventListener("loadedmetadata", onLoadedMetadata)
      audio.removeEventListener("ended", onEnded)
    }
  }, [data?.recording_url])

  const togglePlayPause = () => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) { audio.pause() } else { audio.play() }
    setIsPlaying(!isPlaying)
  }

  const seekAudio = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current
    if (!audio || !audioDuration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    audio.currentTime = pct * audioDuration
  }

  const submitReview = async (decision: "approve" | "reject") => {
    if (!participantId) return
    setReviewBusy(true)
    try {
      const body: any = { decision }
      if (decision === "approve") body.nextStatus = approveStage
      const res = await fetch(`/api/phone-screening/participants/${participantId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to save decision")
      toast({
        title: decision === "approve" ? "Approved" : "Rejected",
        description: decision === "approve" ? `Moved to ${approveStage}` : "Candidate moved to rejected",
      })
      setData((prev) => (prev ? { ...prev, review_status: decision } : prev))
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" })
    } finally {
      setReviewBusy(false)
    }
  }

  const parsedSummary = data?.ai_summary
    ? (() => { try { return JSON.parse(data.ai_summary) as Record<string, unknown> } catch { return null } })()
    : null

  const enriched = data?.enriched_summary as Record<string, unknown> | null | undefined

  const verdict = data?.verdict_json
    ? (typeof data.verdict_json === "string" ? JSON.parse(data.verdict_json) : data.verdict_json)
    : null

  // Prefer enriched summary over basic verdict
  const pluses: string[] = (enriched?.strengths as string[]) || (verdict?.pluses as string[]) || ((parsedSummary?.pluses as string[]) || [])
  const minuses: string[] = (enriched?.concerns as string[]) || (verdict?.minuses as string[]) || ((parsedSummary?.minuses as string[]) || [])
  const verdictExplanation = (enriched?.comprehensive_summary as string) || (verdict?.verdict_explanation as string) || (parsedSummary?.verdict_explanation as string) || ""
  const fitAssessment = (enriched?.fit_assessment as string) || ""
  const salaryAnalysis = (enriched?.salary_analysis as { current?: string; expected?: string; risk?: string; notes?: string }) || null
  const relocationAssessment = (enriched?.relocation_assessment as string) || ""
  const nextSteps = (enriched?.recommended_next_steps as string) || ""
  const interviewFocus = (enriched?.interview_focus_areas as string[]) || []
  const overallVerdict = (enriched?.overall_verdict as string) || ""
  const confidenceScore = (enriched?.confidence_score as number) || null

  const jdFit = (parsedSummary?.jd_fit ?? null) as {
    matched_skills?: string[]; missing_skills?: string[]; experience_fit?: string; overall?: string
  } | null

  const whatsappHistory = data?.whatsapp_history || []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-[540px] overflow-y-auto p-0">
        {loading ? (
          <div className="flex items-center justify-center h-full py-20">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          </div>
        ) : !data ? (
          <div className="text-center py-20 text-zinc-400 font-semibold text-sm">No data available</div>
        ) : (
          <div className="flex flex-col h-full">
            {/* FIXED TOP: Header + Score + Verdict + Actions */}
            <div className="shrink-0 border-b border-zinc-200 bg-white">
              <div className="p-4 pb-0">
                <SheetHeader className="mb-3">
                  <SheetTitle className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-zinc-200 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-zinc-600">
                        {data.candidates.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <span className="block truncate">{data.candidates.name}</span>
                      <SheetDescription className="text-xs">{data.candidates.current_role}</SheetDescription>
                    </div>
                  </SheetTitle>
                </SheetHeader>

                <div className="flex items-center gap-2 flex-wrap mb-3">
                  {data.ai_score && <ScoreBadge score={data.ai_score} />}
                  {data.ai_recommendation && <RecommendationBadge recommendation={data.ai_recommendation} />}
                  {data.call_duration_seconds && (
                    <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs bg-zinc-50 border-zinc-200">
                      <Clock className="h-3.5 w-3.5" />
                      {formatDuration(data.call_duration_seconds)}
                    </Badge>
                  )}
                  {data.call_cost_cents != null && (
                    <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs bg-zinc-50 border-zinc-200">
                      <DollarSign className="h-3.5 w-3.5" />
                      {formatCost(data.call_cost_cents)}
                    </Badge>
                  )}
                </div>

                {data.callback_preference && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg border border-blue-100 bg-blue-50/50 text-sm text-blue-800 mb-3">
                    <PhoneCall className="h-4 w-4 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold">Callback requested:</span>{" "}
                      {data.callback_preference}
                      <div className="text-xs text-blue-600 mt-0.5">
                        {data.scheduled_call_at
                          ? `Re-dial scheduled for ${formatCallTime(data.scheduled_call_at)}`
                          : "Retry queued — next call placed automatically"}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Verdict summary — always visible */}
              {(verdict || enriched) && (verdictExplanation || pluses.length > 0 || minuses.length > 0 || fitAssessment) && (
                <div className="px-4 pb-3">
                  <div className="p-3 rounded-xl border border-zinc-200 bg-zinc-50/60 space-y-2">
                    {verdictExplanation && (
                      <p className="text-sm text-zinc-700 leading-relaxed">{verdictExplanation}</p>
                    )}
                    {fitAssessment && fitAssessment !== verdictExplanation && (
                      <div>
                        <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Fit Assessment</p>
                        <p className="text-xs text-zinc-600 leading-relaxed">{fitAssessment}</p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      {pluses.length > 0 && (
                        <div className="flex items-start gap-1.5">
                          <ThumbsUp className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                          <span className="text-green-700">{pluses.length} strengths</span>
                        </div>
                      )}
                      {minuses.length > 0 && (
                        <div className="flex items-start gap-1.5">
                          <ThumbsDown className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
                          <span className="text-amber-700">{minuses.length} concerns</span>
                        </div>
                      )}
                      {overallVerdict && (
                        <Badge variant="outline" className={`text-[10px] font-bold px-2 py-0.5 rounded-full border-none shadow-sm ${
                          overallVerdict === "strong_fit" ? "bg-emerald-100 text-emerald-700" :
                          overallVerdict === "good_fit" ? "bg-green-100 text-green-700" :
                          overallVerdict === "possible_fit" ? "bg-amber-100 text-amber-700" :
                          "bg-red-100 text-red-700"
                        }`}>
                          {overallVerdict.replace(/_/g, " ")}
                        </Badge>
                      )}
                      {confidenceScore != null && (
                        <span className="text-[10px] text-zinc-400">Confidence: {Math.round(confidenceScore * 100)}%</span>
                      )}
                    </div>
                    {salaryAnalysis && (salaryAnalysis.current || salaryAnalysis.expected) && (
                      <div className="pt-2 border-t border-zinc-200">
                        <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Salary Analysis</p>
                        <div className="flex flex-wrap gap-3 text-xs">
                          {salaryAnalysis.current && <span>Current: <span className="font-semibold text-zinc-700">{salaryAnalysis.current}</span></span>}
                          {salaryAnalysis.expected && <span>Expected: <span className="font-semibold text-zinc-700">{salaryAnalysis.expected}</span></span>}
                          {salaryAnalysis.risk && <span>Risk: <span className={`font-semibold ${salaryAnalysis.risk === "high" ? "text-red-600" : salaryAnalysis.risk === "medium" ? "text-amber-600" : "text-green-600"}`}>{salaryAnalysis.risk}</span></span>}
                        </div>
                        {salaryAnalysis.notes && <p className="text-xs text-zinc-500 mt-1">{salaryAnalysis.notes}</p>}
                      </div>
                    )}
                    {relocationAssessment && (
                      <div className="pt-2 border-t border-zinc-200">
                        <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Relocation</p>
                        <p className="text-xs text-zinc-600">{relocationAssessment}</p>
                      </div>
                    )}
                    {nextSteps && (
                      <div className="pt-2 border-t border-zinc-200">
                        <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Recommended Next Steps</p>
                        <p className="text-xs text-zinc-600">{nextSteps}</p>
                      </div>
                    )}
                    {interviewFocus.length > 0 && (
                      <div className="pt-2 border-t border-zinc-200">
                        <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Interview Focus Areas</p>
                        <ul className="text-xs text-zinc-600 space-y-0.5">
                          {interviewFocus.map((area, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              <span className="text-zinc-400 shrink-0">•</span>
                              {area}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Actions — always visible */}
              {data.status === "completed" && data.review_status !== "approved" && data.review_status !== "rejected" && (
                <div className="px-4 pb-3">
                  <div className="flex flex-col sm:flex-row gap-2 items-start">
                    <Select value={approveStage} onValueChange={setApproveStage}>
                      <SelectTrigger className="h-9 w-full sm:w-[190px] text-xs bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="shortlist">Shortlist</SelectItem>
                        <SelectItem value="interview">Interview</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <Button size="sm" className="h-9 text-xs bg-green-600 hover:bg-green-700 gap-1 flex-1 sm:flex-none" onClick={() => submitReview("approve")} disabled={reviewBusy}>
                        {reviewBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ThumbsUp className="h-3.5 w-3.5" />}
                        Approve
                      </Button>
                      <Button size="sm" className="h-9 text-xs bg-red-600 hover:bg-red-700 gap-1 flex-1 sm:flex-none" onClick={() => submitReview("reject")} disabled={reviewBusy}>
                        <ThumbsDown className="h-3.5 w-3.5" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {data.review_status && data.review_status !== "pending" && (
                <div className="px-4 pb-3">
                  <Badge variant="outline" className={`gap-1.5 px-3 py-1.5 text-xs font-bold ${
                    data.review_status === "approved" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-600 border-red-200"
                  }`}>
                    {data.review_status === "approved" ? <CheckCircle className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
                    {data.review_status === "approved" ? "Approved by team" : "Rejected by team"}
                  </Badge>
                </div>
              )}

              {/* Tabs */}
              <div className="px-4">
                <div className="flex border-b border-zinc-200 -mb-px overflow-x-auto">
                  {TABS.map((tab) => {
                    const Icon = tab.icon
                    const count = tab.id === "whatsapp" ? whatsappHistory.length :
                                  tab.id === "transcript" ? data.transcripts.length :
                                  tab.id === "qa" ? data.answers.length :
                                  tab.id === "recording" ? (data.recording_url ? 1 : 0) :
                                  tab.id === "jd_fit" ? (jdFit ? 1 : 0) : 0
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                          "flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors -mb-px whitespace-nowrap",
                          activeTab === tab.id
                            ? "border-zinc-900 text-zinc-900"
                            : "border-transparent text-zinc-400 hover:text-zinc-600"
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {tab.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* SCROLLABLE TAB CONTENT */}
            <div className="flex-1 overflow-y-auto p-4">
              {/* WhatsApp Flow Tab */}
              {activeTab === "whatsapp" && (
                <div>
                  {whatsappHistory.length === 0 && !data.whatsapp_sent_at ? (
                    <p className="text-sm text-zinc-400 text-center py-8">No WhatsApp messages sent</p>
                  ) : (
                    <div className="space-y-0">
                      {/* WhatsApp status summary */}
                      {data.whatsapp_delivery_status && (
                        <div className="flex items-center gap-2 mb-4 p-2.5 rounded-lg bg-zinc-50 border border-zinc-100">
                          <Smartphone className="h-4 w-4 text-zinc-400" />
                          <span className="text-xs font-semibold text-zinc-500">Status:</span>
                          <Badge variant="outline" className={`text-[10px] font-bold ${
                            data.whatsapp_delivery_status === "read" ? "bg-blue-50 text-blue-700 border-blue-200" :
                            data.whatsapp_delivery_status === "delivered" ? "bg-teal-50 text-teal-700 border-teal-200" :
                            "bg-zinc-100 text-zinc-600 border-zinc-200"
                          }`}>
                            {data.whatsapp_delivery_status === "read" && <CheckCheck className="h-3 w-3 mr-1" />}
                            {data.whatsapp_delivery_status === "delivered" && <CheckCheck className="h-3 w-3 mr-1" />}
                            {data.whatsapp_delivery_status.charAt(0).toUpperCase() + data.whatsapp_delivery_status.slice(1)}
                          </Badge>
                        </div>
                      )}

                      {/* Timeline */}
                      {whatsappHistory.map((msg, i) => (
                        <div key={i} className="flex gap-3">
                          {/* Timeline line */}
                          <div className="flex flex-col items-center">
                            <div className="h-8 w-8 rounded-full bg-teal-100 flex items-center justify-center shrink-0">
                              <Send className="h-3.5 w-3.5 text-teal-600" />
                            </div>
                            {i < whatsappHistory.length - 1 && (
                              <div className="w-0.5 flex-1 bg-zinc-200 my-1" />
                            )}
                          </div>
                          {/* Content */}
                          <div className="pb-4 flex-1 min-w-0">
                            <p className="text-xs font-bold text-zinc-700 mb-0.5">
                              {msg.template.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                            </p>
                            <p className="text-xs text-zinc-400">{formatTimeAgo(msg.sentAt)}</p>
                          </div>
                        </div>
                      ))}

                      {/* Candidate reply */}
                      {data.whatsapp_reply_text && (
                        <div className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className="h-8 w-8 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                              <MessageCircle className="h-3.5 w-3.5 text-green-600" />
                            </div>
                          </div>
                          <div className="pb-4 flex-1 min-w-0">
                            <p className="text-xs font-bold text-zinc-700 mb-0.5">Candidate Reply</p>
                            <div className="inline-block p-2.5 rounded-xl bg-green-50 border border-green-100 text-sm text-zinc-800 max-w-full">
                              {data.whatsapp_reply_text}
                            </div>
                            {data.whatsapp_reply_at && (
                              <p className="text-xs text-zinc-400 mt-1">{formatTimeAgo(data.whatsapp_reply_at)}</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Transcript Tab */}
              {activeTab === "transcript" && (
                <div>
                  {data.transcripts.length === 0 ? (
                    <p className="text-sm text-zinc-400 text-center py-8">No transcript available</p>
                  ) : (
                    <div className="space-y-2">
                      {data.transcripts.map((t) => (
                        <div
                          key={t.id}
                          className={`p-3 rounded-xl text-sm ${
                            t.speaker === "ai"
                              ? "bg-blue-50 border border-blue-100 ml-0"
                              : "bg-zinc-50 border border-zinc-100 ml-8"
                          }`}
                        >
                          <p className={`text-xs font-bold mb-1 ${
                            t.speaker === "ai" ? "text-blue-600" : "text-zinc-500"
                          }`}>
                            {t.speaker === "ai" ? "AI Screener" : "Candidate"}
                          </p>
                          <p className="text-zinc-700">{t.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Recording Tab */}
              {activeTab === "recording" && (
                <div>
                  {!data.recording_url ? (
                    <p className="text-sm text-zinc-400 text-center py-8">No recording available</p>
                  ) : (
                    <div className="space-y-4">
                      {/* Hidden audio element */}
                      <audio ref={audioRef} src={data.recording_url} preload="metadata" />

                      {/* Player card */}
                      <div className="p-4 rounded-xl border border-zinc-200 bg-white">
                        <div className="flex items-center gap-3 mb-4">
                          <button
                            onClick={togglePlayPause}
                            className="h-12 w-12 rounded-full bg-zinc-900 flex items-center justify-center shrink-0 hover:bg-zinc-800 transition-colors"
                          >
                            {isPlaying
                              ? <Pause className="h-5 w-5 text-white fill-white" />
                              : <Play className="h-5 w-5 text-white fill-white ml-0.5" />
                            }
                          </button>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-zinc-800">Call Recording</p>
                            <p className="text-xs text-zinc-500">
                              {formatDuration(data.call_duration_seconds)}
                              {data.call_started_at && ` · ${formatCallTime(data.call_started_at)}`}
                            </p>
                          </div>
                        </div>

                        {/* Progress bar */}
                        <div className="mb-2">
                          <div
                            className="h-2 bg-zinc-100 rounded-full cursor-pointer relative overflow-hidden"
                            onClick={seekAudio}
                          >
                            <div
                              className="h-full bg-zinc-900 rounded-full transition-all"
                              style={{ width: audioDuration ? `${(audioProgress / audioDuration) * 100}%` : "0%" }}
                            />
                          </div>
                          <div className="flex justify-between mt-1">
                            <span className="text-[10px] text-zinc-400 font-mono">
                              {formatDuration(Math.floor(audioProgress))}
                            </span>
                            <span className="text-[10px] text-zinc-400 font-mono">
                              {formatDuration(Math.floor(audioDuration))}
                            </span>
                          </div>
                        </div>

                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 flex-1" asChild>
                            <a href={data.recording_url} target="_blank" rel="noopener noreferrer">
                              <Download className="h-3.5 w-3.5" />
                              Download
                            </a>
                          </Button>
                          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 flex-1" asChild>
                            <a href={data.recording_url} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-3.5 w-3.5" />
                              Open
                            </a>
                          </Button>
                        </div>
                      </div>

                      {/* Call details */}
                      <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-100">
                        <p className="text-xs font-bold text-zinc-500 mb-2">Call Details</p>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <span className="text-zinc-400 text-xs block">Duration</span>
                            <span className="text-zinc-700">{formatDuration(data.call_duration_seconds)}</span>
                          </div>
                          <div>
                            <span className="text-zinc-400 text-xs block">Cost</span>
                            <span className="text-zinc-700">{formatCost(data.call_cost_cents)}</span>
                          </div>
                          {data.carrier && (
                            <div>
                              <span className="text-zinc-400 text-xs block">Carrier</span>
                              <span className="text-zinc-700">{data.carrier}</span>
                            </div>
                          )}
                          {data.hangup_by && (
                            <div>
                              <span className="text-zinc-400 text-xs block">Hung up by</span>
                              <span className="text-zinc-700">{data.hangup_by}</span>
                            </div>
                          )}
                          {data.ring_duration != null && (
                            <div>
                              <span className="text-zinc-400 text-xs block">Ring time</span>
                              <span className="text-zinc-700">{data.ring_duration}s</span>
                            </div>
                          )}
                          {data.call_voicemail != null && (
                            <div>
                              <span className="text-zinc-400 text-xs block">Voicemail</span>
                              <span className="text-zinc-700">{data.call_voicemail ? "Yes" : "No"}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Cost breakdown */}
                      {data.cost_breakdown && Object.keys(data.cost_breakdown).length > 0 && (
                        <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-100">
                          <p className="text-xs font-bold text-zinc-500 mb-2">Cost Breakdown</p>
                          <div className="space-y-1.5">
                            {Object.entries(data.cost_breakdown).map(([key, val]) => (
                              <div key={key} className="flex justify-between text-sm">
                                <span className="text-zinc-500 capitalize">{key}</span>
                                <span className="text-zinc-700 font-mono">₹{(val / 100).toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Q&A Tab */}
              {activeTab === "qa" && (
                <div>
                  {data.answers.length === 0 ? (
                    <p className="text-sm text-zinc-400 text-center py-8">No screening answers available</p>
                  ) : (
                    <div className="space-y-3">
                      {data.answers.map((a) => (
                        <div key={a.id} className="p-3 rounded-xl bg-zinc-50 border border-zinc-100">
                          <p className="text-xs font-semibold text-zinc-400 mb-1">{a.question_text}</p>
                          <p className="text-sm text-zinc-800">{a.answer_text || "Not disclosed"}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* JD Fit Tab */}
              {activeTab === "jd_fit" && (
                <div>
                  {!jdFit ? (
                    <p className="text-sm text-zinc-400 text-center py-8">No JD fit analysis available</p>
                  ) : (
                    <div className="space-y-4">
                      {jdFit.matched_skills && jdFit.matched_skills.length > 0 && (
                        <div className="p-3 rounded-xl bg-green-50 border border-green-100">
                          <p className="text-xs font-bold text-green-600 mb-1.5 flex items-center gap-1">
                            <CheckCircle className="h-3.5 w-3.5" /> Matched Skills
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {jdFit.matched_skills.map((s, i) => (
                              <Badge key={i} variant="outline" className="text-xs bg-green-100 text-green-700 border-green-200 px-2 py-0.5">
                                {s}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                      {jdFit.missing_skills && jdFit.missing_skills.length > 0 && (
                        <div className="p-3 rounded-xl bg-red-50 border border-red-100">
                          <p className="text-xs font-bold text-red-600 mb-1.5 flex items-center gap-1">
                            <AlertTriangle className="h-3.5 w-3.5" /> Missing Skills
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {jdFit.missing_skills.map((s, i) => (
                              <Badge key={i} variant="outline" className="text-xs bg-red-100 text-red-700 border-red-200 px-2 py-0.5">
                                {s}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                      {jdFit.experience_fit && (
                        <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-100">
                          <p className="text-xs font-bold text-zinc-500 mb-1">Experience Fit</p>
                          <p className="text-sm text-zinc-700">{jdFit.experience_fit}</p>
                        </div>
                      )}
                      {jdFit.overall && (
                        <div className="p-3 rounded-xl bg-blue-50/40 border border-blue-100">
                          <p className="text-xs font-bold text-blue-600 mb-1">Overall Assessment</p>
                          <p className="text-sm text-zinc-700 leading-relaxed">{jdFit.overall}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Agent Config Tab */}
              {activeTab === "agent_config" && (
                <div className="space-y-4">
                  {/* Screening Context */}
                  {data.screening_context && (
                    <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-100">
                      <p className="text-xs font-bold text-zinc-500 mb-2">Screening Context</p>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        {data.screening_context.jobTitle && (
                          <div>
                            <span className="text-zinc-400">Job Title:</span>
                            <span className="text-zinc-700 ml-1 font-medium">{data.screening_context.jobTitle}</span>
                          </div>
                        )}
                        {data.screening_context.clientName && (
                          <div>
                            <span className="text-zinc-400">Client:</span>
                            <span className="text-zinc-700 ml-1 font-medium">{data.screening_context.clientName}</span>
                          </div>
                        )}
                        {data.screening_context.location && (
                          <div>
                            <span className="text-zinc-400">Location:</span>
                            <span className="text-zinc-700 ml-1 font-medium">{data.screening_context.location}</span>
                          </div>
                        )}
                        {data.screening_context.experienceRange && (
                          <div>
                            <span className="text-zinc-400">Experience:</span>
                            <span className="text-zinc-700 ml-1 font-medium">{data.screening_context.experienceRange}</span>
                          </div>
                        )}
                        {data.screening_context.salaryRange && (
                          <div>
                            <span className="text-zinc-400">Salary:</span>
                            <span className="text-zinc-700 ml-1 font-medium">{data.screening_context.salaryRange}</span>
                          </div>
                        )}
                        {data.screening_context.origin && (
                          <div>
                            <span className="text-zinc-400">Origin:</span>
                            <Badge variant="outline" className={`ml-1 text-[10px] font-bold ${
                              data.screening_context.origin === "outbound" ? "bg-violet-100 text-violet-700 border-violet-200" : "bg-blue-100 text-blue-700 border-blue-200"
                            }`}>
                              {data.screening_context.origin}
                            </Badge>
                          </div>
                        )}
                      </div>
                      {data.screening_context.mustHaveSkills && (
                        <div className="mt-2">
                          <span className="text-zinc-400 text-xs">Required Skills:</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {data.screening_context.mustHaveSkills.split(",").filter(Boolean).map((skill, i) => (
                              <Badge key={i} variant="outline" className="text-[10px] bg-white text-zinc-600 border-zinc-200">
                                {skill.trim()}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Generated Questions */}
                  {data.generated_questions && (
                    <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-100">
                      <p className="text-xs font-bold text-emerald-600 mb-2 flex items-center gap-1">
                        <Bot className="h-3.5 w-3.5" /> AI-Generated Screening Questions
                      </p>
                      <ol className="space-y-1.5">
                        {data.generated_questions.split("\n").filter(Boolean).map((q, i) => (
                          <li key={i} className="flex gap-2 text-xs text-zinc-700">
                            <span className="font-bold text-emerald-600 shrink-0">{i + 1}.</span>
                            <span>{q.replace(/^\d+\.\s*/, "")}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {/* Full Bolna User Data */}
                  {data.call_payload_json && Object.keys(data.call_payload_json).length > 0 && (
                    <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-100">
                      <p className="text-xs font-bold text-zinc-500 mb-2">Full Bolna Agent User Data</p>
                      <div className="space-y-2">
                        {Object.entries(data.call_payload_json).map(([key, value]) => {
                          if (key === "resume_text" || key === "questions") return null // Skip large fields
                          const displayValue = typeof value === "object" ? JSON.stringify(value) : String(value || "")
                          if (!displayValue) return null
                          return (
                            <div key={key} className="text-xs">
                              <span className="text-zinc-400 font-mono">{key}:</span>
                              <span className="text-zinc-700 ml-2 break-words">{displayValue.slice(0, 200)}{displayValue.length > 200 ? "..." : ""}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* No data fallback */}
                  {!data.screening_context && !data.generated_questions && !data.call_payload_json && (
                    <p className="text-sm text-zinc-400 text-center py-8">No agent configuration data available for this call</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
