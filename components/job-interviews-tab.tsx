"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Plus, Pencil, Trash2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { cachedFetchJson, invalidateSessionCache } from "@/lib/utils"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface InterviewRound {
  id: string; job_id: string; name: string; sort_order: number
}

interface InterviewEntry {
  id: string; round_id: string; application_id: string
  status: string; scheduled_at: string | null; notes: string | null; updated_at: string | null
}

interface Application {
  id: string; candidate_id: string; status: string
  candidates: { name: string; [key: string]: any }
}

interface InterviewsTabProps {
  jobId: string
  applications: Application[]
}

function toDateTimeLocal(iso: string | null) {
  if (!iso) return ""
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const INTERVIEW_STATUSES = [
  { value: "pending", label: "Pending", color: "bg-zinc-100 text-zinc-600" },
  { value: "waitlist", label: "Waitlist", color: "bg-amber-100 text-amber-600" },
  { value: "on-hold", label: "On Hold", color: "bg-orange-100 text-orange-600" },
  { value: "passed", label: "Passed", color: "bg-green-100 text-green-600" },
  { value: "move_next", label: "Move to Next Round", color: "bg-blue-100 text-blue-600" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-600" },
]

export function InterviewsTab({ jobId, applications }: InterviewsTabProps) {
  const { toast } = useToast()
  const [rounds, setRounds] = useState<InterviewRound[]>([])
  const [interviewsByKey, setInterviewsByKey] = useState<Record<string, InterviewEntry>>({})
  const [roundId, setRoundId] = useState("")
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, { notes: string; scheduledAtLocal: string }>>({})

  // Round editor
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<"create" | "rename">("create")
  const [editorRoundId, setEditorRoundId] = useState<string | null>(null)
  const [editorName, setEditorName] = useState("")
  const [editorSaving, setEditorSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteSaving, setDeleteSaving] = useState(false)
  const [statusFilter, setStatusFilter] = useState("all")

  useEffect(() => { fetchData() }, [jobId])

  const fetchData = async () => {
    setLoading(true)
    try {
      const data = await cachedFetchJson<{ rounds: InterviewRound[]; interviews: InterviewEntry[] }>(
        `internal:job-interviews:${jobId}`,
        `/api/jobs/${jobId}/interviews`,
        undefined,
        { ttlMs: 3 * 60_000 },
      )
      const r = data?.rounds || []
      setRounds(r)
      if (!roundId && r.length > 0) setRoundId(r[0].id)

      const map: Record<string, InterviewEntry> = {}
      const d: Record<string, { notes: string; scheduledAtLocal: string }> = {}
      for (const it of data?.interviews || []) {
        if (!it.round_id || !it.application_id) continue
        map[`${it.round_id}:${it.application_id}`] = it
        d[`${it.round_id}:${it.application_id}`] = {
          notes: String(it.notes || ""),
          scheduledAtLocal: toDateTimeLocal(it.scheduled_at),
        }
      }
      setInterviewsByKey(map)
      setDrafts(d)
    } catch {
      toast({ title: "Failed to load interviews", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  const upsert = async (applicationId: string, patch: Partial<Pick<InterviewEntry, "status" | "notes" | "scheduled_at">>) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/interviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, roundId, ...patch }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error)
      const it = data?.interview as InterviewEntry | undefined
      if (it?.round_id && it?.application_id) {
        setInterviewsByKey((prev) => ({ ...prev, [`${it.round_id}:${it.application_id}`]: it }))
      }
      if (patch.status === "move_next") {
        // Auto-switch to next round after a short delay to let the DB settle
        setTimeout(() => {
          fetchData()
          // Find the next round and switch to it
          const currentIdx = rounds.findIndex((r) => r.id === roundId)
          if (currentIdx >= 0 && currentIdx + 1 < rounds.length) {
            setRoundId(rounds[currentIdx + 1].id)
          }
        }, 300)
      }
    } catch (e: any) {
      toast({ title: "Update failed", description: e.message, variant: "destructive" })
    }
  }

  const interviewApps = applications.filter((a) => a.status === "interview")

  const filtered = statusFilter === "all"
    ? interviewApps
    : interviewApps.filter((a) => {
        const entry = interviewsByKey[`${roundId}:${a.id}`]
        return entry?.status === statusFilter
      })

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-zinc-300" /></div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {rounds.map((r) => {
            const active = r.id === roundId
            return (
              <button
                key={r.id}
                className={`flex items-center rounded-full border ${active ? "bg-purple-50 border-purple-300" : "bg-white border-zinc-200"} px-4 py-2 text-sm font-bold transition-all`}
                onClick={() => setRoundId(r.id)}
              >
                {r.name}
                {active && (
                  <>
                    <button onClick={(e) => { e.stopPropagation(); setEditorMode("rename"); setEditorRoundId(r.id); setEditorName(r.name); setEditorOpen(true) }} className="ml-2 text-zinc-400 hover:text-zinc-600">
                      <Pencil className="h-3 w-3" />
                    </button>
                  </>
                )}
              </button>
            )
          })}
          <Button variant="outline" size="sm" className="rounded-full h-8 w-8 p-0" onClick={() => { setEditorMode("create"); setEditorRoundId(null); setEditorName(""); setEditorOpen(true) }}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {INTERVIEW_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-3">
        {filtered.map((app) => {
          const key = `${roundId}:${app.id}`
          const entry = interviewsByKey[key] || { status: "pending", notes: "", scheduled_at: null }
          const draft = drafts[key] || { notes: "", scheduledAtLocal: "" }

          return (
            <Card key={app.id} className="rounded-2xl border-zinc-200">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-bold text-zinc-900">{app.candidates.name}</p>
                  </div>
                  <Select value={entry.status || "pending"} onValueChange={(v) => upsert(app.id, { status: v })}>
                    <SelectTrigger className="h-7 text-xs w-36 rounded-lg">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVIEW_STATUSES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-[10px] font-bold uppercase text-zinc-400">Schedule</Label>
                    <Input
                      type="datetime-local"
                      value={draft.scheduledAtLocal}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], scheduledAtLocal: e.target.value } }))}
                      className="h-8 text-xs mt-1"
                    />
                    {draft.scheduledAtLocal !== (toDateTimeLocal(entry.scheduled_at) || "") && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] mt-1"
                        onClick={() => upsert(app.id, { scheduled_at: new Date(draft.scheduledAtLocal).toISOString() })}
                      >
                        Save Time
                      </Button>
                    )}
                  </div>
                  <div>
                    <Label className="text-[10px] font-bold uppercase text-zinc-400">Notes</Label>
                    <Textarea
                      value={draft.notes}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], notes: e.target.value } }))}
                      className="h-8 text-xs mt-1 min-h-[30px]"
                      placeholder="Add notes..."
                    />
                    {draft.notes !== (entry.notes || "") && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] mt-1"
                        onClick={() => upsert(app.id, { notes: draft.notes })}
                      >
                        Save Notes
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
        {filtered.length === 0 && (
          <div className="text-center py-12 text-zinc-400 text-sm">
            <p className="font-semibold">No candidates in interview stage</p>
          </div>
        )}
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{editorMode === "create" ? "Add interview round" : "Rename round"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <Label>Round name</Label>
            <Input value={editorName} onChange={(e) => setEditorName(e.target.value)} />
          </div>
          <DialogFooter>
            {editorMode === "rename" && (
              <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} disabled={editorSaving}>
                Delete
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setEditorOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              onClick={async () => {
                if (!editorName.trim()) return
                setEditorSaving(true)
                try {
                  const method = editorMode === "create" ? "POST" : "PUT"
                  const body = editorMode === "create" ? { name: editorName.trim() } : { id: editorRoundId, name: editorName.trim() }
                  const res = await fetch(`/api/jobs/${jobId}/interview-rounds`, {
                    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
                  })
                  if (!res.ok) throw new Error("Failed")
                  invalidateSessionCache(`internal:job-interviews:${jobId}`)
                  await fetchData()
                  setEditorOpen(false)
                } catch {
                  toast({ title: "Failed", variant: "destructive" })
                } finally {
                  setEditorSaving(false)
                }
              }}
              disabled={!editorName.trim() || editorSaving}
            >
              {editorSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this round?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove the round and all interview data inside it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                setDeleteSaving(true)
                try {
                  await fetch(`/api/jobs/${jobId}/interview-rounds`, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: editorRoundId }),
                  })
                  setDeleteOpen(false)
                  setEditorOpen(false)
                  await fetchData()
                } catch {
                  toast({ title: "Failed to delete", variant: "destructive" })
                } finally {
                  setDeleteSaving(false)
                }
              }}
              disabled={deleteSaving}
            >
              {deleteSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
