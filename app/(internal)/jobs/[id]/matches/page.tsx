import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, ExternalLink } from "lucide-react"
import MatchesClient from "@/components/job-matches-client"
import { getBoardJobApplyUrl } from "@/lib/utils"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

interface JobPageProps {
  params: Promise<{ id: string }>
}

export default async function MatchesPage(props: JobPageProps) {
  await requireAnyInternalPermission(["jobs.view", "jobs.edit", "jobs.post"])
  const { id } = await props.params
  const { data: job } = await supabaseAdmin.from("jobs").select("*").eq("id", id).single()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" asChild>
          <Link href="/jobs" className="flex items-center gap-2 text-gray-600 hover:text-gray-900">
            <ArrowLeft className="h-4 w-4" />
            Back to Jobs
          </Link>
        </Button>
        <div className="hidden sm:block font-semibold text-gray-700">Database Matches</div>
      </div>

      <div className="bg-white rounded-xl p-6 shadow-sm border dark:bg-zinc-900 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-xl font-bold text-blue-700 dark:text-blue-300">{job?.title || "Matches"}</CardTitle>
          {job && (
            <>
              <Badge variant="secondary" className="text-sm px-3 py-1">
                {job.industry || job.department_category || ""}
              </Badge>
              <Badge variant="outline" className="text-sm px-3 py-1">
                {String(job.employment_type || "").replace(/_/g, " ")}
              </Badge>
              <span className="text-sm text-gray-500 dark:text-gray-400">{job.location}</span>
              <a
                href={getBoardJobApplyUrl(id)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 text-blue-600 hover:underline"
              >
                View Public Page <ExternalLink className="h-3 w-3" />
              </a>
            </>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl p-6 shadow-sm border dark:bg-zinc-900 dark:border-zinc-800">
        <MatchesClient jobId={id} />
      </div>
    </div>
  )
}
