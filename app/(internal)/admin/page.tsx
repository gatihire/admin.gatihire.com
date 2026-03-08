import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AdminPanel } from "@/components/admin-panel"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export default async function AdminPage() {
  await requireAnyInternalPermission(["export.data", "users.manage"])
  return (
    <Card className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-md">
      <CardHeader>
        <CardTitle>Admin Panel</CardTitle>
        <CardDescription>Analytics, statistics, data export, and platform management tools</CardDescription>
      </CardHeader>
      <CardContent>
        <AdminPanel />
      </CardContent>
    </Card>
  )
}
