import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CandidatesSection } from "@/components/candidates-section"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export default async function CandidatesPage() {
  await requireAnyInternalPermission(["candidates.view", "candidates.edit"])
  return (
    <Card className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-md">
      <CardHeader>
        <CardTitle>Candidate Dashboard</CardTitle>
        <CardDescription>View, filter, and manage uploaded resumes and imported Juicebox / LinkedIn profiles</CardDescription>
      </CardHeader>
      <CardContent>
        <CandidatesSection />
      </CardContent>
    </Card>
  )
}
