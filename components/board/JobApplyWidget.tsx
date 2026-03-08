"use client"

import { useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ApplyFlowDialog, BoardJobLite } from "@/components/board/ApplyFlowDialog"
import { ExternalLink, Upload } from "lucide-react"
import { trackEvent } from "@/lib/analytics-client"

type Props = {
  job: {
    id: string
    title: string
    client_name?: string | null
    company_logo_url?: string | null
    apply_type?: string | null
    external_apply_url?: string | null
    status?: string | null
  }
}

export function JobApplyWidget({ job }: Props) {
  const [open, setOpen] = useState(false)
  const jobLite = useMemo<BoardJobLite>(
    () => ({
      id: job.id,
      title: job.title,
      client_name: job.client_name,
      company_logo_url: job.company_logo_url,
      apply_type: job.apply_type,
      external_apply_url: job.external_apply_url,
    }),
    [job]
  )

  const isExternal = String(job.apply_type || "in_platform") === "external"
  const isOpen = String(job.status || "open") === "open"

  return (
    <>
      <Card className="shadow-lg border-blue-100 overflow-hidden">
        <CardHeader className="bg-blue-50/50 border-b border-blue-100 pb-6">
          <CardTitle className="text-xl text-blue-900">Apply for this position</CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          {isOpen ? (
            <Button
              className="w-full gap-2"
              variant={isExternal ? "outline" : "default"}
              onClick={() => {
                trackEvent({ event_name: "board.apply.started", entity_type: "jobs", entity_id: job.id, metadata: { job_id: job.id, surface: "job_page" } })
                setOpen(true)
              }}
            >
              {isExternal ? <ExternalLink className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
              {isExternal ? "Apply on company site" : "Upload your CV to apply"}
            </Button>
          ) : (
            <div className="text-center py-6 text-gray-500">This position is no longer accepting applications.</div>
          )}
        </CardContent>
      </Card>
      <ApplyFlowDialog job={jobLite} open={open} onOpenChange={setOpen} />
    </>
  )
}
