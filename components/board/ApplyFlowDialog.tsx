"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/components/ui/use-toast"
import { Loader2, Chrome, Upload, ExternalLink, CheckCircle2 } from "lucide-react"
import { trackEvent } from "@/lib/analytics-client"

export type BoardJobLite = {
  id: string
  title: string
  client_name?: string | null
  company_logo_url?: string | null
  apply_type?: string | null
  external_apply_url?: string | null
}

type CandidateLite = {
  id: string
  name: string
  email: string
  file_url?: string | null
  file_name?: string | null
}

type Props = {
  job: BoardJobLite | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCandidateUpdated?: (candidate: CandidateLite) => void
}

type Intent =
  | { type: "apply"; jobId: string }
  | { type: "external"; jobId: string; redirectUrl: string }

const INTENT_KEY = "gatihire_candidate_intent"

function setIntent(intent: Intent) {
  try {
    localStorage.setItem(INTENT_KEY, JSON.stringify(intent))
  } catch {}
}

function clearIntent() {
  try {
    localStorage.removeItem(INTENT_KEY)
  } catch {}
}

async function getAccessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token || null
}

async function fetchCandidate() {
  const token = await getAccessToken()
  if (!token) return null
  const res = await fetch("/api/candidate/me", { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) return null
  return (await res.json()) as CandidateLite
}

function formatCompany(job: BoardJobLite) {
  const name = String(job.client_name || "").trim()
  return name || "Company"
}

export function ApplyFlowDialog({ job, open, onOpenChange, onCandidateUpdated }: Props) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [isAuthed, setIsAuthed] = useState(false)
  const [consent, setConsent] = useState(false)
  const [candidate, setCandidate] = useState<CandidateLite | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [done, setDone] = useState(false)
  const applyStartedTracked = useRef(false)

  const isExternal = useMemo(() => String(job?.apply_type || "in_platform") === "external", [job])
  const externalUrl = useMemo(() => String(job?.external_apply_url || "").trim(), [job])

  const unlockScroll = useCallback(() => {
    if (typeof document === "undefined") return
    const body = document.body
    const html = document.documentElement
    body.style.overflow = ""
    body.style.paddingRight = ""
    body.style.pointerEvents = ""
    body.removeAttribute("data-scroll-locked")
    html.style.overflow = ""
    html.style.paddingRight = ""
    html.removeAttribute("data-scroll-locked")
  }, [])

  const scheduleUnlockScroll = useCallback(() => {
    const delays = [0, 50, 200, 500]
    const timers = delays.map((ms) => window.setTimeout(unlockScroll, ms))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [unlockScroll])

  useEffect(() => {
    let unsub: any = null
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      setIsAuthed(!!data.session)
      setSessionReady(true)
    })()

    const sub = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAuthed(!!session)
    })
    unsub = sub.data.subscription

    return () => {
      try {
        unsub?.unsubscribe?.()
      } catch {}
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setConsent(false)
      setFile(null)
      setDone(false)
      setLoading(false)
      applyStartedTracked.current = false
      return scheduleUnlockScroll()
    }

    if (job?.id) {
      trackEvent({ event_name: "board.apply.dialog_opened", entity_type: "jobs", entity_id: job.id, metadata: { job_id: job.id } })
    }

    if (job?.id && !applyStartedTracked.current) {
      applyStartedTracked.current = true
      ;(async () => {
        const token = await getAccessToken()
        await trackEvent({
          event_name: "board.apply.started",
          entity_type: "jobs",
          entity_id: job.id,
          metadata: { job_id: job.id, apply_type: isExternal ? "external" : "in_platform" },
          access_token: token,
        })
      })()
    }

    if (!sessionReady) return
    if (!isAuthed) {
      setCandidate(null)
      return
    }

    setLoading(true)
    fetchCandidate()
      .then((c) => {
        setCandidate(c)
        if (c && onCandidateUpdated) onCandidateUpdated(c)
      })
      .finally(() => setLoading(false))
  }, [open, isAuthed, sessionReady, onCandidateUpdated, job, isExternal, scheduleUnlockScroll])

  useEffect(() => {
    return () => {
      unlockScroll()
    }
  }, [unlockScroll])

  const startGoogle = async () => {
    if (!job) return
    if (!consent) {
      toast({ title: "Confirm to continue", description: "Tick the checkbox to proceed.", variant: "destructive" })
      return
    }
    trackEvent({ event_name: "board.signup.oauth_clicked", entity_type: "jobs", entity_id: job.id, metadata: { job_id: job.id, provider: "google" } })
    const redirectTo = `${window.location.origin}/board`
    if (isExternal && externalUrl) {
      setIntent({ type: "external", jobId: job.id, redirectUrl: externalUrl })
    } else {
      setIntent({ type: "apply", jobId: job.id })
    }
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } })
  }

  const submitApplication = async (opts: { useExisting: boolean }) => {
    if (!job) return
    setLoading(true)
    try {
      const token = await getAccessToken()
      if (!token) throw new Error("Not signed in")

      trackEvent({ event_name: "board.apply.submit_clicked", entity_type: "jobs", entity_id: job.id, metadata: { job_id: job.id, use_existing_resume: opts.useExisting }, access_token: token })

      if (!opts.useExisting) {
        if (!file) throw new Error("Please choose a resume")
        const fd = new FormData()
        fd.append("resume", file)
        const up = await fetch("/api/candidate/resume", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: fd,
        })
        const upData = await up.json().catch(() => null)
        if (!up.ok) throw new Error(upData?.error || "Resume upload failed")
        const nextCandidate = upData?.candidate as CandidateLite | undefined
        if (nextCandidate) {
          setCandidate(nextCandidate)
          if (onCandidateUpdated) onCandidateUpdated(nextCandidate)
        }
      }

      const res = await fetch("/api/candidate/apply", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId: job.id }),
      })
      if (res.status === 409) {
        toast({ title: "Already applied", description: "You have already applied for this job." })
        setDone(true)
        clearIntent()
        return
      }
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to apply")

      setDone(true)
      clearIntent()
      toast({ title: "Applied", description: "Your application was submitted." })
    } catch (e: any) {
      toast({ title: "Could not apply", description: e?.message || "Try again", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  const continueExternal = async () => {
    if (!job) return
    if (!externalUrl) {
      toast({ title: "Missing link", description: "This job has no external apply URL.", variant: "destructive" })
      return
    }
    setLoading(true)
    try {
      const token = await getAccessToken()
      if (!token) throw new Error("Not signed in")

      trackEvent({ event_name: "board.external_apply.clicked", entity_type: "jobs", entity_id: job.id, metadata: { job_id: job.id }, access_token: token })
      await fetch("/api/candidate/external-apply", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId: job.id, redirectUrl: externalUrl, referrer: document.referrer || null }),
      })
      clearIntent()
      window.open(externalUrl, "_blank", "noopener,noreferrer")
      onOpenChange(false)
    } catch (e: any) {
      toast({ title: "Could not redirect", description: e?.message || "Try again", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  if (!job) return null

  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen)
    if (!newOpen) scheduleUnlockScroll()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="leading-tight">
            {isExternal ? "Apply on company site" : done ? "Application submitted" : "Upload your CV to apply"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-3">
          {job.company_logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={String(job.company_logo_url)} alt="Logo" className="h-10 w-10 rounded-md border bg-white object-contain p-1" />
          ) : (
            <div className="h-10 w-10 rounded-md border bg-muted" />
          )}
          <div className="min-w-0">
            <div className="font-semibold truncate">{job.title}</div>
            <div className="text-sm text-muted-foreground truncate">{formatCompany(job)}</div>
          </div>
        </div>

        <Separator />

        {!sessionReady ? (
          <div className="py-8 flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : !isAuthed ? (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              Sign in to create your profile and apply faster next time.
            </div>
            <label className="flex items-start gap-3 rounded-lg border p-3">
              <Checkbox checked={consent} onCheckedChange={(v) => setConsent(Boolean(v))} />
              <div className="text-sm">
                <div className="font-medium text-foreground">Create my profile with GatiHire</div>
                <div className="text-muted-foreground">
                  By continuing, you agree we can save your resume and preferences for future applications.
                </div>
              </div>
            </label>
            <Button className="w-full" onClick={startGoogle} disabled={loading || !consent}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Chrome className="mr-2 h-4 w-4" />}
              Continue with Google
            </Button>
          </div>
        ) : done ? (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-lg border bg-green-50 px-4 py-3 text-green-800">
              <CheckCircle2 className="h-5 w-5" />
              Application submitted
            </div>
            <Button className="w-full" onClick={() => onOpenChange(false)}>
              Back to jobs
            </Button>
          </div>
        ) : isExternal ? (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              You’ll be redirected to the company’s official job page to complete your application.
            </div>
            <Button className="w-full" onClick={continueExternal} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
              Continue to company site
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {loading ? (
              <div className="py-6 flex items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading profile…
              </div>
            ) : null}
            {candidate?.file_url ? (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <div className="font-medium">Resume on file</div>
                <div className="text-muted-foreground truncate">{candidate.file_name || "Resume"}</div>
              </div>
            ) : (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                Upload your resume once to apply in a few taps next time.
              </div>
            )}

            {candidate?.file_url ? (
              <div className="grid gap-2">
                <Button className="w-full" onClick={() => submitApplication({ useExisting: true })} disabled={loading}>
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Apply with saved resume
                </Button>
                <div className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium">Replace resume</div>
                    <div className="text-xs text-muted-foreground">PDF/DOCX, max 10MB</div>
                  </div>
                  <div className="mt-3">
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,.txt"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                      className="block w-full text-sm"
                    />
                  </div>
                  <Button
                    variant="outline"
                    className="mt-3 w-full"
                    onClick={() => submitApplication({ useExisting: false })}
                    disabled={loading || !file}
                  >
                    {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                    Upload & Apply
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">Resume / CV</div>
                  <div className="text-xs text-muted-foreground">PDF/DOCX, max 10MB</div>
                </div>
                <div className="mt-3">
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.txt"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                    className="block w-full text-sm"
                  />
                </div>
                <Button className="mt-4 w-full" onClick={() => submitApplication({ useExisting: false })} disabled={loading || !file}>
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  Upload & Apply
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function readCandidateIntent(): Intent | null {
  try {
    const raw = localStorage.getItem(INTENT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && parsed.type === "apply" && typeof parsed.jobId === "string") return parsed
    if (parsed && parsed.type === "external" && typeof parsed.jobId === "string" && typeof parsed.redirectUrl === "string") return parsed
    return null
  } catch {
    return null
  }
}

export function clearCandidateIntent() {
  clearIntent()
}
