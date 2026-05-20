"use client"

import { useEffect, useState, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Building2, Mail, Phone, Users, Briefcase, Calendar, CheckCircle2, XCircle, Clock, Edit, Package, ShoppingCart } from "lucide-react"
import { cachedFetchJson } from "@/lib/utils"

type ClientInfo = {
  id: string
  name: string
  primary_contact_email: string | null
  primary_contact_name: string | null
  contact_phone: string | null
  contact_name: string | null
  industry: string | null
  employee_count: string | null
  hiring_for: string[] | null
}

type OrderDetails = {
  type: "bundle" | "individual"
  bundle?: string
  duration?: string
  price?: number
  credits?: string
  creditType?: string
  amount?: number
  estimatedCost?: number
}

type CreditRequest = {
  id: string
  client_id: string
  request_type: "profile_unlock" | "job_post" | "profile_unlocks" | "job_posts"
  requested_amount: number
  message: string | null
  status: "pending" | "approved" | "rejected" | "fulfilled"
  created_at: string
  reviewed_at: string | null
  clients: ClientInfo | null
  orderDetails: OrderDetails | null
}

const STATUS_COLORS: Record<string, { bg: string, text: string, label: string }> = {
  pending: { bg: "bg-yellow-100", text: "text-yellow-800", label: "Pending" },
  approved: { bg: "bg-green-100", text: "text-green-800", label: "Approved" },
  fulfilled: { bg: "bg-green-100", text: "text-green-800", label: "Approved" },
  rejected: { bg: "bg-red-100", text: "text-red-800", label: "Rejected" },
}

const TYPE_LABELS: Record<string, string> = {
  profile_unlock: "Profile Unlock",
  job_post: "Job Post",
  profile_unlocks: "Profile Unlocks",
  job_posts: "Job Posts",
}

const BUNDLE_LABELS: Record<string, string> = {
  database: "Database Only",
  jobposting: "Job Posting Only",
  both: "Database + Job Posting",
}

const DURATION_LABELS: Record<string, string> = {
  "1month": "1 Month",
  "3months": "3 Months",
  "6months": "6 Months",
}

function parseOrderDetails(message: string | null): OrderDetails | null {
  if (!message || !message.includes("---ORDER_DETAILS---")) return null
  try {
    const parts = message.split("---ORDER_DETAILS---")
    return JSON.parse(parts[1].trim())
  } catch {
    return null
  }
}

function parseClientMessage(message: string | null): string {
  if (!message) return ""
  let msg = message
  if (msg.includes("---ADMIN_NOTE---")) {
    msg = msg.split("---ADMIN_NOTE---")[0]
  }
  if (msg.includes("---ORDER_DETAILS---")) {
    msg = msg.split("---ORDER_DETAILS---")[0]
  }
  return msg.trim()
}

function parseAdminNote(message: string | null): string {
  if (!message || !message.includes("---ADMIN_NOTE---")) return ""
  return message.split("---ADMIN_NOTE---")[1]?.trim() || ""
}

function formatPrice(price: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(price)
}

export function CreditRequestsDashboard() {
  const [requests, setRequests] = useState<CreditRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending")
  const [processing, setProcessing] = useState<string | null>(null)
  
  const [selectedCompany, setSelectedCompany] = useState<ClientInfo | null>(null)
  const [reviewRequest, setReviewRequest] = useState<{ req: CreditRequest, isEdit: boolean } | null>(null)
  
  const [reviewAmount, setReviewAmount] = useState<number>(0)
  const [adminNote, setAdminNote] = useState("")

  const fetchRequests = useCallback(async (opts?: { force?: boolean }) => {
    setLoading(true)
    try {
      const url = `/api/clients/credit-requests?status=${statusFilter}`
      const data = await cachedFetchJson<{ requests: CreditRequest[] }>(
        `internal:credit-requests:${url}`,
        url,
        undefined,
        {
          ttlMs: 5 * 60_000,
          force: Boolean(opts?.force),
          swr: true,
          onData: (freshData) => {
            const parsed = (freshData.requests || []).map((req: any) => ({
              ...req,
              orderDetails: parseOrderDetails(req.message),
            }))
            setRequests(parsed)
          }
        }
      )
      const parsed = (data.requests || []).map((req: any) => ({
        ...req,
        orderDetails: parseOrderDetails(req.message),
      }))
      setRequests(parsed)
    } catch {
      console.error("Failed to load requests")
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { fetchRequests() }, [fetchRequests])

  const handleOpenReview = (req: CreditRequest, isEdit = false) => {
    setReviewRequest({ req, isEdit })
    setReviewAmount(req.requested_amount)
    setAdminNote(parseAdminNote(req.message))
  }

  const submitReview = async (action: "approve" | "reject" | "edit") => {
    if (!reviewRequest) return
    setProcessing(reviewRequest.req.id)
    try {
      const res = await fetch("/api/clients/credit-requests", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          request_id: reviewRequest.req.id, 
          action,
          amount: reviewAmount,
          admin_note: adminNote
        }),
      })
      if (!res.ok) throw new Error("Failed")
      await fetchRequests()
      setReviewRequest(null)
    } catch (e: any) {
      alert("Error: " + e.message)
    } finally {
      setProcessing(null)
    }
  }

  const handleActionDirect = async (requestId: string, action: "reject") => {
    setProcessing(requestId)
    try {
      const res = await fetch("/api/clients/credit-requests", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, action }),
      })
      if (!res.ok) throw new Error("Failed")
      await fetchRequests()
    } catch (e: any) {
      alert("Error: " + e.message)
    } finally {
      setProcessing(null)
    }
  }

  const pendingCount = requests.filter(r => r.status === "pending").length

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      <Tabs defaultValue="requests" className="w-full">
        <div className="flex items-center justify-between mb-6">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight">Credit Management</h1>
            <p className="text-muted-foreground">Manage client credit requests — bundles & individual purchases.</p>
          </div>
          <TabsList>
            <TabsTrigger value="requests">Requests {pendingCount > 0 && <Badge variant="destructive" className="ml-2">{pendingCount}</Badge>}</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="requests" className="space-y-6">
          <div className="flex gap-2">
            {(["pending", "approved", "rejected", "all"] as const).map(s => (
              <Button
                key={s}
                variant={statusFilter === s ? "default" : "outline"}
                onClick={() => setStatusFilter(s)}
                className="capitalize"
              >
                {s}
              </Button>
            ))}
            <Button variant="ghost" onClick={() => fetchRequests({ force: true })} className="ml-auto">↻ Refresh</Button>
          </div>

          {loading ? (
            <div className="space-y-4">
              {[1, 2, 3].map(i => <div key={i} className="h-32 bg-muted animate-pulse rounded-lg" />)}
            </div>
          ) : requests.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground border rounded-lg border-dashed">
              <p>No {statusFilter === "all" ? "" : statusFilter} credit requests found.</p>
            </div>
          ) : (
            <div className="grid gap-4">
              {requests.map(req => {
                const st = STATUS_COLORS[req.status] || STATUS_COLORS.pending
                const client = req.clients
                const isPending = req.status === "pending"
                const isApproved = req.status === "approved" || req.status === "fulfilled"
                
                const clientMsg = parseClientMessage(req.message)
                const existingAdminNote = parseAdminNote(req.message)
                const orderDetails = req.orderDetails

                return (
                  <div key={req.id} className={`p-5 rounded-xl border bg-card text-card-foreground shadow-sm flex gap-6 ${isPending ? 'border-l-4 border-l-yellow-500' : ''}`}>
                    <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xl shrink-0">
                      {(client?.name || "?").charAt(0).toUpperCase()}
                    </div>
                    
                    <div className="flex-1 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <button 
                              onClick={() => setSelectedCompany(client)}
                              className="font-bold text-lg hover:underline text-primary"
                            >
                              {client?.name || req.client_id}
                            </button>
                            {client?.contact_phone && (
                              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                                <Phone className="w-3 h-3" /> {client.contact_phone}
                              </span>
                            )}
                            <Badge className={`${st.bg} ${st.text} hover:${st.bg} border-none`}>{st.label}</Badge>
                            {orderDetails && (
                              <Badge variant={orderDetails.type === "bundle" ? "default" : "secondary"} className="flex items-center gap-1">
                                {orderDetails.type === "bundle" ? <Package className="w-3 h-3" /> : <ShoppingCart className="w-3 h-3" />}
                                {orderDetails.type === "bundle" ? "Bundle" : "Individual"}
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                            {client?.primary_contact_email && <span className="flex items-center gap-1"><Mail className="w-3 h-3"/> {client.primary_contact_email}</span>}
                            {client?.contact_phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3"/> {client.contact_phone}</span>}
                          </div>
                        </div>

                        <div className="flex flex-col gap-2 items-end">
                          {isPending && (
                            <div className="flex gap-2">
                              <Button variant="outline" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => handleActionDirect(req.id, "reject")} disabled={!!processing}>
                                Reject
                              </Button>
                              <Button onClick={() => handleOpenReview(req, false)} disabled={!!processing}>
                                Review & Approve
                              </Button>
                            </div>
                          )}
                          {isApproved && (
                            <Button variant="outline" size="sm" onClick={() => handleOpenReview(req, true)} disabled={!!processing}>
                              <Edit className="w-4 h-4 mr-2" /> Edit Granted Credits
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Order Details Card */}
                      {orderDetails && (
                        <div className={`p-4 rounded-lg border ${orderDetails.type === "bundle" ? "bg-blue-50 border-blue-200" : "bg-purple-50 border-purple-200"}`}>
                          {orderDetails.type === "bundle" ? (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <Package className="w-4 h-4 text-blue-600" />
                                <span className="font-semibold text-blue-900">Subscription Bundle</span>
                              </div>
                              <div className="grid grid-cols-2 gap-3 text-sm">
                                <div>
                                  <span className="text-muted-foreground text-xs block">Plan</span>
                                  <span className="font-medium">{BUNDLE_LABELS[orderDetails.bundle || ""] || orderDetails.bundle}</span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground text-xs block">Duration</span>
                                  <span className="font-medium">{DURATION_LABELS[orderDetails.duration || ""] || orderDetails.duration}</span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground text-xs block">Price</span>
                                  <span className="font-bold text-blue-700">{orderDetails.price ? formatPrice(orderDetails.price) : "N/A"}</span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground text-xs block">Includes</span>
                                  <span className="font-medium">{orderDetails.credits}</span>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <ShoppingCart className="w-4 h-4 text-purple-600" />
                                <span className="font-semibold text-purple-900">Individual Credits</span>
                              </div>
                              <div className="grid grid-cols-3 gap-3 text-sm">
                                <div>
                                  <span className="text-muted-foreground text-xs block">Type</span>
                                  <span className="font-medium">{TYPE_LABELS[orderDetails.creditType || ""] || orderDetails.creditType}</span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground text-xs block">Amount</span>
                                  <span className="font-bold">{orderDetails.amount} credits</span>
                                </div>
                                <div>
                                  <span className="text-muted-foreground text-xs block">Est. Cost</span>
                                  <span className="font-bold text-purple-700">{orderDetails.estimatedCost ? formatPrice(orderDetails.estimatedCost) : "N/A"}</span>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Legacy display for old requests without order details */}
                      {!orderDetails && (
                        <div className="flex gap-8 text-sm bg-muted/50 p-3 rounded-lg">
                          <div>
                            <span className="text-muted-foreground uppercase text-[10px] font-bold block">Type</span>
                            <span className="font-medium">{TYPE_LABELS[req.request_type] || req.request_type}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground uppercase text-[10px] font-bold block">Requested</span>
                            <span className="font-bold text-primary">{req.requested_amount} credits</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground uppercase text-[10px] font-bold block">Date</span>
                            <span>{new Date(req.created_at).toLocaleDateString()}</span>
                          </div>
                        </div>
                      )}

                      {clientMsg && (
                        <div className="text-sm italic text-muted-foreground border-l-2 pl-3">
                          "{clientMsg}"
                        </div>
                      )}
                      
                      {existingAdminNote && (
                        <div className="text-sm bg-blue-50 text-blue-900 p-2 rounded border border-blue-100">
                          <strong>Admin Note:</strong> {existingAdminNote}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="analytics">
          <div className="p-8 text-center border rounded-lg border-dashed bg-muted/20">
            <h3 className="text-xl font-semibold mb-2">Credit Analytics</h3>
            <p className="text-muted-foreground mb-4">Analytics dashboard is coming soon. Here you will see charts for credit usage, top clients, and revenue metrics.</p>
            <BarChartPlaceholder />
          </div>
        </TabsContent>
      </Tabs>

      {/* Review Dialog */}
      <Dialog open={!!reviewRequest} onOpenChange={(open) => !open && setReviewRequest(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {reviewRequest?.isEdit ? <Edit className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
              {reviewRequest?.isEdit ? 'Edit Approved Request' : 'Review Credit Request'}
            </DialogTitle>
            <DialogDescription>
              {reviewRequest?.req.clients?.name && (
                <span className="block font-medium text-foreground mb-1">
                  Client: {reviewRequest.req.clients.name}
                  {reviewRequest.req.clients.primary_contact_email && (
                    <span className="text-muted-foreground font-normal ml-2">
                      ({reviewRequest.req.clients.primary_contact_email})
                    </span>
                  )}
                </span>
              )}
              {reviewRequest?.isEdit ? 'Adjust the credits granted or update the admin note.' : 'Review and modify the requested amount before approving.'}
            </DialogDescription>
          </DialogHeader>
          
          {reviewRequest && reviewRequest.req.orderDetails && (
            <div className={`p-4 rounded-lg border mb-4 ${reviewRequest.req.orderDetails.type === "bundle" ? "bg-blue-50 border-blue-200" : "bg-purple-50 border-purple-200"}`}>
              {reviewRequest.req.orderDetails.type === "bundle" ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Package className="w-4 h-4 text-blue-600" />
                    <span className="font-semibold text-blue-900">Subscription Bundle</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground text-xs block">Plan</span>
                      <span className="font-medium">{BUNDLE_LABELS[reviewRequest.req.orderDetails.bundle || ""] || reviewRequest.req.orderDetails.bundle}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs block">Duration</span>
                      <span className="font-medium">{DURATION_LABELS[reviewRequest.req.orderDetails.duration || ""] || reviewRequest.req.orderDetails.duration}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs block">Price</span>
                      <span className="font-bold text-blue-700">{reviewRequest.req.orderDetails.price ? formatPrice(reviewRequest.req.orderDetails.price) : "N/A"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs block">Includes</span>
                      <span className="font-medium">{reviewRequest.req.orderDetails.credits}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <ShoppingCart className="w-4 h-4 text-purple-600" />
                    <span className="font-semibold text-purple-900">Individual Credits</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground text-xs block">Type</span>
                      <span className="font-medium">{TYPE_LABELS[reviewRequest.req.orderDetails.creditType || ""] || reviewRequest.req.orderDetails.creditType}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs block">Amount</span>
                      <span className="font-bold">{reviewRequest.req.orderDetails.amount} credits</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs block">Est. Cost</span>
                      <span className="font-bold text-purple-700">{reviewRequest.req.orderDetails.estimatedCost ? formatPrice(reviewRequest.req.orderDetails.estimatedCost) : "N/A"}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {reviewRequest?.req.orderDetails?.type === "bundle" ? "Number of Bundles to Grant" : "Credits to Grant"}
              </label>
              <Input 
                type="number" 
                value={reviewAmount} 
                onChange={e => setReviewAmount(Number(e.target.value))} 
                min={0}
              />
              <div className="flex justify-between items-center">
                <p className="text-xs text-muted-foreground">Original request: {reviewRequest?.req.requested_amount}</p>
                {reviewRequest?.req.orderDetails?.type === "bundle" && (
                  <p className="text-[10px] text-blue-600 font-medium italic">
                    Credits will be added based on bundle description.
                  </p>
                )}
              </div>
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium">Admin Note (Internal & Client visible)</label>
              <Textarea 
                placeholder="E.g., Added 20% bonus credits for our top 100 clients!" 
                value={adminNote}
                onChange={e => setAdminNote(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewRequest(null)}>Cancel</Button>
            <Button 
              onClick={() => submitReview(reviewRequest?.isEdit ? 'edit' : 'approve')}
              disabled={!!processing}
            >
              {processing ? 'Saving...' : (reviewRequest?.isEdit ? 'Save Changes' : 'Approve & Grant Credits')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Company Info Modal */}
      <Dialog open={!!selectedCompany} onOpenChange={(open) => !open && setSelectedCompany(null)}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <Building2 className="w-5 h-5" />
              {selectedCompany?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase">Primary Email</span>
                <p className="text-sm font-medium flex items-center gap-2"><Mail className="w-3 h-3"/> {selectedCompany?.primary_contact_email || 'N/A'}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase">Phone</span>
                <p className="text-sm font-medium flex items-center gap-2"><Phone className="w-3 h-3"/> {selectedCompany?.contact_phone || 'N/A'}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase">Contact Person</span>
                <p className="text-sm font-medium flex items-center gap-2"><Users className="w-3 h-3"/> {selectedCompany?.contact_name || selectedCompany?.primary_contact_name || 'N/A'}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase">Industry</span>
                <p className="text-sm font-medium flex items-center gap-2"><Briefcase className="w-3 h-3"/> {selectedCompany?.industry || 'N/A'}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase">Company Size</span>
                <p className="text-sm font-medium flex items-center gap-2"><Users className="w-3 h-3"/> {selectedCompany?.employee_count || 'N/A'}</p>
              </div>
            </div>
            
            {selectedCompany?.hiring_for && selectedCompany.hiring_for.length > 0 && (
              <div className="space-y-2 mt-2">
                <span className="text-xs text-muted-foreground uppercase">Hiring For</span>
                <div className="flex flex-wrap gap-2">
                  {selectedCompany.hiring_for.map(role => (
                    <Badge key={role} variant="secondary">{role}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BarChartPlaceholder() {
  return (
    <div className="h-64 w-full flex items-end justify-center gap-4 mt-8 opacity-50">
      <div className="w-16 bg-primary/40 h-1/4 rounded-t-sm" />
      <div className="w-16 bg-primary/60 h-2/4 rounded-t-sm" />
      <div className="w-16 bg-primary/80 h-3/4 rounded-t-sm" />
      <div className="w-16 bg-primary h-full rounded-t-sm" />
      <div className="w-16 bg-primary/60 h-2/4 rounded-t-sm" />
    </div>
  )
}
