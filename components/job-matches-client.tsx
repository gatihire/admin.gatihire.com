"use client"
import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { useToast } from "@/components/ui/use-toast"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Checkbox } from "@/components/ui/checkbox"
import { RefreshCw, User, CheckCircle, MapPin, Briefcase, Eye, Loader2, Sparkles, Send } from "lucide-react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { cachedFetchJson, invalidateSessionCache } from "@/lib/utils"

const CandidatePreviewDialogDynamic = dynamic(() => import("./candidate-preview-dialog").then(m => m.CandidatePreviewDialog), {
  ssr: false,
})

export default function MatchesClient({ jobId }: { jobId: string }) {
  const { toast } = useToast()
  const [items, setItems] = useState<any[]>([])
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(20)
  const [total, setTotal] = useState(0)
  const [cachedTotal, setCachedTotal] = useState(0)
  const [maxPages, setMaxPages] = useState(5)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedCandidate, setSelectedCandidate] = useState<any | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [existingAppsByCandidateId, setExistingAppsByCandidateId] = useState<Record<string, { id: string; status: string }>>({})
  const [pendingCandidateIds, setPendingCandidateIds] = useState<Record<string, true>>({})

  const [aiByCandidateId, setAiByCandidateId] = useState<Record<string, { summary: string; expanded: boolean; visible: boolean }>>({})
  const [aiLoadingByCandidateId, setAiLoadingByCandidateId] = useState<Record<string, true>>({})

  const [manageOpen, setManageOpen] = useState(false)
  const [manageCandidateId, setManageCandidateId] = useState<string>("")
  const [manageCandidate, setManageCandidate] = useState<any | null>(null)
  const [manageScore, setManageScore] = useState<number>(0)
  const [manageStage, setManageStage] = useState<string>("shortlist")
  const [manageAction, setManageAction] = useState<"assign" | "invite" | "both">("assign")
  const [manageInviteChannel, setManageInviteChannel] = useState<"whatsapp" | "email" | "both">("both")
  const [manageBusy, setManageBusy] = useState<boolean>(false)

  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Record<string, true>>({})
  const [bulkStage, setBulkStage] = useState<string>("shortlist")
  const [bulkInviteChannel, setBulkInviteChannel] = useState<"whatsapp" | "email" | "both">("both")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selectScopeOpen, setSelectScopeOpen] = useState(false)
  const [selectingAll, setSelectingAll] = useState(false)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkConfirmAction, setBulkConfirmAction] = useState<"associate" | "invite" | "both" | null>(null)
  const [inviteOneOpen, setInviteOneOpen] = useState(false)
  const [inviteOneCandidateId, setInviteOneCandidateId] = useState("")
  const [inviteOneCandidate, setInviteOneCandidate] = useState<any | null>(null)
  const [inviteOneChannel, setInviteOneChannel] = useState<"whatsapp" | "email" | "both">("both")
  const [inviteOneBusy, setInviteOneBusy] = useState(false)

  const STATUS_OPTIONS = [
    { id: "applied", label: "Applied" },
    { id: "shortlist", label: "Shortlist" },
    { id: "screening", label: "Screening" },
    { id: "interview", label: "Interview" },
    { id: "offer", label: "Offer" },
    { id: "hired", label: "Hired" },
    { id: "rejected", label: "Rejected" }
  ]

  const fetchMatches = async (opts?: { refresh?: boolean }) => {
    try {
      setLoading(true)
      const url = `/api/jobs/${jobId}/matches?page=${page}&perPage=${perPage}${opts?.refresh ? "&refresh=1" : ""}`
      const data = await cachedFetchJson<any>(
        `internal:job-matches:${jobId}:page:${page}:per:${perPage}:${opts?.refresh ? "refresh" : "base"}`,
        url,
        undefined,
        { ttlMs: 5 * 60_000, force: Boolean(opts?.refresh) },
      )
      setItems(data.items || [])
      setTotal(data.total || 0)
      setCachedTotal(typeof data.cachedTotal === "number" ? data.cachedTotal : (data.items?.length || 0))
      if (typeof data.maxPages === "number") setMaxPages(data.maxPages)
      if (typeof data.page === "number" && data.page !== page) setPage(data.page)
    } catch (e) {
      toast({ title: "Error", description: "Failed to load matches", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchMatches()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, page, perPage])

  const refreshExistingApps = async () => {
    try {
      const rows = await cachedFetchJson<any[]>(
        `internal:applications:job:${jobId}`,
        `/api/applications?jobId=${jobId}`,
        undefined,
        { ttlMs: 5 * 60_000 },
      )
      const next: Record<string, { id: string; status: string }> = {}
      for (const row of Array.isArray(rows) ? rows : []) {
        const cid = String((row as any)?.candidate_id || "").trim()
        const id = String((row as any)?.id || "").trim()
        const status = String((row as any)?.status || "").trim()
        if (cid && id) next[cid] = { id, status }
      }
      setExistingAppsByCandidateId(next)
    } catch {
      setExistingAppsByCandidateId({})
    }
  }

  useEffect(() => {
    refreshExistingApps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const refreshMatches = async () => {
    try {
      setRefreshing(true)
      invalidateSessionCache(`internal:job-matches:${jobId}:`, { prefix: true })
      await fetchMatches({ refresh: true })
      toast({ title: "Database refreshed", description: "Matches recomputed and cached" })
    } catch (e) {
    } finally {
      setRefreshing(false)
    }
  }

  const openManage = (candidateId: string, candidate: any, score: number) => {
    const existing = existingAppsByCandidateId[candidateId]
    setManageCandidateId(candidateId)
    setManageCandidate(candidate)
    setManageScore(score)
    setManageStage(existing?.status || "shortlist")
    setManageAction("assign")
    setManageInviteChannel("both")
    setManageOpen(true)
  }

  const selectedCount = Object.keys(selectedCandidateIds).length
  const allIdsOnPage = items.map((m) => String(m?.candidate_id || "")).filter(Boolean)
  const allSelectedOnPage = allIdsOnPage.length > 0 && allIdsOnPage.every((id) => Boolean(selectedCandidateIds[id]))
  const bulkStageLabel = STATUS_OPTIONS.find((s) => s.id === bulkStage)?.label || bulkStage
  const bulkInviteChannelLabel =
    bulkInviteChannel === "both" ? "WhatsApp + Email" : bulkInviteChannel === "email" ? "Email only" : "WhatsApp only"
  const maxPageForUi = Math.max(1, Math.ceil((total || 0) / perPage) || 1)

  const toggleSelected = (candidateId: string, nextChecked: boolean) => {
    setSelectedCandidateIds((prev) => {
      const next = { ...prev }
      if (nextChecked) next[candidateId] = true
      else delete next[candidateId]
      return next
    })
  }

  const setSelectedForPage = (checked: boolean) => {
    setSelectedCandidateIds((prev) => {
      const next = { ...prev }
      for (const id of allIdsOnPage) {
        if (checked) next[id] = true
        else delete next[id]
      }
      return next
    })
  }

  const clearSelection = () => setSelectedCandidateIds({})

  const selectAllMatches = async () => {
    setSelectingAll(true)
    try {
      const data = await cachedFetchJson<any>(
        `internal:job-match-ids:${jobId}`,
        `/api/jobs/${jobId}/matches?idsOnly=1`,
        undefined,
        { ttlMs: 5 * 60_000 }
      )
      const ids = Array.isArray(data?.candidateIds) ? data.candidateIds.map((x: any) => String(x || "")).filter(Boolean) : []
      const next: Record<string, true> = {}
      for (const id of ids) next[id] = true
      setSelectedCandidateIds(next)
      const totalMatches = typeof data?.total === "number" ? data.total : ids.length
      const cachedCount = typeof data?.cachedTotal === "number" ? data.cachedTotal : ids.length
      setCachedTotal(cachedCount)
      setTotal(totalMatches)
      toast({ title: "Selected all matches", description: `${ids.length} candidates selected.` })
    } catch (e: any) {
      toast({ title: "Selection failed", description: e?.message || "Failed to select all matches", variant: "destructive" })
    } finally {
      setSelectingAll(false)
    }
  }

  const inviteFlagsForChannel = (channel: "whatsapp" | "email" | "both") => {
    return {
      sendWhatsapp: channel === "whatsapp" || channel === "both",
      sendEmail: channel === "email" || channel === "both",
    }
  }

  const requestBulkConfirm = (action: "associate" | "invite" | "both") => {
    setBulkConfirmAction(action)
    setBulkConfirmOpen(true)
  }

  const runBulkConfirmed = async () => {
    if (!bulkConfirmAction) return
    if (bulkConfirmAction === "associate") return bulkAssociate()
    if (bulkConfirmAction === "invite") return bulkInvite()
    return bulkAssociate({ alsoInvite: true })
  }

  const openInviteOne = (candidateId: string, candidate: any) => {
    setInviteOneCandidateId(candidateId)
    setInviteOneCandidate(candidate)
    setInviteOneChannel("both")
    setInviteOneOpen(true)
  }

  const sendInviteOne = async () => {
    if (!inviteOneCandidateId) return
    const flags = inviteFlagsForChannel(inviteOneChannel)
    setInviteOneBusy(true)
    setPendingCandidateIds((prev) => ({ ...prev, [inviteOneCandidateId]: true }))
    try {
      const res = await fetch("/api/job-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, candidateId: inviteOneCandidateId, resend: true, ...flags })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to create/send invite")
      invalidateSessionCache(`internal:job-invites:${jobId}`)
      toast({ title: "Invite sent", description: "Invite created and sent via selected channel(s)." })
      setInviteOneOpen(false)
    } catch (e: any) {
      toast({ title: "Invite failed", description: e?.message || "Failed", variant: "destructive" })
    } finally {
      setInviteOneBusy(false)
      setPendingCandidateIds((prev) => {
        const next = { ...prev }
        delete next[inviteOneCandidateId]
        return next
      })
    }
  }

  const bulkAssociate = async (opts?: { alsoInvite?: boolean }) => {
    const candidateIds = Object.keys(selectedCandidateIds)
    if (candidateIds.length === 0) return

    setBulkBusy(true)
    try {
      let assigned = 0
      let invited = 0
      let failed = 0

      for (const candidateId of candidateIds) {
        setPendingCandidateIds((prev) => ({ ...prev, [candidateId]: true }))
        try {
          const existing = existingAppsByCandidateId[candidateId]
          const m = items.find((x) => String(x?.candidate_id || "") === candidateId)
          const score = Number(m?.relevance_score || 0)

          if (existing?.id) {
            if (existing.status !== bulkStage) {
              const res = await fetch(`/api/applications/${existing.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: bulkStage })
              })
              if (!res.ok) throw new Error("Failed to update stage")
            }
          } else {
            const res = await fetch("/api/applications", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                job_id: jobId,
                candidate_id: candidateId,
                source: "database",
                status: bulkStage,
                match_score: score
              })
            })
            if (res.status !== 409 && !res.ok) throw new Error("Failed to associate candidate")
          }
          assigned += 1

          if (opts?.alsoInvite) {
            const flags = inviteFlagsForChannel(bulkInviteChannel)
            const res = await fetch("/api/job-invites", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jobId, candidateId, resend: true, ...flags })
            })
            const data = await res.json().catch(() => null)
            if (!res.ok) throw new Error(data?.error || "Failed to invite candidate")
            invited += 1
          }
        } catch {
          failed += 1
        } finally {
          setPendingCandidateIds((prev) => {
            const next = { ...prev }
            delete next[candidateId]
            return next
          })
        }
      }

      invalidateSessionCache(`internal:applications:job:${jobId}`)
      invalidateSessionCache(`internal:job-invites:${jobId}`)
      await refreshExistingApps()
      clearSelection()

      const parts = [`Associated: ${assigned}`]
      if (opts?.alsoInvite) parts.push(`Invited: ${invited}`)
      if (failed) parts.push(`Failed: ${failed}`)
      toast({ title: "Bulk action completed", description: parts.join(" • ") })
    } finally {
      setBulkBusy(false)
    }
  }

  const bulkInvite = async () => {
    const candidateIds = Object.keys(selectedCandidateIds)
    if (candidateIds.length === 0) return

    setBulkBusy(true)
    try {
      let invited = 0
      let failed = 0
      const flags = inviteFlagsForChannel(bulkInviteChannel)

      for (const candidateId of candidateIds) {
        setPendingCandidateIds((prev) => ({ ...prev, [candidateId]: true }))
        try {
          const res = await fetch("/api/job-invites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId, candidateId, resend: true, ...flags })
          })
          const data = await res.json().catch(() => null)
          if (!res.ok) throw new Error(data?.error || "Failed to invite candidate")
          invited += 1
        } catch {
          failed += 1
        } finally {
          setPendingCandidateIds((prev) => {
            const next = { ...prev }
            delete next[candidateId]
            return next
          })
        }
      }

      invalidateSessionCache(`internal:job-invites:${jobId}`)
      clearSelection()
      toast({ title: "Invites sent", description: `Invited: ${invited}${failed ? ` • Failed: ${failed}` : ""}` })
    } finally {
      setBulkBusy(false)
    }
  }

  const saveManage = async () => {
    if (!manageCandidateId) return
    const candidateId = manageCandidateId
    const existing = existingAppsByCandidateId[candidateId]
    const targetStage = manageStage
    const shouldAssign = manageAction !== "invite"
    const shouldInvite = manageAction !== "assign"

    setManageBusy(true)
    setPendingCandidateIds((prev) => ({ ...prev, [candidateId]: true }))
    try {
      if (shouldAssign) {
        if (existing?.id) {
          if (existing.status !== targetStage) {
            const res = await fetch(`/api/applications/${existing.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: targetStage })
            })
            if (!res.ok) throw new Error("Failed to update stage")
          }
        } else {
          const res = await fetch("/api/applications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              job_id: jobId,
              candidate_id: candidateId,
              source: "database",
              status: targetStage,
              match_score: manageScore
            })
          })

          if (res.status === 409) {
            await refreshExistingApps()
          } else if (!res.ok) {
            throw new Error("Failed to assign candidate")
          }
        }
      }

      if (shouldInvite) {
        const flags = inviteFlagsForChannel(manageInviteChannel)
        const res = await fetch("/api/job-invites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, candidateId, resend: true, ...flags })
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || "Failed to create/send invite")
        if (shouldAssign) {
          toast({ title: "Saved", description: data?.emailSent ? "Assigned and invite email sent." : "Assigned and invite link ready." })
        } else {
          toast({ title: "Invite created", description: data?.emailSent ? "Invite email sent." : "Invite link ready." })
        }
      } else if (shouldAssign) {
        toast({ title: "Saved", description: "Candidate assigned successfully." })
      }

      invalidateSessionCache(`internal:applications:job:${jobId}`)
      invalidateSessionCache(`internal:job-invites:${jobId}`)
      await refreshExistingApps()
      setManageOpen(false)
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Failed", variant: "destructive" })
    } finally {
      setManageBusy(false)
      setPendingCandidateIds((prev) => {
        const next = { ...prev }
        delete next[candidateId]
        return next
      })
    }
  }

  const openPreview = async (candidate: any, score: number) => {
    try {
        setIsPreviewLoading(true)
        // Fetch complete candidate data if needed, or use existing
        const id = candidate._id || candidate.id
        if (id) {
            const res = await fetch(`/api/candidates/${id}`)
            if (res.ok) {
                const fullCandidateData = await res.json()
                setSelectedCandidate({
                    ...fullCandidateData,
                    matchPercentage: Math.round((score || 0) * 100)
                })
            } else {
                setSelectedCandidate({
                    ...candidate,
                    matchPercentage: Math.round((score || 0) * 100)
                })
            }
        } else {
             setSelectedCandidate({
                ...candidate,
                matchPercentage: Math.round((score || 0) * 100)
            })
        }
    } catch (e) {
        console.error("Error fetching candidate details:", e)
        setSelectedCandidate({
            ...candidate,
            matchPercentage: Math.round((score || 0) * 100)
        })
    } finally {
        setIsPreviewLoading(false)
    }
  }

  const getAvatarColor = (score: number) => {
    if (score >= 0.8) return "bg-green-500"
    if (score >= 0.5) return "bg-yellow-500"
    return "bg-gray-400"
  }

  const toggleAi = async (candidateId: string) => {
    if (!candidateId) return

    const existing = aiByCandidateId[candidateId]
    if (existing?.summary) {
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
        body: JSON.stringify({ jobId, candidateId })
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

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <Checkbox
            checked={allSelectedOnPage}
            onCheckedChange={(v) => {
              const checked = Boolean(v)
              if (!checked) setSelectedForPage(false)
              else setSelectScopeOpen(true)
            }}
          />
          <div className="text-sm text-gray-600">
            Total matches: {total}
            {cachedTotal && cachedTotal !== total ? ` • Cached: ${cachedTotal}` : ""}
            {selectedCount ? ` • Selected: ${selectedCount}` : ""}
          </div>
          {selectedCount ? (
            <Button variant="ghost" size="sm" className="h-8 px-2" onClick={clearSelection} disabled={bulkBusy}>
              Clear
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(perPage)} onValueChange={(v) => setPerPage(parseInt(v))}>
            <SelectTrigger className="h-8 w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10</SelectItem>
              <SelectItem value="20">20</SelectItem>
              <SelectItem value="50">50</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={refreshMatches} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
            Refresh Database
          </Button>
        </div>
      </div>

      <Card className="border border-indigo-100 bg-indigo-50/40">
        <CardContent className="p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="text-sm text-indigo-900">
            <span className="font-semibold">Associate</span> = add candidate to this job’s pipeline stage (no message sent).{" "}
            {selectedCount ? <span className="text-indigo-800">Selected: {selectedCount}</span> : <span className="text-indigo-800">Select candidates to enable bulk actions.</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={bulkStage} onValueChange={setBulkStage}>
              <SelectTrigger className="h-9 w-[190px] bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={bulkInviteChannel} onValueChange={(v) => setBulkInviteChannel(v as any)}>
              <SelectTrigger className="h-9 w-[190px] bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="whatsapp">WhatsApp only</SelectItem>
                <SelectItem value="email">Email only</SelectItem>
                <SelectItem value="both">WhatsApp + Email</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" className="h-9" onClick={() => requestBulkConfirm("associate")} disabled={bulkBusy || selectedCount === 0}>
              Associate
            </Button>
            <Button variant="outline" className="h-9" onClick={() => requestBulkConfirm("invite")} disabled={bulkBusy || selectedCount === 0}>
              Invite
            </Button>
            <Button
              variant="outline"
              className="h-9 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
              onClick={() => requestBulkConfirm("both")}
              disabled={bulkBusy || selectedCount === 0}
            >
              Associate + Invite
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3">
        {loading ? (
          <div className="text-center py-12 text-gray-500 flex flex-col items-center">
             <Loader2 className="h-8 w-8 animate-spin mb-2"/>
             Loading matches...
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No matches found</div>
        ) : (
          items.map((m) => {
            const candidate = m.candidate || {}
            const score = m.relevance_score || 0
            const matchPercentage = Math.round(score * 100)
            const isAdded = !!existingAppsByCandidateId[m.candidate_id]
            const isPending = !!pendingCandidateIds[m.candidate_id]
            const addedStage = existingAppsByCandidateId[m.candidate_id]?.status || ""
            const isSelected = Boolean(selectedCandidateIds[m.candidate_id])

            return (
              <Card
                key={`${m.job_id}-${m.candidate_id}`}
                className={`hover:shadow-md transition-all border-l-4 border-l-transparent hover:border-l-blue-500 ${isSelected ? "ring-2 ring-blue-200" : ""}`}
              >
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row gap-4 items-start">
                    {/* Avatar Section */}
                    <div className="flex-shrink-0">
                        <div className="flex items-center gap-2 mb-2">
                          <Checkbox checked={isSelected} onCheckedChange={(v) => toggleSelected(m.candidate_id, Boolean(v))} />
                          <div className="text-xs text-gray-500">Select</div>
                        </div>
                         <Avatar className="h-12 w-12 border-2 border-white shadow-sm">
                            <AvatarFallback className={`text-white ${getAvatarColor(score)}`}>
                                {candidate.name?.substring(0, 2).toUpperCase() || "CN"}
                            </AvatarFallback>
                        </Avatar>
                        <div className="mt-2 text-center">
                            <Badge variant={score >= 0.8 ? "default" : score >= 0.5 ? "secondary" : "outline"} className="text-[10px] px-1 h-5">
                                {matchPercentage}%
                            </Badge>
                        </div>
                    </div>

                    {/* Content Section */}
                    <div className="flex-grow min-w-0 space-y-1">
                        <div className="flex justify-between items-start">
                            <div>
                                <h3 className="font-semibold text-base truncate pr-2">{candidate.name || "Unknown Candidate"}</h3>
                                <div className="flex items-center text-sm text-gray-500 mt-1">
                                    <Briefcase className="h-3.5 w-3.5 mr-1" />
                                    <span className="truncate max-w-[200px]">{candidate.current_role || "No role"}</span>
                                </div>
                                <div className="flex items-center text-sm text-gray-500 mt-0.5">
                                    <MapPin className="h-3.5 w-3.5 mr-1" />
                                    <span className="truncate">{candidate.location || "No location"}</span>
                                </div>
                            </div>
                            
                            <div className="flex gap-2 flex-shrink-0">
                                <Button 
                                    variant="outline" 
                                    size="sm" 
                                    className="h-8"
                                    onClick={() => openPreview(candidate, score)}
                                >
                                    <Eye className="h-4 w-4 mr-2" />
                                    View
                                </Button>

                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8"
                                  disabled={!!aiLoadingByCandidateId[m.candidate_id]}
                                  onClick={() => toggleAi(m.candidate_id)}
                                >
                                  {aiLoadingByCandidateId[m.candidate_id] ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                                  AI
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8"
                                  onClick={() => openInviteOne(m.candidate_id, candidate)}
                                  disabled={isPending}
                                >
                                  <Send className="h-4 w-4 mr-2" />
                                  Invite
                                </Button>
                                <Button 
                                    size="sm" 
                                    className="h-8 bg-blue-600 hover:bg-blue-700"
                                    onClick={() => openManage(m.candidate_id, candidate, score)}
                                    disabled={isPending}
                                >
                                    {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-2" />}
                                    {isAdded ? "Manage" : "Assign"}
                                </Button>
                            </div>
                        </div>

                        {isAdded ? (
                          <div className="mt-2 text-xs text-gray-500">
                            In pipeline{addedStage ? ` • Stage: ${addedStage}` : ""}
                          </div>
                        ) : null}

                        {aiByCandidateId[m.candidate_id]?.summary && aiByCandidateId[m.candidate_id]?.visible ? (
                          <div className="mt-3 rounded-lg border bg-purple-50/40 p-3">
                            <div className="text-xs font-semibold text-purple-700 mb-1">AI Analysis</div>
                            <div className="text-sm text-gray-700 whitespace-pre-wrap">
                              {aiByCandidateId[m.candidate_id].expanded
                                ? aiByCandidateId[m.candidate_id].summary
                                : aiByCandidateId[m.candidate_id].summary.length > 260
                                  ? aiByCandidateId[m.candidate_id].summary.slice(0, 260) + "…"
                                  : aiByCandidateId[m.candidate_id].summary}
                            </div>
                            {aiByCandidateId[m.candidate_id].summary.length > 260 ? (
                              <div className="mt-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={() =>
                                    setAiByCandidateId((prev) => ({
                                      ...prev,
                                      [m.candidate_id]: { ...prev[m.candidate_id], expanded: !prev[m.candidate_id].expanded }
                                    }))
                                  }
                                >
                                  {aiByCandidateId[m.candidate_id].expanded ? "View less" : "View more"}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        {/* AI Match Analysis (Compact) */}
                      {((m.matchDetails && m.matchDetails.length > 0) || m.match_summary || candidate.matchSummary) && (
                        <div className="mt-2 pt-2 border-t border-gray-100 bg-gray-50/30 p-2 rounded">
                          
                          {/* AI Insight Summary */}
                          {(m.match_summary || candidate.matchSummary) && (
                              <div className="mb-2 text-xs text-gray-700 bg-purple-50/50 p-2 rounded border border-purple-100">
                                  <span className="font-bold text-purple-700 mr-1">AI Insight:</span>
                                  {m.match_summary || candidate.matchSummary}
                              </div>
                          )}

                          {/* Score Bars (Compact) */}
                          {(m.score_breakdown || candidate.scoreBreakdown) && (
                            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
                              {Object.entries(m.score_breakdown || candidate.scoreBreakdown || {}).map(([key, data]: [string, any]) => (
                                <div key={key} className="flex items-center text-[10px] w-[140px]">
                                  <span className="w-16 font-medium text-gray-500 truncate capitalize">{key.replace(/_/g, ' ')}</span>
                                  <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden mx-1">
                                    <div 
                                      className={`h-full rounded-full ${
                                        (typeof data === 'object' ? data.percentage : data) > 80 ? 'bg-green-500' : 
                                        (typeof data === 'object' ? data.percentage : data) > 40 ? 'bg-yellow-500' : 'bg-red-400'
                                      }`} 
                                      style={{ width: `${typeof data === 'object' ? data.percentage : data}%` }}
                                    />
                                  </div>
                                  <span className="text-gray-400">{typeof data === 'object' ? data.earned : data}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Key Matches & Gaps */}
                          <div className="mt-2 space-y-2">
                            <div>
                              {(m.matchDetails?.filter((d: any) => d.status === 'match').length > 0 || (candidate.matchDetails && candidate.matchDetails.filter((d: any) => d.status === 'match').length > 0)) ? (
                                <div className="text-sm text-green-700">
                                  <span className="font-semibold mr-1">✓ Matched:</span>
                                  {(m.matchDetails || candidate.matchDetails || []).filter((d: any) => d.status === 'match').map((d: any) => d.category).join(', ')}
                                </div>
                              ) : null}
                            </div>
                            <div>
                              {(m.gapAnalysis && m.gapAnalysis.length > 0) || (candidate.gapAnalysis && candidate.gapAnalysis.length > 0) || (m.matchDetails?.some((d: any) => d.status === 'miss') || candidate.matchDetails?.some((d: any) => d.status === 'miss')) ? (
                                <div className="text-sm text-red-700">
                                  <span className="font-semibold mr-1">✗ Missing:</span>
                                  {Array.from(new Set([
                                    ...(m.gapAnalysis || candidate.gapAnalysis || []),
                                    ...((m.matchDetails || candidate.matchDetails || []).filter((d: any) => d.status === 'miss').map((d: any) => d.category) || [])
                                  ])).join(', ')}
                                </div>
                              ) : (
                                <div className="text-sm text-gray-400 italic">No major gaps</div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                        {/* Matching Keywords */}
                        {(m.matching_keywords || candidate.matchingKeywords || []).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                                <span className="text-[10px] font-medium text-gray-500 self-center mr-1">Matched:</span>
                                {(m.matching_keywords || candidate.matchingKeywords || []).slice(0, 5).map((keyword: string, i: number) => (
                                    <Badge key={i} variant="secondary" className="text-[10px] px-1.5 py-0 h-5 font-normal bg-green-50 text-green-700 border-green-200">
                                        {keyword}
                                    </Badge>
                                ))}
                                {(m.matching_keywords || candidate.matchingKeywords || []).length > 5 && (
                                    <span className="text-[10px] text-gray-400 self-center">+{ (m.matching_keywords || candidate.matchingKeywords || []).length - 5 } more</span>
                                )}
                            </div>
                        )}

                        {/* Skills/Tags if available (Fallback) */}
                        {(!(m.matching_keywords || candidate.matchingKeywords) || (m.matching_keywords || candidate.matchingKeywords).length === 0) && (candidate.skills || []).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                                {candidate.skills.slice(0, 3).map((skill: string, i: number) => (
                                    <Badge key={i} variant="secondary" className="text-[10px] px-1.5 py-0 h-5 font-normal bg-gray-100 text-gray-600 hover:bg-gray-200">
                                        {skill}
                                    </Badge>
                                ))}
                                {candidate.skills.length > 3 && (
                                    <span className="text-[10px] text-gray-400 self-center">+{candidate.skills.length - 3} more</span>
                                )}
                            </div>
                        )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>

      <div className="flex justify-between items-center">
        <Button variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
        <div className="text-sm text-gray-600">Page {page} of {maxPageForUi}</div>
        <Button variant="outline" disabled={page >= maxPageForUi} onClick={() => setPage((p) => Math.min(maxPageForUi, p + 1))}>Next</Button>
      </div>
      
      {selectedCandidate && (
        <CandidatePreviewDialogDynamic
          candidate={selectedCandidate}
          isOpen={!!selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
          jobId={jobId}
          showRelevanceScore={true}
        />
      )}

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Manage candidate</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div>
              <div className="text-sm font-medium">{manageCandidate?.name || "Candidate"}</div>
              {manageCandidate?.email ? <div className="mt-1 text-sm text-gray-500">{manageCandidate.email}</div> : null}
            </div>

            <div className="grid gap-2">
              <Label>Action</Label>
              <Select
                value={manageAction}
                onValueChange={(v) => setManageAction(v as any)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="assign">Assign to pipeline (no invite)</SelectItem>
                  <SelectItem value="invite">Invite to apply only</SelectItem>
                  <SelectItem value="both">Assign + Invite</SelectItem>
                </SelectContent>
              </Select>
              <div className="text-xs text-gray-500">
                Assigning controls pipeline stages. Invites are tracked separately in the Invites section.
              </div>
            </div>

            {manageAction !== "invite" ? (
              <div className="grid gap-2">
                <Label>Stage</Label>
                <Select value={manageStage} onValueChange={setManageStage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="text-xs text-gray-500">This controls where the candidate appears in your pipeline stages.</div>
              </div>
            ) : (
              <div className="rounded-lg border bg-gray-50 p-3 text-xs text-gray-600">
                Invite-only does not place the candidate into any pipeline stage.
              </div>
            )}

            {manageAction !== "assign" ? (
              <div className="grid gap-2">
                <Label>Invite channel</Label>
                <Select value={manageInviteChannel} onValueChange={(v) => setManageInviteChannel(v as any)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="whatsapp">WhatsApp only</SelectItem>
                    <SelectItem value="email">Email only</SelectItem>
                    <SelectItem value="both">WhatsApp + Email</SelectItem>
                  </SelectContent>
                </Select>
                <div className="text-xs text-gray-500">
                  If email is not configured, Email-only will fail. WhatsApp requires phone number.
                </div>
              </div>
            ) : null}

            {manageAction !== "assign" ? (
              <div className="rounded-lg border bg-blue-50 p-3 text-xs text-blue-700">
                A tracked invite link will be created and sent via the selected channel(s).
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManageOpen(false)} disabled={manageBusy}>
              Cancel
            </Button>
            <Button onClick={saveManage} disabled={manageBusy || !manageCandidateId}>
              {manageBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={selectScopeOpen} onOpenChange={setSelectScopeOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Select candidates</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-gray-600">
            Select candidates from this page only, or select all matches across all pages.
          </div>
          <div className="mt-4 grid gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setSelectedForPage(true)
                setSelectScopeOpen(false)
              }}
              disabled={allIdsOnPage.length === 0}
            >
              Select this page ({allIdsOnPage.length})
            </Button>
            <Button
              onClick={async () => {
                await selectAllMatches()
                setSelectScopeOpen(false)
              }}
              disabled={selectingAll || total === 0}
            >
              {selectingAll ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Select all matches ({total})
            </Button>
            <Button variant="ghost" onClick={() => setSelectScopeOpen(false)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Confirm bulk action</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 text-sm text-gray-700">
            <div>
              Selected candidates: <span className="font-semibold">{selectedCount}</span>
            </div>
            {bulkConfirmAction === "associate" || bulkConfirmAction === "both" ? (
              <div>
                Stage: <span className="font-semibold">{bulkStageLabel}</span>
              </div>
            ) : null}
            {bulkConfirmAction === "invite" || bulkConfirmAction === "both" ? (
              <div>
                Invite via: <span className="font-semibold">{bulkInviteChannelLabel}</span>
              </div>
            ) : null}
            {bulkConfirmAction === "both" ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                This will update stages and send invites for all selected candidates.
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConfirmOpen(false)} disabled={bulkBusy}>
              Cancel
            </Button>
            <Button
              className={bulkConfirmAction === "both" ? "bg-red-600 hover:bg-red-700" : ""}
              onClick={async () => {
                await runBulkConfirmed()
                setBulkConfirmOpen(false)
              }}
              disabled={bulkBusy || selectedCount === 0}
            >
              {bulkBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {bulkConfirmAction === "associate"
                ? "Confirm associate"
                : bulkConfirmAction === "invite"
                  ? "Confirm invite"
                  : "Confirm associate + invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={inviteOneOpen} onOpenChange={setInviteOneOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Send invite</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="text-sm">
              {inviteOneCandidate?.name ? <span className="font-semibold">{inviteOneCandidate.name}</span> : "Candidate"}
            </div>
            <div className="grid gap-2">
              <Label>Channel</Label>
              <Select value={inviteOneChannel} onValueChange={(v) => setInviteOneChannel(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="whatsapp">WhatsApp only</SelectItem>
                  <SelectItem value="email">Email only</SelectItem>
                  <SelectItem value="both">WhatsApp + Email</SelectItem>
                </SelectContent>
              </Select>
              <div className="text-xs text-gray-500">
                Email requires an email address. WhatsApp requires a phone number.
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOneOpen(false)} disabled={inviteOneBusy}>
              Cancel
            </Button>
            <Button onClick={sendInviteOne} disabled={inviteOneBusy}>
              {inviteOneBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
