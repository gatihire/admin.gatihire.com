import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CandidateDashboard } from "@/components/candidate-dashboard"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export default async function CandidatesPage() {
  await requireAnyInternalPermission(["candidates.view", "candidates.edit"])
  return (
    <Card className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-md">
      <CardHeader>
        <CardTitle>Candidate Dashboard</CardTitle>
        <CardDescription>View, filter, and manage all uploaded resumes with advanced search capabilities</CardDescription>
      </CardHeader>
      <CardContent>
        <CandidateDashboard />
      </CardContent>
    </Card>
  )
}
