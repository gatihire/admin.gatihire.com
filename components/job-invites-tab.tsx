"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Send, Mail, MessageCircle, Plus, ClipboardCopy, ExternalLink, RotateCw, ChevronDown, ChevronUp } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { cachedFetchJson, getBoardAppBaseUrl, invalidateSessionCache } from "@/lib/utils"

interface Invite {
  id: string
  email: string
  token: string
  status: string
  sent_at: string | null
  opened_at: string | null
  applied_at: string | null
  rejected_at: string | null
  created_at: string | null
  candidate_id?: string | null
  metadata?: {
    whatsapp?: { status: string; phone: string | null; error: string | null; sent_at: string | null }
    source?: string
  } | null
}

interface InvitesTabProps {
  jobId: string
}

function inviteBadgeClass(status: string) {
  switch (status) {
    case "sent": return "bg-gray-50 text-gray-700 border-gray-200"
    case "opened": return "bg-blue-50 text-blue-700 border-blue-200"
    case "applied": return "bg-green-50 text-green-700 border-green-200"
    case "rejected": return "bg-red-50 text-red-700 border-red-200"
    default: return "bg-gray-50 text-gray-700 border-gray-200"
  }
}

function messageStatusBadge(status: string) {
  const base = "px-2 py-1 rounded-full text-[10px] font-bold border"
  switch (status) {
    case "pending": return `${base} bg-yellow-50 text-yellow-700 border-yellow-200`
    case "sent": return `${base} bg-blue-50 text-blue-700 border-blue-200`
    case "delivered": return `${base} bg-green-50 text-green-700 border-green-200`
    case "opened": return `${base} bg-purple-50 text-purple-700 border-purple-200`
    case "failed": return `${base} bg-red-50 text-red-700 border-red-200`
    default: return `${base} bg-gray-50 text-gray-700 border-gray-200`
  }
}

export function InvitesTab({ jobId }: InvitesTabProps) {
  const { toast } = useToast()
  const [invites, setInvites] = useState<Invite[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [sendEmail, setSendEmail] = useState(true)
  const [sendWhatsapp, setSendWhatsapp] = useState(true)
  const [creating, setCreating] = useState(false)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [statusFilter, setStatusFilter] = useState("all")
  const limit = 10

  const inviteBase = getBoardAppBaseUrl()
  const inviteLink = (token: string) => `${inviteBase}/invite/${token}`

  useEffect(() => { fetchInvites() }, [jobId, page, statusFilter])

  const fetchInvites = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ jobId, page: String(page), limit: String(limit), status: statusFilter })
      const data = await cachedFetchJson<{ invites: Invite[]; pagination: any }>(
        `internal:job-invites:${jobId}:${params.toString()}`,
        `/api/job-invites?${params.toString()}`,
        undefined,
        { ttlMs: 60_000 },
      )
      setInvites(data?.invites || [])
      if (data?.pagination) {
        setTotal(data.pagination.total)
        setTotalPages(data.pagination.totalPages)
      }
    } catch {
      setInvites([])
    } finally {
      setLoading(false)
    }
  }

  const createInvite = async () => {
    if (!email.trim()) return
    setCreating(true)
    try {
      const res = await fetch("/api/job-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId, email: email.trim(), phone: phone.trim() || undefined,
          sendEmail, sendWhatsapp,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Failed")
      toast({ title: "Invite sent", description: `Invitation sent to ${email}` })
      setEmail(""); setPhone("")
      invalidateSessionCache(`internal:job-invites:${jobId}`, { prefix: true })
      await fetchInvites()
    } catch (err: any) {
      toast({ title: "Failed", description: err.message, variant: "destructive" })
    } finally {
      setCreating(false)
    }
  }

  const resendInvite = async (invite: Invite) => {
    setResendingId(invite.id)
    try {
      const res = await fetch("/api/job-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId, email: invite.email, resendToken: invite.token, sendEmail, sendWhatsapp,
        }),
      })
      if (!res.ok) throw new Error("Failed")
      toast({ title: "Resent", description: `Invite resent to ${invite.email}` })
      invalidateSessionCache(`internal:job-invites:${jobId}`, { prefix: true })
      await fetchInvites()
    } catch {
      toast({ title: "Resend failed", variant: "destructive" })
    } finally {
      setResendingId(null)
    }
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <Card className="border border-blue-100 bg-gradient-to-br from-blue-50/50 via-indigo-50/30 to-purple-50/50 rounded-2xl">
        <CardContent className="p-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="h-10 w-10 rounded-2xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-200">
              <Send className="h-5 w-5 text-white" />
            </div>
            <div>
              <h3 className="font-black text-lg text-blue-900">Manual Candidate Invitation</h3>
              <p className="text-xs font-semibold text-blue-700/70">Add candidates to the pipeline manually</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-4">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Candidate Email" className="h-10 bg-white/80 border-blue-200 rounded-xl" />
            </div>
            <div className="md:col-span-3">
              <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="WhatsApp Number" className="h-10 bg-white/80 border-blue-200 rounded-xl" />
            </div>
            <div className="md:col-span-2 flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Checkbox id="invite-email" checked={sendEmail} onCheckedChange={(v) => setSendEmail(!!v)} />
                <Label htmlFor="invite-email" className="text-xs cursor-pointer"><Mail className="h-3 w-3 inline mr-0.5" />Email</Label>
              </div>
              <div className="flex items-center gap-1.5">
                <Checkbox id="invite-whatsapp" checked={sendWhatsapp} onCheckedChange={(v) => setSendWhatsapp(!!v)} />
                <Label htmlFor="invite-whatsapp" className="text-xs cursor-pointer"><MessageCircle className="h-3 w-3 inline mr-0.5" />WhatsApp</Label>
              </div>
            </div>
            <div className="md:col-span-3">
              <Button onClick={createInvite} disabled={!email.trim() || creating} className="w-full h-10 bg-blue-600 hover:bg-blue-700 rounded-xl gap-1.5">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Send Invite
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h4 className="font-bold text-zinc-800">Sent Invites ({total})</h4>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1) }}>
          <SelectTrigger className="h-8 w-28 text-xs rounded-lg">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="opened">Opened</SelectItem>
            <SelectItem value="applied">Applied</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-zinc-300" /></div>
      ) : invites.length === 0 ? (
        <p className="text-sm text-zinc-400 text-center py-8">No invites sent yet</p>
      ) : (
        <div className="space-y-2">
          {invites.map((inv) => {
            const expanded = expandedIds.has(inv.id)
            const meta = inv.metadata
            const whatsapp = meta?.whatsapp
            return (
              <Card key={inv.id} className="rounded-2xl border-zinc-200">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-zinc-800 truncate">{inv.email}</p>
                        <p className="text-xs text-zinc-400">{inv.candidate_id ? "Existing candidate" : "New invite"}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className={`text-[10px] font-bold ${inviteBadgeClass(inv.status)}`}>
                        {inv.status.toUpperCase()}
                      </Badge>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => toggleExpanded(inv.id)}>
                        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="mt-3 pt-3 border-t border-zinc-100 space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline" className={messageStatusBadge(meta?.source === "whatsapp_sent" ? "sent" : "pending")}>
                          <Mail className="h-3 w-3 mr-1" />Email: {inv.sent_at ? "Sent" : "Pending"}
                        </Badge>
                        {whatsapp && (
                          <Badge variant="outline" className={messageStatusBadge(whatsapp.status || "pending")}>
                            <MessageCircle className="h-3 w-3 mr-1" />
                            WhatsApp: {whatsapp.status || "Pending"}
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mt-2">
                        <Button variant="outline" size="sm" className="h-7 text-[10px] rounded-lg gap-1" onClick={() => { navigator.clipboard.writeText(inviteLink(inv.token)); toast({ title: "Copied" }) }}>
                          <ClipboardCopy className="h-3 w-3" />Copy Link
                        </Button>
                        <Button variant="outline" size="sm" className="h-7 text-[10px] rounded-lg gap-1" onClick={() => window.open(inviteLink(inv.token), "_blank")}>
                          <ExternalLink className="h-3 w-3" />Open
                        </Button>
                        <Button variant="outline" size="sm" className="h-7 text-[10px] rounded-lg gap-1" onClick={() => resendInvite(inv)} disabled={resendingId === inv.id}>
                          {resendingId === inv.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                          Resend
                        </Button>
                      </div>

                      {inv.sent_at && <p className="text-[10px] text-zinc-400">Sent: {new Date(inv.sent_at).toLocaleString()}</p>}
                      {inv.opened_at && <p className="text-[10px] text-blue-500">Opened: {new Date(inv.opened_at).toLocaleString()}</p>}
                      {inv.applied_at && <p className="text-[10px] text-green-600">Applied: {new Date(inv.applied_at).toLocaleString()}</p>}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="text-xs">Previous</Button>
          <span className="text-xs text-zinc-500 font-semibold">Page {page} of {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="text-xs">Next</Button>
        </div>
      )}
    </div>
  )
}
