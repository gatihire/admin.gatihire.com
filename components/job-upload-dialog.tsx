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
  { value: "job_board", label: "Other job board" },
]

const OUTBOUND_OPTIONS = [
  { value: "recruiter_upload", label: "Sourced Profile" },
  { value: "database", label: "Database Match" },
]

interface UploadFile {
  file: File
  status: "uploading" | "processing" | "completed" | "error" | "duplicate" | "parsing-failed" | "blocked" | "created" | "updated"
  progress: number
  result?: any
  error?: string
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

  const processFile = useCallback(async (file: File, index: number) => {
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

    try {
      const response = await fetch(`/api/jobs/${jobId}/upload-resume`, {
        method: "POST",
        body: formData,
      })

      clearInterval(progressInterval)
      const result = await response.json()

      if (!response.ok) {
        if (result.isDuplicate || result.error === "Resume already exists") {
          setUploadedFiles((prev) =>
            prev.map((f, i) => i === index ? { ...f, status: "duplicate", progress: 100, result } : f),
          )
          return
        }
        if (result.parsingFailed || result.error === "Resume parsing failed") {
          setUploadedFiles((prev) =>
            prev.map((f, i) => i === index ? { ...f, status: "parsing-failed", progress: 0, error: result.details || "Parsing failed" } : f),
          )
          return
        }
        setUploadedFiles((prev) =>
          prev.map((f, i) => i === index ? { ...f, status: "error", progress: 0, error: result.error || "Upload failed" } : f),
        )
        return
      }

      const candidateId = result.candidateId
      const successStatus = result.updatedExisting ? "updated" : "created"

      setUploadedFiles((prev) =>
        prev.map((f, i) => i === index ? { ...f, status: successStatus as UploadFile["status"], progress: 100, result } : f),
      )

      invalidateSessionCache("internal:candidates:", { prefix: true })

      if (!result.updatedExisting) {
        toast({ title: "Resume Uploaded", description: `${file.name} parsed and assigned to ${jobTitle}` })
      } else {
        toast({ title: "Profile Updated", description: `${file.name} updated existing candidate` })
      }
    } catch (error: any) {
      clearInterval(progressInterval)
      setUploadedFiles((prev) =>
        prev.map((f, i) => i === index ? { ...f, status: "error", progress: 0, error: error.message || "Unknown error" } : f),
      )
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

    for (let i = 0; i < newFiles.length; i++) {
      await processFile(newFiles[i].file, startIdx + i)
      if (i < newFiles.length - 1) {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    setIsProcessing(false)
  }, [uploadedFiles.length, toast, processFile])

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
      case "parsing-failed": return <Badge variant="outline" className="bg-red-50 text-red-600 border-red-200 text-[10px] gap-1"><AlertCircle className="h-3 w-3" />Parse Error</Badge>
      case "error": return <Badge variant="outline" className="bg-red-50 text-red-600 border-red-200 text-[10px] gap-1"><AlertCircle className="h-3 w-3" />Error</Badge>
      default: return null
    }
  }

  const allCompleted = uploadedFiles.length > 0 && uploadedFiles.every((f) =>
    ["completed", "created", "updated", "duplicate", "parsing-failed", "error"].includes(f.status)
  )

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
                  {(f.status === "duplicate" || f.status === "parsing-failed" || f.status === "error") && !isProcessing && (
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
            {uploadedFiles.filter((f) => f.status === "created" || f.status === "updated" || f.status === "completed").length}/{uploadedFiles.length} uploaded
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={clearAll} disabled={isProcessing}>
              Close
            </Button>
            {allCompleted && (
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
