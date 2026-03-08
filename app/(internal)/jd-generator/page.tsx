import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { JDGenerator } from "@/components/jd-generator"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export default async function JDGeneratorPage() {
  await requireAnyInternalPermission(["jobs.post", "jobs.edit"])
  return (
    <Card className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-md">
      <CardHeader>
        <CardTitle>Job Description Generator</CardTitle>
        <CardDescription>Generate tailored job descriptions based on candidate profiles using AI</CardDescription>
      </CardHeader>
      <CardContent>
        <JDGenerator />
      </CardContent>
    </Card>
  )
}
