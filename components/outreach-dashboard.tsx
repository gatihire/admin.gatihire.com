"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { ArrowLeft, Send, Users, Mail, MessageCircle, CheckCircle, XCircle, Clock, RefreshCw, Search } from "lucide-react"
import { format } from "date-fns"

interface Candidate {
  id: string
  name: string
  email: string
  phone: string
  current_role: string
  messages: Message[]
  responded: boolean
}

interface Message {
  id: string
  type: "email" | "whatsapp"
  status: "pending" | "sent" | "delivered" | "failed" | "opened"
  sent_at: string
  delivered_at: string
  opened_at: string
  unique_link: string
}

interface Job {
  id: string
  title: string
  description: string
  client_name: string
  is_external_link: boolean
  auto_matchmaking_enabled: boolean
  messaging_preferences: string
}

interface OutreachStats {
  total_outreached: number
  responded: number
  messages_sent: number
  by_status: {
    pending: number
    sent: number
    delivered: number
    opened: number
    failed: number
  }
}

interface OutreachDashboardProps {
  jobId: string
}

export function OutreachDashboard({ jobId }: OutreachDashboardProps) {
  const [job, setJob] = useState<Job | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [stats, setStats] = useState<OutreachStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [messagingPreference, setMessagingPreference] = useState<"email" | "whatsapp" | "both">("both")
  const [autoMatchmaking, setAutoMatchmaking] = useState(true)
  const [query, setQuery] = useState("")
  const [candidateFilter, setCandidateFilter] = useState<"all" | "responded" | "not_responded">("all")
  const [channelTab, setChannelTab] = useState<"all" | "email" | "whatsapp">("all")
  const [page, setPage] = useState(1)
  const [perPage] = useState(20)
  const [totalCandidates, setTotalCandidates] = useState(0)
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Record<string, true>>({})
  const [reinviteChannel, setReinviteChannel] = useState<"email" | "whatsapp" | "both">("both")
  const [reiniviting, setReinviting] = useState(false)
  const [reinviteConfirmOpen, setReinviteConfirmOpen] = useState(false)
  const { toast } = useToast()
  const router = useRouter()

  useEffect(() => {
    fetchJobDetails()
    fetchOutreachData()
  }, [jobId, page])

  useEffect(() => {
    clearSelection()
    setReinviteConfirmOpen(false)
  }, [page])

  const fetchJobDetails = async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`)
      if (res.ok) {
        const data = await res.json()
        setJob(data)
        setMessagingPreference(data.messaging_preferences || "both")
        setAutoMatchmaking(data.auto_matchmaking_enabled !== false)
      }
    } catch (error) {
      console.error("Failed to fetch job details", error)
    }
  }

  const fetchOutreachData = async () => {
    try {
      setRefreshing(true)
      const res = await fetch(`/api/jobs/${jobId}/outreach?page=${page}&perPage=${perPage}`)
      if (res.ok) {
        const data = await res.json()
        setCandidates(data.candidates || [])
        setStats(data.stats || null)
        setTotalCandidates(typeof data.totalCandidates === "number" ? data.totalCandidates : (data.stats?.total_outreached || 0))
      }
    } catch (error) {
      console.error("Failed to fetch outreach data", error)
      toast({
        title: "Error",
        description: "Failed to fetch outreach data",
        variant: "destructive"
      })
    } finally {
      setRefreshing(false)
      setLoading(false)
    }
  }

  const sendOutreachMessages = async () => {
    setSending(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/outreach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          messagingPreference,
          autoMatchmaking
        })
      })

      const data = await res.json()

      if (res.ok) {
        toast({
          title: "Success",
          description: data.message || "Outreach messages sent successfully"
        })
        fetchOutreachData() // Refresh data
      } else {
        toast({
          title: "Error",
          description: data.error || "Failed to send outreach messages",
          variant: "destructive"
        })
      }
    } catch (error) {
      console.error("Failed to send outreach messages", error)
      toast({
        title: "Error",
        description: "Failed to send outreach messages",
        variant: "destructive"
      })
    } finally {
      setSending(false)
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "sent":
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case "delivered":
        return <CheckCircle className="h-4 w-4 text-blue-500" />
      case "opened":
        return <Mail className="h-4 w-4 text-purple-500" />
      case "failed":
        return <XCircle className="h-4 w-4 text-red-500" />
      default:
        return <Clock className="h-4 w-4 text-gray-500" />
    }
  }

  const getStatusBadge = (status: string) => {
    const variants = {
      pending: "bg-gray-100 text-gray-800",
      sent: "bg-green-100 text-green-800",
      delivered: "bg-blue-100 text-blue-800",
      opened: "bg-purple-100 text-purple-800",
      failed: "bg-red-100 text-red-800"
    }
    return <Badge className={variants[status as keyof typeof variants] || variants.pending}>{status}</Badge>
  }

  const normalizedQuery = query.trim().toLowerCase()
  const baseFilteredCandidates = candidates.filter((c) => {
    if (candidateFilter === "responded" && !c.responded) return false
    if (candidateFilter === "not_responded" && c.responded) return false
    if (!normalizedQuery) return true
    const hay = `${c.name} ${c.email} ${c.phone || ""} ${c.current_role || ""}`.toLowerCase()
    return hay.includes(normalizedQuery)
  })

  const filteredCandidates = baseFilteredCandidates.filter((c) => {
    if (channelTab === "all") return true
    return (c.messages || []).some((m) => m.type === channelTab)
  })

  const toggleSelected = (candidateId: string, checked: boolean) => {
    setSelectedCandidateIds((prev) => {
      const next = { ...prev }
      if (checked) next[candidateId] = true
      else delete next[candidateId]
      return next
    })
  }

  const clearSelection = () => setSelectedCandidateIds({})

  const selectShownNotResponded = () => {
    setSelectedCandidateIds((prev) => {
      const next = { ...prev }
      for (const c of filteredCandidates) {
        if (!c.responded) next[c.id] = true
      }
      return next
    })
  }

  const selectedCount = Object.keys(selectedCandidateIds).length
  const shownNotRespondedCount = filteredCandidates.filter((c) => !c.responded).length

  const reinviteSelected = async () => {
    const candidateIds = Object.keys(selectedCandidateIds)
    if (candidateIds.length === 0) return
    setReinviting(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/outreach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "resend",
          candidateIds,
          messagingPreference: reinviteChannel,
          autoMatchmaking: false
        })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to reinvite candidates")
      toast({ title: "Re-invites sent", description: data?.message || "Messages sent successfully." })
      clearSelection()
      fetchOutreachData()
    } catch (e: any) {
      toast({ title: "Re-invite failed", description: e?.message || "Failed", variant: "destructive" })
    } finally {
      setReinviting(false)
    }
  }

  const mediumStats = (type: "email" | "whatsapp") => {
    const withType = candidates.filter((c) => (c.messages || []).some((m) => m.type === type))
    const responded = withType.filter((c) => c.responded).length
    return {
      total: withType.length,
      responded,
      rate: withType.length ? Math.round((responded / withType.length) * 100) : 0
    }
  }

  const emailStats = mediumStats("email")
  const whatsappStats = mediumStats("whatsapp")

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold">Loading...</h1>
        </div>
      </div>
    )
  }

  if (!job) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold">Job not found</h1>
        </div>
      </div>
    )
  }

  if (job.is_external_link) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold">External Link Job</h1>
        </div>
        <Card>
          <CardContent className="p-6">
            <p className="text-muted-foreground">
              External link jobs do not support automatic candidate outreach and matchmaking.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Outreach Dashboard</h1>
            <p className="text-muted-foreground">{job.title}{job.client_name ? ` • ${job.client_name}` : ""}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={fetchOutreachData} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Configuration Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Outreach Configuration</CardTitle>
          <CardDescription>
            Configure messaging preferences and matchmaking settings for this job
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Messaging Preference</label>
              <Select value={messagingPreference} onValueChange={(val) => setMessagingPreference(val as "email" | "whatsapp" | "both")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">Email + WhatsApp</SelectItem>
                  <SelectItem value="email">Email Only</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp Only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Auto Matchmaking</label>
              <Select value={autoMatchmaking ? "enabled" : "disabled"} onValueChange={(val) => setAutoMatchmaking(val === "enabled")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="enabled">Enabled</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button 
            onClick={sendOutreachMessages} 
            disabled={sending || !autoMatchmaking}
            className="w-full md:w-auto"
          >
            {sending ? (
              <>
                <Clock className="mr-2 h-4 w-4 animate-spin" />
                Sending Messages...
              </>
            ) : (
              <>
                <Send className="mr-2 h-4 w-4" />
                Send Outreach Messages
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Stats Card */}
      {stats && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Outreach Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold">{stats.total_outreached}</div>
                <div className="text-sm text-muted-foreground">Candidates</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{stats.responded}</div>
                <div className="text-sm text-muted-foreground">Responded</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{stats.messages_sent}</div>
                <div className="text-sm text-muted-foreground">Messages Sent</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">
                  {stats.total_outreached > 0 ? Math.round((stats.responded / stats.total_outreached) * 100) : 0}%
                </div>
                <div className="text-sm text-muted-foreground">Response Rate</div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex items-center justify-between rounded-lg border bg-white p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span>Email</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  {emailStats.responded}/{emailStats.total} responded • {emailStats.rate}%
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border bg-white p-3">
                <div className="flex items-center gap-2 text-sm">
                  <MessageCircle className="h-4 w-4 text-muted-foreground" />
                  <span>WhatsApp</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  {whatsappStats.responded}/{whatsappStats.total} responded • {whatsappStats.rate}%
                </div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-2">
              <div className="text-center">
                <Badge variant="outline">Pending: {stats.by_status.pending}</Badge>
              </div>
              <div className="text-center">
                <Badge variant="outline" className="bg-green-50 text-green-700">Sent: {stats.by_status.sent}</Badge>
              </div>
              <div className="text-center">
                <Badge variant="outline" className="bg-blue-50 text-blue-700">Delivered: {stats.by_status.delivered}</Badge>
              </div>
              <div className="text-center">
                <Badge variant="outline" className="bg-purple-50 text-purple-700">Opened: {stats.by_status.opened}</Badge>
              </div>
              <div className="text-center">
                <Badge variant="outline" className="bg-red-50 text-red-700">Failed: {stats.by_status.failed}</Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Candidates List */}
      <Card>
        <CardHeader>
          <CardTitle>Candidate Outreach</CardTitle>
          <CardDescription>
            Track the status of outreach messages sent to candidates
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={channelTab} onValueChange={(v) => setChannelTab(v as any)}>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:flex-1">
                <TabsList className="w-fit">
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="email">Email</TabsTrigger>
                  <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
                </TabsList>
                <div className="relative w-full md:max-w-md">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search candidates by name, email, phone…"
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={candidateFilter} onValueChange={(v) => setCandidateFilter(v as any)}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All candidates</SelectItem>
                    <SelectItem value="responded">Responded</SelectItem>
                    <SelectItem value="not_responded">Not responded</SelectItem>
                  </SelectContent>
                </Select>
                <Badge variant="outline">{filteredCandidates.length} shown</Badge>
                <Badge variant="outline">
                  Page {page} • Total {totalCandidates}
                </Badge>
              </div>
            </div>

            {shownNotRespondedCount > 0 || selectedCount > 0 ? (
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-4 rounded-lg border bg-gray-50/40 p-3">
                <div className="text-sm text-muted-foreground">
                  Not responded (shown): <span className="font-semibold text-foreground">{shownNotRespondedCount}</span>
                  {selectedCount ? (
                    <>
                      {" "}
                      • Selected: <span className="font-semibold text-foreground">{selectedCount}</span>
                    </>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={selectShownNotResponded} disabled={shownNotRespondedCount === 0}>
                    Select shown
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearSelection} disabled={selectedCount === 0}>
                    Clear selection
                  </Button>
                  <Select value={reinviteChannel} onValueChange={(v) => setReinviteChannel(v as any)}>
                    <SelectTrigger className="h-9 w-[180px] bg-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="whatsapp">WhatsApp only</SelectItem>
                      <SelectItem value="email">Email only</SelectItem>
                      <SelectItem value="both">WhatsApp + Email</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button onClick={() => setReinviteConfirmOpen(true)} disabled={reiniviting || selectedCount === 0}>
                    Re-invite selected
                  </Button>
                </div>
              </div>
            ) : null}

            <TabsContent value="all" />
            <TabsContent value="email" />
            <TabsContent value="whatsapp" />
          </Tabs>

          {filteredCandidates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>{candidates.length === 0 ? "No candidates have been outreached yet." : "No candidates match your filters."}</p>
              {candidates.length === 0 ? <p className="text-sm mt-2">Click "Send Outreach Messages" to start the process.</p> : null}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredCandidates.map((candidate) => (
                <div key={candidate.id} className="border rounded-lg p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={Boolean(selectedCandidateIds[candidate.id])}
                        onCheckedChange={(v) => toggleSelected(candidate.id, Boolean(v))}
                        disabled={candidate.responded}
                      />
                      <div>
                      <h3 className="font-semibold">{candidate.name}</h3>
                      <p className="text-sm text-muted-foreground">{candidate.current_role}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Mail className="h-3 w-3 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">{candidate.email}</span>
                        {candidate.phone && (
                          <>
                            <span className="text-muted-foreground">•</span>
                            <MessageCircle className="h-3 w-3 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">{candidate.phone}</span>
                          </>
                        )}
                      </div>
                      </div>
                    </div>
                    {candidate.responded && (
                      <Badge className="bg-green-100 text-green-800">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Responded
                      </Badge>
                    )}
                  </div>
                  
                  <div className="space-y-2">
                    {candidate.messages
                      .filter((m) => channelTab === "all" || m.type === channelTab)
                      .map((message) => (
                      <div key={message.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center gap-3">
                          {getStatusIcon(message.status)}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">
                                {message.type === "email" ? "Email" : "WhatsApp"} Message
                              </span>
                              {getStatusBadge(message.status)}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {message.sent_at && `Sent: ${format(new Date(message.sent_at), "MMM d, yyyy HH:mm")}`}
                              {message.delivered_at && ` • Delivered: ${format(new Date(message.delivered_at), "MMM d, yyyy HH:mm")}`}
                              {message.opened_at && ` • Opened: ${format(new Date(message.opened_at), "MMM d, yyyy HH:mm")}`}
                            </div>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(message.unique_link, "_blank")}
                        >
                          View Link
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 flex items-center justify-between">
            <Button variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || refreshing}>
              Previous
            </Button>
            <div className="text-sm text-muted-foreground">
              Page {page} of {Math.max(1, Math.ceil((totalCandidates || 0) / perPage))}
            </div>
            <Button
              variant="outline"
              onClick={() => setPage((p) => p + 1)}
              disabled={refreshing || page >= Math.max(1, Math.ceil((totalCandidates || 0) / perPage))}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={reinviteConfirmOpen} onOpenChange={setReinviteConfirmOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Confirm re-invite</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 text-sm text-muted-foreground">
            <div>
              You are about to re-invite <span className="font-semibold text-foreground">{selectedCount}</span> candidate(s).
            </div>
            <div>
              Channel: <span className="font-semibold text-foreground">{reinviteChannel}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReinviteConfirmOpen(false)} disabled={reiniviting}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                await reinviteSelected()
                setReinviteConfirmOpen(false)
              }}
              disabled={reiniviting || selectedCount === 0}
            >
              {reiniviting ? <Clock className="mr-2 h-4 w-4 animate-spin" /> : null}
              Send re-invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
