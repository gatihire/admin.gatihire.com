"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Eye, RefreshCw, User, MapPin, Briefcase, CheckCircle, Clock, Sparkles, Loader2, RotateCw } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import dynamic from "next/dynamic"
import { cachedFetchJson, invalidateSessionCache } from "@/lib/utils"

const CandidatePreviewDialogDynamic = dynamic(() => import("./candidate-preview-dialog").then(m => m.CandidatePreviewDialog), {
  ssr: false,
})

interface JobMatchesTabProps {
  jobId: string
  onShortlist?: () => void
}

export function JobMatchesTab({ jobId, onShortlist }: JobMatchesTabProps) {
  const { toast } = useToast()
  const [matches, setMatches] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedCandidate, setSelectedCandidate] = useState<any>(null)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(20)
  const [total, setTotal] = useState(0)
  const [aiByCandidateId, setAiByCandidateId] = useState<Record<string, { summary: string; expanded: boolean; visible: boolean }>>({})
  const [aiLoadingByCandidateId, setAiLoadingByCandidateId] = useState<Record<string, true>>({})

  const fetchMatches = async (opts?: { refresh?: boolean }) => {
    try {
      if (!opts?.refresh) setLoading(true)
      const url = `/api/jobs/${jobId}/matches?page=${page}&perPage=${perPage}${opts?.refresh ? "&refresh=1" : ""}`
      const data = await cachedFetchJson<any>(
        `internal:job-matches:${jobId}:page:${page}:per:${perPage}:${opts?.refresh ? "refresh" : "base"}`,
        url,
        undefined,
        { ttlMs: 5 * 60_000, force: Boolean(opts?.refresh) },
      )
      setMatches(data.items || [])
      setTotal(data.total || 0)
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to fetch matches",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchMatches()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, page, perPage])

  const refreshMatches = async () => {
    setRefreshing(true)
    invalidateSessionCache(`internal:job-matches:${jobId}:`, { prefix: true })
    await fetchMatches({ refresh: true })
    setRefreshing(false)
    toast({ title: "Refreshed", description: "Database matches have been recomputed." })
  }

  const shortlist = async (candidateId: string, score: number) => {
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            job_id: jobId, 
            candidate_id: candidateId, 
            source: "database", 
            status: "shortlist",
            match_score: score
        })
      })
      
      if (res.status === 409) {
        toast({ title: "Already added", description: "Candidate already in applicants" })
        return
      }
      
      if (!res.ok) throw new Error("Failed to shortlist")
      
      toast({ title: "Shortlisted", description: "Candidate added to Shortlisted from DB" })
      
      // Update local state to reflect change (optional, maybe remove from list or show checkmark)
      if (onShortlist) onShortlist()
    } catch (e) {
      toast({ title: "Error", description: "Failed to shortlist candidate", variant: "destructive" })
    }
  }

  const openPreview = (match: any) => {
    if (!match.candidate) return
    // Merge match details into candidate object for preview
    const candidateWithMatchInfo = {
        ...match.candidate,
        relevanceScore: match.relevance_score,
        matchSummary: match.match_summary
    }
    setSelectedCandidate(candidateWithMatchInfo)
    setIsPreviewOpen(true)
  }

  const toggleAi = async (candidateId: string, force?: boolean) => {
    if (!candidateId) return
    const existing = aiByCandidateId[candidateId]
    if (!force && existing?.summary) {
      setAiByCandidateId((prev) => ({
        ...prev,
        [candidateId]: { ...prev[candidateId], visible: !prev[candidateId].visible }
      }))
      return
    }

    setAiLoadingByCandidateId((prev) => ({ ...prev, [candidateId]: true }))
    try {
      const res = await fetch("/api/matches/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, candidateId, force: !!force })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to generate analysis")
      setAiByCandidateId((prev) => ({
        ...prev,
        [candidateId]: { summary: String(data?.summary || ""), expanded: false, visible: true }
      }))
    } catch (e: any) {
      toast({ title: "AI analysis failed", description: e?.message || "Failed", variant: "destructive" })
    } finally {
      setAiLoadingByCandidateId((prev) => {
        const next = { ...prev }
        delete next[candidateId]
        return next
      })
    }
  }

  const getRelevanceColor = (score: number) => {
    if (score >= 0.8) return "bg-green-100 text-green-800 border-green-200"
    if (score >= 0.6) return "bg-yellow-100 text-yellow-800 border-yellow-200"
    return "bg-gray-100 text-gray-800 border-gray-200"
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center bg-white p-4 rounded-lg border shadow-sm">
        <div className="text-sm text-gray-500">
            Found {total} potential matches
        </div>
        <Button variant="outline" size="sm" onClick={refreshMatches} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
          Refresh Database
        </Button>
      </div>

      {loading && !refreshing ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full"></div>
        </div>
      ) : matches.length === 0 ? (
        <div className="text-center py-12 text-gray-500 bg-white rounded-lg border border-dashed">
          No matches found. Try refreshing the database.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {matches.map((match) => (
            <Card key={`${match.job_id}-${match.candidate_id}`} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4 flex items-start gap-4">
                <Avatar className="h-12 w-12 border">
                    <AvatarFallback className="bg-blue-50 text-blue-700">
                        {match.candidate?.name?.charAt(0) || "?"}
                    </AvatarFallback>
                </Avatar>
                
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex justify-between items-start">
                    <div>
                        <h4 className="font-medium text-base truncate">{match.candidate?.name || "Unknown Candidate"}</h4>
                        <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className={`${getRelevanceColor(match.relevance_score || 0)} font-normal`}>
                                {Math.round((match.relevance_score || 0) * 100)}% Match
                            </Badge>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                         <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => openPreview(match)}>
                            <Eye className="h-4 w-4 text-gray-500" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          disabled={!!aiLoadingByCandidateId[match.candidate_id]}
                          onClick={() => toggleAi(match.candidate_id)}
                        >
                          {aiLoadingByCandidateId[match.candidate_id] ? <Loader2 className="h-4 w-4 animate-spin text-purple-600" /> : <Sparkles className="h-4 w-4 text-purple-600" />}
                        </Button>
                        <Button size="sm" onClick={() => shortlist(match.candidate_id, match.relevance_score || 0)} className="h-8 text-xs">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Shortlist
                        </Button>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-500 mt-2">
                    <div className="flex items-center gap-2">
                        <Briefcase className="h-3.5 w-3.5 text-gray-400" />
                        <span className="truncate">{match.candidate?.current_role || "No role specified"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <MapPin className="h-3.5 w-3.5 text-gray-400" />
                        <span className="truncate">{match.candidate?.location || "No location"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Clock className="h-3.5 w-3.5 text-gray-400" />
                        <span className="truncate">{match.candidate?.total_experience || "No experience"}</span>
                    </div>
                  </div>

                  {aiByCandidateId[match.candidate_id]?.summary && aiByCandidateId[match.candidate_id]?.visible ? (
                    <div className="mt-3 rounded-lg border bg-purple-50/40 p-3">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-xs font-semibold text-purple-700">AI Analysis</div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs text-purple-600 hover:text-purple-700 hover:bg-purple-100"
                          onClick={() => toggleAi(match.candidate_id, true)}
                          disabled={!!aiLoadingByCandidateId[match.candidate_id]}
                        >
                          {aiLoadingByCandidateId[match.candidate_id] ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RotateCw className="h-3 w-3 mr-1" />}
                          Re-analyze
                        </Button>
                      </div>
                      <div className="text-sm text-gray-700 whitespace-pre-wrap">
                        {aiByCandidateId[match.candidate_id].expanded
                          ? aiByCandidateId[match.candidate_id].summary
                          : aiByCandidateId[match.candidate_id].summary.length > 260
                            ? aiByCandidateId[match.candidate_id].summary.slice(0, 260) + "…"
                            : aiByCandidateId[match.candidate_id].summary}
                      </div>
                      {aiByCandidateId[match.candidate_id].summary.length > 260 ? (
                        <div className="mt-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() =>
                              setAiByCandidateId((prev) => ({
                                ...prev,
                                [match.candidate_id]: { ...prev[match.candidate_id], expanded: !prev[match.candidate_id].expanded }
                              }))
                            }
                          >
                            {aiByCandidateId[match.candidate_id].expanded ? "View less" : "View more"}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      
      {/* Pagination Controls */}
      {total > perPage && (
          <div className="flex justify-center gap-2 mt-4">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
              <span className="flex items-center text-sm text-gray-600">Page {page}</span>
              <Button variant="outline" size="sm" disabled={page * perPage >= total} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
      )}

      <CandidatePreviewDialogDynamic
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        candidate={selectedCandidate}
      />
    </div>
  )
}
