import { NextRequest, NextResponse } from "next/server"
import { runWeeklyReview, extractFineTuneRows } from "@/lib/ai-learning"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const secret = process.env.AI_LEARNING_CRON_SECRET
  if (secret) {
    const header = request.headers.get("x-cron-secret")
    if (header !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get("dryRun") === "1" || searchParams.get("dry_run") === "1"
  const extract = searchParams.get("extractFineTune") === "1"

  try {
    const review = await runWeeklyReview({ dryRun })

    let fineTuneRows = 0
    if (extract && !dryRun) {
      fineTuneRows = await extractFineTuneRows()
    }

    return NextResponse.json({ ok: true, ...review, fineTuneRows })
  } catch (error: any) {
    logger.error("Weekly learning review failed", { error: error.message })
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
