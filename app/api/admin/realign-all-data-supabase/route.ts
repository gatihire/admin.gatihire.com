import { NextRequest, NextResponse } from "next/server"
import { SupabaseCandidateService } from "@/lib/supabase-candidates"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"

export async function POST(request: NextRequest) {
  try {
    const ctx = await getInternalAuthContext(request)
    if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!hasPermission(ctx, "export.data")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

    // Get all candidates
    const candidates = await SupabaseCandidateService.getAllCandidates()
    
    // For each candidate, update their data to ensure consistency
    let updatedCount = 0
    for (const candidate of candidates) {
      try {
        if (!candidate.id) continue
        // Update the candidate with the same data to trigger any normalization logic
        await SupabaseCandidateService.updateCandidate(candidate.id, candidate)
        updatedCount++
      } catch (error) {
        console.error(`Failed to update candidate ${candidate.id}:`, error)
      }
    }

    return NextResponse.json({ 
      success: true, 
      message: `Successfully realigned ${updatedCount} of ${candidates.length} candidates` 
    })
  } catch (error) {
    console.error("Realign error:", error)
    return NextResponse.json({ error: "Failed to realign data" }, { status: 500 })
  }
}
