import { TodayView } from "@/components/today/TodayView"
import { getServerInternalPermissions, requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export const dynamic = "force-dynamic"

export default async function TodayPage() {
  await requireAnyInternalPermission(["dispatch.view", "applications.view"])
  const { isSuperAdmin, permissionKeys } = await getServerInternalPermissions()
  const canViewTeam = isSuperAdmin || permissionKeys.has("dispatch.view.team")

  return <TodayView canViewTeam={canViewTeam} defaultScope={canViewTeam ? "team" : "mine"} />
}
