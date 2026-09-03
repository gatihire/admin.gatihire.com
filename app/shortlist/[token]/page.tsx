"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Award,
  BrainCircuit,
  Briefcase,
  Building2,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  ExternalLink,
  Eye,
  FileText,
  GraduationCap,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  X,
  XCircle,
} from "lucide-react"

interface ExperienceRange {
  min: number | null
  max: number | null
}

interface ShareData {
  title: string
  jobId: string
  jobTitle: string
  clientName: string | null
  jobLocation: string | null
  experienceRange: ExperienceRange | null
  createdAt: string
  expiresAt: string | null
}

interface AiFit {
  score: number | null
  summary: string | null
  pros: string[]
  misses: string[]
  interviewProbes: string[]
}

interface ShareCandidate {
  id: string
  applicationId: string
  candidateId: string
  name: string
  currentRole: string | null
  currentCompany: string | null
  location: string | null
  email: string | null
  phone: string | null
  totalExperience: number | null
  summary: string | null
  technicalSkills: string[]
  softSkills: string[]
  jobTitles: string[]
  desiredRole: string | null
  resumeText: string
  hasResumeFile: boolean
  fileName: string | null
  matchScore: number | null
  screeningScore: number | null
  screeningVerdict: string | null
  aiFit: AiFit | null
  status: "pending" | "approved" | "rejected"
  decidedAt: string | null
  decisionNote: string | null
}

type LoadState = "loading" | "ready" | "error"

const VERDICT_META: Record<string, { label: string; className: string }> = {
  advance: { label: "AI Recommended", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  further_review: { label: "Worth a look", className: "bg-amber-50 text-amber-700 border-amber-200" },
  not_a_fit: { label: "Borderline", className: "bg-zinc-100 text-zinc-600 border-zinc-200" },
}

function initials(name: string | null): string {
  if (!name) return "?"
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const first = parts[0][0] ?? ""
  const last = parts[parts.length - 1][0] ?? ""
  return (first + last).toUpperCase()
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function scoreColorClass(pct: number) {
  if (pct >= 80) return { text: "text-emerald-600", stroke: "#059669", bg: "bg-emerald-50", border: "border-emerald-200" }
  if (pct >= 50) return { text: "text-amber-600", stroke: "#d97706", bg: "bg-amber-50", border: "border-amber-200" }
  return { text: "text-zinc-500", stroke: "#71717a", bg: "bg-zinc-50", border: "border-zinc-200" }
}

/** Circular match-score indicator */
function ScoreRing({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  const colors = scoreColorClass(clamped)
  const r = 15
  const c = 2 * Math.PI * r
  return (
    <div className="relative h-11 w-11 shrink-0" title={`${clamped}% match`}>
      <svg viewBox="0 0 36 36" className="h-11 w-11 -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="#e4e4e7" strokeWidth="3.5" />
        <circle
          cx="18" cy="18" r={r} fill="none"
          stroke={colors.stroke}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
        />
      </svg>
      <span className={`absolute inset-0 grid place-items-center text-[10px] font-bold ${colors.text}`}>
        {clamped}
      </span>
    </div>
  )
}

export default function ClientShortlistPage({ params }: { params: Promise<{ token: string }> }) {
  const [resolvedToken, setResolvedToken] = useState<string | null>(null)

  useEffect(() => {
    params.then(p => setResolvedToken(p.token))
  }, [params])

  return <ShortlistView token={resolvedToken} />
}

function ShortlistView({ token }: { token: string | null }) {
  const [state, setState] = useState<LoadState>("loading")
  const [error, setError] = useState("")
  const [share, setShare] = useState<ShareData | null>(null)
  const [candidates, setCandidates] = useState<ShareCandidate[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState("")
  const [openCandidateId, setOpenCandidateId] = useState<string | null>(null)

  const load = useCallback(async (t: string) => {
    setState("loading")
    setError("")
    try {
      const res = await fetch(`/api/public/shortlist/${encodeURIComponent(t)}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error || "This shortlist could not be loaded.")
        setState("error")
        return
      }
      setShare(data.share)
      setCandidates(data.candidates || [])
      setState("ready")
    } catch {
      setError("Something went wrong loading this shortlist. Please try again.")
      setState("error")
    }
  }, [])

  useEffect(() => {
    if (token) load(token)
  }, [token, load])

  const decide = useCallback(
    async (candidateId: string, decision: "approved" | "rejected", note?: string) => {
      if (!token) return
      setBusyId(candidateId)
      setActionError("")
      // Optimistic update
      setCandidates(prev =>
        prev.map(c => (c.id === candidateId ? { ...c, status: decision, decidedAt: new Date().toISOString(), ...(note !== undefined ? { decisionNote: note } : {}) } : c))
      )
      try {
        const res = await fetch(`/api/public/shortlist/${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId, decision, note }),
        })
        const data = await res.json()
        if (!res.ok) {
          setActionError(data?.error || "Could not record your decision. Please try again.")
          // Revert optimistic update
          setCandidates(prev => prev.map(c => (c.id === candidateId ? { ...c, status: "pending", decidedAt: null } : c)))
          return
        }
        setCandidates(prev =>
          prev.map(c => (c.id === candidateId ? { ...c, ...data.candidate } : c))
        )
      } catch {
        setActionError("Could not record your decision. Please try again.")
        setCandidates(prev => prev.map(c => (c.id === candidateId ? { ...c, status: "pending", decidedAt: null } : c)))
      } finally {
        setBusyId(null)
      }
    },
    [token]
  )

  const openCandidate = useMemo(
    () => candidates.find(c => c.id === openCandidateId) || null,
    [candidates, openCandidateId]
  )

  const pendingCount = useMemo(() => candidates.filter(c => c.status === "pending").length, [candidates])
  const approvedCount = useMemo(() => candidates.filter(c => c.status === "approved").length, [candidates])
  const reviewedCount = candidates.length - pendingCount
  const reviewPct = candidates.length > 0 ? Math.round((reviewedCount / candidates.length) * 100) : 0

  return (
    <main className="min-h-screen bg-gradient-to-b from-indigo-50/60 via-gray-50 to-gray-50">
      {/* Top brand bar */}
      <header className="sticky top-0 z-40 border-b border-gray-200/80 bg-white/85 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 py-3 sm:px-6 flex items-center justify-between">
          <div className="flex items-center gap-2 text-gray-900 font-semibold">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-sm">
              <Share2 className="h-4 w-4" />
            </div>
            GatiHire
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            Secure private link
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {state === "loading" && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-500">
            <Loader2 className="h-6 w-6 animate-spin mb-3 text-indigo-500" />
            <p className="text-sm">Preparing your shortlist…</p>
          </div>
        )}

        {state === "error" && (
          <div className="rounded-2xl border border-gray-200 bg-white px-6 py-16 text-center shadow-sm">
            <XCircle className="mx-auto h-10 w-10 text-red-400 mb-4" />
            <h1 className="text-lg font-semibold text-gray-900">Link unavailable</h1>
            <p className="mt-2 text-sm text-gray-500">{error}</p>
          </div>
        )}

        {state === "ready" && share && (
          <>
            {/* Hero */}
            <div className="mb-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
                {share.clientName || "Hiring partner"} · Curated for you
              </p>
              <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">{share.title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
                {share.jobLocation && (
                  <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{share.jobLocation}</span>
                )}
                {share.experienceRange?.min != null && (
                  <span className="inline-flex items-center gap-1">
                    <Briefcase className="h-3.5 w-3.5" />
                    {share.experienceRange.max != null && share.experienceRange.max !== share.experienceRange.min
                      ? `${share.experienceRange.min}–${share.experienceRange.max} yrs`
                      : `${share.experienceRange.min}+ yrs`}
                  </span>
                )}
                <span>Shared {formatDate(share.createdAt)}</span>
              </div>

              {/* Stats + progress */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <StatChip icon={Eye} label={`${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`} />
                {approvedCount > 0 && <StatChip icon={ThumbsUp} tone="emerald" label={`${approvedCount} approved`} />}
                {pendingCount > 0 && <StatChip icon={Clock} tone="indigo" label={`${pendingCount} awaiting review`} />}
                {share.expiresAt && (
                  <StatChip icon={Clock} tone="zinc" label={`Link expires ${formatDate(share.expiresAt)}`} />
                )}
              </div>

              {/* Review progress */}
              {candidates.length > 0 && (
                <div className="mt-4 max-w-md">
                  <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
                    <span>Review progress</span>
                    <span className="font-medium">{reviewedCount} of {candidates.length} reviewed</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500"
                      style={{ width: `${reviewPct}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {actionError && (
              <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {actionError}
              </div>
            )}

            {candidates.length === 0 ? (
              <div className="rounded-2xl border border-gray-200 bg-white px-6 py-16 text-center text-sm text-gray-500 shadow-sm">
                No candidates in this shortlist yet.
              </div>
            ) : (
              <ul className="space-y-4">
                {candidates.map((candidate, idx) => (
                  <ShortlistCard
                    key={candidate.id}
                    candidate={candidate}
                    rank={idx + 1}
                    busy={busyId === candidate.id}
                    onDecide={decide}
                    onOpen={() => setOpenCandidateId(candidate.id)}
                  />
                ))}
              </ul>
            )}

            <p className="mt-10 text-center text-xs text-gray-400">
              Powered by GatiHire · Shared {formatDate(share.createdAt)}
            </p>
          </>
        )}
      </div>

      {/* Full profile drawer */}
      {openCandidate && (
        <ProfileDrawer
          candidate={openCandidate}
          token={token}
          busy={busyId === openCandidate.id}
          onClose={() => setOpenCandidateId(null)}
          onDecide={decide}
        />
      )}
    </main>
  )
}

function StatChip({
  icon: Icon,
  label,
  tone = "white",
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  tone?: "white" | "emerald" | "indigo" | "zinc"
}) {
  const tones = {
    white: "bg-white border-gray-200 text-gray-700",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-700",
    indigo: "bg-indigo-50 border-indigo-200 text-indigo-700",
    zinc: "bg-gray-50 border-gray-200 text-gray-500",
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${tones[tone]}`}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  )
}

/* ------------------------------- Card ------------------------------- */

function ShortlistCard({
  candidate,
  rank,
  busy,
  onDecide,
  onOpen,
}: {
  candidate: ShareCandidate
  rank: number
  busy: boolean
  onDecide: (id: string, d: "approved" | "rejected", note?: string) => void
  onOpen: () => void
}) {
  const verdict = candidate.screeningVerdict ? VERDICT_META[candidate.screeningVerdict] : undefined
  const matchPct = candidate.matchScore != null ? Math.round(candidate.matchScore * 100) : null
  const decided = candidate.status !== "pending"
  const fitLine =
    candidate.aiFit?.summary ||
    candidate.aiFit?.pros?.[0] ||
    null

  return (
    <li
      className={`group relative overflow-hidden rounded-2xl border bg-white shadow-sm transition-all hover:shadow-md ${
        candidate.status === "approved"
          ? "border-emerald-300"
          : candidate.status === "rejected"
            ? "border-gray-200 opacity-70"
            : "border-gray-200"
      }`}
    >
      {/* Rank ribbon */}
      {matchPct != null && !decided && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-indigo-500 to-violet-500" />
      )}

      <div className="p-4 sm:p-5 pl-5 sm:pl-6">
        <div className="flex items-start gap-4">
          {/* Avatar */}
          <button onClick={onOpen} className="relative shrink-0 focus:outline-none" aria-label="View profile">
            <div className={`grid h-12 w-12 place-items-center rounded-xl text-sm font-bold shadow-sm ${
              decided
                ? candidate.status === "approved"
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-gray-100 text-gray-400"
                : "bg-gradient-to-br from-indigo-100 to-violet-100 text-indigo-700"
            }`}>
              {initials(candidate.name)}
            </div>
            {!decided && (
              <span className="absolute -top-1.5 -left-1.5 grid h-5 w-5 place-items-center rounded-full bg-gray-900 text-[10px] font-bold text-white">
                {rank}
              </span>
            )}
          </button>

          {/* Main info */}
          <button onClick={onOpen} className="min-w-0 flex-1 text-left focus:outline-none">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-base font-semibold text-gray-900 group-hover:text-indigo-700 transition-colors">
                {candidate.name}
              </h2>
              {verdict && (
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${verdict.className}`}>
                  <Sparkles className="h-3 w-3" />
                  {verdict.label}
                </span>
              )}
              {decided && (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  candidate.status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
                }`}>
                  {candidate.status === "approved" ? "Approved by you" : "Passed"}
                </span>
              )}
            </div>

            <p className="mt-0.5 truncate text-sm text-gray-600">
              {[candidate.currentRole, candidate.currentCompany].filter(Boolean).join(" · ") || "Profile available"}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
              {candidate.totalExperience != null && candidate.totalExperience > 0 && (
                <span className="inline-flex items-center gap-1"><Briefcase className="h-3 w-3" />{candidate.totalExperience} yr{candidate.totalExperience === 1 ? "" : "s"}</span>
              )}
              {candidate.location && (
                <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{candidate.location}</span>
              )}
              {(candidate.technicalSkills?.length ?? 0) > 0 && (
                <span className="hidden sm:inline text-gray-400">
                  {candidate.technicalSkills.slice(0, 4).join(" · ")}
                  {candidate.technicalSkills.length > 4 && ` +${candidate.technicalSkills.length - 4}`}
                </span>
              )}
            </div>

            {fitLine && (
              <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-gray-500">
                <Sparkles className="mr-1 inline h-3 w-3 text-violet-500 align-[-1px]" />
                {fitLine}
              </p>
            )}
          </button>

          {/* Right column: score + actions */}
          <div className="flex shrink-0 flex-col items-end gap-2.5">
            {matchPct != null && (
              <div className="flex items-center gap-1.5">
                <ScoreRing pct={matchPct} />
                <span className="sr-only">{matchPct}% match</span>
              </div>
            )}

            {!decided ? (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => onDecide(candidate.id, "approved")}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Approve
                </button>
                <RejectButton candidate={candidate} busy={busy} onReject={onDecide} />
              </div>
            ) : (
              <button
                onClick={onOpen}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-300 transition-colors"
              >
                <FileText className="h-3.5 w-3.5" />
                View profile
              </button>
            )}

            {!decided && (
              <button
                onClick={onOpen}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                View full profile & resume
                <ChevronDown className="h-3 w-3 -rotate-90" />
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

function RejectButton({
  candidate,
  busy,
  onReject,
}: {
  candidate: ShareCandidate
  busy: boolean
  onReject: (candidateId: string, decision: "approved" | "rejected", note?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
      >
        <XCircle className="h-3.5 w-3.5" />
        Pass
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-gray-200 bg-white p-4 shadow-xl">
            <label className="block text-xs font-medium text-gray-600">Reason (optional)</label>
            <textarea
              ref={noteRef}
              autoFocus
              rows={3}
              className="mt-1.5 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="e.g. Salary expectations, missing experience…"
            />
            <button
              onClick={() => {
                onReject(candidate.id, "rejected", noteRef.current?.value.trim() || undefined)
                setOpen(false)
              }}
              className="mt-2 w-full rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
            >
              Confirm pass
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------ Drawer ------------------------------ */

function ProfileDrawer({
  candidate,
  token,
  busy,
  onClose,
  onDecide,
}: {
  candidate: ShareCandidate
  token: string | null
  busy: boolean
  onClose: () => void
  onDecide: (id: string, d: "approved" | "rejected", note?: string) => void
}) {
  const [tab, setTab] = useState<"overview" | "resume">("overview")
  const [resumeUrl, setResumeUrl] = useState<string | null>(null)
  const [resumeLoading, setResumeLoading] = useState(false)
  const [resumeError, setResumeError] = useState("")
  const [noteOpen, setNoteOpen] = useState(false)

  useEffect(() => {
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = ""
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const isPdf = useMemo(() => {
    if (!candidate.fileName) return true
    return /\.pdf($|\?)/i.test(candidate.fileName) || !/\.(docx?|rtf|txt)$/i.test(candidate.fileName)
  }, [candidate.fileName])

  const loadResume = useCallback(async () => {
    if (!token || resumeUrl || resumeLoading) return
    if (!candidate.hasResumeFile) return
    setResumeLoading(true)
    setResumeError("")
    try {
      const res = await fetch(
        `/api/public/shortlist/${encodeURIComponent(token)}/candidates/${encodeURIComponent(candidate.id)}/resume`
      )
      const data = await res.json()
      if (!res.ok) {
        setResumeError(data?.error || "Resume file is not available.")
        return
      }
      setResumeUrl(data.url)
    } catch {
      setResumeError("Could not load the resume file.")
    } finally {
      setResumeLoading(false)
    }
  }, [token, candidate.id, candidate.hasResumeFile, resumeUrl, resumeLoading])

  const openResumeTab = useCallback(() => {
    setTab("resume")
    loadResume()
  }, [loadResume])

  const hasText = Boolean(candidate.resumeText?.trim())

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-gray-900/50 backdrop-blur-[2px]" onClick={onClose} />

      <div className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col bg-white shadow-2xl sm:rounded-l-3xl animate-in slide-in-from-right duration-300 overflow-hidden">
        {/* Drawer header */}
        <div className="relative shrink-0 border-b border-gray-200 bg-gradient-to-r from-indigo-50 via-violet-50 to-white px-5 py-4 sm:px-6">
          <button
            onClick={onClose}
            className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full bg-white/80 text-gray-500 shadow-sm hover:bg-white hover:text-gray-800 transition-colors"
            aria-label="Close profile"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="flex items-start gap-3.5 pr-10">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-lg font-bold text-white shadow-md">
              {initials(candidate.name)}
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold text-gray-900">{candidate.name}</h2>
              <p className="truncate text-sm text-gray-600">
                {[candidate.currentRole, candidate.currentCompany].filter(Boolean).join(" · ") || "—"}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {candidate.matchScore != null && (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${scoreColorClass(Math.round(candidate.matchScore * 100)).bg} ${scoreColorClass(Math.round(candidate.matchScore * 100)).border} ${scoreColorClass(Math.round(candidate.matchScore * 100)).text}`}>
                    <Award className="h-3 w-3" />
                    {Math.round(candidate.matchScore * 100)}% match
                  </span>
                )}
                {candidate.screeningVerdict && VERDICT_META[candidate.screeningVerdict] && (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${VERDICT_META[candidate.screeningVerdict].className}`}>
                    {VERDICT_META[candidate.screeningVerdict].label}
                  </span>
                )}
                {candidate.screeningScore != null && (
                  <span className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-600">
                    AI screen {candidate.screeningScore}/10
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Contact strip */}
          {(candidate.email || candidate.phone) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              {candidate.email && (
                <a href={`mailto:${candidate.email}`} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-gray-600 hover:border-indigo-300 hover:text-indigo-700 transition-colors">
                  <Mail className="h-3 w-3" />
                  {candidate.email}
                </a>
              )}
              {candidate.phone && (
                <a href={`tel:${candidate.phone}`} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-gray-600 hover:border-indigo-300 hover:text-indigo-700 transition-colors">
                  <Phone className="h-3 w-3" />
                  {candidate.phone}
                </a>
              )}
            </div>
          )}

          {/* Tabs */}
          <div className="mt-4 flex gap-1">
            <DrawerTab active={tab === "overview"} onClick={() => setTab("overview")} icon={Eye} label="Overview" />
            <DrawerTab
              active={tab === "resume"}
              onClick={openResumeTab}
              icon={FileText}
              label="Resume"
              badge={!candidate.hasResumeFile && !hasText ? "N/A" : undefined}
            />
          </div>
        </div>

        {/* Drawer body */}
        <div className="flex-1 overflow-y-auto bg-gray-50/60">
          {tab === "overview" ? (
            <div className="space-y-5 p-5 sm:p-6">
              {/* Quick facts */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <FactTile icon={Briefcase} label="Experience" value={candidate.totalExperience != null && candidate.totalExperience > 0 ? `${candidate.totalExperience} yrs` : "—"} />
                <FactTile icon={MapPin} label="Location" value={candidate.location || "—"} />
                <FactTile icon={Building2} label="Current" value={candidate.currentCompany || "—"} />
                <FactTile icon={GraduationCap} label="Target role" value={candidate.desiredRole || candidate.currentRole || "—"} />
              </div>

              {/* Summary */}
              {candidate.summary && (
                <Section icon={MessageSquare} title="Professional summary">
                  <p className="whitespace-pre-line text-sm leading-relaxed text-gray-600">{candidate.summary}</p>
                </Section>
              )}

              {/* Skills */}
              {(candidate.technicalSkills.length > 0 || candidate.softSkills.length > 0) && (
                <Section icon={Sparkles} title="Skills">
                  <div className="space-y-3">
                    {candidate.technicalSkills.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Technical</p>
                        <div className="flex flex-wrap gap-1.5">
                          {candidate.technicalSkills.map((s, i) => (
                            <span key={i} className="rounded-lg border border-indigo-100 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700">
                              {s}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {candidate.softSkills.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Strengths</p>
                        <div className="flex flex-wrap gap-1.5">
                          {candidate.softSkills.map((s, i) => (
                            <span key={i} className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600">
                              {s}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {/* AI Insight */}
              {candidate.aiFit && (
                <div className="overflow-hidden rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-indigo-50 p-5">
                  <div className="flex items-center gap-2">
                    <BrainCircuit className="h-4 w-4 text-violet-600" />
                    <h3 className="text-sm font-bold text-violet-900">Why we shortlisted this candidate</h3>
                    {candidate.aiFit.score != null && (
                      <span className="ml-auto rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-bold text-white">
                        {Math.round(candidate.aiFit.score)}% fit
                      </span>
                    )}
                  </div>
                  {candidate.aiFit.summary && (
                    <p className="mt-2.5 text-sm leading-relaxed text-violet-900/80">{candidate.aiFit.summary}</p>
                  )}
                  {(candidate.aiFit.pros.length > 0 || candidate.aiFit.misses.length > 0) && (
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      {candidate.aiFit.pros.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Strengths</p>
                          <ul className="space-y-1.5">
                            {candidate.aiFit.pros.map((p, i) => (
                              <li key={i} className="flex items-start gap-1.5 text-xs text-gray-700">
                                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                                {p}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {candidate.aiFit.misses.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-orange-700">Gaps to probe</p>
                          <ul className="space-y-1.5">
                            {candidate.aiFit.misses.map((m, i) => (
                              <li key={i} className="flex items-start gap-1.5 text-xs text-gray-700">
                                <Search className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-400" />
                                {m}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  {candidate.aiFit.interviewProbes.length > 0 && (
                    <div className="mt-4 rounded-xl bg-white/70 p-3">
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-700">Suggested interview questions</p>
                      <ol className="list-decimal space-y-1 pl-4 text-xs text-gray-600">
                        {candidate.aiFit.interviewProbes.map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}

              {/* Decision history */}
              {candidate.decisionNote && candidate.status === "rejected" && (
                <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-500">
                  <span className="font-semibold text-gray-700">Your note:</span> {candidate.decisionNote}
                </div>
              )}
            </div>
          ) : (
            /* ------------------------- Resume tab ------------------------- */
            <div className="p-5 sm:p-6">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-gray-500">
                  {candidate.fileName || (hasText ? "Extracted resume text" : "No resume")}
                </span>
                {resumeUrl && (
                  <>
                    <a
                      href={resumeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-indigo-300 hover:text-indigo-700 transition-colors"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open in new tab
                    </a>
                    <a
                      href={resumeUrl}
                      download={candidate.fileName || "resume"}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download
                    </a>
                  </>
                )}
              </div>

              {resumeLoading && (
                <div className="flex h-96 flex-col items-center justify-center gap-3 rounded-xl border border-gray-200 bg-white text-gray-400">
                  <Loader2 className="h-5 w-5 animate-spin text-indigo-500" />
                  <span className="text-sm">Loading resume…</span>
                </div>
              )}

              {!resumeLoading && resumeError && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  {resumeError}
                  {hasText && <p className="mt-1 text-xs text-amber-700">You can still read the extracted resume text below.</p>}
                </div>
              )}

              {!resumeLoading && !resumeError && resumeUrl && isPdf && (
                <iframe
                  src={resumeUrl}
                  title={`${candidate.name} — resume`}
                  className="h-[calc(100vh-19rem)] min-h-[28rem] w-full rounded-xl border border-gray-200 bg-white"
                />
              )}

              {!resumeLoading && !resumeError && resumeUrl && !isPdf && hasText && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                    Word documents can&apos;t be previewed inline — use the buttons above to open or download the original.
                  </div>
                  <TextResume content={candidate.resumeText} />
                </div>
              )}

              {!resumeLoading && !resumeError && !resumeUrl && hasText && (
                <TextResume content={candidate.resumeText} />
              )}

              {!resumeLoading && !hasText && !resumeUrl && !resumeError && (
                <div className="flex h-96 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white text-gray-400">
                  <FileText className="h-8 w-8" />
                  <span className="text-sm">No resume attached for this candidate.</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sticky footer actions */}
        <div className="shrink-0 border-t border-gray-200 bg-white px-5 py-3.5 sm:px-6">
          {candidate.status === "pending" ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => onDecide(candidate.id, "approved")}
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Approve — move to interview
              </button>
              <div className="relative">
                <button
                  onClick={() => setNoteOpen(v => !v)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                >
                  <XCircle className="h-4 w-4" />
                  Pass
                </button>
                {noteOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setNoteOpen(false)} />
                    <PassNotePopover
                      onSubmit={(note) => {
                        onDecide(candidate.id, "rejected", note)
                        setNoteOpen(false)
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className={`flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold ${
              candidate.status === "approved"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-gray-100 text-gray-500"
            }`}>
              {candidate.status === "approved" ? (
                <><CheckCircle2 className="h-4 w-4" /> Approved on {formatDate(candidate.decidedAt)} — our team will coordinate next steps</>
              ) : (
                <><XCircle className="h-4 w-4" /> Passed on {formatDate(candidate.decidedAt)}</>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DrawerTab({
  active,
  onClick,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  badge?: string
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors ${
        active ? "bg-gray-900 text-white shadow-sm" : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {badge && <span className="rounded-full bg-red-100 px-1.5 text-[10px] font-bold text-red-600">{badge}</span>}
    </button>
  )
}

function FactTile({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <p className="mt-1 truncate text-sm font-medium text-gray-800" title={value}>{value}</p>
    </div>
  )
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="mb-2.5 flex items-center gap-2">
        <Icon className="h-4 w-4 text-indigo-500" />
        <h3 className="text-sm font-bold text-gray-900">{title}</h3>
      </div>
      {children}
    </section>
  )
}

function TextResume({ content }: { content: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-gray-700">
        {content}
      </pre>
    </div>
  )
}

function PassNotePopover({ onSubmit }: { onSubmit: (note?: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <div className="absolute bottom-full right-0 z-20 mb-2 w-72 rounded-xl border border-gray-200 bg-white p-4 shadow-xl">
      <label className="block text-xs font-medium text-gray-600">Reason (optional)</label>
      <textarea
        ref={ref}
        autoFocus
        rows={3}
        className="mt-1.5 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        placeholder="e.g. Salary expectations, missing experience…"
      />
      <button
        onClick={() => onSubmit(ref.current?.value.trim() || undefined)}
        className="mt-2 w-full rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
      >
        Confirm pass
      </button>
    </div>
  )
}
