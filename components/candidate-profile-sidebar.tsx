"use client"

import { useState, useEffect, useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Download, MapPin, Phone, Mail, Building, Award, Globe, FileText,
  BrainCircuit, ChevronDown, ChevronUp, ExternalLink, GraduationCap,
  Maximize2, Minimize2,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { CandidateActivityTimeline } from "./candidate-activity-timeline"
import { createPreviewUrl } from "@/lib/file-preview-utils"

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
}

export function CandidateProfileSidebar({
  candidate: rawCandidate, application, isOpen, onClose, jobId, aiInfo,
}: CandidateProfileSidebarProps) {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState("screening")
  const [enriched, setEnriched] = useState<EnrichedCandidate | null>(null)
  const [enrichedLoading, setEnrichedLoading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string>("")
  const [previewLoading, setPreviewLoading] = useState(false)
  const [experienceExpanded, setExperienceExpanded] = useState(false)
  const [resumeExpanded, setResumeExpanded] = useState(false)

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
      totalExperience: rawCandidate.totalExperience || rawCandidate.total_experience,
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

  return (
    <>
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-[520px] p-0 overflow-hidden flex flex-col">
        {/* ═══════════════════════════════════════════════════════════════
            HEADER
            ═══════════════════════════════════════════════════════════════ */}
        <div className="px-7 pt-7 pb-5 border-b border-zinc-100 bg-white">
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
            {(c.currentSalary || c.expectedSalary || c.noticePeriod) && (
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
                </div>
              </div>
            )}
          </div>

          {/* Contact info row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-4 text-xs text-zinc-500">
            {c.phone && (
              <span className="flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5 text-zinc-400" />
                {c.phone}
              </span>
            )}
            {c.email && (
              <span className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 text-zinc-400" />
                <span className="truncate max-w-[200px]">{c.email}</span>
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

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2 mt-4">
            {c.phone && (
              <button
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold text-white transition-colors"
                style={{ background: "#25D366" }}
                onClick={() => { navigator.clipboard.writeText(c.phone || ""); toast({ title: "Phone copied" }) }}
              >
                <Phone className="h-3.5 w-3.5" /> WhatsApp
              </button>
            )}
            {c.email && (
              <button
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-zinc-600 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                onClick={() => { navigator.clipboard.writeText(c.email || ""); toast({ title: "Email copied" }) }}
              >
                <Mail className="h-3.5 w-3.5" /> Email
              </button>
            )}
            {c.phone && (
              <button
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-zinc-600 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                onClick={() => { navigator.clipboard.writeText(c.phone || ""); toast({ title: "Phone copied" }) }}
              >
                <Phone className="h-3.5 w-3.5" /> Call
              </button>
            )}
            {c.file_url && (
              <button
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-zinc-600 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                onClick={() => window.open(c.file_url, "_blank")}
              >
                <Download className="h-3.5 w-3.5" /> Resume
              </button>
            )}
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════════
            AI MATCH ANALYSIS
            ═══════════════════════════════════════════════════════════════ */}
        {aiInfo && (
          <div className="px-7 py-4 border-b border-zinc-100 bg-white">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 mb-2">
              AI Match Analysis
            </p>
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200">
              <div className="flex flex-wrap gap-2 mb-2">
                {aiScore != null && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${
                    aiScore >= 7 ? "bg-emerald-100 text-emerald-700" :
                    aiScore >= 4 ? "bg-amber-100 text-amber-700" :
                    "bg-red-100 text-red-600"
                  }`}>
                    Score: {aiScore}/10
                  </span>
                )}
                {aiInfo.recommendation && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold capitalize ${
                    aiInfo.recommendation === "advance" ? "bg-emerald-100 text-emerald-700" :
                    aiInfo.recommendation === "further_review" ? "bg-amber-100 text-amber-700" :
                    "bg-red-100 text-red-600"
                  }`}>
                    {aiInfo.recommendation.replace(/_/g, " ")}
                  </span>
                )}
              </div>
              <p className="text-xs text-emerald-800 leading-relaxed">
                {aiInfo.recommendation === "advance"
                  ? "This candidate is a strong fit based on AI screening. Consider advancing to the next stage."
                  : aiInfo.recommendation === "further_review"
                  ? "This candidate may be a fit but needs further evaluation. Review the transcript for details."
                  : "This candidate did not meet the screening criteria. Review the transcript for specifics."}
              </p>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            TABS
            ═══════════════════════════════════════════════════════════════ */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <div className="px-7 border-b border-zinc-100 bg-white flex-shrink-0">
            <TabsList className="h-10 bg-transparent gap-0 p-0">
              {["screening", "profile", "resume", "activity"].map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="text-xs font-semibold capitalize data-[state=active]:text-zinc-900 data-[state=active]:border-b-2 data-[state=active]:border-zinc-900 data-[state=active]:font-bold rounded-none h-10 px-4 text-zinc-400 border-b-2 border-transparent"
                >
                  {tab}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <ScrollArea className="flex-1">
            {/* ── Screening Tab ── */}
            <TabsContent value="screening" className="px-7 py-5 space-y-5 mt-0">
              {aiInfo ? (
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
                <div className="text-center py-12 text-zinc-400">
                  <BrainCircuit className="h-8 w-8 mx-auto mb-2 text-zinc-300" />
                  <p className="text-sm font-semibold">No screening data yet</p>
                  <p className="text-xs mt-1 mb-4">Start an AI screening call to see results here</p>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors"
                      onClick={() => {
                        toast({ title: "Starting AI call...", description: `Calling ${c?.name}` })
                      }}
                    >
                      <Phone className="h-3.5 w-3.5" /> Start AI Call
                    </button>
                    <button
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-zinc-700 bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                      onClick={() => {
                        toast({ title: "Sending WhatsApp nudge...", description: `Nudging ${c?.name}` })
                      }}
                    >
                      <Mail className="h-3.5 w-3.5" /> WhatsApp Nudge
                    </button>
                  </div>
                </div>
              )}
            </TabsContent>

            {/* ── Profile Tab ── */}
            <TabsContent value="profile" className="px-7 py-5 space-y-5 mt-0">
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
            <TabsContent value="resume" className="px-7 py-5 mt-0">
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
            <TabsContent value="activity" className="px-7 py-5 space-y-5 mt-0">
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
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>

    {/* ── Resume Fullscreen Modal ── */}
    <Dialog open={resumeExpanded} onOpenChange={setResumeExpanded}>
      <DialogContent className="!fixed !inset-0 !left-0 !top-0 !translate-x-0 !translate-y-0 !max-w-none !max-h-none !w-screen !h-screen !rounded-none !border-0 !p-[15px] !gap-0 !m-0 [&>button]:hidden">
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
