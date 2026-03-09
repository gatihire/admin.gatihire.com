import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { Loader2 } from "lucide-react"

interface Job {
  id: string
  title: string
  status: string
  client_id?: string | null
  client_name?: string | null
}

interface Client {
  id: string
  name: string
}

interface AssignJobDialogProps {
  candidateId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  candidateName: string
}

export function AssignJobDialog({ candidateId, open, onOpenChange, candidateName }: AssignJobDialogProps) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchingClients, setFetchingClients] = useState(false)
  const [fetchingJobs, setFetchingJobs] = useState(false)
  const [selectedClient, setSelectedClient] = useState<string>("")
  const [selectedJob, setSelectedJob] = useState<string>("")
  const [notes, setNotes] = useState("")
  const [action, setAction] = useState<"assign" | "invite" | "both">("assign")
  const [stage, setStage] = useState<string>("shortlist")
  const { toast } = useToast()

  useEffect(() => {
    if (open) {
      setSelectedClient("")
      setSelectedJob("")
      setJobs([])
      fetchClients()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    if (!selectedClient) return
    setSelectedJob("")
    fetchJobs(selectedClient)
  }, [open, selectedClient])

  const fetchClients = async () => {
    setFetchingClients(true)
    try {
      const res = await fetch("/api/clients")
      if (res.ok) {
        const data = (await res.json().catch(() => [])) as any[]
        const normalized = (Array.isArray(data) ? data : [])
          .map((c) => ({ id: String(c.id), name: String(c.name || "").trim() }))
          .filter((c) => c.id && c.name)
          .sort((a, b) => a.name.localeCompare(b.name))
        setClients(normalized)
      }
    } catch (error) {
      console.error("Failed to fetch clients", error)
    } finally {
      setFetchingClients(false)
    }
  }

  const fetchJobs = async (clientId: string) => {
    setFetchingJobs(true)
    try {
      const res = await fetch(`/api/jobs?status=open&clientId=${encodeURIComponent(clientId)}`)
      if (res.ok) {
        const data = await res.json()
        setJobs(data)
      }
    } catch (error) {
      console.error("Failed to fetch jobs", error)
    } finally {
      setFetchingJobs(false)
    }
  }

  const handleAssign = async () => {
    if (!selectedJob) return
    setLoading(true)
    try {
      const shouldAssign = action !== "invite"
      const shouldInvite = action !== "assign"

      if (shouldAssign) {
        const res = await fetch("/api/applications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id: selectedJob,
            candidate_id: candidateId,
            status: stage,
            source: "database",
            notes
          })
        })

        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || "Failed to assign")
      }

      if (shouldInvite) {
        const inv = await fetch("/api/job-invites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: selectedJob, candidateId, resend: true, sendWhatsapp: true, sendEmail: true })
        })
        const data = await inv.json().catch(() => null)
        if (!inv.ok) throw new Error(data?.error || "Failed to create invite")

        const parts: string[] = []
        if (data?.emailSent) parts.push("Email sent")
        else if (data?.emailError) parts.push(`Email failed: ${data.emailError}`)
        if (data?.whatsappSent) parts.push("WhatsApp sent")
        else if (data?.whatsappError) parts.push(`WhatsApp failed: ${data.whatsappError}`)
        const description = parts.length ? parts.join(" • ") : "Invite created."

        toast({
          title: shouldAssign ? "Saved" : "Invite created",
          description
        })
      } else {
        toast({ title: "Saved", description: "Candidate assigned successfully." })
      }

      onOpenChange(false)
      setSelectedJob("")
      setNotes("")
      setAction("assign")
      setStage("shortlist")
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to assign job",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Assign to Job</DialogTitle>
          <DialogDescription>
            Assign {candidateName} to an active job opening.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="company">Select Company</Label>
            <Select value={selectedClient} onValueChange={setSelectedClient} disabled={fetchingClients}>
              <SelectTrigger>
                <SelectValue placeholder={fetchingClients ? "Loading companies..." : "Select a company"} />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
                {clients.length === 0 && !fetchingClients && (
                  <SelectItem value="none" disabled>
                    No companies found
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="job">Select Job</Label>
            <Select value={selectedJob} onValueChange={setSelectedJob} disabled={fetchingJobs || !selectedClient}>
              <SelectTrigger>
                <SelectValue
                  placeholder={!selectedClient ? "Select a company first" : fetchingJobs ? "Loading jobs..." : "Select a job"}
                />
              </SelectTrigger>
              <SelectContent>
                {jobs.map((job) => (
                  <SelectItem key={job.id} value={job.id}>
                    {job.title}
                  </SelectItem>
                ))}
                {jobs.length === 0 && !fetchingJobs && selectedClient && (
                  <SelectItem value="none" disabled>No open jobs found</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>Action</Label>
            <Select value={action} onValueChange={(v) => setAction(v as any)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="assign">Assign to pipeline (no invite)</SelectItem>
                <SelectItem value="invite">Invite to apply only</SelectItem>
                <SelectItem value="both">Assign + Invite</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground">Invites are tracked separately in the job’s Invites section.</div>
          </div>

          {action !== "invite" ? (
            <div className="grid gap-2">
              <Label>Stage</Label>
              <Select value={stage} onValueChange={setStage}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="applied">Applied</SelectItem>
                  <SelectItem value="shortlist">Shortlist</SelectItem>
                  <SelectItem value="screening">Screening</SelectItem>
                  <SelectItem value="interview">Interview</SelectItem>
                  <SelectItem value="offer">Offer</SelectItem>
                  <SelectItem value="hired">Hired</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="notes">Notes (Optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add initial screening notes..."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleAssign} disabled={loading || !selectedJob}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
