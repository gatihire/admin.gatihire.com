"use client"

import { useState, useCallback } from "react"
import { useDropzone } from "react-dropzone"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Upload, FileText, CheckCircle, AlertCircle, AlertTriangle,
  Loader2, X, RefreshCw, Clock
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { invalidateSessionCache } from "@/lib/utils"

const INBOUND_OPTIONS = [
  { value: "portal", label: "GatiHire Portal" },
  { value: "apna", label: "Apna" },
  { value: "naukri", label: "Naukri" },
  { value: "workindia", label: "WorkIndia" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "job_board", label: "Other job board" },
]

const OUTBOUND_OPTIONS = [
  { value: "recruiter_upload", label: "Sourced Profile" },
  { value: "database", label: "Database Match" },
  { value: "linkedin", label: "LinkedIn" },
]

interface UploadFile {
  file: File
  status:
    | "uploading"
    | "processing"
    | "completed"
    | "error"
    | "duplicate"
    | "parsing-failed"
    | "blocked"
    | "created"
    | "updated"
    | "needs-review"
  progress: number
  result?: any
  error?: string
}

// A file whose resume was saved and added to the job, but whose text could not
// be read automatically. It is NOT a failure — the CV is in the pipeline and a
// recruiter can open it — so it counts as uploaded.
const UPLOADED_STATUSES: UploadFile["status"][] = ["completed", "created", "updated", "duplicate", "needs-review"]
const FAILED_STATUSES: UploadFile["status"][] = ["error", "parsing-failed", "blocked"]

function isUploaded(status: UploadFile["status"]) {
  return UPLOADED_STATUSES.includes(status)
}

function isFailed(status: UploadFile["status"]) {
  return FAILED_STATUSES.includes(status)
}

function friendlyUploadError(error: any, status?: number) {
  const msg = String(error?.message || error || "").trim()
  if (/failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(msg)) {
    return "Could not reach the server — the upload was interrupted. Please retry."
  }
  if (!msg && status) return `Upload failed (HTTP ${status}). Please retry.`
  return msg || "Upload failed. Please retry."
}

interface JobUploadDialogProps {
  jobId: string
  jobTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

export function JobUploadDialog({ jobId, jobTitle, open, onOpenChange, onComplete }: JobUploadDialogProps) {
  const [uploadedFiles, setUploadedFiles] = useState<UploadFile[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [origin, setOrigin] = useState<"inbound" | "outbound">("inbound")
  const [source, setSource] = useState("portal")
  const { toast } = useToast()

  const selectOrigin = (o: "inbound" | "outbound") => {
    setOrigin(o)
    setSource(o === "inbound" ? INBOUND_OPTIONS[0].value : OUTBOUND_OPTIONS[0].value)
  }

  const processFile = useCallback(async (file: File, index: number): Promise<UploadFile["status"]> => {
    setUploadedFiles((prev) => prev.map((f, i) => (i === index ? { ...f, status: "processing", progress: 30 } : f)))

    const formData = new FormData()
    formData.append("resume", file)
    formData.append("source", source)
    formData.append("origin", origin)

    const progressInterval = setInterval(() => {
      setUploadedFiles((prev) =>
        prev.map((f, i) => (i === index && f.progress < 90 ? { ...f, progress: f.progress + 10 } : f)),
      )
    }, 500)

    let finalStatus: UploadFile["status"] = "error"

    try {
      const response = await fetch(`/api/jobs/${jobId}/upload-resume`, {
        method: "POST",
        body: formData,
      })

      // A gateway timeout / crash returns HTML or an empty body, not JSON.
      // Calling response.json() on that threw "Unexpected token '<'", which
      // looked like a code bug instead of a failed upload.
      const rawBody = await response.text()
      let result: any = {}
      try {
        result = rawBody ? JSON.parse(rawBody) : {}
      } catch {
        result = { error: `Upload failed (HTTP ${response.status}). The server did not return a readable response.` }
      }

      if (!response.ok) {
        if (result.isDuplicate || result.error === "Resume already exists") {
          finalStatus = "duplicate"
          setUploadedFiles((prev) =>
            prev.map((f, i) => i === index ? { ...f, status: finalStatus, progress: 100, result } : f),
          )
          return finalStatus
        }
        if (result.parsingFailed || result.error === "Resume parsing failed") {
          finalStatus = "parsing-failed"
          setUploadedFiles((prev) =>
            prev.map((f, i) => i === index ? { ...f, status: finalStatus, progress: 0, error: result.details || "Parsing failed" } : f),
          )
          return finalStatus
        }
        if (result.validationFailed || result.resultType === "blocked") {
          finalStatus = "blocked"
          setUploadedFiles((prev) =>
            prev.map((f, i) => i === index ? { ...f, status: finalStatus, progress: 0, error: result.details || result.error || "This file was blocked" } : f),
          )
          return finalStatus
        }
        finalStatus = "error"
        setUploadedFiles((prev) =>
          prev.map((f, i) => i === index ? { ...f, status: finalStatus, progress: 0, error: friendlyUploadError(result.error, response.status) } : f),
        )
        return finalStatus
      }

      // The route reports identity merges as `isDuplicate`; there is no
      // `updatedExisting` key, so the old check always evaluated to false and a
      // merged upload was labelled "created" with the "new candidate" toast.
      const mergedExisting = !!(result.isDuplicate || result.updatedExisting)
      // `needsReview` means the CV is stored and attached to the job but the
      // text could not be read. That is an upload that arrived — not a failure.
      finalStatus = result.needsReview ? "needs-review" : mergedExisting ? "updated" : "created"

      setUploadedFiles((prev) =>
        prev.map((f, i) => i === index ? { ...f, status: finalStatus, progress: 100, result } : f),
      )

      invalidateSessionCache("internal:candidates:", { prefix: true })

      if (finalStatus === "needs-review") {
        toast({ title: "Resume Saved — Needs Review", description: `${file.name} was added to ${jobTitle}. We could not read the text automatically, so it is flagged for review.` })
      } else if (mergedExisting) {
        toast({ title: "Existing Candidate Updated", description: `${file.name} matched an existing profile by phone — refreshed and added to ${jobTitle}` })
      } else {
        toast({ title: "Resume Uploaded", description: `${file.name} parsed and added to the Applied stage of ${jobTitle} for review` })
      }

      return finalStatus
    } catch (error: any) {
      finalStatus = "error"
      setUploadedFiles((prev) =>
        prev.map((f, i) => i === index ? { ...f, status: finalStatus, progress: 0, error: friendlyUploadError(error) } : f),
      )
      return finalStatus
    } finally {
      clearInterval(progressInterval)
    }
  }, [source, origin, jobId, jobTitle, toast])

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) {
      toast({ title: "Invalid Files", description: "Please select valid PDF, DOCX, DOC, or TXT files", variant: "destructive" })
      return
    }

    const newFiles = acceptedFiles.map((file) => ({ file, status: "uploading" as const, progress: 0 }))
    const startIdx = uploadedFiles.length
    setUploadedFiles((prev) => [...prev, ...newFiles])
    setIsProcessing(true)

    let uploaded = 0
    let failed = 0
    for (let i = 0; i < newFiles.length; i++) {
      const status = await processFile(newFiles[i].file, startIdx + i)
      if (isUploaded(status)) uploaded += 1
      else if (isFailed(status)) failed += 1
      if (i < newFiles.length - 1) {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    setIsProcessing(false)

    if (failed > 0) {
      toast({
        title: `${failed} file${failed === 1 ? "" : "s"} not uploaded`,
        description: `${uploaded} of ${newFiles.length} resume${newFiles.length === 1 ? "" : "s"} made it in. Use Retry on the failed file${failed === 1 ? "" : "s"}.`,
        variant: "destructive",
      })
    } else {
      toast({
        title: "Upload Complete",
        description: `${uploaded} of ${newFiles.length} resume${newFiles.length === 1 ? "" : "s"} uploaded.`,
      })
    }
  }, [uploadedFiles.length, toast, processFile])

  // Retry every file that failed, without touching the ones that succeeded.
  const retryFailed = useCallback(async () => {
    const failedIndexes = uploadedFiles
      .map((f, i) => (isFailed(f.status) ? i : -1))
      .filter((i) => i >= 0)
    if (!failedIndexes.length) return

    setIsProcessing(true)
    for (const index of failedIndexes) {
      const file = uploadedFiles[index]?.file
      if (!file) continue
      await processFile(file, index)
      await new Promise((r) => setTimeout(r, 500))
    }
    setIsProcessing(false)
  }, [uploadedFiles, processFile])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/msword": [".doc"],
      "text/plain": [".txt"],
    },
    maxSize: 10 * 1024 * 1024,
    disabled: isProcessing,
  })

  const removeFile = (idx: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  const clearAll = () => {
    setUploadedFiles([])
    onOpenChange(false)
  }

  const statusBadge = (status: string) => {
    switch (status) {
      case "uploading": return <Badge variant="outline" className="bg-blue-50 text-blue-600 border-blue-200 text-[10px] gap-1"><Loader2 className="h-3 w-3 animate-spin" />Uploading</Badge>
      case "processing": return <Badge variant="outline" className="bg-amber-50 text-amber-600 border-amber-200 text-[10px] gap-1"><Clock className="h-3 w-3" />Parsing</Badge>
      case "completed":
      case "created": return <Badge variant="outline" className="bg-green-50 text-green-600 border-green-200 text-[10px] gap-1"><CheckCircle className="h-3 w-3" />Done</Badge>
      case "updated": return <Badge variant="outline" className="bg-indigo-50 text-indigo-600 border-indigo-200 text-[10px] gap-1"><RefreshCw className="h-3 w-3" />Updated</Badge>
      case "duplicate": return <Badge variant="outline" className="bg-orange-50 text-orange-600 border-orange-200 text-[10px] gap-1"><AlertTriangle className="h-3 w-3" />Duplicate</Badge>
      case "needs-review": return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[10px] gap-1"><AlertTriangle className="h-3 w-3" />Needs Review</Badge>
      case "parsing-failed": return <Badge variant="outline" className="bg-red-50 text-red-600 border-red-200 text-[10px] gap-1"><AlertCircle className="h-3 w-3" />Parse Error</Badge>
      case "error": return <Badge variant="outline" className="bg-red-50 text-red-600 border-red-200 text-[10px] gap-1"><AlertCircle className="h-3 w-3" />Error</Badge>
      default: return null
    }
  }

  const uploadedCount = uploadedFiles.filter((f) => isUploaded(f.status)).length
  const failedCount = uploadedFiles.filter((f) => isFailed(f.status)).length
  const allFinished = uploadedFiles.length > 0 && uploadedFiles.every((f) => !["uploading", "processing"].includes(f.status))
  // "Done" is only honest when every file actually made it in. The old check
  // treated "error" and "parse failed" as finished, so HR clicked Done on a
  // dialog that said "0/2 uploaded" and the resumes were never in the pipeline.
  const canFinish = allFinished && failedCount === 0

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!isProcessing) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-[560px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-emerald-500" />
            Upload Resumes to {jobTitle}
          </DialogTitle>
          <DialogDescription>
            PDF, DOCX, DOC, or TXT files up to 10MB each. Resumes are parsed via AI and automatically assigned to this job.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs font-bold text-zinc-600 uppercase tracking-wider">
              How did these candidates come in?
            </Label>

            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                type="button"
                disabled={isProcessing}
                onClick={() => selectOrigin("inbound")}
                className={`rounded-xl border-2 p-3 text-left transition-all ${
                  origin === "inbound"
                    ? "border-blue-500 bg-blue-50/60 ring-2 ring-blue-200"
                    : "border-zinc-200 bg-white hover:border-blue-300"
                } ${isProcessing ? "opacity-60 pointer-events-none" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-black uppercase tracking-widest ${origin === "inbound" ? "text-blue-700" : "text-zinc-500"}`}>
                    Inbound
                  </span>
                  <span className={`h-3 w-3 rounded-full border-2 ${origin === "inbound" ? "bg-blue-500 border-blue-500" : "border-zinc-300"}`} />
                </div>
                <p className="text-[11px] text-zinc-500 mt-1.5 leading-snug">
                  Candidate applied to this job on a site — they already know about the role.
                </p>
              </button>

              <button
                type="button"
                disabled={isProcessing}
                onClick={() => selectOrigin("outbound")}
                className={`rounded-xl border-2 p-3 text-left transition-all ${
                  origin === "outbound"
                    ? "border-violet-500 bg-violet-50/60 ring-2 ring-violet-200"
                    : "border-zinc-200 bg-white hover:border-violet-300"
                } ${isProcessing ? "opacity-60 pointer-events-none" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-black uppercase tracking-widest ${origin === "outbound" ? "text-violet-700" : "text-zinc-500"}`}>
                    Outbound
                  </span>
                  <span className={`h-3 w-3 rounded-full border-2 ${origin === "outbound" ? "bg-violet-500 border-violet-500" : "border-zinc-300"}`} />
                </div>
                <p className="text-[11px] text-zinc-500 mt-1.5 leading-snug">
                  Sourced profile — they don't know about this job; we reach out to check interest.
                </p>
              </button>
            </div>
          </div>

          <div>
            <Label className="text-xs font-bold text-zinc-600 uppercase tracking-wider">
              Source
            </Label>
            <div className="flex items-center gap-3 mt-1.5">
              <div className="flex-1">
                <Select value={source} onValueChange={setSource} disabled={isProcessing}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {(origin === "inbound" ? INBOUND_OPTIONS : OUTBOUND_OPTIONS).map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Badge
                variant="outline"
                className={`shrink-0 gap-1 text-[10px] font-bold px-2 py-1 rounded-full ${
                  origin === "inbound"
                    ? "bg-blue-50 text-blue-700 border-blue-200"
                    : "bg-violet-50 text-violet-700 border-violet-200"
                }`}
              >
                {origin === "inbound" ? "Inbound" : "Outbound"}
              </Badge>
            </div>
            <p className="text-[11px] text-zinc-400 mt-1.5">
              {origin === "inbound"
                ? "Candidate applied via a job posting — AI screening intro will thank them for applying."
                : "Profile sourced/matched by you — AI screening intro will reference your outreach, not an application."}
            </p>
          </div>
        </div>

        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors ${
            isDragActive
              ? "border-emerald-400 bg-emerald-50"
              : "border-zinc-300 hover:border-zinc-400 bg-zinc-50/50"
          } ${isProcessing ? "pointer-events-none opacity-60" : ""}`}
        >
          <input {...getInputProps()} />
          <Upload className="h-10 w-10 mx-auto mb-3 text-zinc-300" />
          <p className="text-sm font-semibold text-zinc-600">
            {isDragActive ? "Drop files here..." : "Drag & drop resumes here, or click to browse"}
          </p>
          <p className="text-xs text-zinc-400 mt-1">Supported: PDF, DOCX, DOC, TXT (max 10MB)</p>
        </div>

        {uploadedFiles.length > 0 && (
          <div className="flex-1 overflow-y-auto min-h-0 space-y-2">
            {uploadedFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-zinc-50 border border-zinc-100">
                <FileText className="h-5 w-5 text-zinc-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-700 truncate">{f.file.name}</p>
                  {f.status === "uploading" || f.status === "processing" ? (
                    <Progress value={f.progress} className="h-1.5 mt-1.5" />
                  ) : f.error ? (
                    <p className="text-xs text-red-500 mt-0.5 truncate">{f.error}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {statusBadge(f.status)}
                  {(f.status === "duplicate" || f.status === "parsing-failed" || f.status === "blocked" || f.status === "error") && !isProcessing && (
                    <button onClick={() => removeFile(i)} className="text-zinc-400 hover:text-zinc-600">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-zinc-100">
          <div className="text-xs text-zinc-400">
            <span className={failedCount > 0 ? "font-semibold text-red-500" : undefined}>
              {uploadedCount}/{uploadedFiles.length} uploaded
            </span>
            {failedCount > 0 ? <span className="text-red-500"> • {failedCount} failed</span> : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={clearAll} disabled={isProcessing}>
              Close
            </Button>
            {failedCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="border-red-200 text-red-600 hover:bg-red-50"
                onClick={retryFailed}
                disabled={isProcessing}
              >
                <RefreshCw className="h-4 w-4 mr-1.5" />
                Retry failed ({failedCount})
              </Button>
            )}
            {canFinish && (
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => { onComplete(); clearAll() }}>
                <CheckCircle className="h-4 w-4 mr-1.5" />
                Done
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
