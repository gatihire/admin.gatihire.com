import { NextRequest, NextResponse } from "next/server"
export const runtime = "nodejs"
import { supabaseAdmin } from "@/lib/supabase"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import * as XLSX from "xlsx"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "applications.view") && !hasPermission(ctx, "applications.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id: jobId } = await params
  const { searchParams } = new URL(request.url)
  const stage = searchParams.get("stage") || "all"
  const origin = searchParams.get("origin") || "all"

  try {
    // Fetch job details
    const { data: job } = await supabaseAdmin
      .from("jobs")
      .select("title, location, industry")
      .eq("id", jobId)
      .single()

    // Fetch all applications for this job with candidate details
    let query = supabaseAdmin
      .from("applications")
      .select(`
        id,
        status,
        applied_at,
        origin,
        source,
        match_score,
        candidates:candidate_id (
          id,
          name,
          email,
          phone,
          current_role,
          current_company,
          total_experience,
          location,
          file_url,
          resume_text,
          technical_skills
        )
      `)
      .eq("job_id", jobId)
      .order("applied_at", { ascending: false })

    // Apply stage filter
    if (stage && stage !== "all") {
      query = query.eq("status", stage)
    }

    // Apply origin filter
    if (origin && origin !== "all") {
      query = query.eq("origin", origin)
    }

    const { data: applications, error } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!applications || applications.length === 0) {
      return NextResponse.json({ error: "No candidates found" }, { status: 404 })
    }

    // Prepare data for Excel
    const excelData = applications.map((app: any, index: number) => {
      const candidate = app.candidates || {}
      return {
        "S.No": index + 1,
        "Candidate Name": candidate.name || "",
        "Email": candidate.email || "",
        "Phone": candidate.phone || "",
        "Current Job Title": candidate.current_role || "",
        "Current Company": candidate.current_company || "",
        "Total Experience": candidate.total_experience || "",
        "Current Location": candidate.location || "",
        "Pipeline Stage": app.status || "",
        "Origin": app.origin || "",
        "Source": app.source || "",
        "Match Score (%)": app.match_score ? Math.round(app.match_score * 100) : "",
        "Applied Date": app.applied_at ? new Date(app.applied_at).toLocaleDateString("en-IN") : "",
        "Resume Link": candidate.file_url || "",
        "Technical Skills": Array.isArray(candidate.technical_skills) ? candidate.technical_skills.join(", ") : "",
      }
    })

    // Create workbook
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(excelData)

    // Set column widths
    const colWidths = [
      { wch: 6 },   // S.No
      { wch: 25 },  // Candidate Name
      { wch: 35 },  // Email
      { wch: 18 },  // Phone
      { wch: 30 },  // Current Job Title
      { wch: 25 },  // Current Company
      { wch: 18 },  // Total Experience
      { wch: 20 },  // Current Location
      { wch: 18 },  // Pipeline Stage
      { wch: 12 },  // Origin
      { wch: 20 },  // Source
      { wch: 14 },  // Match Score
      { wch: 14 },  // Applied Date
      { wch: 40 },  // Resume Link
      { wch: 50 },  // Technical Skills
    ]
    ws["!cols"] = colWidths

    const sheetName = `Pipeline_${job?.title?.replace(/[^a-zA-Z0-9]/g, "_") || "Export"}`
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))

    // Generate buffer
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })

    // Return as file download
    const fileName = `${job?.title?.replace(/[^a-zA-Z0-9]/g, "_") || "candidates"}_${new Date().toISOString().split("T")[0]}.xlsx`

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    })
  } catch (error: any) {
    console.error("Export error:", error)
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}