import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export async function POST(_request: NextRequest) {
  const response = NextResponse.json({ success: true })

  response.cookies.set("sb-access-token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  })

  response.cookies.set("sb-refresh-token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  })

  return response
}
