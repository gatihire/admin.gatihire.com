"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/use-toast"
import { JuiceboxImportDialog } from "./juicebox-import-dialog"
import { JuiceboxProfileDetail } from "./juicebox-profile-detail"
import {
  STATUS_STYLES, experienceText, downloadJuiceboxResume,
  JuiceboxEnrichDialog, JuiceboxCallDialog, JuiceboxDeleteConfirm,
} from "./juicebox-actions"
import {
  Database, Upload, Loader2, Search, Sparkles, PhoneCall, Download, RefreshCw, Linkedin, Trash2, ChevronLeft, ChevronRight
} from "lucide-react"

interface JuiceboxProfileRow {
  id: string
  full_name: string
  first_name: string
  last_name: string
  job_title: string
  job_company_name: string
  location_name: string
  total_experience_months: number | null
  enrichment_status: string
  linkedin_url: string | null
  import_order: number
  created_at: string
  updated_at: string
}

interface ListResponse {
  profiles: JuiceboxProfileRow[]
  total: number
  counts: { pending: number; enriching: number; enriched: number; failed: number }
  page: number
  limit: number
}

interface JuiceboxProfilesTabProps {
  jobId: string
  jobTitle: string
}

export function JuiceboxProfilesTab({ jobId, jobTitle }: JuiceboxProfilesTabProps) {
  const { toast } = useToast()
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState("all")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [importOpen, setImportOpen] = useState(false)
  const [detailProfileId, setDetailProfileId] = useState<string | null>(null)
  const [enrichOpen, setEnrichOpen] = useState(false)
  const [callOpen, setCallOpen] = useState(false)
  const [enrichContactTypes, setEnrichContactTypes] = useState<string[]>(["phone", "email"])
  const [busy, setBusy] = useState(false)
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), limit: "50" })
    if (statusFilter !== "all") params.set("status", statusFilter)
    if (debouncedSearch) params.set("q", debouncedSearch)
    try {
      const res = await fetch(`/api/jobs/${jobId}/juicebox?${params.toString()}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Failed to load profiles")
      setData(json)
    } catch (err: any) {
      toast({ title: "Failed to load profiles", description: err.message, variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [jobId, page, statusFilter, debouncedSearch, toast])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => { setPage(1) }, [statusFilter, debouncedSearch])

  useEffect(() => {
    // Drop selections that no longer exist after a reload.
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const ids = new Set((data?.profiles || []).map((p) => p.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [data])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    const ids = data?.profiles?.map((p) => p.id) || []
    setSelected((prev) => (prev.size === ids.length ? new Set() : new Set(ids)))
  }

  const runEnrich = async () => {
    if (selected.size === 0) return
    setBusy(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/juicebox/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: [...selected], contactTypes: enrichContactTypes }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Enrichment failed")
      toast({
        title: "Enrichment complete",
        description: `${json.enriched?.length} enriched · ${json.failed?.length} failed · ${json.skipped?.length} already cached`,
      })
      setEnrichOpen(false)
      setSelected(new Set())
      load()
    } catch (err: any) {
      toast({ title: "Enrichment failed", description: err.message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const runCalls = async () => {
    if (selected.size === 0) return
    setBusy(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/juicebox/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: [...selected] }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Call assignment failed")
      toast({
        title: "AI calls triggered",
        description: `${json.callsTriggered}/${json.totalCandidates} calls placed · ${json.skippedNoPhone?.length || json.noContact?.length || 0} skipped (no contact)`,
      })
      setCallOpen(false)
      setSelected(new Set())
    } catch (err: any) {
      toast({ title: "Call assignment failed", description: err.message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const downloadResume = async (profileId: string) => {
    try {
      await downloadJuiceboxResume(jobId, profileId)
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" })
    }
  }

  const removeProfile = async () => {
    if (!deleteProfileId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/juicebox/${deleteProfileId}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Delete failed")
      toast({ title: "Profile removed" })
      setDeleteProfileId(null)
      setSelected(new Set())
      load()
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const counts = data?.counts || { pending: 0, enriching: 0, enriched: 0, failed: 0 }
  const profiles = data?.profiles || []
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / 50))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-700">
          <Database className="h-4 w-4 text-blue-500" />
          <span className="font-semibold">Juicebox / LinkedIn Profiles</span>
          <Badge variant="outline" className="ml-1 text-zinc-500">{data?.total ?? 0}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 text-[11px] text-zinc-500">
            <Badge variant="outline" className="bg-zinc-50">{counts.pending} pending</Badge>
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">{counts.enriching} enriching</Badge>
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">{counts.enriched} enriched</Badge>
            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">{counts.failed} failed</Badge>
          </div>
          <Button variant="outline" size="sm" onClick={() => load()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />Refresh
          </Button>
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => setImportOpen(true)}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />Import JSON
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px] h-9">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="enriching">Enriching</SelectItem>
            <SelectItem value="enriched">Enriched</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <Input
            className="pl-9 h-9"
            placeholder="Search name, title, company..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-2.5">
          <span className="text-sm font-semibold text-blue-700">{selected.size} selected</span>
          <Button size="sm" variant="outline" className="bg-white" onClick={() => setEnrichOpen(true)}>
            <Sparkles className="h-3.5 w-3.5 mr-1.5 text-violet-500" />Enrich
          </Button>
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setCallOpen(true)}>
            <PhoneCall className="h-3.5 w-3.5 mr-1.5" />Assign to AI calls
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <div className="rounded-2xl border border-zinc-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-3 w-10">
                  <Checkbox checked={profiles.length > 0 && selected.size === profiles.length} onCheckedChange={toggleAll} />
                </th>
                <th className="px-3 py-3">#</th>
                <th className="px-3 py-3">Name</th>
                <th className="px-3 py-3">Current role</th>
                <th className="px-3 py-3">Company</th>
                <th className="px-3 py-3">Location</th>
                <th className="px-3 py-3">Exp</th>
                <th className="px-3 py-3">Enrichment</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-zinc-400">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : profiles.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-sm text-zinc-400">
                    {search || statusFilter !== "all"
                      ? "No profiles match the current filters."
                      : "No Juicebox profiles yet. Import a Juicebox search JSON to get started."}
                  </td>
                </tr>
              ) : (
                profiles.map((p) => (
                  <tr key={p.id} className="border-t border-zinc-100 hover:bg-zinc-50/60">
                    <td className="px-4 py-3">
                      <Checkbox checked={selected.has(p.id)} onCheckedChange={() => toggle(p.id)} />
                    </td>
                    <td className="px-3 py-3 text-zinc-400">{p.import_order + 1}</td>
                    <td className="px-3 py-3">
                      <button className="font-medium text-zinc-800 hover:text-blue-600 text-left" onClick={() => setDetailProfileId(p.id)}>
                        {p.full_name || "—"}
                      </button>
                      {p.linkedin_url && (
                        <a
                          href={`https://${p.linkedin_url.replace(/^https?:\/\//, "")}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-[10px] text-zinc-400 hover:text-blue-600 ml-1.5"
                        >
                          <Linkedin className="h-3 w-3" />
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-3 text-zinc-600">{p.job_title || "—"}</td>
                    <td className="px-3 py-3 text-zinc-600">{p.job_company_name || "—"}</td>
                    <td className="px-3 py-3 text-zinc-500">{p.location_name || "—"}</td>
                    <td className="px-3 py-3 text-zinc-500">{experienceText(p.total_experience_months)}</td>
                    <td className="px-3 py-3">
                      <Badge variant="outline" className={STATUS_STYLES[p.enrichment_status] || STATUS_STYLES.pending}>
                        {p.enrichment_status}
                      </Badge>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          title="Download resume"
                          onClick={() => downloadResume(p.id)}
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-blue-600 hover:bg-blue-50"
                        >
                          <Download className="h-4 w-4" />
                        </button>
                        <button
                          title="View profile"
                          onClick={() => setDetailProfileId(p.id)}
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100"
                        >
                          <Search className="h-4 w-4" />
                        </button>
                        <button
                          title="Delete"
                          onClick={() => setDeleteProfileId(p.id)}
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-2.5">
            <span className="text-xs text-zinc-500">Page {page} of {totalPages}</span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <JuiceboxImportDialog
        jobId={jobId}
        jobTitle={jobTitle}
        open={importOpen}
        onOpenChange={setImportOpen}
        onComplete={() => load()}
      />

      <JuiceboxProfileDetail
        jobId={jobId}
        profileId={detailProfileId}
        open={!!detailProfileId}
        onOpenChange={(o) => setDetailProfileId(o ? detailProfileId : null)}
      />

      <JuiceboxEnrichDialog
        open={enrichOpen}
        onOpenChange={setEnrichOpen}
        count={selected.size}
        busy={busy}
        contactTypes={enrichContactTypes}
        onContactTypesChange={setEnrichContactTypes}
        onConfirm={runEnrich}
      />

      <JuiceboxCallDialog
        open={callOpen}
        onOpenChange={setCallOpen}
        count={selected.size}
        busy={busy}
        onConfirm={runCalls}
      />

      <JuiceboxDeleteConfirm
        open={!!deleteProfileId}
        onOpenChange={(o) => setDeleteProfileId(o ? deleteProfileId : null)}
        busy={busy}
        onConfirm={removeProfile}
      />
    </div>
  )
}
