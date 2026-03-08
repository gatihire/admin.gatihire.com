import { JobDetailsPageClient } from "@/components/job-details-page-client"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export const runtime = "nodejs"
export const revalidate = 0

export default async function JobDetailPage(props: { params: Promise<{ id: string }> }) {
  await requireAnyInternalPermission(["jobs.view", "jobs.edit", "jobs.post"])
  const { id } = await props.params
  return <JobDetailsPageClient jobId={id} />
}
