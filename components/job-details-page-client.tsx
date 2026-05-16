"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { JobDetails } from "@/components/job-details"
import { cachedFetchJson } from "@/lib/utils"

export function JobDetailsPageClient({ jobId }: { jobId: string }) {
  const router = useRouter()
  const sp = useSearchParams()
  const tab = sp.get("tab") || undefined
  const [job, setJob] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    cachedFetchJson<any>(`internal:job:${jobId}`, `/api/jobs/${jobId}`, undefined, {
      ttlMs: 10 * 60_000,
    })
      .then((data) => {
        if (!active) return
        setJob(data)
      })
      .catch((e: any) => {
        if (!active) return
        setError(e?.message || "Failed to load job")
        setJob(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [jobId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
          Loading job...
        </div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-sm text-red-600">{error || "Job not found"}</div>
      </div>
    )
  }

  return <JobDetails job={job} onBack={() => {
    if (window.history.length > 1) {
      router.back()
    } else {
      router.push("/jobs")
    }
  }} initialTab={tab} />
}
