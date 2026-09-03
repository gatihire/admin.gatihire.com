import { OutreachDashboard } from "@/components/outreach-dashboard"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export const runtime = "nodejs"
export const revalidate = 0

export default async function OutreachPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAnyInternalPermission(["jobs.view", "jobs.edit", "jobs.post"])
  const { id } = await params
  return <OutreachDashboard jobId={id} />
}
