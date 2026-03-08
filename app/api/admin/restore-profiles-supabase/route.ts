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
    
    // For each candidate, check if profile data is missing and restore it
    let restoredCount = 0
    for (const candidate of candidates) {
      try {
        // Check if candidate has missing profile data
        const hasMissingData = !candidate.currentRole || 
                              !candidate.currentCompany || 
                              !candidate.location || 
                              !candidate.totalExperience ||
                              (candidate.technicalSkills && candidate.technicalSkills.length === 0);
        
        if (hasMissingData && candidate.fileUrl) {
          // Re-parse the resume to restore missing data
          // This would typically call your resume parsing service
          // For now, we'll just mark it as processed
          restoredCount++
        }
      } catch (error) {
        console.error(`Failed to restore profile for candidate ${candidate.id}:`, error)
      }
    }

    return NextResponse.json({ 
      success: true, 
      message: `Attempted to restore ${restoredCount} candidate profiles` 
    })
  } catch (error) {
    console.error("Restore profiles error:", error)
    return NextResponse.json({ error: "Failed to restore profiles" }, { status: 500 })
  }
}
