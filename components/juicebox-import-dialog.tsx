"use client"

import { useState, useCallback } from "react"
import { useDropzone } from "react-dropzone"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  FileJson, Loader2, CheckCircle, AlertCircle, X, Upload, Database
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { parseJuiceboxPayload, type JuiceboxProfileInput } from "@/lib/juicebox-importer"

interface ImportPreview {
  profiles: JuiceboxProfileInput[]
  errors: { index: number; message: string }[]
}

interface JuiceboxImportDialogProps {
  jobId: string
  jobTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

export function JuiceboxImportDialog({ jobId, jobTitle, open, onOpenChange, onComplete }: JuiceboxImportDialogProps) {
  const [fileName, setFileName] = useState("")
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<any | null>(null)
  const { toast } = useToast()

  const reset = () => {
    setFileName("")
    setPreview(null)
    setResult(null)
  }

  const handleClose = () => {
    reset()
    onOpenChange(false)
  }

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = parseJuiceboxPayload(JSON.parse(String(reader.result)))
        setFileName(file.name)
        setPreview(parsed)
        setResult(null)
      } catch {
        toast({ title: "Invalid JSON", description: "Could not parse this file as JSON.", variant: "destructive" })
      }
    }
    reader.readAsText(file)
  }, [toast])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/json": [".json"] },
    maxFiles: 1,
    disabled: importing,
  })

  const runImport = async () => {
    if (!preview) return
    setImporting(true)
    const formData = new FormData()
    formData.append("file", new File([JSON.stringify(preview.profiles.map((p) => p.raw))], fileName || "juicebox.json", { type: "application/json" }))
    try {
      const res = await fetch(`/api/jobs/${jobId}/juicebox/import`, { method: "POST", body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Import failed")
      setResult(data)
      toast({
        title: "Import Complete",
        description: `${data.imported} imported · ${data.duplicates + (data.alreadyExists || 0)} duplicates · ${data.errors?.length || 0} errors`,
      })
      onComplete()
    } catch (err: any) {
      toast({ title: "Import Failed", description: err.message, variant: "destructive" })
    } finally {
      setImporting(false)
    }
  }

  const totalErrors = preview ? preview.errors.length : 0

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!importing) { if (!o) handleClose(); else onOpenChange(o) } }}>
      <DialogContent className="sm:max-w-[560px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="h-5 w-5 text-blue-500" />
            Import Juicebox Profiles to {jobTitle}
          </DialogTitle>
          <DialogDescription>
            Upload a Juicebox search-export JSON (result.json). Profiles are imported in file order, deduplicated by contact / LinkedIn id, and kept in a separate Juicebox schema — never mixed with resume data.
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors ${
              isDragActive ? "border-blue-400 bg-blue-50" : "border-zinc-300 hover:border-zinc-400 bg-zinc-50/50"
            }`}
          >
            <input {...getInputProps()} />
            <FileJson className="h-10 w-10 mx-auto mb-3 text-zinc-300" />
            <p className="text-sm font-semibold text-zinc-600">
              {isDragActive ? "Drop the JSON here..." : "Drag & drop result.json here, or click to browse"}
            </p>
            <p className="text-xs text-zinc-400 mt-1">Supported: .json (Juicebox export)</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-xl bg-zinc-50 border border-zinc-200 p-3">
              <FileJson className="h-4 w-4 text-blue-500 shrink-0" />
              <span className="text-sm text-zinc-700 truncate flex-1">{fileName}</span>
              {!importing && (
                <button onClick={() => { reset() }} className="text-zinc-400 hover:text-zinc-600">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="rounded-xl border border-zinc-200 overflow-hidden max-h-[260px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Current role</th>
                    <th className="px-3 py-2">Company</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.profiles.map((p, i) => (
                    <tr key={i} className="border-t border-zinc-100">
                      <td className="px-3 py-2 text-zinc-400">{i + 1}</td>
                      <td className="px-3 py-2 font-medium text-zinc-800">{p.full_name || "—"}</td>
                      <td className="px-3 py-2 text-zinc-600">{p.job_title || "—"}</td>
                      <td className="px-3 py-2 text-zinc-600">{p.job_company_name || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.errors.length > 0 && (
              <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-600">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {preview.errors.length} row(s) could not be read
              </div>
            )}

            {result && (
              <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-700">
                <CheckCircle className="h-4 w-4 shrink-0" />
                <span>
                  Imported <b>{result.imported}</b> profile(s) · {result.duplicates + (result.alreadyExists || 0)} duplicate(s) skipped{totalErrors > 0 ? ` · ${totalErrors} row error(s)` : ""}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-zinc-100">
          <div className="text-xs text-zinc-400">
            {preview ? `${preview.profiles.length} profile(s) detected` : "No file selected"}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleClose} disabled={importing}>
              Close
            </Button>
            {preview && !result && (
              <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={runImport} disabled={importing || preview.profiles.length === 0}>
                {importing ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Upload className="h-4 w-4 mr-1.5" />}
                Import {preview.profiles.length} profile(s)
              </Button>
            )}
            {result && (
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={handleClose}>
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
