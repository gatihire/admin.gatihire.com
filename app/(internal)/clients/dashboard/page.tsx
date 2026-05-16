import { Card, CardContent } from "@/components/ui/card"
import { ClientAdminDashboard } from "@/components/client-admin-dashboard"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export default async function ClientDashboardPage() {
  await requireAnyInternalPermission(["jobs.view", "jobs.edit", "jobs.post", "analytics.view"])
  return (
    <Card className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-md">
      <CardContent className="p-6">
        <ClientAdminDashboard />
      </CardContent>
    </Card>
  )
}
