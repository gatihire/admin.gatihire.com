import { NextRequest, NextResponse } from "next/server"
import { getPlivoAnswerXml } from "@/lib/plivo"
import { getActivePlaybook, formatPlaybookForAgent } from "@/lib/ai-playbook"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const agentId = process.env.PLIVO_AGENT_ID || ""
  const searchParams = request.nextUrl.searchParams
  const candidateName = searchParams.get("candidateName") || "Candidate"
  const candidateProfile = JSON.parse(searchParams.get("candidateProfile") || "{}")
  const jobDetails = JSON.parse(searchParams.get("jobDetails") || "{}")
  const originParam = searchParams.get("origin")
  const origin = originParam === "outbound" ? "outbound" : "inbound"
  const playbookParam = searchParams.get("playbook")

  let playbook = playbookParam || ""
  if (!playbook) {
    const active = await getActivePlaybook()
    playbook = formatPlaybookForAgent(active)
  }

  const xml = getPlivoAnswerXml({
    agentId,
    candidateName,
    candidateProfile,
    jobDetails,
    origin,
    playbook: playbook || undefined,
  })

  return new NextResponse(xml, {
    headers: { "Content-Type": "application/xml" },
  })
}
