import { Card, CardContent } from "@/components/ui/card"
import { ClientsDashboard } from "@/components/clients-dashboard"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export default async function ClientsPage() {
  await requireAnyInternalPermission(["jobs.view", "jobs.edit", "jobs.post"])
  return (
    <Card className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-md">
      <CardContent className="p-6">
        <ClientsDashboard />
      </CardContent>
    </Card>
  )
}
