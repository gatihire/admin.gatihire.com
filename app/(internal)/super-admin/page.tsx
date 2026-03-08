import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SuperAdminHub } from "@/components/super-admin/SuperAdminHub"
import { requireSuperAdmin } from "@/lib/server-internal-permissions"

export default async function SuperAdminPage() {
  await requireSuperAdmin()

  return (
    <Card className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-md">
      <CardHeader>
        <CardTitle>Super Admin</CardTitle>
        <CardDescription>Platform analytics, access control, and team performance</CardDescription>
      </CardHeader>
      <CardContent>
        <SuperAdminHub />
      </CardContent>
    </Card>
  )
}
