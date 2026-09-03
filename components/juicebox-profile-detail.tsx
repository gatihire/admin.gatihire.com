"use client"

import { useEffect, useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Loader2, Mail, Phone, Linkedin, MapPin, Briefcase, Download
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"

interface ProfileDetail {
  profile: any
  experience: any[]
  education: any[]
  contacts: any[]
}

interface JuiceboxProfileDetailProps {
  jobId: string
  profileId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-600 border-zinc-200",
  enriching: "bg-amber-50 text-amber-600 border-amber-200",
  enriched: "bg-emerald-50 text-emerald-600 border-emerald-200",
  failed: "bg-red-50 text-red-600 border-red-200",
}

function experienceYears(months: number | null): string {
  if (months == null) return "—"
  const years = months / 12
  return years >= 1 ? `${years.toFixed(1)} yrs` : `${months} mo`
}

function formatDate(value: string): string {
  if (!value) return ""
  const m = /(\d{4})(?:-(\d{1,2}))?/.exec(value)
  if (!m) return value
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return m[2] ? `${months[Number(m[2]) - 1]} ${m[1]}` : m[1]
}

export function JuiceboxProfileDetail({ jobId, profileId, open, onOpenChange }: JuiceboxProfileDetailProps) {
  const [data, setData] = useState<ProfileDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    if (!open || !profileId) return
    setLoading(true)
    setData(null)
    fetch(`/api/jobs/${jobId}/juicebox/${profileId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load"))))
      .then(setData)
      .catch(() => toast({ title: "Failed to load profile", variant: "destructive" }))
      .finally(() => setLoading(false))
  }, [open, profileId, jobId, toast])

  const downloadResume = async () => {
    if (!profileId) return
    setDownloading(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/juicebox/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error || "Download failed")
      }
      const blob = await res.blob()
      const disposition = res.headers.get("Content-Disposition") || ""
      const match = /filename="([^"]+)"/.exec(disposition)
      const filename = match?.[1] || "resume.html"
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: "Resume downloaded", description: "Print to PDF from the browser to save as PDF." })
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" })
    } finally {
      setDownloading(false)
    }
  }

  const p = data?.profile
  const contact = data?.contacts?.[0]

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onOpenChange(false); setData(null) } else onOpenChange(o) }}>
      <DialogContent className="sm:max-w-[680px] max-h-[88vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-3 pr-8">
            <span className="flex items-center gap-2 text-lg">{p ? p.full_name : "Profile"}</span>
            {p && (
              <Badge variant="outline" className={STATUS_STYLES[p.enrichment_status] || STATUS_STYLES.pending}>
                {(p.enrichment_status || "pending").toUpperCase()}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-zinc-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : !p ? (
          <div className="py-16 text-center text-sm text-zinc-400">No profile data</div>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0 space-y-5 pr-1">
            <div className="space-y-1.5">
              <div className="text-sm text-zinc-700 font-medium">
                {[p.job_title, p.job_company_name].filter(Boolean).join(" · ") || "—"}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                {p.location_name && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{p.location_name}</span>}
                {p.total_experience_months != null && (
                  <span className="inline-flex items-center gap-1"><Briefcase className="h-3 w-3" />{experienceYears(p.total_experience_months)}</span>
                )}
                {p.linkedin_url && (
                  <a href={`https://${p.linkedin_url.replace(/^https?:\/\//, "")}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                    <Linkedin className="h-3 w-3" />LinkedIn
                  </a>
                )}
              </div>
            </div>

            {(contact?.phone || contact?.work_email || contact?.personal_email) && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 space-y-1.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Enriched Contact · {contact.provider || "thepeakai"}</div>
                {contact.phone && <div className="flex items-center gap-2 text-sm text-zinc-800"><Phone className="h-4 w-4 text-emerald-600" />{contact.phone}</div>}
                {(contact.work_email || contact.personal_email) && (
                  <div className="flex items-center gap-2 text-sm text-zinc-800"><Mail className="h-4 w-4 text-emerald-600" />{contact.personal_email || contact.work_email}</div>
                )}
                {contact.fetched_at && <div className="text-[11px] text-zinc-400">Fetched {new Date(contact.fetched_at).toLocaleString()}</div>}
              </div>
            )}

            {p.summary && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Summary</div>
                <p className="text-[13px] text-zinc-700 whitespace-pre-wrap leading-relaxed">{p.summary}</p>
              </div>
            )}

            {data?.experience?.length ? (
              <div className="space-y-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Experience</div>
                <div className="space-y-3">
                  {data.experience.map((e, i) => (
                    <div key={i} className="rounded-xl border border-zinc-200 p-3">
                      <div className="flex items-baseline justify-between gap-2 flex-wrap">
                        <div className="text-sm font-semibold text-zinc-800">{e.title || "—"}</div>
                        <div className="text-xs text-zinc-500">
                          {[formatDate(e.start_date), e.end_date ? formatDate(e.end_date) : "Present"].filter(Boolean).join(" — ")}
                          {e.duration_months ? ` (${e.duration_months} mo)` : ""}
                        </div>
                      </div>
                      <div className="text-xs text-zinc-500">{[e.company, e.location].filter(Boolean).join(" · ")}</div>
                      {e.summary && <p className="text-xs text-zinc-600 mt-1.5 whitespace-pre-wrap line-clamp-3">{e.summary}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {data?.education?.length ? (
              <div className="space-y-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Education</div>
                <div className="space-y-2">
                  {data.education.map((e, i) => (
                    <div key={i} className="rounded-xl border border-zinc-200 p-3">
                      <div className="text-sm font-semibold text-zinc-800">{e.school || "—"}</div>
                      <div className="text-xs text-zinc-500">
                        {[e.degree, e.field].filter(Boolean).join(" — ")}
                        {[e.start_year, e.end_year].filter(Boolean).length ? ` (${[e.start_year, e.end_year].filter(Boolean).join("–")})` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {p.ai_skills?.length ? (
              <div className="space-y-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Skills</div>
                <div className="flex flex-wrap gap-1.5">
                  {p.ai_skills.map((s: string, i: number) => (
                    <span key={i} className="rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-0.5 text-[11px]">{s}</span>
                  ))}
                </div>
              </div>
            ) : null}

            {p.languages?.length ? (
              <div className="space-y-1.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Languages</div>
                <div className="text-xs text-zinc-600">{p.languages.join(", ")}</div>
              </div>
            ) : null}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-100">
          <Button variant="outline" size="sm" onClick={() => { onOpenChange(false); setData(null) }}>
            Close
          </Button>
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={downloadResume} disabled={downloading || !profileId}>
            {downloading ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Download className="h-4 w-4 mr-1.5" />}
            Download resume
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
