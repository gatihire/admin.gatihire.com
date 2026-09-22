"use client"

import { useEffect, useState, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Building2, Mail, Search, Edit2, Save, X, DollarSign, Users, CreditCard, Loader2, AlertCircle, CheckCircle2 } from "lucide-react"
import { cachedFetchJson } from "@/lib/utils"

type ClientCredit = {
  id: string
  name: string
  slug: string
  primary_contact_email: string | null
  primary_contact_name: string | null
  contact_phone: string | null
  contact_name: string | null
  industry: string | null
  employee_count: string | null
  hiring_for: string[] | null
  job_post_credits: number
  profile_unlock_credits: number
  created_at: string
  updated_at: string
}

export function ClientCreditsDashboard() {
  const [clients, setClients] = useState<ClientCredit[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editJobCredits, setEditJobCredits] = useState<number>(0)
  const [editUnlockCredits, setEditUnlockCredits] = useState<number>(0)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchClients = useCallback(async (opts?: { force?: boolean }) => {
    setLoading(true)
    try {
      const data = await cachedFetchJson<ClientCredit[]>(
        "internal:clients:credits",
        "/api/clients",
        undefined,
        { ttlMs: 30_000, force: Boolean(opts?.force), swr: true }
      )
      setClients(data || [])
    } catch (e) {
      console.error("Failed to load clients", e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchClients() }, [fetchClients])

  const filteredClients = clients.filter(c => {
    const q = search.toLowerCase()
    return (
      c.name.toLowerCase().includes(q) ||
      c.primary_contact_email?.toLowerCase().includes(q) ||
      c.primary_contact_name?.toLowerCase().includes(q) ||
      c.slug.toLowerCase().includes(q) ||
      c.id.includes(q)
    )
  })

  const handleEditClick = (client: ClientCredit) => {
    setEditingId(client.id)
    setEditJobCredits(client.job_post_credits || 0)
    setEditUnlockCredits(client.profile_unlock_credits || 0)
    setError(null)
  }

  const handleSave = async (client: ClientCredit) => {
    setSavingId(client.id)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_post_credits: editJobCredits,
          profile_unlock_credits: editUnlockCredits,
        }),
      })
      if (!res.ok) throw new Error("Failed to save")
      
      setClients(prev => prev.map(c => 
        c.id === client.id ? { ...c, job_post_credits: editJobCredits, profile_unlock_credits: editUnlockCredits, updated_at: new Date().toISOString() } : c
      ))
      setEditingId(null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSavingId(null)
    }
  }

  const handleCancel = () => {
    setEditingId(null)
    setError(null)
  }

  const getCreditStatus = (credits: number) => {
    if (credits <= 0) return { label: "Empty", className: "bg-red-100 text-red-800" }
    if (credits <= 2) return { label: "Low", className: "bg-yellow-100 text-yellow-800" }
    return { label: "OK", className: "bg-green-100 text-green-800" }
  }

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Client Credit Management</h1>
          <p className="text-muted-foreground">View and edit job post / profile unlock credits for all clients.</p>
        </div>
        <Button onClick={() => fetchClients({ force: true })} disabled={loading}>
          <Loader2 className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="p-4">
          <div className="flex gap-4 items-center">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, email, contact..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <span className="text-sm text-muted-foreground">{filteredClients.length} / {clients.length} clients</span>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 flex items-center gap-3 text-red-800">
          <AlertCircle className="w-5 h-5" />
          <span>{error}</span>
        </div>
      )}

      {/* Clients Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 space-y-4">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-16 animate-pulse bg-muted rounded-lg" />
              ))}
            </div>
          ) : filteredClients.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              No clients found matching "{search}"
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="p-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Client</th>
                    <th className="p-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Contact</th>
                    <th className="p-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Job Post Credits</th>
                    <th className="p-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Profile Unlock Credits</th>
                    <th className="p-4 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClients.map(client => {
                    const isEditing = editingId === client.id
                    const jobStatus = getCreditStatus(client.job_post_credits || 0)
                    const unlockStatus = getCreditStatus(client.profile_unlock_credits || 0)

                    return (
                      <tr key={client.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="p-4">
                          <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-lg shrink-0">
                              {client.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-medium text-foreground">{client.name}</div>
                              <div className="text-xs text-muted-foreground font-mono">{client.slug}</div>
                            </div>
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="space-y-1">
                            {client.primary_contact_email && (
                              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                                <Mail className="w-3 h-3" />
                                <span>{client.primary_contact_email}</span>
                              </div>
                            )}
                            {client.primary_contact_name && (
                              <div className="text-sm text-foreground">{client.primary_contact_name}</div>
                            )}
                            {client.contact_phone && (
                              <div className="text-sm text-muted-foreground">{client.contact_phone}</div>
                            )}
                          </div>
                        </td>
                        <td className="p-4 text-right">
                          {isEditing ? (
                            <Input
                              type="number"
                              value={editJobCredits}
                              onChange={e => setEditJobCredits(Math.max(0, Number(e.target.value)))}
                              className="w-28 text-right font-mono"
                              min={0}
                            />
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-mono font-bold text-lg tabular-nums">{client.job_post_credits || 0}</span>
                              <Badge variant="outline" className={jobStatus.className}>{jobStatus.label}</Badge>
                            </div>
                          )}
                        </td>
                        <td className="p-4 text-right">
                          {isEditing ? (
                            <Input
                              type="number"
                              value={editUnlockCredits}
                              onChange={e => setEditUnlockCredits(Math.max(0, Number(e.target.value)))}
                              className="w-28 text-right font-mono"
                              min={0}
                            />
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-mono font-bold text-lg tabular-nums">{client.profile_unlock_credits || 0}</span>
                              <Badge variant="outline" className={unlockStatus.className}>{unlockStatus.label}</Badge>
                            </div>
                          )}
                        </td>
                        <td className="p-4 text-center">
                          {isEditing ? (
                            <div className="flex items-center justify-center gap-2">
                              <Button size="sm" onClick={() => handleSave(client)} disabled={savingId === client.id}>
                                {savingId === client.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={handleCancel}>
                                <X className="w-4 h-4" />
                              </Button>
                            </div>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => handleEditClick(client)}>
                              <Edit2 className="w-4 h-4 mr-1" /> Edit
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Clients</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{clients.length}</div>
            <p className="text-xs text-muted-foreground">Registered clients</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Job Credits</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{clients.reduce((sum, c) => sum + (c.job_post_credits || 0), 0)}</div>
            <p className="text-xs text-muted-foreground">Across all clients</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Unlock Credits</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{clients.reduce((sum, c) => sum + (c.profile_unlock_credits || 0), 0)}</div>
            <p className="text-xs text-muted-foreground">Across all clients</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Clients Needing Credits</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {clients.filter(c => (c.job_post_credits || 0) <= 2 || (c.profile_unlock_credits || 0) <= 2).length}
            </div>
            <p className="text-xs text-muted-foreground">Low on at least one credit type</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}