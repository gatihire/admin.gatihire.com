import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AnalyticsDashboard } from "@/components/analytics-dashboard"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export default async function AnalyticsPage() {
  await requireAnyInternalPermission(["analytics.view"])
  return (
    <Card className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-md">
      <CardHeader>
        <CardTitle>My Analytics</CardTitle>
        <CardDescription>Track your personal usage and performance metrics</CardDescription>
      </CardHeader>
      <CardContent>
        <AnalyticsDashboard />
      </CardContent>
    </Card>
  )
}
