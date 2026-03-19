"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Building2, MoreHorizontal, Plus, Trash2, Upload } from "lucide-react"
import { cachedFetchJson, invalidateSessionCache } from "@/lib/utils"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Client = {
  id: string
  slug: string
  name: string
  about: string | null
  website: string | null
  company_type: string | null
  company_subtype: string | null
  location: string | null
  logo_url: string | null
  primary_contact_name: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  additional_contacts: any[]
  about_generated_at: string | null
  about_source_url: string | null
  created_at: string
  updated_at: string
}

const COMPANY_TYPES = [
  "Transportation & Fleet",
  "Warehousing & Infrastructure",
  "Freight & Multimodal",
  "E-commerce & Tech",
  "Enterprise & Services",
  "Support & Ancillary Services",
  "Other"
]

const COMPANY_SUBTYPES: Record<string, string[]> = {
  "Transportation & Fleet": ["Car Carrier", "Dry Van", "Reefer", "Flatbed", "Tanker", "LTL", "Intermodal", "Last Mile", "Hazmat"],
  "Warehousing & Infrastructure": ["Fulfillment center", "Cross-dock", "Cold storage", "3PL warehouse", "Yard operations"],
  "Freight & Multimodal": ["Brokerage", "Forwarding", "Rail", "Air", "Ocean"],
  "E-commerce & Tech": ["Marketplace", "SaaS", "Tracking", "TMS vendor", "WMS vendor"],
  "Enterprise & Services": ["Consulting", "Staffing", "BPO", "Managed services"],
  "Support & Ancillary Services": ["Insurance", "Financing", "Training", "Compliance"],
  Other: []
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 50)
}

export function ClientsDashboard() {
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [sourceFilter, setSourceFilter] = useState<string>("all")
  const [clientStats, setClientStats] = useState<Record<string, { truckinzy: number; employee: number; total: number }>>({})

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Client | null>(null)
  const [saving, setSaving] = useState(false)
  const [aboutBusy, setAboutBusy] = useState(false)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string>("")

  const [form, setForm] = useState({
    name: "",
    slug: "",
    about: "",
    website: "",
    company_type: "",
    company_subtype: "",
    location: "",
    primary_contact_name: "",
    primary_contact_email: "",
    primary_contact_phone: "",
    additional_contacts: [] as { name: string; email: string; phone: string }[]
  })

  const fetchClients = async (opts?: { force?: boolean }) => {
    setLoading(true)
    try {
      const data = await cachedFetchJson<any[]>(`internal:clients:/api/clients`, "/api/clients", undefined, {
        ttlMs: 10 * 60_000,
        force: Boolean(opts?.force),
      })
      const rows = Array.isArray(data) ? (data as any[]) : []
      setClients(rows as Client[])

      const ids = rows.map((c: any) => String(c?.id || "").trim()).filter(Boolean)
      if (ids.length) {
        const url = `/api/clients/stats?ids=${encodeURIComponent(ids.join(","))}`
        const stats = await cachedFetchJson<{ byClient: Record<string, { truckinzy: number; employee: number; total: number }> }>(
          `internal:clients:/api/clients/stats:${url}`,
          url,
          undefined,
          { ttlMs: 10 * 60_000, force: Boolean(opts?.force) }
        )
        setClientStats(stats?.byClient || {})
      } else {
        setClientStats({})
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchClients()
  }, [])

  useEffect(() => {
    const editId = searchParams.get("edit")
    const shouldNew = searchParams.get("new")
    if (!clients.length) return
    if (editId) {
      const found = clients.find((c) => c.id === editId) || null
      if (found) {
        openEdit(found)
        router.replace("/clients")
      }
      return
    }
    if (shouldNew) {
      openNew()
      router.replace("/clients")
    }
  }, [clients, router, searchParams])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = clients
    if (q) {
      list = list.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.slug || "").toLowerCase().includes(q))
    }
    if (sourceFilter !== "all") {
      list = list.filter((c) => {
        const stat = clientStats[c.id]
        if (!stat) return false
        if (sourceFilter === "truckinzy") return stat.truckinzy > 0
        if (sourceFilter === "employee") return stat.employee > 0
        return true
      })
    }
    return list
  }, [clients, search, sourceFilter, clientStats])

  const openNew = () => {
    setEditing(null)
    setLogoFile(null)
    setLogoPreviewUrl("")
    setForm({
      name: "",
      slug: "",
      about: "",
      website: "",
      company_type: "",
      company_subtype: "",
      location: "",
      primary_contact_name: "",
      primary_contact_email: "",
      primary_contact_phone: "",
      additional_contacts: []
    })
    setDialogOpen(true)
  }

  const openEdit = (c: Client) => {
    setEditing(c)
    setLogoFile(null)
    setLogoPreviewUrl("")
    setForm({
      name: c.name || "",
      slug: c.slug || "",
      about: c.about || "",
      website: c.website || "",
      company_type: c.company_type || "",
      company_subtype: (c as any).company_subtype || "",
      location: c.location || "",
      primary_contact_name: c.primary_contact_name || "",
      primary_contact_email: c.primary_contact_email || "",
      primary_contact_phone: c.primary_contact_phone || "",
      additional_contacts: Array.isArray((c as any).additional_contacts) ? ((c as any).additional_contacts as any[]) : []
    })
    setDialogOpen(true)
  }

  const generateAbout = async () => {
    if (!form.website.trim()) {
      toast({ title: "Website required", description: "Enter a website first.", variant: "destructive" })
      return
    }
    setAboutBusy(true)
    try {
      const res = await fetch("/api/clients/generate-about", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website: form.website })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to generate")
      setForm((prev) => ({ ...prev, about: data.about || prev.about }))
      toast({ title: "About generated", description: "Review and edit before saving." })
    } catch (e: any) {
      toast({ title: "Generate failed", description: e.message || "Failed", variant: "destructive" })
    } finally {
      setAboutBusy(false)
    }
  }

  const save = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name required", description: "Client name is required.", variant: "destructive" })
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        slug: form.slug ? slugify(form.slug) : slugify(form.name),
        about: form.about || null,
        website: form.website?.trim() || "",
        company_type: form.company_type || null,
        company_subtype: form.company_subtype || null,
        location: form.location || null
      }

      const enriched = {
        ...payload,
        primary_contact_name: form.primary_contact_name.trim() || null,
        primary_contact_email: form.primary_contact_email.trim() || null,
        primary_contact_phone: form.primary_contact_phone || null,
        additional_contacts: form.additional_contacts
      }

      const url = editing ? `/api/clients/${editing.id}` : "/api/clients"
      const method = editing ? "PUT" : "POST"
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(enriched) })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to save client")

      const clientId = String(data?.id || editing?.id || "").trim()
      if (logoFile && clientId) {
        await uploadLogo(clientId, logoFile)
      }

      toast({ title: "Saved", description: editing ? "Client updated." : "Client created." })
      setDialogOpen(false)
      invalidateSessionCache("internal:clients:", { prefix: true })
      await fetchClients({ force: true })
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Failed to save", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!logoFile) {
      setLogoPreviewUrl("")
      return
    }
    const url = URL.createObjectURL(logoFile)
    setLogoPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [logoFile])

  const uploadLogo = async (clientId: string, file: File) => {
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch(`/api/clients/${clientId}/logo`, { method: "POST", body: fd })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to upload logo")
      toast({ title: "Logo updated" })
      invalidateSessionCache("internal:clients:", { prefix: true })
      await fetchClients({ force: true })
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message || "Failed", variant: "destructive" })
    }
  }

  const removeClient = async (clientId: string) => {
    if (!confirm("Delete this client?")) return
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: "DELETE" })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to delete")
      toast({ title: "Deleted" })
      invalidateSessionCache("internal:clients:", { prefix: true })
      await fetchClients({ force: true })
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message || "Failed", variant: "destructive" })
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Clients</h2>
          <p className="text-muted-foreground">Create and manage client profiles used across job posts.</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" />
          New Client
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
        <div className="md:col-span-5">
          <div className="text-xs text-zinc-500 mb-1">Search</div>
          <Input placeholder="Search clients..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full" />
        </div>

        <div className="md:col-span-4">
          <div className="text-xs text-zinc-500 mb-1">Source</div>
          <Tabs value={sourceFilter} onValueChange={setSourceFilter}>
            <TabsList className="w-full justify-start">
              <TabsTrigger value="all" className="flex-1">All</TabsTrigger>
              <TabsTrigger value="truckinzy" className="flex-1">Truckinzy</TabsTrigger>
              <TabsTrigger value="employee" className="flex-1">Employee</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="md:col-span-3">
          <div className="text-xs text-zinc-500 mb-1">&nbsp;</div>
          <Button
            variant="outline"
            className="w-full"
            onClick={async () => {
              invalidateSessionCache("internal:clients:", { prefix: true })
              await fetchClients({ force: true })
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-36 bg-gray-100 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => (
            <Card
              key={c.id}
              className="cursor-pointer border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition"
              onClick={() => router.push(`/clients/${c.id}`)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {c.logo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.logo_url} alt={c.name} className="h-10 w-10 rounded-xl border bg-white object-contain p-1" />
                    ) : (
                      <div className="h-10 w-10 rounded-xl border bg-gray-50 flex items-center justify-center">
                        <Building2 className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <CardTitle className="text-base truncate">{c.name}</CardTitle>
                      <div className="text-xs text-muted-foreground truncate">/{c.slug}</div>
                    </div>
                  </div>
                  <input
                    id={`client-logo-upload-${c.id}`}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      e.stopPropagation()
                      const f = e.currentTarget.files?.[0]
                      e.currentTarget.value = ""
                      if (f) uploadLogo(c.id, f)
                    }}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem onClick={() => openEdit(c)}>Edit</DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          const el = document.getElementById(`client-logo-upload-${c.id}`) as HTMLInputElement | null
                          el?.click()
                        }}
                      >
                        <Upload className="mr-2 h-4 w-4" /> Upload logo
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-red-600 focus:text-red-600"
                        onClick={() => removeClient(c.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm text-muted-foreground max-h-24 overflow-auto pr-1">{c.about || "No about added yet."}</div>
                <div className="flex flex-wrap items-center gap-2">
                  {c.location ? <Badge variant="outline">{c.location}</Badge> : null}
                  {c.company_type ? <Badge variant="secondary">{c.company_type}</Badge> : null}
                  {c.website ? (
                    <Badge variant="outline" className="max-w-full truncate">
                      {String(c.website).replace(/^https?:\/\//, "").replace(/\/$/, "")}
                    </Badge>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
          {filtered.length === 0 ? <div className="col-span-full text-center py-10 text-muted-foreground">No clients yet.</div> : null}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[95vw] sm:max-w-[900px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit client" : "Create client"}</DialogTitle>
            <DialogDescription>These clients appear in job posts and public client pages.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="rounded-xl border bg-white p-4 dark:bg-zinc-900 dark:border-zinc-800">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  {logoPreviewUrl || editing?.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoPreviewUrl || String(editing?.logo_url || "")} alt="Logo" className="h-12 w-12 rounded-xl border bg-white object-cover" />
                  ) : (
                    <div className="h-12 w-12 rounded-xl border bg-gray-50" />
                  )}
                  <div>
                    <div className="text-sm font-semibold">Company logo</div>
                    <div className="text-xs text-muted-foreground">PNG/JPG recommended.</div>
                  </div>
                </div>
                <input
                  id="client-logo-file"
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp,image/svg+xml,image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0] || null
                    e.currentTarget.value = ""
                    setLogoFile(f)
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const el = document.getElementById("client-logo-file") as HTMLInputElement | null
                    el?.click()
                  }}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {editing ? "Upload logo" : "Choose logo"}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Acme Logistics" />
              </div>
              <div className="space-y-2">
                <Label>Slug</Label>
                <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="acme-logistics" />
                <div className="text-xs text-muted-foreground">Auto-generated from name if left empty.</div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Company type</Label>
                <Select value={form.company_type || ""} onValueChange={(v) => setForm({ ...form, company_type: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {COMPANY_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Location</Label>
                <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="City, Country" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Sub category</Label>
              <Input
                value={form.company_subtype}
                onChange={(e) => setForm({ ...form, company_subtype: e.target.value })}
                placeholder="e.g. Car Carrier"
              />
              {form.company_type && (COMPANY_SUBTYPES[form.company_type] || []).length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(COMPANY_SUBTYPES[form.company_type] || []).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="rounded-full border bg-card px-3 py-1 text-xs hover:bg-accent"
                      onClick={() => setForm((prev) => ({ ...prev, company_subtype: s }))}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label>Website (Optional)</Label>
              <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Primary contact name</Label>
                <Input value={form.primary_contact_name} onChange={(e) => setForm({ ...form, primary_contact_name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Primary contact email</Label>
                <Input value={form.primary_contact_email} onChange={(e) => setForm({ ...form, primary_contact_email: e.target.value })} type="email" />
              </div>
              <div className="space-y-2">
                <Label>Primary contact phone</Label>
                <Input value={form.primary_contact_phone} onChange={(e) => setForm({ ...form, primary_contact_phone: e.target.value })} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>About</Label>
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">Candidate-facing summary. Use “Search company” to draft from website.</div>
                <Button type="button" variant="secondary" size="sm" onClick={generateAbout} disabled={aboutBusy}>
                  {aboutBusy ? "Searching..." : "Search company"}
                </Button>
              </div>
              <Textarea value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} className="min-h-[140px]" />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Additional contacts</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      additional_contacts: [...prev.additional_contacts, { name: "", email: "", phone: "" }]
                    }))
                  }
                >
                  Add contact
                </Button>
              </div>
              <div className="grid gap-3">
                {form.additional_contacts.map((c, idx) => (
                  <div key={idx} className="grid grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-4">
                    <Input
                      value={c.name}
                      onChange={(e) => {
                        const next = [...form.additional_contacts]
                        next[idx] = { ...next[idx], name: e.target.value }
                        setForm({ ...form, additional_contacts: next })
                      }}
                      placeholder="Name"
                    />
                    <Input
                      value={c.email}
                      onChange={(e) => {
                        const next = [...form.additional_contacts]
                        next[idx] = { ...next[idx], email: e.target.value }
                        setForm({ ...form, additional_contacts: next })
                      }}
                      placeholder="Email"
                      type="email"
                    />
                    <Input
                      value={c.phone}
                      onChange={(e) => {
                        const next = [...form.additional_contacts]
                        next[idx] = { ...next[idx], phone: e.target.value }
                        setForm({ ...form, additional_contacts: next })
                      }}
                      placeholder="Phone"
                    />
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        const next = form.additional_contacts.filter((_, i) => i !== idx)
                        setForm({ ...form, additional_contacts: next })
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
