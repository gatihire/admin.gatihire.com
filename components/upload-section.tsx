"use client"

import { useState, useCallback } from "react"
import { useDropzone } from "react-dropzone"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import {
  Upload,
  FileText,
  CheckCircle,
  AlertCircle,
  X,
  Loader2,
  Eye,
  Download,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Clock,
  FileCheck,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { logger } from "@/lib/logger"
import { invalidateSessionCache } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"

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

interface UploadedFile {
  file: File
  status: "uploading" | "processing" | "completed" | "error" | "duplicate" | "parsing-failed" | "blocked" | "created" | "updated"
  progress: number
  result?: any
  error?: string
  blockedInfo?: {
    category?: string
    details?: string
    suggestions?: string[]
    docType?: string
    confidence?: number
  }
  failureInfo?: {
    httpStatus?: number
    error?: string
    details?: string
    supabaseError?: {
      code?: string
      message?: string
      details?: any
      hint?: any
    }
  }
  duplicateInfo?: {
    existingName: string
    existingId: string
    uploadedAt: string
    reason?: string
  }
  parsingError?: {
    details: string
    fileName: string
    fileType: string
    fileSize: number
    suggestions: string[]
    timestamp: string
  }
}

export function UploadSection({ jobId }: { jobId?: string }) {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [selectedPreview, setSelectedPreview] = useState<any>(null)
  const [origin, setOrigin] = useState<"inbound" | "outbound">("inbound")
  const [source, setSource] = useState("portal")
  const { toast } = useToast()

  const selectOrigin = (o: "inbound" | "outbound") => {
    setOrigin(o)
    setSource(o === "inbound" ? INBOUND_OPTIONS[0].value : OUTBOUND_OPTIONS[0].value)
  }

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      logger.info("Files dropped:", acceptedFiles.length)

      if (acceptedFiles.length === 0) {
        toast({
          title: "Invalid Files",
          description: "Please select valid PDF, DOCX, DOC, or TXT files",
          variant: "destructive",
        })
        return
      }

      const newFiles = acceptedFiles.map((file) => ({
        file,
        status: "uploading" as const,
        progress: 0,
      }))

      setUploadedFiles((prev) => [...prev, ...newFiles])
      setIsProcessing(true)

      // Process files sequentially to avoid overwhelming the API.
      //
      // Count from the return value of each upload, not from `uploadedFiles`:
      // that state is captured before any of these uploads finish, so the old
      // summary always reported the *previous* batch (typically "0 new, 0
      // duplicates") even when every file had just been uploaded.
      let created = 0
      let updated = 0
      let duplicates = 0
      let failed = 0
      for (let i = 0; i < newFiles.length; i++) {
        const fileIndex = uploadedFiles.length + i
        const status = await processFile(newFiles[i].file, fileIndex)

        if (status === "created" || status === "completed") created += 1
        else if (status === "updated") updated += 1
        else if (status === "duplicate") duplicates += 1
        else failed += 1

        // Small delay between files
        if (i < newFiles.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }

      setIsProcessing(false)

      const uploadedCount = created + updated + duplicates
      if (failed > 0) {
        toast({
          title: `${failed} file${failed === 1 ? "" : "s"} not uploaded`,
          description: `${uploadedCount} of ${newFiles.length} resume${newFiles.length === 1 ? "" : "s"} made it in (${created} new, ${updated} updated, ${duplicates} duplicate${duplicates === 1 ? "" : "s"}). Retry the failed file${failed === 1 ? "" : "s"} from the list below.`,
          variant: "destructive",
        })
      } else {
        toast({
          title: "Upload Complete",
          description: `${newFiles.length} file${newFiles.length === 1 ? "" : "s"} processed — ${created} new, ${updated} updated, ${duplicates} duplicate${duplicates === 1 ? "" : "s"}.`,
        })
      }
    },
    [uploadedFiles.length, toast],
  )

  const processFile = async (file: File, index: number): Promise<UploadedFile["status"]> => {
    logger.info(`Processing file ${index}: ${file.name}`)

    // Maps returned from processFile; declared outside try/catch so it's
    // accessible in both the success path and the catch block.
    let successStatus: UploadedFile["status"] = "error"

    try {
      // Update status to processing
      setUploadedFiles((prev) => prev.map((f, i) => (i === index ? { ...f, status: "processing", progress: 30 } : f)))

      const formData = new FormData()
      formData.append("resume", file)
      formData.append("source", source)
      formData.append("origin", origin)
      if (jobId) formData.append("jobId", jobId)

      logger.info(`Uploading file: ${file.name}, size: ${file.size}, type: ${file.type}`)

      // Simulate upload progress
      const progressInterval = setInterval(() => {
        setUploadedFiles((prev) =>
          prev.map((f, i) => (i === index && f.progress < 90 ? { ...f, progress: f.progress + 10 } : f)),
        )
      }, 500)

      let response: Response
      try {
        response = await fetch("/api/upload-resume", {
          method: "POST",
          body: formData,
        })
      } finally {
        clearInterval(progressInterval)
      }

      logger.info(`Upload response status: ${response.status}`)

      // A gateway timeout / crash returns HTML or an empty body. `response.json()`
      // threw "Unexpected token '<'" and the UI showed a code error instead of a
      // failed upload.
      const rawBody = await response.text()
      let result: any = {}
      try {
        result = rawBody ? JSON.parse(rawBody) : {}
      } catch {
        result = { error: `Upload failed (HTTP ${response.status}). The server did not return a readable response.` }
      }
      logger.info("Upload result:", result)

      if (!response.ok) {
        // Check if it's a duplicate error
        if (result.isDuplicate || result.error === "Resume already exists") {
          setUploadedFiles((prev) =>
            prev.map((f, i) =>
              i === index
                ? {
                    ...f,
                    status: "duplicate",
                    progress: 100,
                    duplicateInfo: result.duplicateInfo || {
                      existingName: "Unknown",
                      existingId: "Unknown",
                      uploadedAt: new Date().toISOString(),
                      reason: result.error || "Duplicate detected"
                    },
                  }
                : f,
            ),
          )
          return "duplicate"
        }
        
        // Check if it's a parsing failure
        if (result.parsingFailed || result.error === "Resume parsing failed") {
          setUploadedFiles((prev) =>
            prev.map((f, i) =>
              i === index
                ? {
                    ...f,
                    status: "parsing-failed",
                    progress: 0,
                    parsingError: {
                      details: result.details || "Unknown parsing error",
                      fileName: result.fileName || file.name,
                      fileType: result.fileType || file.type,
                      fileSize: result.fileSize || file.size,
                      suggestions: result.suggestions || [],
                      timestamp: result.timestamp || new Date().toISOString()
                    },
                  }
                : f,
            ),
          )
          
          toast({
            title: "❌ Parsing Failed",
            description: `Failed to parse ${file.name}. Check the error details below.`,
            variant: "destructive",
          })
          return "parsing-failed"
        }
        
        // Validation failure (blocked)
        if (result.validationFailed || result.resultType === "blocked") {
          setUploadedFiles((prev) =>
            prev.map((f, i) =>
              i === index
                ? {
                    ...f,
                    status: "blocked" as UploadedFile["status"],
                    progress: 0,
                    error: result.error || "Invalid or incomplete profile",
                    blockedInfo: {
                      category: result.blockedCategory || "blocked",
                      details: result.details || result.error || "Blocked",
                      suggestions: result.suggestions || [],
                      docType: result.docType,
                      confidence: result.confidence,
                    },
                  }
                : f,
            ),
          )
          toast({
            title: "Upload Blocked",
            description: result.details || result.error || "This file was blocked",
            variant: "destructive",
          })
          return "blocked"
        }
        
        const message = result.error || "Upload failed"
        setUploadedFiles((prev) =>
          prev.map((f, i) =>
            i === index
              ? {
                  ...f,
                  status: "error",
                  progress: 0,
                  error: message,
                  failureInfo: {
                    httpStatus: response.status,
                    error: result.error,
                    details: result.details,
                    supabaseError: result.supabaseError,
                  },
                }
              : f,
          ),
        )
        // The status is already set above; return instead of throwing so the
        // caller does not show a second, duplicate "Upload Failed" toast.
        return "error"
      }

      // Map success to created/updated based on API flags
      const successStatus =
        result.updatedExisting === true
          ? "updated"
          : result.resultType === "created"
          ? "created"
          : result.resultType === "duplicate"
          ? "duplicate"
          : "completed"
      
      setUploadedFiles((prev) =>
        prev.map((f, i) => (i === index ? { ...f, status: successStatus as UploadedFile["status"], progress: 100, result } : f)),
      )

      logger.info(`✅ Successfully processed: ${file.name}`)

      toast({
        title: result.updatedExisting ? "Updated Existing Profile" : "New Profile Created",
        description: `${file.name} ${result.updatedExisting ? "updated existing candidate" : "created new candidate"}`,
      })

      if (successStatus === "created" || successStatus === "updated" || successStatus === "completed") {
        invalidateSessionCache("internal:candidates:", { prefix: true })
        invalidateSessionCache("internal:smartSearch:", { prefix: true })
        invalidateSessionCache("internal:analytics:", { prefix: true })
      }
    } catch (error) {
      logger.error(`❌ Error processing ${file.name}:`, error)

      // Update status to error
      setUploadedFiles((prev) =>
        prev.map((f, i) =>
          i === index
            ? {
                ...f,
                status: "error",
                progress: 0,
                error: error instanceof Error ? error.message : "Unknown error",
              }
            : f,
        ),
      )

      toast({
        title: "Upload Failed",
        description: `Failed to process ${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`,
        variant: "destructive",
      })
      return "error"
    }
    return successStatus
  }

  const removeFile = (index: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const clearAll = () => {
    setUploadedFiles([])
  }

  const retryFile = async (index: number) => {
    const file = uploadedFiles[index]
    if (file) {
      setUploadedFiles((prev) =>
        prev.map((f, i) => (i === index ? { 
          ...f, 
          status: "uploading", 
          progress: 0, 
          error: undefined,
          parsingError: undefined 
        } : f)),
      )
      await processFile(file.file, index)
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "uploading":
        return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
      case "processing":
        return <Sparkles className="h-4 w-4 animate-pulse text-purple-600" />
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-600" />
      case "created":
        return <CheckCircle className="h-4 w-4 text-green-600" />
      case "updated":
        return <RefreshCw className="h-4 w-4 text-indigo-600" />
      case "duplicate":
        return <FileCheck className="h-4 w-4 text-orange-600" />
      case "parsing-failed":
        return <AlertCircle className="h-4 w-4 text-red-600" />
      case "blocked":
        return <AlertTriangle className="h-4 w-4 text-red-600" />
      case "error":
        return <AlertCircle className="h-4 w-4 text-red-600" />
      default:
        return <FileText className="h-4 w-4 text-gray-400" />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "uploading":
        return "border-blue-200 bg-blue-50"
      case "processing":
        return "border-purple-200 bg-purple-50"
      case "completed":
        return "border-green-200 bg-green-50"
      case "created":
        return "border-green-200 bg-green-50"
      case "updated":
        return "border-indigo-200 bg-indigo-50"
      case "duplicate":
        return "border-orange-200 bg-orange-50"
      case "parsing-failed":
        return "border-red-200 bg-red-50"
      case "blocked":
        return "border-red-200 bg-red-50"
      case "error":
        return "border-red-200 bg-red-50"
      default:
        return "border-gray-200 bg-white"
    }
  }

  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/msword": [".doc"],
      "text/plain": [".txt"],
    },
    multiple: true,
    maxSize: 10 * 1024 * 1024, // 10MB
    disabled: isProcessing,
  })

  return (
    <div className="space-y-6">
      {/* Origin & Source Selection */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <Label className="text-xs font-semibold text-zinc-600 mb-1.5 block">Candidate Origin</Label>
          <div className="flex gap-1.5">
            <button
              onClick={() => selectOrigin("inbound")}
              className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold uppercase tracking-wider border-2 transition-all ${
                origin === "inbound"
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-zinc-200 bg-white text-zinc-400 hover:border-zinc-300"
              }`}
            >
              <span className={`h-2 w-2 rounded-full inline-block mr-1.5 ${origin === "inbound" ? "bg-blue-500" : "border-2 border-zinc-300"}`} />
              Inbound
            </button>
            <button
              onClick={() => selectOrigin("outbound")}
              className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold uppercase tracking-wider border-2 transition-all ${
                origin === "outbound"
                  ? "border-violet-500 bg-violet-50 text-violet-700"
                  : "border-zinc-200 bg-white text-zinc-400 hover:border-zinc-300"
              }`}
            >
              <span className={`h-2 w-2 rounded-full inline-block mr-1.5 ${origin === "outbound" ? "bg-violet-500" : "border-2 border-zinc-300"}`} />
              Outbound
            </button>
          </div>
        </div>
        <div className="flex-1">
          <Label className="text-xs font-semibold text-zinc-600 mb-1.5 block">Source</Label>
          <Select value={source} onValueChange={setSource} disabled={isProcessing}>
            <SelectTrigger className="h-10 text-sm bg-white">
              <SelectValue placeholder="Select source" />
            </SelectTrigger>
            <SelectContent>
              {(origin === "inbound" ? INBOUND_OPTIONS : OUTBOUND_OPTIONS).map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs text-zinc-400 -mt-4">
        {origin === "inbound"
          ? "Candidate applied to this job — they initiated contact."
          : "Profile sourced/matched by you — AI screening intro will reference your outreach."}
      </p>
      {/* Enhanced Upload Area */}
      <div
        {...getRootProps()}
        className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-300 ${
          isDragActive
            ? "border-blue-500 bg-blue-50 scale-105 shadow-lg"
            : isProcessing
              ? "border-gray-200 bg-gray-50 cursor-not-allowed"
              : "border-gray-300 hover:border-blue-400 hover:bg-blue-50/50 hover:shadow-md"
        }`}
      >
        <input {...getInputProps()} />

        <div className="flex flex-col items-center space-y-4">
          {isProcessing ? (
            <div className="relative">
              <Loader2 className="h-16 w-16 text-blue-600 animate-spin" />
              <Sparkles className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 h-6 w-6 text-purple-600 animate-pulse" />
            </div>
          ) : (
            <div className="relative">
              <Upload className="h-16 w-16 text-gray-400" />
              {isDragActive && <div className="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-25" />}
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-xl font-semibold text-gray-900">
              {isDragActive ? "Drop the files here..." : isProcessing ? "Processing files..." : "Upload Resume Files"}
            </h3>
            <p className="text-gray-600">Drag & drop or click to select files</p>
            <div className="flex items-center justify-center space-x-4 text-sm text-gray-500">
              <span className="flex items-center">
                <FileText className="h-4 w-4 mr-1" />
                PDF, DOCX, DOC, TXT
              </span>
              <span>•</span>
              <span>Max 10MB each</span>
              <span>•</span>
              <span>Multiple files supported</span>
            </div>
          </div>

          {!isProcessing && (
            <Button variant="outline" className="mt-4 bg-transparent">
              <Upload className="h-4 w-4 mr-2" />
              Select Files
            </Button>
          )}
        </div>

        {/* Processing indicator */}
        {isProcessing && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2">
            <div className="flex items-center space-x-2 text-sm text-blue-600">
              <Clock className="h-4 w-4" />
              <span>AI is analyzing your resumes...</span>
            </div>
          </div>
        )}
      </div>

      {/* File Rejections */}
      {fileRejections.length > 0 && (
        <Alert variant="destructive" className="border-red-200 bg-red-50">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Some files were rejected:</strong>
            <ul className="mt-2 list-disc list-inside space-y-1">
              {fileRejections.map(({ file, errors }, index) => (
                <li key={index} className="text-sm">
                  <strong>{file.name}:</strong> {errors.map((e) => e.message).join(", ")}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* File Processing Status */}
      {uploadedFiles.length > 0 && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold flex items-center">
              <FileText className="h-5 w-5 mr-2" />
              Processing Files ({uploadedFiles.length})
            </h3>
            {uploadedFiles.length > 0 && (
              <Button variant="outline" size="sm" onClick={clearAll}>
                <X className="h-4 w-4 mr-2" />
                Clear All
              </Button>
            )}
          </div>

          <div className="grid gap-4">
            {uploadedFiles.map((uploadedFile, index) => (
              <Card key={index} className={`transition-all duration-300 ${getStatusColor(uploadedFile.status)}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-3">
                      {getStatusIcon(uploadedFile.status)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 truncate">{uploadedFile.file.name}</p>
                        <p className="text-sm text-gray-500">
                          {(uploadedFile.file.size / 1024 / 1024).toFixed(1)} MB •{" "}
                          {uploadedFile.file.type.split("/")[1].toUpperCase()}
                        </p>
                      </div>
                      <Badge
                        variant={
                          uploadedFile.status === "completed"
                            ? "default"
                            : uploadedFile.status === "duplicate"
                              ? "secondary"
                              : uploadedFile.status === "error" || uploadedFile.status === "parsing-failed"
                                ? "destructive"
                                : "outline"
                        }
                        className="capitalize"
                      >
                        {uploadedFile.status === "duplicate" ? "Already Exists" : 
                         uploadedFile.status === "parsing-failed" ? "Parsing Failed" : 
                         uploadedFile.status}
                      </Badge>
                    </div>

                    <div className="flex items-center space-x-2">
                      {(uploadedFile.status === "error" || uploadedFile.status === "parsing-failed") && (
                        <Button variant="outline" size="sm" onClick={() => retryFile(index)}>
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      )}
                      {uploadedFile.result?.fileUrl && (
                        <>
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="outline" size="sm">
                                <Eye className="h-4 w-4" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-4xl max-h-[80vh]">
                              <DialogHeader>
                                <DialogTitle>Resume Preview - {uploadedFile.result.name}</DialogTitle>
                              </DialogHeader>
                              <div className="space-y-4">
                                <iframe
                                  src={uploadedFile.result.fileUrl}
                                  className="w-full h-96 border rounded"
                                  title="Resume Preview"
                                />
                                <div className="flex justify-end">
                                  <Button asChild>
                                    <a href={uploadedFile.result.fileUrl} download={uploadedFile.file.name}>
                                      <Download className="h-4 w-4 mr-2" />
                                      Download
                                    </a>
                                  </Button>
                                </div>
                              </div>
                            </DialogContent>
                          </Dialog>
                          <Button variant="outline" size="sm" asChild>
                            <a href={uploadedFile.result.fileUrl} download={uploadedFile.file.name}>
                              <Download className="h-4 w-4" />
                            </a>
                          </Button>
                        </>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => removeFile(index)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  {(uploadedFile.status === "uploading" || uploadedFile.status === "processing") && (
                    <div className="space-y-2">
                      <Progress value={uploadedFile.progress} className="h-2" />
                      <p className="text-xs text-gray-600 text-center">
                        {uploadedFile.status === "uploading" ? "Uploading..." : "AI is extracting data..."}
                      </p>
                    </div>
                  )}

                  {/* Success Result */}
                  {(uploadedFile.status === "completed" || uploadedFile.status === "created" || uploadedFile.status === "updated") && uploadedFile.result && (
                    <div className="mt-3 p-4 bg-green-50 rounded-lg border border-green-200">
                      <div className="flex items-center space-x-2 mb-3">
                        <CheckCircle className="h-5 w-5 text-green-600" />
                        <span className="font-medium text-green-800">
                          {uploadedFile.status === "updated" ? "Updated Existing Profile" : "New Profile Created"}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                        <div>
                          <span className="font-medium text-green-700">Name:</span>
                          <p className="text-green-600">{uploadedFile.result.name}</p>
                        </div>
                        <div>
                          <span className="font-medium text-green-700">Role:</span>
                          <p className="text-green-600">{uploadedFile.result.currentRole}</p>
                        </div>
                        <div>
                          <span className="font-medium text-green-700">Experience:</span>
                          <p className="text-green-600">{uploadedFile.result.totalExperience}</p>
                        </div>
                        <div>
                          <span className="font-medium text-green-700">Location:</span>
                          <p className="text-green-600">{uploadedFile.result.location}</p>
                        </div>
                        {uploadedFile.result.email && (
                          <div>
                            <span className="font-medium text-green-700">Email:</span>
                            <p className="text-green-600">{uploadedFile.result.email}</p>
                          </div>
                        )}
                        {uploadedFile.result.phone && (
                          <div>
                            <span className="font-medium text-green-700">Phone:</span>
                            <p className="text-green-600">{uploadedFile.result.phone}</p>
                          </div>
                        )}
                      </div>
                      {uploadedFile.result.technicalSkills && uploadedFile.result.technicalSkills.length > 0 && (
                        <div className="mt-3">
                          <span className="font-medium text-green-700">Skills:</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {uploadedFile.result.technicalSkills
                              .slice(0, 6)
                              .map((skill: string, skillIndex: number) => (
                                <Badge
                                  key={skillIndex}
                                  variant="secondary"
                                  className="text-xs bg-green-100 text-green-700"
                                >
                                  {skill}
                                </Badge>
                              ))}
                            {uploadedFile.result.technicalSkills.length > 6 && (
                              <Badge variant="outline" className="text-xs">
                                +{uploadedFile.result.technicalSkills.length - 6} more
                              </Badge>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Duplicate Warning */}
                  {uploadedFile.status === "duplicate" && (
                    <div className="mt-3 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                      <div className="flex items-start space-x-2">
                        <AlertTriangle className="h-5 w-5 text-orange-600 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <h4 className="font-medium text-orange-800">Resume Already Exists</h4>
                          <p className="text-sm text-orange-700 mt-1">
                            This resume appears to be a duplicate of an existing candidate in our database.
                          </p>
                          {uploadedFile.duplicateInfo && (
                            <div className="mt-2 text-xs text-orange-600 space-y-1">
                              <p><strong>Existing Candidate:</strong> {uploadedFile.duplicateInfo.existingName}</p>
                              <p><strong>Reason:</strong> {uploadedFile.duplicateInfo.reason}</p>
                              <p><strong>Uploaded:</strong> {new Date(uploadedFile.duplicateInfo.uploadedAt).toLocaleDateString()}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Updated Existing Profile */}
                  {uploadedFile.status === "updated" && uploadedFile.result?.duplicateInfo && (
                    <div className="mt-3 p-3 bg-indigo-50 border border-indigo-200 rounded-lg">
                      <div className="flex items-start space-x-2">
                        <RefreshCw className="h-5 w-5 text-indigo-600 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <h4 className="font-medium text-indigo-800">Existing Profile Updated</h4>
                          <div className="mt-2 text-xs text-indigo-700 space-y-1">
                            <p><strong>Candidate:</strong> {uploadedFile.result.duplicateInfo.existingName}</p>
                            <p><strong>Reason:</strong> {uploadedFile.result.duplicateInfo.reason}</p>
                            <p><strong>ID:</strong> {uploadedFile.result.duplicateInfo.existingId}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Blocked Upload */}
                  {uploadedFile.status === "blocked" && (
                    <div className="mt-3 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                      <div className="flex items-start space-x-2">
                        <AlertTriangle className="h-5 w-5 text-amber-700 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <h4 className="font-medium text-amber-900">Upload Blocked</h4>
                          <p className="text-sm text-amber-800 mt-1">
                            {uploadedFile.blockedInfo?.details || uploadedFile.error || "This file was blocked."}
                          </p>
                          {uploadedFile.blockedInfo?.category === "not_resume" && (
                            <div className="mt-2 text-xs text-amber-800">
                              Detected type: {String(uploadedFile.blockedInfo?.docType || "unknown")}
                              {typeof uploadedFile.blockedInfo?.confidence === "number" && (
                                <> • Confidence: {Math.round(uploadedFile.blockedInfo.confidence * 100)}%</>
                              )}
                            </div>
                          )}

                          {uploadedFile.blockedInfo?.suggestions && uploadedFile.blockedInfo.suggestions.length > 0 && (
                            <div className="mt-3 bg-white p-3 rounded border border-amber-100">
                              <h5 className="font-medium text-amber-900 mb-2">What to upload instead</h5>
                              <ul className="text-sm text-amber-800 space-y-1">
                                {uploadedFile.blockedInfo.suggestions.map((s, idx) => (
                                  <li key={idx} className="flex items-start space-x-2">
                                    <span className="text-amber-700 mt-1">•</span>
                                    <span>{s}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          <div className="mt-4 flex space-x-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => retryFile(index)}
                              className="border-amber-200 text-amber-900 hover:bg-amber-100"
                            >
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Try Again
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => removeFile(index)}
                              className="border-amber-200 text-amber-900 hover:bg-amber-100"
                            >
                              <X className="h-4 w-4 mr-2" />
                              Remove File
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Parsing Failure */}
                  {uploadedFile.status === "parsing-failed" && uploadedFile.parsingError && (
                    <div className="mt-3 p-4 bg-red-50 border border-red-200 rounded-lg">
                      <div className="flex items-start space-x-2">
                        <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <h4 className="font-medium text-red-800">Resume Parsing Failed</h4>
                          <p className="text-sm text-red-700 mt-1 mb-3">
                            The AI was unable to extract information from this resume. This usually happens when the file is corrupted, password protected, or contains only images.
                          </p>
                          
                          <div className="space-y-3">
                            <div className="bg-white p-3 rounded border border-red-100">
                              <h5 className="font-medium text-red-800 mb-2">Error Details:</h5>
                              <p className="text-sm text-red-700">{uploadedFile.parsingError.details}</p>
                            </div>
                            
                            <div className="bg-white p-3 rounded border border-red-100">
                              <h5 className="font-medium text-red-800 mb-2">File Information:</h5>
                              <div className="grid grid-cols-2 gap-2 text-xs text-red-600">
                                <div><strong>Name:</strong> {uploadedFile.parsingError.fileName}</div>
                                <div><strong>Type:</strong> {uploadedFile.parsingError.fileType}</div>
                                <div><strong>Size:</strong> {(uploadedFile.parsingError.fileSize / 1024 / 1024).toFixed(1)} MB</div>
                                <div><strong>Time:</strong> {new Date(uploadedFile.parsingError.timestamp).toLocaleTimeString()}</div>
                              </div>
                            </div>
                            
                            {uploadedFile.parsingError.suggestions && uploadedFile.parsingError.suggestions.length > 0 && (
                              <div className="bg-white p-3 rounded border border-red-100">
                                <h5 className="font-medium text-red-800 mb-2">Suggestions to Fix:</h5>
                                <ul className="text-sm text-red-600 space-y-1">
                                  {uploadedFile.parsingError.suggestions.map((suggestion, idx) => (
                                    <li key={idx} className="flex items-start space-x-2">
                                      <span className="text-red-500 mt-1">•</span>
                                      <span>{suggestion}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                          
                          <div className="mt-4 flex space-x-2">
                            <Button 
                              variant="outline" 
                              size="sm" 
                              onClick={() => retryFile(index)}
                              className="border-red-200 text-red-700 hover:bg-red-100"
                            >
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Try Again
                            </Button>
                            <Button 
                              variant="outline" 
                              size="sm" 
                              onClick={() => removeFile(index)}
                              className="border-red-200 text-red-700 hover:bg-red-100"
                            >
                              <X className="h-4 w-4 mr-2" />
                              Remove File
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Error Message */}
                  {uploadedFile.status === "error" && (
                    <Alert variant="destructive" className="mt-3">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        <div className="space-y-2">
                          <div>
                            <strong>Processing failed:</strong> {uploadedFile.error}
                          </div>
                          {uploadedFile.failureInfo?.supabaseError?.code && (
                            <div className="text-sm">
                              <div>
                                <strong>Reason:</strong> {uploadedFile.failureInfo.supabaseError.message}
                              </div>
                              <div>
                                <strong>Code:</strong> {uploadedFile.failureInfo.supabaseError.code}
                              </div>
                              {uploadedFile.failureInfo.supabaseError.hint && (
                                <div>
                                  <strong>Hint:</strong> {String(uploadedFile.failureInfo.supabaseError.hint)}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Enhanced Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200">
          <CardContent className="p-4">
            <div className="flex items-start space-x-3">
              <Sparkles className="h-5 w-5 text-blue-600 mt-0.5" />
              <div>
                <h4 className="font-semibold text-blue-900">AI-Powered Processing</h4>
                <p className="text-sm text-blue-800 mt-1">
                  Advanced AI extracts comprehensive data including education, skills, experience, and more from your
                  resumes.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-r from-green-50 to-emerald-50 border-green-200">
          <CardContent className="p-4">
            <div className="flex items-start space-x-3">
              <FileCheck className="h-5 w-5 text-green-600 mt-0.5" />
              <div>
                <h4 className="font-semibold text-green-900">Smart Duplicate Detection</h4>
                <p className="text-sm text-green-800 mt-1">
                  Automatically detects and prevents duplicate uploads, keeping your database clean and organized.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
