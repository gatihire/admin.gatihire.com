import { WhatsAppInboxView } from "@/components/whatsapp/WhatsAppInboxView"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export const dynamic = "force-dynamic"

export default async function WhatsAppPage() {
  await requireAnyInternalPermission(["applications.view"])
  return <WhatsAppInboxView />
}
