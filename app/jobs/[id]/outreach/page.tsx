import { OutreachDashboard } from "@/components/outreach-dashboard"

export default async function OutreachPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <OutreachDashboard jobId={id} />
}
