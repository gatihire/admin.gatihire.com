import { NextRequest, NextResponse } from 'next/server'
import { BulkResumeParser } from '@/lib/bulk-resume-parser'
import { getInternalAuthContext, hasPermission } from '@/lib/internal-auth'

export async function POST(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const formData = await request.formData()
    const files = formData.getAll('files') as File[]
    
    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided' },
        { status: 400 }
      )
    }

    // Validate file types
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ]

    const invalidFiles = files.filter(file => !allowedTypes.includes(file.type))
    if (invalidFiles.length > 0) {
      return NextResponse.json(
        { 
          error: 'Invalid file types detected',
          invalidFiles: invalidFiles.map(f => f.name)
        },
        { status: 400 }
      )
    }

    // Estimate cost
    const costEstimate = BulkResumeParser.estimateCost(files.length)
    
    console.log(`💰 Cost estimate for ${files.length} files:`)
    console.log(`   Input tokens: ${costEstimate.estimatedTokens.toLocaleString()}`)
    console.log(`   Estimated cost: $${costEstimate.estimatedCost.toFixed(4)}`)
    console.log(`   Input cost: $${costEstimate.breakdown.inputCost.toFixed(4)}`)
    console.log(`   Output cost: $${costEstimate.breakdown.outputCost.toFixed(4)}`)

    // Start bulk parsing
    const result = await BulkResumeParser.parseBulkResumes(
      files,
      (progress) => {
        console.log(`📊 Progress: ${progress.processed}/${progress.total} - ${progress.current}`)
      }
    )

    return NextResponse.json({
      success: true,
      message: `Successfully processed ${result.successful} out of ${files.length} files`,
      results: {
        total: files.length,
        successful: result.successful,
        failed: result.failed,
        candidateIds: result.candidateIds
      },
      costEstimate,
      errors: result.errors
    })

  } catch (error) {
    console.error('Bulk parsing failed:', error)
    
    return NextResponse.json(
      { 
        error: 'Bulk parsing failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "candidates.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const jobs = await BulkResumeParser.getAllParsingJobs()
    
    return NextResponse.json({
      success: true,
      jobs
    })
  } catch (error) {
    console.error('Failed to fetch parsing jobs:', error)
    
    return NextResponse.json(
      { error: 'Failed to fetch parsing jobs' },
      { status: 500 }
    )
  }
}
