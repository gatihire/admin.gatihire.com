import { ClientCreditsDashboard } from "@/components/client-credits-dashboard"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export default async function ClientCreditsPage() {
  await requireAnyInternalPermission(["jobs.view", "jobs.edit", "jobs.post", "analytics.view"])
  return <ClientCreditsDashboard />
}