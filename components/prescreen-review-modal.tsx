"use client"

import { useCallback, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  DollarSign,
  HelpCircle,
  Loader2,
  MessageCircle,
  MessageCircleQuestion,
  MessageCircleReply,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { formatSalaryRange } from "@/lib/call-orchestrator"
import { CollectedInfoView, PreScreenVerdict } from "@/components/candidate-collected-info"
import { WhatsAppConversationModal } from "@/components/whatsapp-conversation-modal"
import type { InfoSource } from "@/lib/info-provenance"

export interface ReviewCandidate {
  participantId: string
  candidateId: string
  name: string
  currentRole?: string
  currentCompany?: string
  phone?: string
  email?: string
  // Raw collected info + where each field came from. The modal shows these
  // rather than a reconstructed message, so a value from the apply form is never
  // presented as something the candidate said on WhatsApp.
  // Candidate said they're interested on WhatsApp. The AI recorded it and sent
  // nothing further, so this is an open decision rather than a detail.
  interestNeedsApproval?: boolean
  interestFlaggedAt?: string | null
  infoData?: Record<string, unknown> | null
  infoSources?: Record<string, unknown> | null
  resumeFallback?: Record<string, unknown> | null
  // Structured AI verdict
  preScreenResult?: {
    decision?: string
    reasons?: string[]
    summary?: string
    evaluatedAt?: string
    skippedChecks?: string[]
  } | null
  aiSuggestsRejection?: boolean
  aiSuggestsRejectionAt?: string
  // Job info
  jobTitle?: string
  jobCity?: string
  jobSalaryMin?: number
  jobSalaryMax?: number
  /** 'annual' | 'monthly' | ... Decides whether the band renders as LPA or rupees. */
  jobSalaryType?: string | null
  jobExpMin?: number
  jobExpMax?: number
  // Timing
  infoReceivedAt?: string
  clarificationQuestion?: string | null
  clarificationAskedAt?: string | null
  /** Set when the candidate replies to the question. Null/absent = still waiting. */
  clarificationAnsweredAt?: string | null
  /** What they said in reply, from screening_context.clarification_answer. */
  clarificationAnswer?: string | null
  /** Raw WhatsApp thread, so the reviewer can read and reply without leaving here. */
  whatsappHistory?: unknown
}

type Decision = "approved" | "rejected" | "clarify"

interface PrescreenReviewModalProps {
  candidate: ReviewCandidate | null
  open: boolean
  onClose: () => void
  onReviewed: () => void
  totalCount?: number
  currentIndex?: number
  onNext?: () => void
  onPrev?: () => void
}

function formatTimeSince(iso: string | null | undefined): string {
  if (!iso) return "unknown"
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff)) return "unknown"
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/**
 * Whether the job row carried any requirements worth showing.
 *
 * Every tile below is individually conditional, so without this the section drew
 * a bordered card with a "Role requirements" heading and nothing under it. That
 * reads as "this role has no requirements" when it actually means "we have no
 * requirement data for this job".
 */
function hasJobRequirements(c: ReviewCandidate): boolean {
  return (
    c.jobSalaryMin != null ||
    c.jobSalaryMax != null ||
    c.jobExpMin != null ||
    c.jobExpMax != null ||
    !!c.jobCity
  )
}

/**
 * Salary band for display. Delegates to the call orchestrator's formatter so the
 * review screen and the AI caller's spoken salary band cannot disagree — both
 * previously showed raw numbers ("500000–800000") against the candidate's "12
 * LPA".
 */
function formatSalaryBand(c: ReviewCandidate): string {
  return formatSalaryRange({
    salary_min: c.jobSalaryMin,
    salary_max: c.jobSalaryMax,
    salary_type: c.jobSalaryType,
  }) || `${c.jobSalaryMin}–${c.jobSalaryMax}`
}

export function PrescreenReviewModal({
  candidate,
  open,
  onClose,
  onReviewed,
  totalCount,
  currentIndex,
  onNext,
  onPrev,
}: PrescreenReviewModalProps) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [decision, setDecision] = useState<Decision | null>(null)
  const [note, setNote] = useState("")
  // The thread opens from inside the review modal so "chat manually" is a real
  // conversation rather than a separate screen. A recruiter deciding whether to
  // spend a call slot routinely needs to read what the candidate actually said
  // first, and that text was previously only visible by hunting for the row.
  const [showThread, setShowThread] = useState(false)
  const [nudging, setNudging] = useState(false)
  // The parent's copy of the thread is a snapshot taken when the queue was built,
  // so it does not contain anything sent from inside this modal. The thread is
  // re-read from the participant row on open and after each send, which is what
  // makes the conversation continue instead of resetting.
  const [threadHistory, setThreadHistory] = useState<unknown>(null)

  const refreshThread = useCallback(async () => {
    if (!candidate?.participantId) return
    try {
      const res = await fetch(`/api/phone-screening/participants/${candidate.participantId}`)
      const json = await res.json()
      if (res.ok && json) setThreadHistory(json.whatsapp_history ?? null)
    } catch {
      // Non-fatal: the composer keeps whatever history it already had.
    }
  }, [candidate?.participantId])

  const openThread = useCallback(() => {
    setThreadHistory(candidate?.whatsappHistory ?? null)
    setShowThread(true)
    void refreshThread()
  }, [candidate?.whatsappHistory, refreshThread])

  if (!candidate) return null

  const submit = async (d: Decision) => {
    const trimmed = note.trim()
    // Rejection needs a recorded reason and clarification needs a real question.
    // Both are enforced server-side too; catching it here saves a round trip.
    if (d === "rejected" && !trimmed) {
      toast({ title: "Add a reason", description: "A rejection needs a reason on the record.", variant: "destructive" })
      return
    }
    if (d === "clarify" && !trimmed) {
      toast({ title: "Write the question", description: "Type what you want to ask the candidate.", variant: "destructive" })
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/phone-screening/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId: candidate.participantId, decision: d, note: trimmed || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to save the decision")

      const failed = (data.results || []).find((r: any) => !r.success)
      if (failed?.error) throw new Error(failed.error)

      toast({
        title: d === "approved" ? "Approved for call" : d === "rejected" ? "Candidate passed" : "Question sent",
        description:
          d === "approved"
            ? "Screening call booked. The candidate gets a confirmation."
            : d === "rejected"
              ? "Candidate notified. Your reason is on the record."
              : "Waiting for their reply — no call booked yet",
      })
      setDecision(null)
      setNote("")
      onReviewed()
      onClose()
    } catch (err: any) {
      toast({ title: "Could not save", description: err.message, variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  /**
   * Send the call nudge without deciding anything.
   *
   * The three review actions are all terminal or semi-terminal — approving books a
   * call, passing ends it, and asking a question commits to waiting on a reply. A
   * recruiter who wants to simply prompt someone again had no way to do it from
   * here, so the only option was to close the modal and go hunting. This is
   * deliberately non-committal: it prompts, it does not approve, and the row stays
   * in the review queue.
   */
  const sendCallNudge = async () => {
    if (nudging) return
    setNudging(true)
    try {
      const res = await fetch(
        `/api/phone-screening/participants/${candidate.participantId}/send-call-nudge`,
        { method: "POST" }
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `Could not send (HTTP ${res.status})`)

      toast({
        title: "Nudge sent",
        description: `We reminded ${candidate.name} to respond. No decision was recorded.`,
      })
      onReviewed()
    } catch (err: any) {
      toast({ title: "Could not send the nudge", description: err.message, variant: "destructive" })
    } finally {
      setNudging(false)
    }
  }

  const aiSaysReject = candidate.aiSuggestsRejection === true

  // Clarification state. `clarificationAnsweredAt` is set by the inbound webhook
  // when the candidate actually replies, so "waiting" and "replied" are
  // distinguishable — before this, the recruiter could not tell whether silence
  // meant "not read it yet" or "replied and we lost the answer".
  const questionSent = !!candidate.clarificationQuestion && !!candidate.clarificationAskedAt
  const hasAnswer = !!candidate.clarificationAnsweredAt
  const awaitingAnswer = questionSent && !hasAnswer

  const notesByDecision: Record<Decision, { label: string; placeholder: string; cta: string }> = {
    approved: {
      label: "Note (optional)",
      placeholder: "e.g. Confirmed the CTC expectation is workable",
      // Was "Confirm — send schedule link & book call". Two things were wrong
      // with that. The schedule link is never sent on this path: approve() calls
      // scheduleBolnaCall and books the screening call directly, so the button
      // promised a link the candidate never received. And it described the
      // outcome in terms the recruiter does not choose — they approve a person
      // for a call, they do not pick a booking method.
      cta: "Approve — book the screening call",
    },
    rejected: {
      label: "Reason for passing (required)",
      placeholder: "e.g. Expects 18L, band tops out at 12L",
      cta: "Confirm pass — notify candidate",
    },
    clarify: {
      label: "What do you need to ask? (required)",
      placeholder: "e.g. Is the 14L expectation negotiable, or is that their floor?",
      cta: "Send question",
    },
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm p-4 pt-6 pb-6"
          onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="relative w-full max-w-2xl rounded-3xl bg-white shadow-2xl border border-gray-200 overflow-hidden"
          >
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white/95 backdrop-blur px-6 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-gray-900 truncate">Review screening</h2>
                  {totalCount != null && currentIndex != null && (
                    <span className="text-xs text-gray-400 shrink-0">{currentIndex + 1} of {totalCount}</span>
                  )}
                </div>
                <p className="text-sm text-gray-500 truncate">{candidate.name} — {candidate.jobTitle || "Role"}</p>
              </div>
              <div className="flex items-center gap-2">
                {totalCount != null && totalCount > 1 && (
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" onClick={onPrev} disabled={currentIndex === 0} className="h-8 w-8 p-0">
                      ←
                    </Button>
                    <Button variant="outline" size="sm" onClick={onNext} disabled={currentIndex === totalCount - 1} className="h-8 w-8 p-0">
                      →
                    </Button>
                  </div>
                )}
                <button onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-5 max-h-[62vh] overflow-y-auto">
              {candidate.infoReceivedAt && (
                <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5">
                  <Clock className="h-4 w-4 text-amber-600" />
                  <span className="text-sm font-medium text-amber-800">
                    Waiting on your decision — details received {formatTimeSince(candidate.infoReceivedAt)}
                  </span>
                </div>
              )}

              {questionSent && (
                <div
                  className={`flex items-start gap-2 rounded-xl border px-4 py-3 ${
                    hasAnswer ? "border-emerald-200 bg-emerald-50" : "border-sky-200 bg-sky-50"
                  }`}
                >
                  {hasAnswer ? (
                    <MessageCircleReply className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                  ) : (
                    <MessageCircleQuestion className="h-4 w-4 text-sky-600 mt-0.5 shrink-0" />
                  )}
                  <div className={`text-sm min-w-0 ${hasAnswer ? "text-emerald-900" : "text-sky-900"}`}>
                    <p className="font-semibold">
                      {hasAnswer ? "They replied" : "Question sent, waiting on their reply"}
                      {hasAnswer && candidate.clarificationAnsweredAt && (
                        <span className="font-normal opacity-70">
                          {" "}· {formatTimeSince(candidate.clarificationAnsweredAt)}
                        </span>
                      )}
                    </p>
                    <p className={`mt-0.5 break-words ${hasAnswer ? "text-emerald-800" : "text-sky-700"}`}>
                      <span className="opacity-70">You asked: </span>
                      {candidate.clarificationQuestion}
                    </p>
                    {hasAnswer && (
                      <p className="mt-2 border-l-2 border-emerald-300 pl-2 break-words">
                        {candidate.clarificationAnswer || "Reply recorded — see the thread below."}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* While waiting on an answer the decision buttons stay disabled
                  elsewhere; this states why, instead of leaving the recruiter
                  guessing whether the buttons are broken. */}
              {awaitingAnswer && (
                <p className="text-xs text-sky-700">
                  Their answer is stored as soon as it arrives. Approve or pass once you have read it.
                </p>
              )}

              {/* Advisory banner: the AI's recommendation is never a decision. */}
              <div
                className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
                  aiSaysReject ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
                }`}
              >
                <ShieldCheck className={`h-5 w-5 mt-0.5 shrink-0 ${aiSaysReject ? "text-red-600" : "text-amber-600"}`} />
                <div className="min-w-0">
                  <p className={`text-sm font-bold ${aiSaysReject ? "text-red-800" : "text-amber-800"}`}>
                    {aiSaysReject ? "AI suggests this may not be a fit" : "AI flagged this for review"}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">
                    {aiSaysReject
                      ? "That is advice only — this candidate has not been told anything. You decide."
                      : "The AI did not filter them out. Confirm and the call gets booked."}
                  </p>
                </div>
              </div>

              {/* Structured verdict + per-field provenance */}
              {candidate.preScreenResult && (
                <PreScreenVerdict result={candidate.preScreenResult} />
              )}

              <div className="rounded-2xl border border-gray-200 bg-white p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-gray-400" />
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">What they told us</p>
                  </div>
                </div>
                <CollectedInfoView
                  infoData={candidate.infoData}
                  infoSources={candidate.infoSources as Record<string, InfoSource> | null}
                  fallback={candidate.resumeFallback}
                />
              </div>

              {/* Job requirements. Rendered only when the job row actually
                  carries requirements. The fields below are individually
                  conditional, so with nothing populated this drew a bordered
                  empty card under a "Role requirements" heading — which read as
                  "this role has no requirements" rather than "we don't have this
                  data". */}
              {hasJobRequirements(candidate) && (
              <div className="rounded-2xl border border-gray-200 bg-white p-4">
                <div className="flex items-center gap-2 mb-3">
                  <DollarSign className="h-4 w-4 text-gray-400" />
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Role requirements</p>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {candidate.jobSalaryMin != null && candidate.jobSalaryMax != null && (
                    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2">
                      <p className="text-[10px] text-gray-400 font-medium">Salary band</p>
                      <p className="text-sm font-semibold text-gray-800">{formatSalaryBand(candidate)}</p>
                    </div>
                  )}
                  {candidate.jobExpMin != null && (
                    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2">
                      <p className="text-[10px] text-gray-400 font-medium">Experience</p>
                      <p className="text-sm font-semibold text-gray-800">{candidate.jobExpMin}+ yrs{candidate.jobExpMax ? ` (max ${candidate.jobExpMax})` : ""}</p>
                    </div>
                  )}
                  {candidate.jobCity && (
                    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2">
                      <p className="text-[10px] text-gray-400 font-medium">Location</p>
                      <p className="text-sm font-semibold text-gray-800">{candidate.jobCity}</p>
                    </div>
                  )}
                </div>
              </div>
              )}
            </div>

            {/* Footer */}
            <div className="sticky bottom-0 border-t border-gray-100 bg-white px-6 py-4 space-y-3">
              {!decision ? (
                <>
                  {/* Read and reply without leaving the queue. The thread is the
                      first thing a recruiter needs: the decision here depends on
                      what the candidate actually said, not on the extracted
                      fields alone. */}
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={openThread}
                      variant="outline"
                      className="flex-1 h-10 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                    >
                      <MessageCircle className="h-4 w-4 mr-2" />
                      Open WhatsApp chat
                    </Button>
                    <Button
                      onClick={() => void sendCallNudge()}
                      disabled={nudging}
                      variant="outline"
                      className="flex-1 h-10 border-amber-200 text-amber-700 hover:bg-amber-50"
                    >
                      {nudging ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Bell className="h-4 w-4 mr-2" />
                      )}
                      Send call nudge
                    </Button>
                  </div>

                  <div className="flex items-center gap-3">
                    <Button
                      onClick={() => setDecision("approved")}
                      disabled={loading}
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white h-11"
                    >
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Approve for call
                    </Button>
                    <Button
                      onClick={() => setDecision("clarify")}
                      disabled={loading}
                      variant="outline"
                      className="h-11 border-sky-200 text-sky-700 hover:bg-sky-50"
                    >
                      <HelpCircle className="h-4 w-4 mr-2" /> Ask a question
                    </Button>
                    <Button
                      onClick={() => setDecision("rejected")}
                      disabled={loading}
                      variant="outline"
                      className="h-11 border-red-200 text-red-600 hover:bg-red-50"
                    >
                      <XCircle className="h-4 w-4 mr-2" /> Pass
                    </Button>
                  </div>
                  <p className="text-[11px] text-gray-400 text-center">
                    The candidate has already been told we&apos;re reviewing them. Nothing else is
                    sent until you choose.
                  </p>
                </>
              ) : (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-gray-600">{notesByDecision[decision].label}</label>
                  <textarea
                    autoFocus
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    placeholder={notesByDecision[decision].placeholder}
                  />
                  {decision === "rejected" && (
                    <p className="flex items-start gap-1.5 text-[11px] text-red-600">
                      <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                      This tells the candidate the role isn't a fit. The reason is stored against your name.
                    </p>
                  )}
                  {decision === "clarify" && (
                    <p className="text-[11px] text-sky-700">
                      Sends one WhatsApp message and waits. No call is booked until they reply and you decide again.
                    </p>
                  )}
                  {/* The first click swaps this panel in, but it looked like
                      nothing happened: the previous row disappeared and a new
                      green "Approve" button appeared in its place, so it read as
                      two identical approve buttons where one was broken rather
                      than as two steps. Naming the step and restating the
                      consequence is what makes it a two-step flow. */}
                  <p className="text-xs font-semibold text-zinc-700">
                    Step 2 of 2 — confirm
                    <span className="ml-1.5 font-normal text-zinc-500">
                      {decision === "approved" && "This books the screening call straight away."}
                      {decision === "rejected" && "This tells the candidate the role isn't a fit."}
                      {decision === "clarify" && "This sends your question and waits."}
                    </span>
                  </p>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => submit(decision)}
                      disabled={loading}
                      className={`flex-1 text-white ${
                        decision === "approved"
                          ? "bg-emerald-600 hover:bg-emerald-700"
                          : decision === "rejected"
                            ? "bg-red-600 hover:bg-red-700"
                            : "bg-sky-600 hover:bg-sky-700"
                      }`}
                    >
                      {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                      {notesByDecision[decision].cta}
                    </Button>
                    <Button
                      onClick={() => { setDecision(null); setNote("") }}
                      variant="outline"
                      className="flex-1"
                      disabled={loading}
                    >
                      Back
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {showThread && (
              <WhatsAppConversationModal
                history={threadHistory}
                candidateName={candidate.name}
                participantId={candidate.participantId}
                onSent={() => {
                  void refreshThread()
                  onReviewed()
                }}
                open={showThread}
                onOpenChange={setShowThread}
              />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
