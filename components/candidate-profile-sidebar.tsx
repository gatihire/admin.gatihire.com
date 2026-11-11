"use client"

import { useState, useEffect, useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Download, MapPin, Phone, Mail, Building, Award, Globe, FileText,
  BrainCircuit, ChevronDown, ChevronUp, ExternalLink, GraduationCap,
  Maximize2, Minimize2, CheckCircle, AlertTriangle, ArrowRight, MessageCircle,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { CandidateActivityTimeline } from "./candidate-activity-timeline"
import { createPreviewUrl } from "@/lib/file-preview-utils"

/**
 * The pipeline, in order. Rendered as a stepper so the recruiter can see at a
 * glance where the candidate sits and what comes next — the old header only
 * showed the current stage name, which read as a label rather than a position.
 */
const PIPELINE_STAGES = [
  { id: "applied", label: "Applied" },
  { id: "ai_screen", label: "AI Screen" },
  { id: "shortlist", label: "Shortlist" },
  { id: "interview", label: "Interview" },
  { id: "offer", label: "Offer" },
] as const

function PipelineStepper({ current }: { current?: string | null }) {
  const idx = PIPELINE_STAGES.findIndex((s) => s.id === current)
  const terminal = current === "hired" || current === "rejected"
  // An unknown/legacy stage (hr_review, client_review…) sits between AI Screen
  // and Shortlist — show it as the current step rather than pretending the
  // candidate never left Applied.
  const currentIdx = idx >= 0 ? idx : terminal ? 4 : 1

  return (
    <div className="flex items-center gap-1">
      {PIPELINE_STAGES.map((s, i) => {
        const done = i < currentIdx
        const active = i === currentIdx
        return (
          <div key={s.id} className="flex items-center gap-1 min-w-0">
            <div className="flex flex-col items-center gap-1 min-w-0">
              <span
                className={`h-2 w-2 rounded-full shrink-0 ${
                  active
                    ? "bg-indigo-600 ring-4 ring-indigo-100"
                    : done
                      ? "bg-emerald-500"
                      : "bg-zinc-200"
                }`}
              />
              <span
                className={`text-[9px] font-semibold uppercase tracking-wide truncate max-w-[52px] ${
                  active ? "text-indigo-700" : done ? "text-emerald-700" : "text-zinc-400"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < PIPELINE_STAGES.length - 1 && (
              <div className={`h-px w-3 shrink-0 -mt-3 ${i < currentIdx ? "bg-emerald-400" : "bg-zinc-200"}`} />
            )}
          </div>
        )
      })}
      {terminal && (
        <div className="flex items-center gap-1 min-w-0">
          <div className="h-px w-3 shrink-0 -mt-3 bg-zinc-200" />
          <div className="flex flex-col items-center gap-1 min-w-0">
            <span className={`h-2 w-2 rounded-full shrink-0 ${current === "hired" ? "bg-emerald-600" : "bg-red-500"}`} />
            <span className={`text-[9px] font-semibold uppercase tracking-wide ${current === "hired" ? "text-emerald-700" : "text-red-600"}`}>
              {current === "hired" ? "Hired" : "Rejected"}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

interface WorkExperience {
  role: string
  company: string
  location?: string
  duration: string
  description?: string
  start_date?: string
  end_date?: string
  is_current?: boolean
}

interface EducationEntry {
  degree: string
  specialization?: string
  institution: string
  year?: string
  percentage?: string
}

interface EnrichedCandidate {
  _id: string
  id: string
  name: string
  email?: string
  phone?: string
  currentRole?: string
  desiredRole?: string
  currentCompany?: string
  location: string
  totalExperience?: string
  highestQualification?: string
  degree?: string
  university?: string
  technicalSkills?: string[]
  softSkills?: string[]
  languagesKnown?: string[]
  certifications?: string[]
  keyAchievements?: string[]
  workExperience?: WorkExperience[]
  education?: EducationEntry[]
  file_url?: string
  resume_text?: string
  currentSalary?: string
  expectedSalary?: string
  noticePeriod?: string
  locationPreference?: string | null
  willingToRelocate?: boolean | null
  reasonForSwitching?: string | null
  linkedin_profile?: string
  rating?: number
  [key: string]: any
}

interface Application {
  id: string
  candidate_id: string
  status: string
  notes: string
  candidate_notes?: string
  match_score?: number
}

interface CandidateProfileSidebarProps {
  candidate: any | null
  application?: Application | null
  isOpen: boolean
  onClose: () => void
  jobId?: string
  aiInfo?: { recommendation?: string; score?: number }
  participant?: any | null
  fitScore?: number | null
  /** Pipeline stage to display in the header (e.g. from Today / WhatsApp inbox). */
  stageLabel?: string | null
  /**
   * Why this candidate is on the recruiter's desk right now, and what to do
   * about it. Without this the header showed a stage name and nothing else,
   * so the recruiter had to work out the next step from scratch.
   */
  nextStep?: { reason?: string | null; cta?: string | null } | null
  /** Job opening context (title, client, description) to show in the header. */
  jobOpening?: { title?: string | null; clientName?: string | null; description?: string | null } | null
}

export function CandidateProfileSidebar({
  candidate: rawCandidate, application, isOpen, onClose, jobId, aiInfo, participant, fitScore,
  stageLabel, nextStep, jobOpening,
}: CandidateProfileSidebarProps) {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState("screening")
  const [enriched, setEnriched] = useState<EnrichedCandidate | null>(null)
  const [enrichedLoading, setEnrichedLoading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string>("")
  const [previewLoading, setPreviewLoading] = useState(false)
  const [experienceExpanded, setExperienceExpanded] = useState(false)
  const [resumeExpanded, setResumeExpanded] = useState(false)
  const [questionsEditing, setQuestionsEditing] = useState(false)
  const [questionsDraft, setQuestionsDraft] = useState<string>(participant?.generated_questions || "")
  const [fitAnalysis, setFitAnalysis] = useState<any>(null)
  const [fitLoading, setFitLoading] = useState(false)
  const [jobDescExpanded, setJobDescExpanded] = useState(false)
  const [reasonExpanded, setReasonExpanded] = useState(false)
  const [callBusy, setCallBusy] = useState(false)
  const [nudgeBusy, setNudgeBusy] = useState(false)

  /**
   * Place a real AI screening call. The button used to only show a toast that
   * said "Starting AI call…" — nothing was dialled, so the recruiter was told
   * a call was happening that never did.
   */
  const startAiCall = async () => {
    if (!participant?.id) {
      toast({ title: "No screening record", description: "This candidate has no phone-screening entry yet.", variant: "destructive" })
      return
    }
    setCallBusy(true)
    try {
      const res = await fetch("/api/phone-screening/call-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId: participant.id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || "Could not place the call")
      if (json?.callPlaced === false) {
        toast({
          title: "Call not placed",
          description: json?.error || json?.reason || "The provider did not accept the call.",
          variant: "destructive",
        })
        return
      }
      toast({
        title: "Call placed",
        description: json?.executionId
          ? `Calling ${c?.name || "the candidate"} now.`
          : `Calling ${c?.name || "the candidate"} now.`,
      })
    } catch (e: any) {
      toast({ title: "Call not placed", description: e?.message || "Something went wrong", variant: "destructive" })
    } finally {
      setCallBusy(false)
    }
  }

  /** Send a real WhatsApp nudge to the candidate. */
  const sendWhatsAppNudge = async () => {
    if (!participant?.id) {
      toast({ title: "No screening record", description: "This candidate has no phone-screening entry yet.", variant: "destructive" })
      return
    }
    setNudgeBusy(true)
    try {
      const first = String(c?.name || "there").split(" ")[0]
      const role = jobOpening?.title || "the role"
      const res = await fetch(`/api/phone-screening/participants/${participant.id}/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `Hi ${first}, following up on your application for ${role}. Do you have a few minutes to chat?`,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || "Could not send the message")
      toast({ title: "Nudge sent", description: `WhatsApp message sent to ${c?.name || "the candidate"}.` })
    } catch (e: any) {
      toast({ title: "Nudge failed", description: e?.message || "Something went wrong", variant: "destructive" })
    } finally {
      setNudgeBusy(false)
    }
  }

  // Merge raw candidate data with enriched data
  const c = useMemo(() => {
    if (!rawCandidate) return null
    // If enriched data is available, use it (API returns camelCase)
    if (enriched) {
      return {
        ...enriched,
        // Map API camelCase to what the sidebar reads
        file_url: enriched.file_url || enriched.fileUrl,
        resume_text: enriched.resume_text || enriched.resumeText,
        currentSalary: enriched.currentSalary || enriched.current_salary,
        expectedSalary: enriched.expectedSalary || enriched.expected_salary,
        noticePeriod: enriched.noticePeriod || enriched.notice_period,
        totalExperience: enriched.totalExperience ?? enriched.total_experience ?? enriched.total_experience_years ?? null,
        locationPreference: enriched.locationPreference ?? enriched.location_preference ?? null,
        willingToRelocate: enriched.willingToRelocate ?? enriched.willing_to_relocate ?? null,
        reasonForSwitching: enriched.reasonForSwitching ?? enriched.reason_for_switching ?? null,
        linkedin_profile: enriched.linkedin_profile || enriched.linkedinProfile,
        workExperience: enriched.workExperience || enriched.work_experience || [],
        education: enriched.education || [],
        technicalSkills: enriched.technicalSkills || enriched.technical_skills || [],
        softSkills: enriched.softSkills || enriched.soft_skills || [],
        languagesKnown: enriched.languagesKnown || enriched.languages_known || enriched.languages || [],
        certifications: enriched.certifications || [],
        keyAchievements: enriched.keyAchievements || enriched.key_achievements || [],
      }
    }
    // Map snake_case from applications route to camelCase
    return {
      _id: rawCandidate._id || rawCandidate.id,
      id: rawCandidate._id || rawCandidate.id,
      name: rawCandidate.name,
      email: rawCandidate.email,
      phone: rawCandidate.phone,
      currentRole: rawCandidate.currentRole || rawCandidate.current_role,
      desiredRole: rawCandidate.desiredRole || rawCandidate.desired_role,
      currentCompany: rawCandidate.currentCompany || rawCandidate.current_company,
      location: rawCandidate.location,
      highestQualification: rawCandidate.highestQualification || rawCandidate.highest_qualification,
      degree: rawCandidate.degree,
      university: rawCandidate.university,
      technicalSkills: rawCandidate.technicalSkills || rawCandidate.technical_skills || [],
      softSkills: rawCandidate.softSkills || rawCandidate.soft_skills || [],
      languagesKnown: rawCandidate.languagesKnown || rawCandidate.languages_known || rawCandidate.languages || [],
      certifications: rawCandidate.certifications || [],
      keyAchievements: rawCandidate.keyAchievements || rawCandidate.key_achievements || [],
      workExperience: rawCandidate.workExperience || rawCandidate.work_experience || [],
      education: rawCandidate.education || [],
      file_url: rawCandidate.file_url,
      resume_text: rawCandidate.resume_text,
      currentSalary: rawCandidate.currentSalary || rawCandidate.current_salary,
      expectedSalary: rawCandidate.expectedSalary || rawCandidate.expected_salary,
      noticePeriod: rawCandidate.noticePeriod || rawCandidate.notice_period,
      totalExperience: rawCandidate.totalExperience ?? rawCandidate.total_experience ?? rawCandidate.total_experience_years ?? null,
      locationPreference: rawCandidate.locationPreference ?? rawCandidate.location_preference ?? null,
      willingToRelocate: rawCandidate.willingToRelocate ?? rawCandidate.willing_to_relocate ?? null,
      reasonForSwitching: rawCandidate.reasonForSwitching ?? rawCandidate.reason_for_switching ?? null,
      linkedin_profile: rawCandidate.linkedin_profile,
      rating: rawCandidate.rating,
    }
  }, [rawCandidate, enriched])

  // Fetch enriched data from /api/candidates/[id]
  useEffect(() => {
    if (!isOpen || !rawCandidate) return
    const id = rawCandidate._id || rawCandidate.id
    if (!id) return

    setEnrichedLoading(true)
    fetch(`/api/candidates/${id}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data) setEnriched(data) })
      .catch(() => {})
      .finally(() => setEnrichedLoading(false))
  }, [isOpen, rawCandidate])

  // Auto-fetch fit analysis on mount if jobId is available
  useEffect(() => {
    if (!isOpen || !jobId || !c?.id || fitAnalysis) return
    const timer = setTimeout(() => {
      fetchFitAnalysis()
    }, 500)
    return () => clearTimeout(timer)
  }, [isOpen, jobId, c?.id])

  // Fetch resume preview URL
  useEffect(() => {
    if (c?.file_url) {
      setPreviewLoading(true)
      createPreviewUrl(c.file_url, `${c.name || "candidate"}_resume`).then((url) => {
        setPreviewUrl(url)
      }).catch(() => {
        setPreviewUrl("")
      }).finally(() => setPreviewLoading(false))
    }
  }, [c?.file_url])

  const initials = useMemo(() => {
    if (!c?.name) return "CN"
    return c.name.substring(0, 2).toUpperCase()
  }, [c?.name])

  const allSkills = useMemo(() => {
    if (!c) return []
    const tech = c.technicalSkills || []
    const soft = c.softSkills || []
    return [...tech, ...soft]
  }, [c])

  if (!c) return null

  const aiScore = aiInfo?.score
  const matchScore = application?.match_score

  const saveQuestions = async () => {
    if (!participant?.id) return
    try {
      // Update both generated_questions and call_payload_json.questions
      const payload: Record<string, any> = { generated_questions: questionsDraft }
      if (participant.call_payload_json) {
        payload.call_payload_json = {
          ...participant.call_payload_json,
          questions: questionsDraft.split("\n").filter((q: string) => q.trim()).map((q: string, i: number) => `${i + 1}. ${q.replace(/^\d+\.\s*/, "")}`).join("\n")
        }
      }
      await fetch(`/api/phone-screening/participants/${participant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
      setQuestionsEditing(false)
      toast({ title: "Questions updated" })
    } catch {
      toast({ title: "Failed to save", variant: "destructive" })
    }
  }

  const fetchFitAnalysis = async () => {
    if (!jobId || !c?.id || fitLoading) return
    setFitLoading(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/fit?candidateIds=${c.id}`)
      const data = await res.json()
      if (data.fits?.[c.id]) {
        setFitAnalysis(data.fits[c.id])
      }
    } catch {
      toast({ title: "Failed to load analysis", variant: "destructive" })
    } finally {
      setFitLoading(false)
    }
  }

  /**
   * Re-run the profile-fit analysis on demand. Kept as a function (rather than
   * the old always-visible purple "Analyze Against JD" button) so the fit can
   * be refreshed after the resume changes — the auto-load on open still fills
   * it in the first place.
   */
  const reAnalyzeFit = async () => {
    if (!jobId || !c?.id || fitLoading) return
    setFitLoading(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/fit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: [c.id], force: true })
      })
      const data = await res.json()
      if (data.fits?.[c.id]) {
        setFitAnalysis(data.fits[c.id])
        toast({ title: "Profile fit refreshed" })
      }
    } catch {
      toast({ title: "Failed to analyze", variant: "destructive" })
    } finally {
      setFitLoading(false)
    }
  }

  return (
    <>
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-[560px] p-0 overflow-hidden flex flex-col">
        {/* ═══════════════════════════════════════════════════════════════
            ONE SCROLL CONTAINER
            The header used to be a fixed, non-scrolling block above a
            separately-scrolling tab body. A long job description then grew the
            header until the tab bar and every tab pushed off the bottom of the
            sheet — the recruiter saw a name and a wall of JD text and nothing
            else. Now the whole sheet scrolls as one column with a sticky tab
            bar, so nothing can ever be pushed out of reach.
            ═══════════════════════════════════════════════════════════════ */}
        <div className="flex-1 min-h-0 overflow-y-auto">
        {/* ═══════════════════════════════════════════════════════════════
            HEADER
            ═══════════════════════════════════════════════════════════════ */}
        <div className="px-5 pt-5 pb-3 border-b border-zinc-100 bg-white">
          <div className="flex items-start gap-4">
            {/* Avatar */}
            <Avatar className="h-16 w-16 border-2 border-zinc-100 shadow-sm shrink-0">
              <AvatarFallback className="bg-emerald-600 text-white font-extrabold text-xl">
                {initials}
              </AvatarFallback>
            </Avatar>

            {/* Name + role + location */}
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-extrabold text-zinc-900 flex items-center gap-2 flex-wrap">
                {c.name}
                {matchScore != null && (
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                    matchScore >= 0.8
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : matchScore >= 0.6
                      ? "bg-amber-50 text-amber-700 border-amber-200"
                      : "bg-zinc-100 text-zinc-600 border-zinc-200"
                  }`}>
                    {Math.round(matchScore * 100)}% Match
                  </span>
                )}
                {(fitScore ?? null) != null && (
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                    (fitScore ?? 0) >= 70
                      ? "bg-purple-50 text-purple-700 border-purple-200"
                      : (fitScore ?? 0) >= 40
                      ? "bg-amber-50 text-amber-700 border-amber-200"
                      : "bg-rose-50 text-rose-600 border-rose-200"
                  }`}>
                    <BrainCircuit className="h-3 w-3" />
                    {fitScore}%
                  </span>
                )}
              </h3>
              <p className="text-[13px] text-zinc-500 mt-1">
                {c.currentRole || c.desiredRole || "Professional"}
                {c.currentCompany ? ` at ${c.currentCompany}` : ""}
                {c.totalExperience ? ` · ${c.totalExperience}yr exp` : ""}
              </p>
              <div className="flex items-center gap-1 text-xs text-zinc-400 mt-0.5">
                <MapPin className="h-3 w-3 shrink-0" />
                <span>{c.location || "N/A"}</span>
              </div>
            </div>

            {/* Expectations card (right-aligned) */}
            {(c.currentSalary || c.expectedSalary || c.noticePeriod || c.totalExperience || c.locationPreference || c.willingToRelocate != null || c.reasonForSwitching) && (
              <div className="bg-zinc-900 rounded-xl p-3 min-w-[140px] shrink-0">
                <p className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-400 mb-2">
                  Expectations
                </p>
                <div className="space-y-1">
                  {c.currentSalary && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Current</span>
                      <span className="font-bold text-white">{c.currentSalary}</span>
                    </div>
                  )}
                  {c.expectedSalary && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Expected</span>
                      <span className="font-bold text-amber-400">{c.expectedSalary}</span>
                    </div>
                  )}
                  {c.noticePeriod && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Notice</span>
                      <span className="font-bold text-white">{c.noticePeriod}</span>
                    </div>
                  )}
                  {c.totalExperience != null && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Experience</span>
                      <span className="font-bold text-white">{c.totalExperience}y</span>
                    </div>
                  )}
                  {c.locationPreference && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Location</span>
                      <span className="font-bold text-white">{c.locationPreference}</span>
                    </div>
                  )}
                  {c.willingToRelocate != null && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Relocate</span>
                      <span className={`font-bold ${c.willingToRelocate ? "text-emerald-400" : "text-red-400"}`}>
                        {c.willingToRelocate ? "Yes" : "No"}
                      </span>
                    </div>
                  )}
                  {c.reasonForSwitching && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Switching</span>
                      <span className="font-bold text-white text-right max-w-[80px] truncate" title={c.reasonForSwitching}>{c.reasonForSwitching}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Where is this candidate + what to do next.
              The job description used to live here, but the header does NOT
              scroll — expanding a long JD pushed the tabs and all content off
              the bottom of the sheet. The JD now has its own tab. */}
          {(stageLabel || nextStep?.reason) && (
            <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 space-y-2.5">
              {stageLabel && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-500 mb-1.5">
                    Where they are in the pipeline
                  </p>
                  <PipelineStepper current={stageLabel} />
                </div>
              )}

              {nextStep?.reason && (
                <div className="rounded-lg bg-white border border-indigo-100 p-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1">
                    Why they&apos;re on your desk
                  </p>
                  <p
                    className={`text-sm text-zinc-800 leading-snug ${reasonExpanded ? "" : "line-clamp-2"}`}
                  >
                    {nextStep.reason}
                  </p>
                  {nextStep.reason.length > 120 && (
                    <button
                      onClick={() => setReasonExpanded(!reasonExpanded)}
                      className="text-[11px] font-semibold text-indigo-600 hover:underline mt-1"
                    >
                      {reasonExpanded ? "Show less" : "Show more"}
                    </button>
                  )}
                  {nextStep.cta && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-indigo-700">
                      <ArrowRight className="h-3 w-3" /> Next: {nextStep.cta}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Contact + actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600">
              {c.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5 text-zinc-400" />
                  {c.phone}
                </span>
              )}
              {c.email && (
                <span className="flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 text-zinc-400" />
                  <span className="truncate max-w-[180px]">{c.email}</span>
                </span>
              )}
              {c.linkedin_profile && (
                <a
                  href={c.linkedin_profile}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[#0A66C2] hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  LinkedIn
                </a>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {c.phone && (
                <button
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-zinc-700 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                  onClick={() => { navigator.clipboard.writeText(c.phone || ""); toast({ title: "Phone copied" }) }}
                >
                  <Phone className="h-3.5 w-3.5" /> Call
                </button>
              )}
              {c.email && (
                <button
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-zinc-700 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                  onClick={() => { navigator.clipboard.writeText(c.email || ""); toast({ title: "Email copied" }) }}
                >
                  <Mail className="h-3.5 w-3.5" /> Email
                </button>
              )}
              {c.file_url && (
                <a
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-zinc-700 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                  href={c.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download className="h-3.5 w-3.5" /> Resume
                </a>
              )}
            </div>
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════════
            TABS
            ═══════════════════════════════════════════════════════════════ */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col">
          {/* Sticky tab bar — it must never be pushed off screen by the header
              or the content above it. */}
          <div className="px-5 border-b border-zinc-100 bg-white/95 backdrop-blur flex-shrink-0 sticky top-0 z-10 overflow-x-auto">
            <TabsList className="h-10 bg-transparent gap-0 p-0">
              {([
                { id: "screening", label: "Screening" },
                { id: "profile", label: "Profile" },
                { id: "job", label: "Job" },
                { id: "resume", label: "Resume" },
                { id: "activity", label: "Activity" },
                { id: "ai_context", label: "AI Context" },
              ]).map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className="text-xs font-semibold capitalize whitespace-nowrap data-[state=active]:text-zinc-900 data-[state=active]:border-b-2 data-[state=active]:border-zinc-900 data-[state=active]:font-bold rounded-none h-10 px-3 text-zinc-400 border-b-2 border-transparent"
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

            {/* ── Screening Tab ── */}
            <TabsContent value="screening" className="px-5 py-5 space-y-5 mt-0">
              {aiInfo?.score != null || aiInfo?.recommendation ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 rounded-xl border border-zinc-200 bg-white text-center">
                      <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400">AI Score</p>
                      <p className={`text-2xl font-extrabold mt-1 ${
                        (aiScore ?? 0) >= 7 ? "text-emerald-600" : (aiScore ?? 0) >= 4 ? "text-amber-600" : "text-rose-600"
                      }`}>
                        {aiScore ?? "—"}/10
                      </p>
                    </div>
                    <div className="p-3 rounded-xl border border-zinc-200 bg-white text-center">
                      <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400">Verdict</p>
                      <Badge variant="outline" className={`mt-2 text-xs font-bold px-2.5 py-1 rounded-full capitalize ${
                        aiInfo.recommendation === "advance" ? "bg-emerald-100 text-emerald-700 border-emerald-200" :
                        aiInfo.recommendation === "further_review" ? "bg-amber-100 text-amber-700 border-amber-200" :
                        "bg-red-100 text-red-600 border-red-200"
                      }`}>
                        {aiInfo.recommendation?.replace(/_/g, " ") || "—"}
                      </Badge>
                    </div>
                    <div className="p-3 rounded-xl border border-zinc-200 bg-white text-center">
                      <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400">Duration</p>
                      <p className="text-lg font-bold text-zinc-700 mt-1">—</p>
                    </div>
                  </div>
                  <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-100">
                    <p className="text-sm text-zinc-600 leading-relaxed">
                      {aiInfo.recommendation === "advance"
                        ? "This candidate is a strong fit based on AI screening. Consider advancing to the next stage."
                        : aiInfo.recommendation === "further_review"
                        ? "This candidate may be a fit but needs further evaluation. Review the transcript for details."
                        : "This candidate did not meet the screening criteria. Review the transcript for specifics."}
                    </p>
                  </div>
                </>
              ) : (
                <div className="space-y-4">
                  {/* No screening has run for this candidate yet.
                      The old UI put an "AI Profile Analysis — Analyze this
                      candidate against the job requirements" prompt here, which
                      was noise: it described a tool rather than telling the
                      recruiter anything about THIS candidate. Replaced with the
                      two things that actually unblock the case. */}
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center">
                    <BrainCircuit className="h-6 w-6 mx-auto mb-2 text-zinc-300" />
                    {fitAnalysis ? (
                      <>
                        <p className="text-sm font-semibold text-zinc-700">Profile fit for this role</p>
                        <p className="text-xs text-zinc-500 mt-1">
                          Matched against the job requirements from the resume.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-semibold text-zinc-700">No AI screening yet</p>
                        <p className="text-xs text-zinc-500 mt-1">
                          This candidate has not been screened by the AI yet. Start a screening call, or
                          nudge them on WhatsApp to collect their details first.
                        </p>
                        {fitLoading && (
                          <div className="mt-3 flex items-center justify-center gap-2 text-xs text-zinc-400">
                            <BrainCircuit className="h-3.5 w-3.5 animate-pulse" />
                            Matching against the job requirements…
                          </div>
                        )}
                      </>
                    )}
                    {fitAnalysis && (
                      <div className="mt-3 text-left p-3 rounded-lg bg-purple-50/50 border border-purple-100 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <BrainCircuit className="h-4 w-4 text-purple-600" />
                            <span className="text-sm font-bold text-purple-700">Profile fit</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-xs font-bold ${
                              fitAnalysis.fit_score >= 70
                                ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                                : fitAnalysis.fit_score >= 40
                                ? "bg-amber-100 text-amber-700 border-amber-200"
                                : "bg-red-100 text-red-600 border-red-200"
                            }`}>
                              {fitAnalysis.fit_score}%
                            </Badge>
                            <button
                              onClick={reAnalyzeFit}
                              disabled={fitLoading}
                              title="Re-run the fit analysis"
                              aria-label="Re-run the fit analysis"
                              className="p-1 rounded text-zinc-400 hover:text-purple-600 disabled:opacity-40"
                            >
                              <BrainCircuit className={`h-3.5 w-3.5 ${fitLoading ? "animate-pulse" : ""}`} />
                            </button>
                          </div>
                        </div>
                        {fitAnalysis.summary && (
                          <p className="text-xs text-zinc-600 leading-relaxed">{fitAnalysis.summary}</p>
                        )}
                        {fitAnalysis.pros?.length > 0 && (
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1">Strengths</p>
                            {fitAnalysis.pros.slice(0, 3).map((pro: string, i: number) => (
                              <p key={i} className="text-xs text-emerald-600 flex gap-1 mb-0.5">
                                <CheckCircle className="h-3 w-3 mt-0.5 shrink-0" /> {pro}
                              </p>
                            ))}
                          </div>
                        )}
                        {fitAnalysis.misses?.length > 0 && (
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1">Concerns</p>
                            {fitAnalysis.misses.slice(0, 3).map((miss: string, i: number) => (
                              <p key={i} className="text-xs text-amber-600 flex gap-1 mb-0.5">
                                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {miss}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Start Call Buttons — these place a REAL call and send a
                      REAL WhatsApp message. They used to only show a toast
                      that said it was happening. */}
                  <div className="flex items-center justify-center gap-2 pt-4 border-t border-zinc-100">
                    <button
                      disabled={!participant || callBusy}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={startAiCall}
                    >
                      {callBusy ? (
                        <BrainCircuit className="h-3.5 w-3.5 animate-pulse" />
                      ) : (
                        <Phone className="h-3.5 w-3.5" />
                      )}
                      {callBusy ? "Calling…" : "Start AI Call"}
                    </button>
                    <button
                      disabled={!participant || nudgeBusy}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-zinc-700 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={sendWhatsAppNudge}
                    >
                      {nudgeBusy ? (
                        <BrainCircuit className="h-3.5 w-3.5 animate-pulse" />
                      ) : (
                        <MessageCircle className="h-3.5 w-3.5" />
                      )}
                      {nudgeBusy ? "Sending…" : "WhatsApp Nudge"}
                    </button>
                  </div>
                  {!participant && (
                    <p className="text-[11px] text-zinc-500 text-center">
                      This candidate has no phone-screening record yet — start a screening from the
                      job pipeline to enable calls and WhatsApp.
                    </p>
                  )}
                </div>
              )}
            </TabsContent>

            {/* ── AI Context Tab ── */}
            <TabsContent value="ai_context" className="px-5 py-5 space-y-5 mt-0">
              {/* Screening Context (Job Context sent to AI) */}
              {participant?.screening_context && (
                <div>
                  <SectionLabel text="Job Context Sent to AI" />
                  <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-100 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Role</p>
                        <p className="text-sm font-semibold text-zinc-700">{participant.screening_context.jobTitle}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Company</p>
                        <p className="text-sm font-semibold text-zinc-700">{participant.screening_context.clientName}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Salary Range</p>
                        <p className="text-sm font-semibold text-zinc-700">{participant.screening_context.salaryRange || "Not specified"}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Experience</p>
                        <p className="text-sm font-semibold text-zinc-700">{participant.screening_context.experienceRange || "Not specified"}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Location</p>
                        <p className="text-sm font-semibold text-zinc-700">{participant.screening_context.location || "Not specified"}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Origin</p>
                        <p className="text-sm font-semibold text-zinc-700 capitalize">{participant.origin || "outbound"}</p>
                      </div>
                    </div>
                    {participant.screening_context.mustHaveSkills && (
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1">Must-Have Skills</p>
                        <div className="flex flex-wrap gap-1.5">
                          {participant.screening_context.mustHaveSkills.split(",").map((skill: string, i: number) => (
                            <Badge key={i} variant="outline" className="text-[10px] bg-blue-50 text-blue-600 border-blue-200">
                              {skill.trim()}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Generated Questions */}
              {participant?.generated_questions && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <SectionLabel text="AI-Generated Questions" />
                    {questionsEditing ? (
                      <div className="flex gap-2">
                        <button onClick={saveQuestions} className="text-xs font-semibold text-emerald-600 hover:text-emerald-700">
                          Save
                        </button>
                        <button onClick={() => setQuestionsEditing(false)} className="text-xs font-semibold text-zinc-400 hover:text-zinc-600">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button 
                        onClick={() => { setQuestionsDraft(participant.generated_questions); setQuestionsEditing(true) }}
                        className="text-xs font-semibold text-blue-600 hover:text-blue-700"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-100">
                    {questionsEditing ? (
                      <textarea
                        value={questionsDraft}
                        onChange={(e) => setQuestionsDraft(e.target.value)}
                        className="w-full text-sm text-zinc-700 bg-white border border-zinc-200 rounded-lg p-3 min-h-[120px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                        rows={6}
                      />
                    ) : (
                      <ol className="space-y-2">
                        {participant.generated_questions.split("\n").filter((q: string) => q.trim()).map((question: string, i: number) => (
                          <li key={i} className="flex gap-2 text-sm">
                            <span className="font-mono text-[10px] font-bold text-zinc-400 mt-0.5">{i + 1}.</span>
                            <span className="text-zinc-700">{question.replace(/^\d+\.\s*/, "")}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              )}

              {/* Empty state when no participant data */}
              {!participant && (
                <div className="text-center py-12 text-zinc-400">
                  <BrainCircuit className="h-8 w-8 mx-auto mb-2 text-zinc-300" />
                  <p className="text-sm font-semibold">No AI context yet</p>
                  <p className="text-xs mt-1 mb-4">Start a screening call to generate questions</p>
                  <div className="flex items-center justify-center gap-2">
                    <button className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors">
                      <Phone className="h-3.5 w-3.5" /> Start AI Call
                    </button>
                    <button className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-zinc-700 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors">
                      <Mail className="h-3.5 w-3.5" /> WhatsApp Nudge
                    </button>
                  </div>
                </div>
              )}

              {/* Full Call Payload (collapsible) */}
              {participant?.call_payload_json && (
                <details className="group">
                  <summary className="flex items-center gap-2 text-xs font-semibold text-zinc-400 hover:text-zinc-600 cursor-pointer">
                    <ChevronDown className="h-3 w-3 group-open:rotate-180 transition-transform" />
                    Full Call Payload (Technical)
                  </summary>
                  <pre className="mt-2 p-4 rounded-xl bg-zinc-50 border border-zinc-100 text-[10px] text-zinc-500 overflow-auto max-h-64 font-mono">
                    {JSON.stringify(participant.call_payload_json, null, 2)}
                  </pre>
                </details>
              )}
            </TabsContent>

            {/* ── Profile Tab ── */}
            <TabsContent value="profile" className="px-5 py-5 space-y-5 mt-0">
              {enrichedLoading && (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="space-y-2">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-16 w-full rounded-xl" />
                    </div>
                  ))}
                </div>
              )}

              {!enrichedLoading && (
                <>
                  {/* Summary */}
                  {c.resume_text && (
                    <div>
                      <SectionLabel text="Summary" />
                      <p className="text-xs text-zinc-600 leading-relaxed whitespace-pre-wrap">
                        {c.resume_text.slice(0, 500)}{c.resume_text.length > 500 ? "..." : ""}
                      </p>
                    </div>
                  )}

                  {/* Skills */}
                  {allSkills.length > 0 && (
                    <div>
                      <SectionLabel text="Skills" />
                      <div className="flex flex-wrap gap-1.5">
                        {allSkills.map((skill) => (
                          <span
                            key={skill}
                            className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-900 text-zinc-200 border border-zinc-700"
                          >
                            {skill}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Languages */}
                  {c.languagesKnown && c.languagesKnown.length > 0 && (
                    <div>
                      <SectionLabel text="Languages" />
                      <div className="flex flex-wrap gap-1.5">
                        {c.languagesKnown.map((lang: string) => (
                          <span
                            key={lang}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-white text-zinc-600 border border-zinc-200"
                          >
                            <Globe className="h-3 w-3 text-zinc-400" />
                            {lang}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Experience */}
                  {c.workExperience && c.workExperience.length > 0 && (
                    <div>
                      <SectionLabel text="Experience" />
                      <div className="space-y-3">
                        {(experienceExpanded ? c.workExperience : c.workExperience.slice(0, 3)).map((exp: WorkExperience, i: number) => (
                          <div key={i} className="p-3.5 rounded-xl border border-zinc-200 bg-white">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-bold text-zinc-900">{exp.role}</p>
                              {exp.duration && (
                                <span className="text-[11px] text-zinc-400 font-medium shrink-0">{exp.duration}</span>
                              )}
                            </div>
                            <p className="text-xs text-zinc-500 mt-0.5">
                              {exp.company}{exp.location ? ` · ${exp.location}` : ""}
                            </p>
                            {exp.description && (
                              <p className="text-xs text-zinc-600 mt-2 leading-relaxed">{exp.description}</p>
                            )}
                          </div>
                        ))}
                        {c.workExperience.length > 3 && (
                          <button
                            onClick={() => setExperienceExpanded(!experienceExpanded)}
                            className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1"
                          >
                            {experienceExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            {experienceExpanded ? "Show less" : `Show all ${c.workExperience.length} roles`}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Education */}
                  {c.education && c.education.length > 0 && (
                    <div>
                      <SectionLabel text="Education" />
                      <div className="space-y-2.5">
                        {c.education.map((edu: EducationEntry, i: number) => (
                          <div key={i} className="p-3.5 rounded-xl border border-zinc-200 bg-white">
                            <p className="text-sm font-bold text-zinc-900">
                              {edu.degree}{edu.specialization ? ` in ${edu.specialization}` : ""}
                            </p>
                            <p className="text-xs text-zinc-500 mt-0.5 flex items-center gap-1">
                              <GraduationCap className="h-3 w-3 text-zinc-400" />
                              {edu.institution}
                            </p>
                            {(edu.year || edu.percentage) && (
                              <p className="text-[11px] text-zinc-400 mt-0.5">
                                {edu.year}{edu.year && edu.percentage ? " · " : ""}{edu.percentage}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Certifications */}
                  {c.certifications && c.certifications.length > 0 && (
                    <div>
                      <SectionLabel text="Certifications" />
                      <div className="flex flex-wrap gap-1.5">
                        {c.certifications.map((cert: string) => (
                          <span
                            key={cert}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-white text-zinc-600 border border-zinc-200"
                          >
                            <Award className="h-3 w-3 text-amber-500" />
                            {cert}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Key Achievements */}
                  {c.keyAchievements && c.keyAchievements.length > 0 && (
                    <div>
                      <SectionLabel text="Key Achievements" />
                      <div className="space-y-1.5">
                        {c.keyAchievements.map((ach: string, i: number) => (
                          <div key={i} className="flex items-start gap-2 text-xs text-zinc-600">
                            <span className="text-emerald-500 mt-0.5">•</span>
                            <span>{ach}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Empty state */}
                  {!c.resume_text && allSkills.length === 0 && (!c.workExperience || c.workExperience.length === 0) && (!c.education || c.education.length === 0) && (
                    <div className="text-center py-12 text-zinc-400">
                      <FileText className="h-8 w-8 mx-auto mb-2 text-zinc-300" />
                      <p className="text-sm font-semibold">No profile data</p>
                      <p className="text-xs mt-1">Upload a resume to populate this candidate's profile</p>
                    </div>
                  )}
                </>
              )}
            </TabsContent>

            {/* ── Resume Tab ── */}
            <TabsContent value="resume" className="px-5 py-5 mt-0">
              {c.file_url ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 rounded-xl border border-zinc-200 bg-white">
                    <FileText className="h-8 w-8 text-blue-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-zinc-800 truncate">{c.name}_resume</p>
                      <p className="text-xs text-zinc-400">PDF Document</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-600 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                        onClick={() => setResumeExpanded(true)}
                      >
                        <Maximize2 className="h-3.5 w-3.5" /> Extend
                      </button>
                      <button
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-600 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                        onClick={() => window.open(c.file_url, "_blank")}
                      >
                        <Download className="h-3.5 w-3.5" /> Download
                      </button>
                    </div>
                  </div>

                  {previewLoading ? (
                    <div className="aspect-[8.5/11] rounded-xl border border-zinc-200 overflow-hidden">
                      <Skeleton className="h-full w-full" />
                    </div>
                  ) : previewUrl ? (
                    <div className="aspect-[8.5/11] rounded-xl border border-zinc-200 overflow-hidden bg-white">
                      <iframe src={previewUrl} className="w-full h-full" title="Resume preview" />
                    </div>
                  ) : (
                    <div className="aspect-[8.5/11] rounded-xl border border-dashed border-zinc-300 flex items-center justify-center bg-zinc-50">
                      <p className="text-sm text-zinc-400">Preview not available</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-12 text-zinc-400">
                  <FileText className="h-8 w-8 mx-auto mb-2 text-zinc-300" />
                  <p className="text-sm font-semibold">No resume uploaded</p>
                </div>
              )}
            </TabsContent>

            {/* ── Activity Tab ── */}
            {/* ── Job Tab ──
                The job description used to sit in the (non-scrolling) header,
                where a long JD pushed the tabs and the whole content area off
                the bottom of the sheet. It gets its own tab now. */}
            <TabsContent value="job" className="px-5 py-5 space-y-4 mt-0">
              {!jobOpening?.title ? (
                <p className="text-sm text-zinc-400 text-center py-8">No job opening linked.</p>
              ) : (
                <>
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Job opening</span>
                      {jobId && (
                        <a
                          href={`/jobs/${jobId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:underline"
                        >
                          Open in pipeline <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <p className="text-base font-bold text-zinc-900 mt-0.5">{jobOpening.title}</p>
                    {jobOpening.clientName && (
                      <p className="text-xs text-zinc-500">{jobOpening.clientName}</p>
                    )}
                  </div>

                  {jobOpening.description ? (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <SectionLabel text="Job description" />
                        {jobOpening.description.length > 400 && (
                          <button
                            onClick={() => setJobDescExpanded(!jobDescExpanded)}
                            className="text-[11px] font-semibold text-indigo-600 hover:underline"
                          >
                            {jobDescExpanded ? "Show less" : "Show full description"}
                          </button>
                        )}
                      </div>
                      <p
                        className={`text-xs text-zinc-600 leading-relaxed whitespace-pre-line ${
                          jobDescExpanded ? "" : "line-clamp-6"
                        }`}
                      >
                        {jobOpening.description}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-400">No description saved for this opening.</p>
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent value="activity" className="px-5 py-5 space-y-5 mt-0">
              {jobId && (
                <CandidateActivityTimeline jobId={jobId} candidateId={c.id || c._id} />
              )}

              {application && (
                <div>
                  <SectionLabel text="Recruiter Notes" />
                  <p className="text-xs text-zinc-600 whitespace-pre-wrap">
                    {application.notes || <span className="text-zinc-400 italic">No notes yet</span>}
                  </p>
                </div>
              )}

              {application?.candidate_notes && (
                <div>
                  <SectionLabel text="Candidate Notes" />
                  <p className="text-xs text-zinc-500 whitespace-pre-wrap bg-zinc-50/50 p-3 rounded-xl border border-zinc-100">
                    {application.candidate_notes}
                  </p>
                </div>
              )}
            </TabsContent>
        </Tabs>
        </div>
      </SheetContent>
    </Sheet>

    {/* ── Resume Fullscreen Modal ── */}
    <Dialog open={resumeExpanded} onOpenChange={setResumeExpanded}>
      <DialogContent className="!fixed !inset-0 !left-0 !top-0 !translate-x-0 !translate-y-0 !max-w-none !max-h-none !w-screen !h-screen !rounded-none !border-0 !p-[15px] !gap-0 !m-0 [&>button]:hidden">
        <DialogTitle className="sr-only">Resume Preview</DialogTitle>
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
          <button
            className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
            onClick={() => window.open(c?.file_url, "_blank")}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
            onClick={() => setResumeExpanded(false)}
          >
            ×
          </button>
        </div>
        {previewUrl ? (
          <iframe src={previewUrl} className="w-full h-full border-0" title="Resume preview" />
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-400">
            <p className="text-sm">Preview not available</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  )
}

function SectionLabel({ text }: { text: string }) {
  return (
    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 mb-2">
      {text}
    </p>
  )
}
