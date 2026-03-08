import { getServerInternalPermissions } from "@/lib/server-internal-permissions"
import { redirect } from "next/navigation"

export default async function DashboardPage() {
  const { isSuperAdmin, permissionKeys } = await getServerInternalPermissions()
  const keys = permissionKeys

  const hasAny = (list: string[]) => list.some((k) => keys.has(k))

  if (isSuperAdmin || hasAny(["jobs.view", "jobs.edit", "jobs.post"])) redirect("/jobs")
  if (hasAny(["candidates.view", "candidates.edit"])) redirect("/candidates")
  if (hasAny(["candidates.edit"])) redirect("/upload")
  if (hasAny(["jobs.view", "jobs.edit", "jobs.post"])) redirect("/clients")
  if (hasAny(["candidates.search", "candidates.search-only"])) redirect("/search")
  if (hasAny(["analytics.view"])) redirect("/analytics")
  if (hasAny(["users.manage", "roles.manage"])) redirect("/admin")

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
      No access has been assigned to this account yet.
    </div>
  )
}
