"use client"

import { useEffect } from "react"
import { supabase } from "@/lib/supabase"
import { ensureSessionStart, trackEvent, trackPageView } from "@/lib/analytics-client"

export function BoardAnalytics(props: { jobId?: string | null }) {
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token || null
      if (cancelled) return
      await ensureSessionStart(token)
      await trackPageView(token)
      if (props.jobId) {
        await trackEvent({
          event_name: "board.job.viewed",
          entity_type: "jobs",
          entity_id: props.jobId,
          metadata: { job_id: props.jobId, surface: "job_page" },
          access_token: token,
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.jobId])

  return null
}

