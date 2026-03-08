import { NextRequest } from 'next/server';
import axios from 'axios';
import { parseResume } from '@/lib/resume-parser';
import { generateEmbedding } from '@/lib/ai-utils';
import { SupabaseCandidateService } from '@/lib/supabase-candidates';
import { ensureResumeBucketExists } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getInternalAuthContext, hasPermission } from '@/lib/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
];

interface UrlItem {
  url: string;
  fileName?: string;
}

interface ProgressEvent {
  type: 'progress' | 'complete' | 'error';
  done?: number;
  total?: number;
  currentFile?: string;
  summary?: {
    total: number;
    successful: number;
    failed: number;
    errors: { url: string; error: string }[];
  };
  message?: string;
}

function sendEvent(controller: ReadableStreamDefaultController, data: ProgressEvent) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  try {
    controller.enqueue(new TextEncoder().encode(payload));
  } catch {}
}

async function downloadFile(url: string): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const res = await axios.get(url, { responseType: 'stream', timeout: 30000 });
  const contentType = res.headers['content-type'] || 'application/octet-stream';
  const contentDisposition = res.headers['content-disposition'];
  let fileName = url.split('/').pop()?.split('?')[0] || 'resume.pdf';
  if (contentDisposition) {
    const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(contentDisposition);
    if (match) fileName = match[1].replace(/['"]/g, '');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.data) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_FILE_SIZE) throw new Error('File too large');
  }
  return { buffer: Buffer.concat(chunks), mimeType: contentType, fileName };
}

// Process a single file using the exact same logic as upload-resume
async function processFile(
  file: any,
  candidateId: string,
  existingCandidates: any[],
  buffer?: Buffer
): Promise<{ success: boolean; error?: string; duplicateInfo?: any; candidateData?: any }> {
  try {
    // Check for duplicate resumes before processing
    console.log('Checking for duplicate resumes...');
    
    // Check for duplicates based on multiple criteria
    const duplicateChecks = [
      // Check by exact email match
      existingCandidates.find(c => c.email && c.email.toLowerCase() === file.name.toLowerCase()),
      // Check by name + phone combination
      existingCandidates.find(c => 
        c.name?.toLowerCase() === file.name.toLowerCase() && 
        c.phone && c.phone === file.name
      ),
      // Check by exact phone match (if phone exists)
      existingCandidates.find(c => c.phone === file.name)
    ].filter(Boolean);

    if (duplicateChecks.length > 0) {
      const duplicate = duplicateChecks[0];
      console.log('Duplicate resume detected:', duplicate);
      
      return {
        success: false,
        error: 'Resume already exists',
        duplicateInfo: {
          existingName: duplicate.name,
          existingId: duplicate.id,
          uploadedAt: duplicate.uploadedAt,
          reason: `Candidate with ${duplicate.email ? 'email' : duplicate.phone ? 'phone' : 'name'} already exists in database`
        }
      };
    }

    // Parse the resume to get candidate information
    console.log('Starting resume parsing...');
    let parsedData;
    let parsingError: string | null = null;
    
    try {
      parsedData = await parseResume(file);
      console.log('✅ Resume parsing successful');
    } catch (parseError) {
      console.error('❌ Resume parsing failed:', parseError);
      parsingError = parseError instanceof Error ? parseError.message : 'Unknown parsing error';
      
      return {
        success: false,
        error: `Resume parsing failed: ${parsingError}`
      };
    }

    if (!parsedData.resumeText) {
      return {
        success: false,
        error: 'No text extracted from resume'
      };
    }

    // Upload file to Supabase Storage using buffer directly
      console.log('Uploading to Supabase Storage...');
      
      // Generate a hash of the file content to use as part of the filename
      const fileBuffer = buffer || await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      
      // Use the first 10 chars of hash in filename for identification
      const fileExt = file.name.split('.').pop();
      const fileName = `${candidateId}-${hashHex.substring(0, 10)}.${fileExt}`;
      
      // Create a Blob from the buffer for upload
      const fileBlob = new Blob([fileBuffer], { type: file.type });
     
     // Upload the file directly to Supabase Storage
     const { data, error } = await supabaseAdmin.storage
       .from('resume-files')
       .upload(fileName, fileBlob, {
         cacheControl: '3600',
         upsert: false
       });
     
     if (error) {
       throw new Error(`Failed to upload to Supabase Storage: ${error.message}`);
     }
     
     // Get the public URL
     const { data: { publicUrl } } = supabaseAdmin.storage
       .from('resume-files')
       .getPublicUrl(data.path);
     
     const fileUrl = publicUrl;
     const filePath = data.path;

    // Generate embedding for vector search (optional)
    console.log('Generating embedding...');
    let embedding: number[] = [];
    try {
      embedding = await generateEmbedding(parsedData.resumeText);
      console.log('✅ Embedding generated successfully');
    } catch (embeddingError) {
      console.warn('⚠️ Failed to generate embedding:', embeddingError);
      // Continue without embedding
    }

    // Prepare candidate data for Supabase (matching upload-resume exactly)
    const candidateData = {
      // Basic Information
      name: parsedData.name,
      email: parsedData.email || '',
      phone: parsedData.phone || '',
      dateOfBirth: parsedData.dateOfBirth || '',
      gender: parsedData.gender || '',
      maritalStatus: parsedData.maritalStatus || '',
      currentRole: parsedData.currentRole || 'Not specified',
      desiredRole: parsedData.desiredRole || '',
      currentCompany: parsedData.currentCompany || '',
      location: parsedData.location || 'Not specified',
      preferredLocation: parsedData.preferredLocation || '',
      totalExperience: parsedData.totalExperience || 'Not specified',
      currentSalary: parsedData.currentSalary || '',
      expectedSalary: parsedData.expectedSalary || '',
      noticePeriod: parsedData.noticePeriod || '',
      highestQualification: parsedData.highestQualification || '',
      degree: parsedData.degree || '',
      specialization: parsedData.specialization || '',
      university: parsedData.university || '',
      educationYear: parsedData.educationYear || '',
      educationPercentage: parsedData.educationPercentage || '',
      additionalQualifications: parsedData.additionalQualifications || '',
      technicalSkills: parsedData.technicalSkills || [],
      softSkills: parsedData.softSkills || [],
      languagesKnown: parsedData.languagesKnown || [],
      certifications: parsedData.certifications || [],
      previousCompanies: parsedData.previousCompanies || [],
      jobTitles: parsedData.jobTitles || [],
      workDuration: parsedData.workDuration || [],
      keyAchievements: parsedData.keyAchievements || [],
      workExperience: parsedData.workExperience || [],
      education: parsedData.education || [],

      // Additional Information
      projects: parsedData.projects || [],
      awards: parsedData.awards || [],
      publications: parsedData.publications || [],
      references: parsedData.references || [],
      linkedinProfile: parsedData.linkedinProfile || '',
      portfolioUrl: parsedData.portfolioUrl || '',
      githubProfile: parsedData.githubProfile || '',
      summary: parsedData.summary || '',

      // File Information
      resumeText: parsedData.resumeText,
      fileName: file.name,
      filePath: filePath,
      fileUrl: fileUrl,

      // Vector embedding (optional)
      embedding,

      // System Fields
      status: 'new' as const,
      tags: [],
      rating: undefined,
      notes: '',
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastContacted: '',
      interviewStatus: 'not-scheduled' as const,
      feedback: '',
      
      // Parsing metadata (exactly like upload-resume)
      parsing_method: 'gemini',
      parsing_confidence: 0.95,
      parsing_errors: [],
    };

    // Add to Supabase
    console.log('Adding to Supabase...');
    await SupabaseCandidateService.addCandidate(candidateData);

    return {
      success: true,
      candidateData: {
        candidateId,
        fileUrl: fileUrl,
        name: parsedData.name,
        email: parsedData.email,
        phone: parsedData.phone,
        resumeText: parsedData.resumeText,
        // Add other properties as needed but exclude fileUrl from spread
        ...Object.fromEntries(Object.entries(parsedData).filter(([key]) => key !== 'fileUrl'))
      }
    };
  } catch (error) {
    console.error('Process file error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getInternalAuthContext(req)
  if (!ctx) return new Response('Unauthorized', { status: 401 })
  if (!hasPermission(ctx, 'candidates.edit')) return new Response('Forbidden', { status: 403 })

  const body = await req.json();
  const rawUrls: string[] = body.urls || [];
  if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
    return new Response('Missing urls array', { status: 400 });
  }

  const items: UrlItem[] = rawUrls.map((line) => {
    const [url, fileName] = line.split('|').map((s) => s.trim());
    return { url, fileName };
  });

  const stream = new ReadableStream({
    async start(controller) {
      const summary = { total: items.length, successful: 0, failed: 0, errors: [] as { url: string; error: string }[] };
      
      // Ensure the Supabase bucket exists (same as upload-resume)
      await ensureResumeBucketExists();
      
      // Get all existing candidates for duplicate checking
      console.log('Fetching existing candidates for duplicate checking...');
      const existingCandidates = await SupabaseCandidateService.getAllCandidates();
      
      sendEvent(controller, { type: 'progress', done: 0, total: summary.total, currentFile: '' });

      for (let i = 0; i < items.length; i++) {
        const { url, fileName } = items[i];
        try {
          sendEvent(controller, { type: 'progress', done: i, total: summary.total, currentFile: fileName || url });

          // Download the file
           const { buffer, mimeType, fileName: detectedName } = await downloadFile(url);
          
          // Validate file type (same as upload-resume)
          if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
            // Check if it's a DOCX/DOC file with wrong MIME type
            const fileNameLower = (fileName || detectedName).toLowerCase();
            if (fileNameLower.endsWith('.docx') || fileNameLower.endsWith('.doc')) {
              console.log(`⚠️ File has wrong MIME type: ${mimeType}, but extension suggests Word document. Proceeding anyway...`);
            } else {
              throw new Error(`Invalid file type: ${mimeType}. Only PDF, DOCX, DOC, and TXT files are allowed.`);
            }
          }

          // Create a mock file object with buffer for parsing (same as upload-resume reuse pattern)
           const mockFile = {
             name: fileName || detectedName,
             type: mimeType,
             size: buffer.length,
             arrayBuffer: () => Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
             text: () => buffer.toString('utf-8'),
             slice: (start?: number, end?: number) => {
               const slicedBuffer = buffer.slice(start || 0, end || buffer.length);
               return {
                 arrayBuffer: () => Promise.resolve(slicedBuffer.buffer.slice(slicedBuffer.byteOffset, slicedBuffer.byteOffset + slicedBuffer.byteLength)),
                 text: () => slicedBuffer.toString('utf-8')
               };
             }
           };
 
           // Generate unique candidate ID
           const candidateId = crypto.randomUUID();
 
           // Process the file using the exact same logic as upload-resume
           const result = await processFile(mockFile as any, candidateId, existingCandidates, buffer);

          if (result.success) {
            summary.successful++;
          } else {
            summary.failed++;
            summary.errors.push({ url, error: result.error || 'Unknown error' });
          }
        } catch (err: any) {
          logger.error(`Bulk import error for ${url}`, err);
          summary.failed++;
          summary.errors.push({ url, error: err.message || 'Unknown error' });
        }
      }

      sendEvent(controller, { type: 'complete', summary });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
