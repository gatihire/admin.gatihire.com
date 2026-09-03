import { NextRequest, NextResponse } from "next/server"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  logger.error("Phone screening answer URL fallback triggered", {
    url: request.url,
  })
  return NextResponse.json({ status: "ok" })
}
