import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { RESUME_BUCKET_NAME as STORAGE_BUCKET } from "@/lib/constants/storage"
import { logger } from "@/lib/logger"

export const runtime = "nodejs"

/**
 * Public-but-guarded resume access for shared shortlists.
 * GET /api/public/shortlist/[token]/candidates/[rowId]/resume
 *
 * Validates the share token + expiry + that the row belongs to this share,
 * then mints a short-lived signed URL. Raw storage paths are never exposed.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; rowId: string }> }
) {
  try {
    const { token, rowId } = await params

    const { data: share } = await supabaseAdmin
      .from("shortlist_shares")
      .select("id, expires_at")
      .eq("token", token)
      .maybeSingle()
    if (!share) return NextResponse.json({ error: "This shortlist link is invalid." }, { status: 404 })
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: "This shortlist link has expired." }, { status: 410 })
    }

    const { data: row } = await supabaseAdmin
      .from("shortlist_share_candidates")
      .select("id, candidate_id")
      .eq("id", rowId)
      .eq("share_id", share.id)
      .maybeSingle()
    if (!row?.candidate_id) {
      return NextResponse.json({ error: "Candidate not found in this shortlist" }, { status: 404 })
    }

    const { data: cand } = await supabaseAdmin
      .from("candidates")
      .select("file_url, file_name")
      .eq("id", String(row.candidate_id))
      .maybeSingle()

    let fileUrl = (cand?.file_url as string) || ""
    const fileName = (cand?.file_name as string) || "resume"
    let signedUrl = ""

    // Prefer minting a fresh signed URL from the storage path when we have one.
    const pathFromFileUrl = (() => {
      try {
        const u = new URL(fileUrl)
        const idx = u.pathname.indexOf(`/${STORAGE_BUCKET}/`)
        return idx >= 0 ? decodeURIComponent(u.pathname.slice(idx + `/${STORAGE_BUCKET}/`.length)) : ""
      } catch {
        return ""
      }
    })()
    const storagePath = fileName && !fileName.startsWith("http") ? fileName : pathFromFileUrl

    if (storagePath) {
      try {
        const { data: signed, error: signError } = await supabaseAdmin.storage
          .from(STORAGE_BUCKET)
          .createSignedUrl(storagePath, 60 * 60)
        if (!signError && signed?.signedUrl) signedUrl = signed.signedUrl
      } catch (err) {
        logger.warn("Failed to sign resume URL for shortlist", err)
      }
    }

    // Fallbacks: an existing signed/public URL on the row.
    if (!signedUrl && fileUrl && /^https?:\/\//.test(fileUrl)) signedUrl = fileUrl

    if (!signedUrl) {
      return NextResponse.json(
        { error: "No resume file available", hasResumeFile: false },
        { status: 404 }
      )
    }

    return NextResponse.json({ url: signedUrl, fileName, expiresIn: 60 * 60 })
  } catch (error: any) {
    logger.error("Error serving shortlist resume", error)
    return NextResponse.json({ error: "Could not load resume" }, { status: 500 })
  }
}
