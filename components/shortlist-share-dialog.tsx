import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import {
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Mail,
  RefreshCw,
  Share2,
  Trash2,
  XCircle,
} from "lucide-react"

interface ShareCandidateDecision {
  id: string
  name: string
  applicationId: string
  candidateId: string
  status: "pending" | "approved" | "rejected"
  decidedAt: string | null
  decisionNote: string | null
}

interface CurrentShortlistCandidate {
  candidateId: string
  name: string | null
  currentRole: string | null
  matchScore: number | null
}

interface ShareSummary {
  id: string
  title: string
  token: string
  url: string
  createdAt: string
  expiresAt: string | null
  expired: boolean
  candidateCount: number
  decidedCount: number
  byStatus: { pending: number; approved: number; rejected: number }
  candidates: ShareCandidateDecision[]
}

interface ShareShortlistDialogProps {
  jobId: string
  jobTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDecisionsChanged?: () => void
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export function ShareShortlistDialog({
  jobId,
  jobTitle,
  open,
  onOpenChange,
  onDecisionsChanged,
}: ShareShortlistDialogProps) {
  const { toast } = useToast()
  const [shares, setShares] = useState<ShareSummary[]>([])
  const [currentShortlist, setCurrentShortlist] = useState<CurrentShortlistCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [resending, setResending] = useState<string | null>(null)
  const [expiresInDays, setExpiresInDays] = useState(30)
  const [copied, setCopied] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState<string | null>(null)

  const loadShares = useCallback(async () => {
    if (!open) return
    setLoading(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/shortlist-share`, { cache: "no-store" })
      const data = await res.json()
      if (res.ok) {
        setShares(data.shares || [])
        setCurrentShortlist(data.currentShortlist || [])
      }
    } catch {
      // ignore; dialog shows empty state
    } finally {
      setLoading(false)
    }
  }, [open, jobId])

  useEffect(() => {
    if (open) loadShares()
  }, [open, loadShares])

  const createShare = async () => {
    setCreating(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/shortlist-share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays, title: `${jobTitle} — Shortlist` }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Could not share shortlist", description: data?.error || "Please try again.", variant: "destructive" })
        return
      }
      setShares(prev => [{ ...data.share, byStatus: { pending: data.share.candidateCount, approved: 0, rejected: 0 }, candidates: [] }, ...prev])
      toast({ title: "Shortlist link created", description: data.message })
      onDecisionsChanged?.()
    } catch {
      toast({ title: "Could not share shortlist", description: "Please try again.", variant: "destructive" })
    } finally {
      setCreating(false)
    }
  }

  const copyLink = async (url: string, id: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(id)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      toast({ title: "Could not copy link", variant: "destructive" })
    }
  }

  const resendEmail = async (share: ShareSummary) => {
    setResending(share.id)
    try {
      const res = await fetch(`/api/jobs/${jobId}/shortlist-share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resendShareId: share.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Could not resend email", description: data?.error || "Please try again.", variant: "destructive" })
        return
      }
      toast({ title: "Email sent", description: data.message })
    } catch {
      toast({ title: "Could not resend email", variant: "destructive" })
    } finally {
      setResending(null)
    }
  }

  const revokeShare = async (share: ShareSummary) => {
    if (!window.confirm("Revoke this share link? Clients with the link will no longer be able to view it.")) return
    setRefreshing(share.id)
    try {
      const res = await fetch(`/api/jobs/${jobId}/shortlist-share`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId: share.id }),
      })
      if (res.ok) {
        setShares(prev => prev.filter(s => s.id !== share.id))
        toast({ title: "Share revoked" })
        onDecisionsChanged?.()
      } else {
        toast({ title: "Could not revoke link", variant: "destructive" })
      }
    } catch {
      toast({ title: "Could not revoke link", variant: "destructive" })
    } finally {
      setRefreshing(null)
    }
  }

  const decisionCounts = (share: ShareSummary) => {
    const decided = share.decidedCount || share.byStatus.approved + share.byStatus.rejected
    return {
      pending: share.candidateCount - decided,
      approved: share.byStatus.approved || 0,
      rejected: share.byStatus.rejected || 0,
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-5 w-5 text-indigo-600" />
            Share shortlist
          </DialogTitle>
          <DialogDescription>
            Share an AI-screened shortlist with the client. No login required — they get a secure private link where they can
            approve or pass each candidate.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="number"
              min={1}
              max={90}
              value={expiresInDays}
              onChange={e => setExpiresInDays(Math.max(1, Math.min(90, Number(e.target.value) || 30)))}
              className="w-24 bg-white"
              aria-label="Link expiry in days"
            />
            <span className="text-sm text-gray-600">day link expiry</span>
            <Button onClick={createShare} disabled={creating} className="ml-auto bg-indigo-600 hover:bg-indigo-700">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Generate link
            </Button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Generates a link to the current shortlist. The link stays live until you revoke it or it expires.
          </p>

          {/* Preview: what a new link would contain */}
          <div className="mt-3 rounded-lg border border-indigo-100 bg-white p-3">
            <p className="text-xs font-semibold text-gray-700">
              A new link would include{" "}
              <span className="text-indigo-600">{currentShortlist.length}</span> shortlisted candidate
              {currentShortlist.length === 1 ? "" : "s"}
            </p>
            {currentShortlist.length > 0 && (
              <ul className="mt-2 space-y-1">
                {currentShortlist.slice(0, 6).map((c) => (
                  <li key={c.candidateId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-gray-600">
                      {c.name || "Candidate"}
                      {c.currentRole && <span className="text-gray-400"> · {c.currentRole}</span>}
                    </span>
                    {c.matchScore != null && (
                      <span className="shrink-0 font-medium text-gray-500">
                        {Math.round(c.matchScore * 100)}%
                      </span>
                    )}
                  </li>
                ))}
                {currentShortlist.length > 6 && (
                  <li className="text-xs text-gray-400">+{currentShortlist.length - 6} more…</li>
                )}
              </ul>
            )}
            {currentShortlist.length === 0 && (
              <p className="mt-1.5 text-xs text-amber-600">
                Shortlist stage is empty — move candidates to the Shortlist pipeline stage first.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Active shares</h3>
            <Button variant="ghost" size="sm" onClick={loadShares} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>

          {loading && shares.length === 0 && (
            <div className="flex items-center justify-center py-8 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading…
            </div>
          )}

          {!loading && shares.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">
              No active share links. Generate one above to share the shortlist with your client.
            </div>
          )}

          {shares.map(share => {
            const counts = decisionCounts(share)
            return (
              <div key={share.id} className="rounded-xl border border-gray-200 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-medium text-gray-900">{share.title}</h4>
                    <p className="mt-0.5 text-xs text-gray-500">
                      Created {formatDate(share.createdAt)}
                      {share.expired ? (
                        <span className="ml-1 rounded bg-red-50 px-1.5 py-0.5 font-medium text-red-600">Expired</span>
                      ) : (
                        share.expiresAt && (
                          <span className="ml-1">· Expires {formatDate(share.expiresAt)}</span>
                        )
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Resend email to client"
                      disabled={resending === share.id || share.expired}
                      onClick={() => resendEmail(share)}
                    >
                      {resending === share.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" title="Copy link" onClick={() => copyLink(share.url, share.id)}>
                      {copied === share.id ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" title="Open link" onClick={() => window.open(share.url, "_blank")}>
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Revoke link"
                      disabled={refreshing === share.id}
                      onClick={() => revokeShare(share)}
                    >
                      {refreshing === share.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-red-500" />}
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-gray-600">
                    <Clock className="h-3 w-3" /> {counts.pending} pending
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">
                    <CheckCircle2 className="h-3 w-3" /> {counts.approved} approved
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-red-700">
                    <XCircle className="h-3 w-3" /> {counts.rejected} passed
                  </span>
                </div>

                {share.candidates.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t border-gray-100 pt-3">
                    {share.candidates.map(c => (
                      <div key={c.id}>
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-gray-700">{c.name || "Candidate"}</span>
                          <span
                            className={`shrink-0 font-medium ${
                              c.status === "approved"
                                ? "text-emerald-600"
                                : c.status === "rejected"
                                  ? "text-red-500"
                                  : "text-gray-400"
                            }`}
                          >
                            {c.status === "approved" ? "Approved" : c.status === "rejected" ? "Passed" : "Awaiting client"}
                          </span>
                        </div>
                        {c.decisionNote && (
                          <p className="mt-0.5 truncate text-[11px] italic text-gray-400" title={c.decisionNote}>
                            “{c.decisionNote}”
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
