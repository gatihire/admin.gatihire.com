import { GoogleGenerativeAI } from "@google/generative-ai"
import { emailRegex, phoneRegex } from "./regexPatterns"
import pdfParse from "pdf-parse"
import mammoth from "mammoth"
import JSZip from "jszip"
import { ComprehensiveCandidateData } from "./types"
import axios from "axios"

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null
const openRouterApiKey = process.env.OPENROUTER_API_KEY || ""

let lastGeminiCallAt = 0
let geminiCallChain: Promise<void> = Promise.resolve()

async function geminiBackoffWait(attempt: number) {
  const base = 800
  const jitter = Math.floor(Math.random() * 250)
  const ms = base * Math.pow(2, attempt) + jitter
  await new Promise((r) => setTimeout(r, ms))
}

async function geminiBackoffWaitFor(status: number, attempt: number) {
  const base = status === 429 ? 3000 : 800
  const jitter = Math.floor(Math.random() * 350)
  const ms = base * Math.pow(2, attempt) + jitter
  await new Promise((r) => setTimeout(r, ms))
}

async function enforceMinGeminiSpacing(minMs = 700) {
  const now = Date.now()
  const wait = lastGeminiCallAt ? Math.max(0, minMs - (now - lastGeminiCallAt)) : 0
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait))
  }
  lastGeminiCallAt = Date.now()
}

function getGeminiErrorStatus(e: any): number {
  return Number(e?.status || e?.response?.status || 0)
}

function isTransientGeminiError(e: any): boolean {
  const status = getGeminiErrorStatus(e)
  const msg = String(e?.message || e)
  return (
    status === 429 ||
    status === 503 ||
    status === 504 ||
    /overloaded|resource exhausted|try again later|timeout/i.test(msg)
  )
}

async function runGeminiCall<T>(
  fn: () => Promise<T>,
  opts?: { minSpacingMs?: number; maxAttempts?: number },
): Promise<T> {
  const minSpacingMs = typeof opts?.minSpacingMs === "number" ? opts.minSpacingMs : 900
  const maxAttempts = typeof opts?.maxAttempts === "number" ? opts.maxAttempts : 5

  const run = async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await enforceMinGeminiSpacing(minSpacingMs)
        return await fn()
      } catch (e: any) {
        if (isTransientGeminiError(e) && attempt < maxAttempts - 1) {
          const status = getGeminiErrorStatus(e)
          await geminiBackoffWaitFor(status, attempt)
          continue
        }
        throw e
      }
    }
    throw new Error("Gemini request failed after retries")
  }

  const p = geminiCallChain.then(run, run)
  geminiCallChain = p.then(
    () => undefined,
    () => undefined,
  )
  return p
}

export async function parseResume(file: any): Promise<ComprehensiveCandidateData> {
  try {
    console.log(`=== Starting Resume Parsing for ${file.name} ===`)

    const extractedText = await extractTextFromFile(file)

    const assessment = await assessResumeDocument(extractedText)
    if (!assessment.isResume) {
      const err: any = new Error(assessment.reason)
      err.code = "NOT_RESUME"
      err.assessment = assessment
      throw err
    }

    let geminiUnavailableReason: string | null = null

    // Try Gemini parsing
    try {
      if (genAI) {
        console.log("Attempting Gemini parsing...")
        const result = await parseResumeWithGemini(file, extractedText)
        if (isValidParsedData(result)) {
          console.log("✅ Gemini parsing successful")
          return {
            ...result,
            filePath: "",
            fileUrl: "",
            parsing_method: "gemini",
            parsing_confidence: 0.95,
            parsing_errors: [],
          } as unknown as ComprehensiveCandidateData
        } else {
          console.log("⚠️ Gemini parsing failed validation, trying basic parsing...")
        }
      }
    } catch (error: any) {
      const status = Number(error?.status || error?.response?.status || 0)
      if (status === 429) geminiUnavailableReason = "gemini_rate_limited"
      if (status === 503) geminiUnavailableReason = "gemini_overloaded"
      const msg = String(error?.message || error)
      console.log(`⚠️ Gemini parsing failed (${status || "unknown"}): ${msg}`)
    }

    // Fallback to enhanced basic parsing
    console.log("Falling back to enhanced basic parsing...")
    const result = await parseResumeBasic(file, extractedText)
    
    if (isValidParsedData(result)) {
      console.log("✅ Enhanced basic parsing successful")
      return {
        ...result,
        filePath: "",
        fileUrl: "",
        parsing_method: "basic",
        parsing_confidence: 0.6,
        parsing_errors: geminiUnavailableReason ? [geminiUnavailableReason] : [],
      } as unknown as ComprehensiveCandidateData
    } else {
      console.log("❌ All parsing methods failed validation")
      throw new Error("Failed to extract valid candidate information from resume")
    }
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`❌ Resume parsing completely failed: ${msg}`)
    throw error
  }
}

async function assessResumeDocument(text: string): Promise<{ isResume: boolean; reason: string; confidence: number; docType: string }> {
  const raw = String(text || "")
  const t = raw.trim()
  if (!t || t.length < 50) {
    return {
      isResume: false,
      docType: "unreadable",
      confidence: 0.9,
      reason: "No readable resume text found. The file may be scanned, corrupted, or not a resume.",
    }
  }

  if (looksLikePdfStructure(t)) {
    return {
      isResume: false,
      docType: "pdf_binary_or_corrupt",
      confidence: 0.95,
      reason: "The extracted content looks like raw PDF structure (not human-readable). Please upload a valid resume PDF/DOCX.",
    }
  }

  const lower = t.toLowerCase()
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
  const phoneRe = /(\+?\d[\d\s\-()]{7,})/
  const yearRe = /\b(19\d{2}|20\d{2})\b/

  const positiveSignals: Array<[string, number, (s: string) => boolean]> = [
    ["email", 3, (s) => emailRe.test(s)],
    ["phone", 2, (s) => phoneRe.test(s)],
    ["linkedin", 1, (s) => s.includes("linkedin.com")],
    ["education", 2, (s) => /\beducation\b|\bqualification\b|\bdegree\b/i.test(s)],
    ["experience", 2, (s) => /\bexperience\b|\bemployment\b|\bwork history\b/i.test(s)],
    ["skills", 2, (s) => /\bskills\b|\btechnical skills\b|\bcore skills\b/i.test(s)],
    ["projects", 1, (s) => /\bprojects?\b|\bportfolio\b/i.test(s)],
    ["years", 1, (s) => yearRe.test(s)],
  ]

  const negativeSignals: Array<[string, number, (s: string) => boolean]> = [
    ["invoice", 4, (s) => /\binvoice\b|\btax invoice\b|\binvoice no\b/i.test(s)],
    ["receipt", 4, (s) => /\breceipt\b|\bpayment\b|\bpaid\b/i.test(s)],
    ["bank", 4, (s) => /\bbank statement\b|\baccount number\b|\bifsc\b/i.test(s)],
    ["shipping", 3, (s) => /\bawb\b|\btracking\b|\bshipping\b|\bconsignment\b/i.test(s)],
    ["legal", 3, (s) => /\bagreement\b|\bcontract\b|\bterms and conditions\b/i.test(s)],
  ]

  let score = 0
  let negHit: string | null = null
  for (const [name, w, fn] of positiveSignals) {
    if (fn(lower)) score += w
  }
  for (const [name, w, fn] of negativeSignals) {
    if (fn(lower)) {
      score -= w
      if (!negHit) negHit = name
    }
  }

  if (score >= 4) {
    return { isResume: true, docType: "resume", confidence: 0.8, reason: "Looks like a resume." }
  }

  const hasEmail = emailRe.test(lower)
  const hasPhone = phoneRe.test(lower)
  const hasLinkedIn = lower.includes("linkedin.com")
  const hasContactSignal = hasEmail || hasPhone || hasLinkedIn
  const hasSectionSignal = /\bexperience\b|\bemployment\b|\bwork history\b|\beducation\b|\bskills\b|\bprojects?\b|\bportfolio\b/i.test(lower)
  const hasResumeKeyword = /\bresume\b|\bcv\b/i.test(lower.slice(0, 400))

  if (t.length >= 200 && hasContactSignal && (hasSectionSignal || hasResumeKeyword || score >= 2)) {
    return { isResume: true, docType: "resume", confidence: 0.65, reason: "Resume signals detected." }
  }

  if (score <= -3) {
    return {
      isResume: false,
      docType: negHit ? `non_resume_${negHit}` : "non_resume",
      confidence: 0.85,
      reason: negHit
        ? `This file looks like a ${negHit} rather than a resume.`
        : "This file does not look like a resume.",
    }
  }

  if (!genAI) {
    return {
      isResume: false,
      docType: "unknown",
      confidence: 0.6,
      reason: "Unable to confirm this file is a resume. Please upload a resume PDF/DOCX with clear sections (skills/experience/education).",
    }
  }

  const modelName = process.env.GEMINI_CLASSIFIER_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash"
  const model = genAI.getGenerativeModel({ model: modelName })
  const limited = t.slice(0, 6000)
  const prompt = `Classify the following document text.

Return ONLY valid JSON with keys:
- is_resume (boolean)
- document_type (string, e.g. resume, invoice, receipt, bank_statement, offer_letter, unknown)
- confidence (number 0-1)
- reason (string, short)

Document text:
${limited}`

  try {
    const result: any = await runGeminiCall(() => model.generateContent(prompt), { minSpacingMs: 900, maxAttempts: 4 })
    const content = result.response.text()
    const match = content.match(/\{[\s\S]*\}/)
    const parsed = match ? JSON.parse(match[0]) : null
    const isResume = Boolean(parsed?.is_resume)
    const docType = String(parsed?.document_type || "unknown")
    const conf = Math.max(0, Math.min(1, Number(parsed?.confidence ?? 0.5)))
    const reason = String(parsed?.reason || (isResume ? "Looks like a resume." : "Does not look like a resume."))
    return { isResume, docType, confidence: conf, reason }
  } catch {
    return {
      isResume: false,
      docType: "unknown",
      confidence: 0.6,
      reason: "Unable to confirm this file is a resume. Please upload a resume PDF/DOCX with clear sections (skills/experience/education).",
    }
  }
}

function testRegexOnce(pattern: RegExp, value: string): boolean {
  const flags = pattern.flags.replace(/g/g, "")
  const re = new RegExp(pattern.source, flags)
  return re.test(value)
}

function looksLikePdfStructure(text: string): boolean {
  const t = String(text || "")
  const head = t.slice(0, 2200)
  if (!head) return false
  if (/%PDF-\d/i.test(head)) return true
  if (/\b(xref|startxref|endobj|obj\s*<<|trailer\s*<<)\b/i.test(head)) return true
  const letters = (head.match(/[A-Za-z]/g) || []).length
  const ratio = letters / Math.max(1, head.length)
  return head.length > 600 && ratio < 0.18
}

function isExtractionErrorMarker(text: string): boolean {
  const t = String(text || "").trim()
  if (!t) return false
  return /^(error extracting text from|doc processing error:)/i.test(t)
}

function normalizeForNameMatch(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function isNameConsistentWithText(name: string, resumeText: string): boolean {
  const n = normalizeForNameMatch(name)
  const t = normalizeForNameMatch(resumeText)
  if (!n || !t) return false
  const tokens = n.split(/\s+/).filter((x) => x.length >= 3)
  if (!tokens.length) return false
  const hits = tokens.filter((tok) => t.includes(tok)).length
  return hits >= Math.min(2, tokens.length) || hits >= 1
}

// Function to validate parsed data quality with confidence scoring
function isValidParsedData(data: any): boolean {
  // Must have a valid name (not empty, not "unknown", not just whitespace)
  if (!data.name || 
      data.name.trim() === "" || 
      data.name.toLowerCase() === "unknown" ||
      data.name.toLowerCase() === "not specified" ||
      data.name.length < 2) {
    console.log("❌ Invalid name:", data.name)
    return false
  }

  // Must have readable resume text content
  const resumeText = (data.resumeText || "").trim()
  const resumeTextLooksErroneous = isExtractionErrorMarker(resumeText)
  const resumeTextLooksPdf = looksLikePdfStructure(resumeText)
  if (!resumeText || resumeText.length < 50 || resumeTextLooksErroneous || resumeTextLooksPdf) {
    console.log("❌ Missing or invalid resume content")
    return false
  }

  // Must have at least one of: email, phone, or current role
  if (!data.email && !data.phone && !data.currentRole) {
    console.log("❌ Missing essential contact/professional information")
    return false
  }

  // Guard against hallucinated identity: extracted name must exist in resume text
  if (!isNameConsistentWithText(String(data.name || ""), resumeText)) {
    console.log("❌ Name does not match resume text:", data.name)
    return false
  }

  // Calculate a confidence score based on data completeness
  let confidenceScore = 0;
  
  // Core fields - higher weight
  if (data.name && data.name.trim().length > 2) confidenceScore += 20;
  if (data.email && testRegexOnce(emailRegex, String(data.email))) confidenceScore += 15;
  if (data.phone && testRegexOnce(phoneRegex, String(data.phone))) confidenceScore += 15;
  if (data.currentRole && data.currentRole.trim().length > 2) confidenceScore += 10;
  if (data.currentCompany && data.currentCompany.trim().length > 2) confidenceScore += 10;
  
  // Secondary fields - lower weight
  if (data.totalExperience) confidenceScore += 5;
  if (data.highestQualification) confidenceScore += 5;
  if (data.location) confidenceScore += 5;
  if (Array.isArray(data.technicalSkills) && data.technicalSkills.length > 0) confidenceScore += 5;
  if (Array.isArray(data.previousCompanies) && data.previousCompanies.length > 0) confidenceScore += 5;
  if (data.degree) confidenceScore += 3;
  if (data.university) confidenceScore += 2;
  
  // Work experience and education - additional weight
  if (Array.isArray(data.workExperience) && data.workExperience.length > 0) {
    confidenceScore += 10;
    console.log(`✅ Work experience data found: ${data.workExperience.length} entries`);
  } else {
    console.log("⚠️ No work experience data found");
  }
  
  if (Array.isArray(data.education) && data.education.length > 0) {
    confidenceScore += 10;
    console.log(`✅ Education data found: ${data.education.length} entries`);
  } else {
    console.log("⚠️ No education data found");
  }
  
  console.log(`📊 Parsing confidence score: ${confidenceScore}/120`);
  
  // Only consider high confidence results (threshold can be adjusted)
  const confidenceThreshold = 40;
  if (confidenceScore < confidenceThreshold) {
    console.log(`❌ Confidence score too low: ${confidenceScore} < ${confidenceThreshold}`);
    return false;
  }

  console.log("✅ Data validation passed for:", data.name, `(Confidence: ${confidenceScore})`);
  return true;
}

// Parse resume using Google Gemini
async function parseResumeWithGemini(file: File, preExtractedText?: string): Promise<ComprehensiveCandidateData> {
  if (!genAI) {
    throw new Error("Gemini API not configured")
  }
    
  try {
    console.log("🔄 Starting Gemini parsing...")
    const text = typeof preExtractedText === "string" ? preExtractedText : await extractTextFromFile(file)
    console.log(`📄 Extracted text length: ${text.length} characters`)
    console.log(`📄 First 200 characters: ${text.substring(0, 200)}...`)

    // Limit text to avoid token limits but provide enough context
    const limitedText = text.substring(0, 5000)
    
    const prompt = `You are an expert resume parser with 10+ years of experience in HR and recruitment. Your task is to extract accurate information from this resume and return ONLY a valid JSON object.

CRITICAL INSTRUCTIONS:
1. Return ONLY valid JSON - no explanations, no markdown, no extra text
2. If a field is not found, use empty string "" for text or empty array [] for lists
3. For arrays, ensure each item is a string or object as specified in the schema
4. For experience, calculate total years from all work experience and use format like "5 years" or "3.5 years"
5. For skills, extract ONLY actual skills mentioned in the resume, don't make up generic ones
6. For location, use format like "Mumbai, Maharashtra" or "Delhi, India"
7. For name, extract the actual person's name from the resume header or personal details section
8. For current role, extract the job title they currently hold (most recent position)
9. For current company, extract the company they currently work for (most recent employer)
10. For education, focus on the highest qualification achieved but also extract ALL education history
11. For previous companies, list all companies mentioned in work experience (excluding current)
12. Be very careful with name extraction - look for patterns like "Name:", "Full Name:", or prominent text at the top
13. IMPORTANT: Extract ALL work experience and education history as structured arrays with detailed information

NAME EXTRACTION RULES:
- Look for the person's name at the very top of the resume, usually in large/bold text
- Common patterns: "Name: [Name]", "Full Name: [Name]", or just the name prominently displayed
- The name is usually the first thing you see, not project names or company names
- Do not confuse headings, companies, job titles, or projects as the person's name
- Look for personal contact information section which usually contains the name
- The name is typically followed by contact details like phone, email, or address
- DO NOT extract project names, company names, or other text as the person's name
- The name should be a person's name (2-4 words), not a company, project, or section header
- If you are not sure of the name, return an empty string for "name" instead of guessing

ANTI-HALLUCINATION RULE:
- You MUST ONLY extract facts that appear in the provided RESUME TEXT. Do not invent or assume anything.

EXTRACT THESE FIELDS WITH HIGH ACCURACY:
{
  "name": "Full name (required - must be extracted from resume header or personal details)",
  "email": "Email address if found (look for @ symbol)",
  "phone": "Phone number with country code if available (look for patterns like +91, 10 digits)",
  "currentRole": "Current job title/position (most recent work experience)",
  "currentCompany": "Current employer company name (most recent work experience)",
  "location": "Current location (city, state, country) - look for address or location fields",
  "totalExperience": "Total years of experience calculated from all work experience",
  "highestQualification": "Highest education level achieved (e.g., 'Master's Degree', 'Bachelor's Degree')",
  "degree": "Specific degree name (e.g., 'B.Tech Computer Science', 'MBA Finance')",
  "university": "University/College name where highest degree was obtained",
  "educationYear": "Year of graduation for highest degree",
  "technicalSkills": ["actual technical skills mentioned in resume"],
  "softSkills": ["actual soft skills mentioned in resume"],
  "languagesKnown": ["languages mentioned in resume"],
  "certifications": ["certifications mentioned in resume"],
  "previousCompanies": ["all companies from work experience excluding current"],
  "keyAchievements": ["key achievements mentioned in resume"],
  "projects": ["projects mentioned in resume"],
  "summary": "Professional summary or objective statement if present",
  
  "workExperience": [
    {
      "company": "Company name",
      "role": "Job title/position",
      "duration": "Duration (e.g., 'Jan 2020 - Present', 'Mar 2018 - Dec 2019')",
      "description": "Job description and responsibilities",
      "achievements": "Notable achievements in this role",
      "location": "Work location if mentioned"
    }
  ],
  
  "education": [
    {
      "degree": "Degree name (e.g., 'B.Tech', 'MBA')",
      "specialization": "Field of study/specialization",
      "institution": "University/College name",
      "year": "Year of graduation",
      "percentage": "Percentage/CGPA if mentioned",
      "location": "Location if mentioned"
    }
  ]
}

RESUME TEXT:
${limitedText}

Return ONLY the JSON object:`

    // Try different Gemini models with fallback (prioritize gemini-3.1-flash-lite which is available)
    const models = [process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview", "gemini-2.5-flash"]
    let lastError = null

    for (const modelName of models) {
      try {
        console.log(`🔄 Trying Gemini model: ${modelName}`)
        // Remove responseMimeType to prevent 400 Bad Request on some API versions
        const model = genAI.getGenerativeModel({ 
          model: modelName
        })
        
        const result: any = await runGeminiCall(() => model.generateContent(prompt), {
          minSpacingMs: 900,
          maxAttempts: 5,
        })
        const content = result.response.text()
        
        // Extract JSON from the response - try multiple approaches
        let parsedData = null
        
        // Method 1: Look for JSON between curly braces
        const jsonMatch = content.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            parsedData = JSON.parse(jsonMatch[0])
          } catch (e) {
          }
        }
        
        // Method 2: Look for JSON after "Return ONLY the JSON object:"
        if (!parsedData) {
          const afterPrompt = content.split("Return ONLY the JSON object:")
          if (afterPrompt.length > 1) {
            try {
              const jsonPart = afterPrompt[1].trim()
              const jsonMatch2 = jsonPart.match(/\{[\s\S]*\}/)
              if (jsonMatch2) {
                parsedData = JSON.parse(jsonMatch2[0])
              }
            } catch (e) {
            }
          }
        }
        
        // Method 3: Try to find any valid JSON in the content
        if (!parsedData) {
          const jsonMatches = content.match(/\{[^{}]*\}/g)
          if (jsonMatches) {
            for (const match of jsonMatches) {
              try {
                parsedData = JSON.parse(match)
                if (parsedData.name && parsedData.name !== "Unknown") {
                  break
                }
              } catch (e) {
                continue
              }
            }
          }
        }

        if (!parsedData) {
          throw new Error("No valid JSON found in Gemini response")
        }
        
        // Validate the extracted name - it should not be a project name or company name
        if (parsedData.name) {
          const suspiciousNames = [
            'railway', 'infrastructure', 'projects', 'tech', 'company', 'ltd', 'pvt', 'inc',
            'corporation', 'enterprise', 'solutions', 'systems', 'platform', 'app', 'web',
            'resume', 'curriculum', 'vitae', 'cv', 'skills', 'experience', 'education',
            'lead', 'engineer', 'developer', 'manager', 'specialist', 'coordinator'
          ]
          
          const nameLower = parsedData.name.toLowerCase()
          const isSuspicious = suspiciousNames.some(word => nameLower.includes(word))
          
          if (isSuspicious) {
            // Try to find a better name in the text
            const namePatterns = [
              /name\s*:\s*([^\n]+)/i,
              /full\s*name\s*:\s*([^\n]+)/i,
              /^([A-Z][a-z]+\s+[A-Z][a-z]+)/m,
              /^([A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+)/m
            ]
            
            for (const pattern of namePatterns) {
              const match = text.match(pattern)
              if (match && match[1]) {
                const potentialName = match[1].trim()
                if (potentialName.length > 2 && !suspiciousNames.some(word => potentialName.toLowerCase().includes(word))) {
                  parsedData.name = potentialName
                  break
                }
              }
            }
            
            // If still suspicious, try to find the actual person's name from the resume
            if (isSuspicious) {
              const actualName = extractActualPersonName(text)
              if (actualName) {
                parsedData.name = actualName
              }
            }
          }
        }

        // Validate and clean the parsed data
        const cleanedData = {
          name: cleanString(parsedData.name),
          email: cleanString(parsedData.email),
          phone: cleanString(parsedData.phone),
          currentRole: cleanString(parsedData.currentRole),
          currentCompany: cleanString(parsedData.currentCompany),
          location: cleanString(parsedData.location),
          totalExperience: cleanString(parsedData.totalExperience),
          highestQualification: cleanString(parsedData.highestQualification),
          degree: cleanString(parsedData.degree),
          university: cleanString(parsedData.university),
          educationYear: cleanString(parsedData.educationYear),
          technicalSkills: cleanArray(parsedData.technicalSkills),
          softSkills: cleanArray(parsedData.softSkills),
          languagesKnown: cleanArray(parsedData.languagesKnown),
          certifications: cleanArray(parsedData.certifications),
          previousCompanies: cleanArray(parsedData.previousCompanies),
          keyAchievements: cleanArray(parsedData.keyAchievements),
          projects: cleanArray(parsedData.projects),
          summary: cleanString(parsedData.summary)
        }

        const emailsInText = (text.match(emailRegex) || []).map((e) => e.trim()).filter(Boolean)
        const phonesInText = (text.match(phoneRegex) || []).map((p) => p.trim()).filter(Boolean)
        const emailFromText = emailsInText.length ? emailsInText[0] : ""
        const phoneFromText = phonesInText.sort((a, b) => b.length - a.length)[0] || ""

        if (emailFromText && (!cleanedData.email || !text.toLowerCase().includes(cleanedData.email.toLowerCase()))) {
          cleanedData.email = emailFromText
        }

        if (phoneFromText && (!cleanedData.phone || !text.includes(cleanedData.phone))) {
          cleanedData.phone = phoneFromText
        }

        if (cleanedData.name && !isNameConsistentWithText(cleanedData.name, text)) {
          const actualName = extractActualPersonName(text) || extractNameFromText(text)
          if (actualName) {
            cleanedData.name = actualName
          }
        }

        // Enhanced validation and correction
        if (!cleanedData.name || cleanedData.name === "Unknown" || cleanedData.name.length < 2) {
          // Try to extract name from resume text if Gemini failed
          const nameFromText = extractNameFromText(text)
          if (nameFromText) {
            cleanedData.name = nameFromText
          }
        }

        // Improve location if not found
        if (!cleanedData.location || cleanedData.location === "Not specified") {
          const locationFromText = extractLocationFromText(text)
          if (locationFromText) {
            cleanedData.location = locationFromText
          }
        }

        // Improve current role if not found
        if (!cleanedData.currentRole || cleanedData.currentRole === "Not specified") {
          const roleFromText = extractRoleFromText(text)
          if (roleFromText) {
            cleanedData.currentRole = roleFromText
          }
        }

        // Improve experience if not found
        if (!cleanedData.totalExperience || cleanedData.totalExperience === "Not specified") {
          const expFromText = extractExperienceFromText(text)
          if (expFromText) {
            cleanedData.totalExperience = expFromText
          }
        }
        
        // Map to ComprehensiveCandidateData format with CORRECT field mapping
        const candidateData: ComprehensiveCandidateData = {
          // Basic Information - Columns A-G
          name: cleanedData.name || "Unknown Name",                    // Column B: Name
          email: cleanedData.email || "",                              // Column C: Email
          phone: cleanedData.phone || "",                              // Column D: Phone
          dateOfBirth: "",                                             // Column E: Date of Birth
          gender: "",                                                  // Column F: Gender
          maritalStatus: "",                                           // Column G: Marital Status
          
          // Professional Information - Columns H-P
          currentRole: cleanedData.currentRole || "Not specified",     // Column H: Current Role
          desiredRole: "",                                             // Column I: Desired Role
          currentCompany: cleanedData.currentCompany || "",            // Column J: Current Company
          location: cleanedData.location || "Not specified",          // Column K: Location
          preferredLocation: "",                                       // Column L: Preferred Location
          totalExperience: cleanedData.totalExperience || "Not specified", // Column M: Total Experience
          currentSalary: "",                                           // Column N: Current Salary
          expectedSalary: "",                                          // Column O: Expected Salary
          noticePeriod: "",                                            // Column P: Notice Period
          
          // Education Details - Columns Q-V
          highestQualification: cleanedData.highestQualification || "", // Column Q: Highest Qualification
          degree: cleanedData.degree || "",                            // Column R: Degree
          specialization: "",                                          // Column S: Specialization
          university: cleanedData.university || "",                    // Column T: University/College
          educationYear: cleanedData.educationYear || "",              // Column U: Education Year
          educationPercentage: "",                                     // Column V: Education Percentage/CGPA
          additionalQualifications: "",                                // Column W: Additional Qualifications
          
          // Skills & Expertise - Columns X-AA
          technicalSkills: cleanedData.technicalSkills,                // Column X: Technical Skills
          softSkills: cleanedData.softSkills,                         // Column Y: Soft Skills
          languagesKnown: cleanedData.languagesKnown,                  // Column Z: Languages Known
          certifications: cleanedData.certifications,                  // Column AA: Certifications
          
          // Work Experience - Columns AB-AE
          previousCompanies: cleanedData.previousCompanies,            // Column AB: Previous Companies
          jobTitles: [],                                               // Column AC: Job Titles
          workDuration: [],                                            // Column AD: Work Duration
          keyAchievements: cleanedData.keyAchievements,                // Column AE: Key Achievements
          workExperience: parsedData.workExperience || [],             // Column AF: Work Experience Details
          education: parsedData.education || [],                       // Column AG: Education Details
          
          // Additional Information - Columns AH-AM
          projects: cleanedData.projects,                              // Column AH: Projects
          awards: [],                                                  // Column AI: Awards
          publications: [],                                            // Column AJ: Publications
          references: [],                                              // Column AK: References
          linkedinProfile: "",                                         // Column AL: LinkedIn Profile
          portfolioUrl: "",                                            // Column AM: Portfolio URL
          githubProfile: "",                                           // Column AN: GitHub Profile
          summary: cleanedData.summary || "",                          // Column AO: Summary/Objective
          
          // File Information - Columns AP-AT
          resumeText: text,                                            // Column AP: Resume Text
          fileName: file.name,                                         // Column AQ: File Name
          filePath: "",                                             // Column AR: Supabase Storage File Path
           fileUrl: "",                                                // Column AS: Supabase Storage File URL
          
          // System Fields - Columns AT-BB
          status: "new" as const,                                     // Column AT: Status
          tags: [],                                                    // Column AU: Tags
          rating: undefined,                                           // Column AV: Rating
          notes: "",                                                   // Column AW: Notes
          uploadedAt: new Date().toISOString(),                        // Column AX: Uploaded At
          updatedAt: new Date().toISOString(),                         // Column AY: Updated At
          lastContacted: "",                                           // Column AZ: Last Contacted
          interviewStatus: "not-scheduled" as const,                   // Column BA: Interview Status
          feedback: "",                                                // Column BB: Feedback
        }

        console.log("✅ Gemini parsing completed successfully")
        console.log("Final parsed data:", {
          name: candidateData.name,
          email: candidateData.email,
          phone: candidateData.phone,
          currentRole: candidateData.currentRole,
          currentCompany: candidateData.currentCompany,
          location: candidateData.location,
          totalExperience: candidateData.totalExperience,
          technicalSkills: candidateData.technicalSkills?.length || 0,
          softSkills: candidateData.softSkills?.length || 0
        })
        
        return candidateData

      } catch (error) {
        console.log(`⚠️ Gemini model ${modelName} failed:`, error)
        lastError = error
        continue
      }
    }

    throw lastError || new Error("All Gemini models failed")

  } catch (error) {
    console.error("❌ Gemini parsing failed:", error)
    throw error
  }
}

// Function to categorize skills into technical and soft skills
function categorizeSkills(skills: string[]): { technicalSkills: string[], softSkills: string[] } {
  const technicalSkills = [
    // Logistics & Supply Chain Technical Skills
    "Supply Chain Management", "Logistics Management", "Logistics Operations", "Warehouse Operations",
    "Transportation Management", "Fleet Management", "Inventory Management", "Distribution Management",
    "Procurement", "FASTag", "GPS Tracking", "Route Optimization", "WMS", "TMS", "ERP Systems",
    "SAP", "Microsoft Excel", "Data Analysis", "Reporting Tools", "Automation",
    // IT & Programming Skills
    "JavaScript", "Python", "Java", "React", "Node.js", "SQL", "MongoDB", "AWS", "Docker", "Git",
    "HTML", "CSS", "TypeScript", "Angular", "Vue.js", "PHP", "C++", "C#", "Ruby", "Go", "Rust",
    "Kubernetes", "Jenkins", "Jira", "Confluence"
  ]

  const softSkills = [
    // Leadership & Management
    "Leadership", "Team Leadership", "Team Leads", "Management", "Supervision", "Mentoring", "Coaching",
    // Communication & Interpersonal
    "Communication", "Customer Service", "Customer Relationship Management", "Interpersonal Skills",
    "Presentation Skills", "Negotiation", "Conflict Resolution",
    // Problem Solving & Analytical
    "Problem Solving", "Problem Resolution", "Critical Thinking", "Analytical Skills", "Decision Making",
    "Strategic Thinking",
    // Organization & Planning
    "Organization", "Organizational Skills", "Planning", "Time Management", "Project Management",
    "Resource Management", "Resource Balancing", "Multi-tasking",
    // Teamwork & Collaboration
    "Teamwork", "Collaboration", "Relationship Management", "Cross-functional Collaboration",
    "Stakeholder Management",
    // Adaptability & Learning
    "Adaptability", "Flexibility", "Learning Agility", "Continuous Learning", "Innovation", "Creativity",
    // Work Ethic
    "Attention to Detail", "Quality Focus", "Results-oriented", "Self-motivated", "Initiative", "Reliability"
  ]

  const categorized = { technicalSkills: [] as string[], softSkills: [] as string[] }

  for (const skill of skills) {
    const lowerSkill = skill.toLowerCase()
    
    // Check if it's a technical skill
    if (technicalSkills.some(techSkill => 
      lowerSkill.includes(techSkill.toLowerCase()) || 
      techSkill.toLowerCase().includes(lowerSkill)
    )) {
      if (categorized.technicalSkills.length < 8) {
        categorized.technicalSkills.push(skill)
      }
    }
    // Check if it's a soft skill
    else if (softSkills.some(softSkill => 
      lowerSkill.includes(softSkill.toLowerCase()) || 
      softSkill.toLowerCase().includes(lowerSkill)
    )) {
      if (categorized.softSkills.length < 8) {
        categorized.softSkills.push(skill)
      }
    }
    // If unclear, add to technical skills if it sounds technical
    else if (lowerSkill.includes('management') || 
             lowerSkill.includes('system') || 
             lowerSkill.includes('software') || 
             lowerSkill.includes('technology') ||
             lowerSkill.includes('operation') ||
             lowerSkill.includes('logistics') ||
             lowerSkill.includes('supply') ||
             lowerSkill.includes('warehouse') ||
             lowerSkill.includes('transport')) {
      if (categorized.technicalSkills.length < 8) {
        categorized.technicalSkills.push(skill)
      }
    }
    // Otherwise add to soft skills
    else {
      if (categorized.softSkills.length < 8) {
        categorized.softSkills.push(skill)
      }
    }
  }

  return categorized
}

// Enhanced name extraction function
function extractNameFromText(text: string): string {
  const lines = text.split('\n')
  
  for (const line of lines) {
    const trimmedLine = line.trim()
    
    // Skip empty lines and common headers
    if (!trimmedLine || 
        trimmedLine.toLowerCase().includes('resume') ||
        trimmedLine.toLowerCase().includes('cv') ||
        trimmedLine.toLowerCase().includes('curriculum vitae') ||
        trimmedLine.toLowerCase().includes('phone') ||
        trimmedLine.toLowerCase().includes('email') ||
        trimmedLine.toLowerCase().includes('address')) {
      continue
    }
    
    // Look for name patterns with more flexibility
    const namePattern = /^[\p{L}][\p{L}\s\.\-']{2,50}$/u
    if (namePattern.test(trimmedLine) && trimmedLine.split(' ').length >= 2 && trimmedLine.split(' ').length <= 4) {
      return trimmedLine
    }
  }
  
  return "Unknown Name"
}

// Function to extract the actual person's name from resume text
function extractActualPersonName(text: string): string | null {
  if (!text) return null
  
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  
  const stopWords = ['resume','curriculum','vitae','cv','skills','experience','education','projects','achievements','objective','summary','profile']
  const contactPattern = /@|phone|mobile|\+?\d/
  const topLimit = Math.min(12, lines.length)
  function isCandidate(s: string) {
    const w = s.split(/\s+/).filter(Boolean)
    if (w.length < 2 || w.length > 4) return false
    if (/^\d|@/.test(s)) return false
    if (s.length < 3 || s.length > 60) return false
    const lettersOnly = w.every(t => /^[\p{L}\-'.]+$/u.test(t))
    return lettersOnly
  }
  const candidates: { name: string; score: number; idx: number }[] = []
  for (let i = 0; i < topLimit; i++) {
    const line = lines[i]
    const lower = line.toLowerCase()
    if (stopWords.some(k => lower.includes(k))) continue
    if (!isCandidate(line)) continue
    let score = 0
    if (i <= 3) score += 2
    if (i <= 5) score += 1
    const next = i + 1 < lines.length ? lines[i + 1].toLowerCase() : ''
    const prev = i > 0 ? lines[i - 1].toLowerCase() : ''
    if (contactPattern.test(next) || contactPattern.test(prev)) score += 2
    const words = line.split(/\s+/)
    const uppercaseCount = words.filter(w => w === w.toUpperCase()).length
    if (uppercaseCount === words.length) score += 1
    candidates.push({ name: line, score, idx: i })
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || a.idx - b.idx)
    return candidates[0].name
  }

  if (lines.length) {
    const top = lines[0]
    const cleaned = top.replace(emailRegex, " ").replace(phoneRegex, " ").trim()
    const tokens = cleaned.split(/\s+/).filter((tok) => /^[\p{L}]{2,}$/u.test(tok))
    const stop = new Set(stopWords.map((x) => x.toLowerCase()))
    const nameTokens: string[] = []
    for (const tok of tokens) {
      if (stop.has(tok.toLowerCase())) break
      if (tok.length > 20) break
      nameTokens.push(tok)
      if (nameTokens.length >= 4) break
    }
    if (nameTokens.length >= 2) return nameTokens.join(" ")
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase()
    if (contactPattern.test(l)) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
        const s = lines[j]
        if (isCandidate(s)) {
          const lower = s.toLowerCase()
          if (!stopWords.some(k => lower.includes(k))) return s
        }
      }
    }
  }
  const emails = text.match(emailRegex) || []
  if (emails.length) {
    const firstEmail = emails[0]
    if (firstEmail) {
      const local = firstEmail.split('@')[0]
      const parts = local.split(/[._-]+/).filter(Boolean)
      if (parts.length >= 2 && parts.length <= 4) {
        const name = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
        return name
      }
    }
  }
  return null
}

// Enhanced location extraction function
function extractLocationFromText(text: string): string {
  const locationPatterns = [
    /(?:from|at|in|based in|located in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*[A-Z]{2}/g,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+[A-Z]{2}/g,
    /(?:address|location):\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
  ]
  
  for (const pattern of locationPatterns) {
    const match = text.match(pattern)
    if (match && match[1] && match[1].trim().length > 2) {
      return match[1].trim()
    }
  }
  
  return "Not specified"
}

// Enhanced role extraction function
function extractRoleFromText(text: string): string {
  const rolePatterns = [
    /(?:currently|presently|working as|employed as)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /(?:position|role|title):\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /(?:job|work|employment):\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
  ]
  
  for (const pattern of rolePatterns) {
    const match = text.match(pattern)
    if (match && match[1] && match[1].trim().length > 3) {
      return match[1].trim()
    }
  }
  
  return "Not specified"
}

// Enhanced experience extraction function
function extractExperienceFromText(text: string): string {
  const expPatterns = [
    /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\s*(?:of\s+)?experience/gi,
    /experience[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/gi,
    /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\s*in\s+[A-Za-z\s]+/gi,
    /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\s*work/gi,
  ]
  
  for (const pattern of expPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      return `${match[1]} years`
    }
  }
  
  return "Not specified"
}

// Helper function to extract string values from Affinda objects
function extractStringValue(field: any): string {
  if (!field) return ""
  if (typeof field === "string") return field
  if (field.raw) return field.raw
  if (field.parsed) return field.parsed
  if (field.rawLocation) return field.rawLocation
  if (field.city) return field.city
  return ""
}

// Helper function to extract education section
function extractEducationSection(text: string) {
  const education = []
  let highestQualification = ""

  // Look for education section with multiple patterns
  const educationPatterns = [
    /education[:\s]*([^]*?)(?=work|experience|skills|projects|achievements|$)/i,
    /academic[:\s]*([^]*?)(?=work|experience|skills|projects|achievements|$)/i,
    /qualification[:\s]*([^]*?)(?=work|experience|skills|projects|achievements|$)/i,
    /degree[:\s]*([^]*?)(?=work|experience|skills|projects|achievements|$)/i
  ]

  for (const pattern of educationPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const educationText = match[1]
      
      // Split by potential education entry indicators to separate different education entries
      const educationBlocks = educationText.split(/(?=\b(?:[A-Z][A-Z\s&]+(?:University|College|Institute|School|Academy|Polytechnic)|(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|Present|Current|Now)|(?:Bachelor|Master|PhD|Diploma|B\.Tech|M\.Tech|MBA|B\.Sc|M\.Sc|B\.A|M\.A|B\.Com|M\.Com|B\.E|M\.E)))/i)
        .filter(block => block.trim().length > 10)
      
      for (const block of educationBlocks) {
        const lines = block.split('\n').filter(line => line.trim().length > 0)
        
        let degree = ""
        let specialization = ""
        let university = ""
        let startYear = ""
        let endYear = ""
        let percentage = ""
        let description = ""
        
        // Process each line to extract education details
        for (const line of lines) {
          const cleanLine = line.trim()
          
          // Extract degree with more patterns
          if (!degree) {
            if (cleanLine.toLowerCase().includes('b.tech') || cleanLine.toLowerCase().includes('bachelor') || 
                cleanLine.toLowerCase().includes('ba') || cleanLine.toLowerCase().includes('b.sc') || 
                cleanLine.toLowerCase().includes('b.e') || cleanLine.toLowerCase().includes('b.com')) {
              degree = "Bachelor's"
              if (!highestQualification || 
                  highestQualification === "Diploma" || 
                  highestQualification === "12th" || 
                  highestQualification === "10th") {
                highestQualification = "Bachelor's"
              }
            } else if (cleanLine.toLowerCase().includes('master') || cleanLine.toLowerCase().includes('ms') || 
                      cleanLine.toLowerCase().includes('m.tech') || cleanLine.toLowerCase().includes('m.sc') || 
                      cleanLine.toLowerCase().includes('m.e') || cleanLine.toLowerCase().includes('m.com')) {
              degree = "Master's"
              if (!highestQualification || 
                  highestQualification === "Bachelor's" || 
                  highestQualification === "Diploma" || 
                  highestQualification === "12th" || 
                  highestQualification === "10th") {
                highestQualification = "Master's"
              }
            } else if (cleanLine.toLowerCase().includes('mba')) {
              degree = "MBA"
              if (!highestQualification || 
                  highestQualification === "Bachelor's" || 
                  highestQualification === "Diploma" || 
                  highestQualification === "12th" || 
                  highestQualification === "10th") {
                highestQualification = "MBA"
              }
            } else if (cleanLine.toLowerCase().includes('phd') || cleanLine.toLowerCase().includes('doctorate')) {
              degree = "PhD"
              highestQualification = "PhD"
            } else if (cleanLine.toLowerCase().includes('diploma')) {
              degree = "Diploma"
              if (!highestQualification || 
                  highestQualification === "12th" || 
                  highestQualification === "10th") {
                highestQualification = "Diploma"
              }
            } else if (cleanLine.toLowerCase().includes('12th') || cleanLine.toLowerCase().includes('hsc') || 
                      cleanLine.toLowerCase().includes('intermediate') || cleanLine.toLowerCase().includes('higher secondary')) {
              degree = "12th"
              if (!highestQualification || highestQualification === "10th") {
                highestQualification = "12th"
              }
            } else if (cleanLine.toLowerCase().includes('10th') || cleanLine.toLowerCase().includes('ssc') || 
                      cleanLine.toLowerCase().includes('matric') || cleanLine.toLowerCase().includes('secondary')) {
              degree = "10th"
              if (!highestQualification) {
                highestQualification = "10th"
              }
            }
          }
          
          // Extract specialization
          if (!specialization && degree) {
            const specMatch = cleanLine.match(/(?:in|of)\s+([A-Za-z\s&]+)(?:from|at|,|\.|$)/i)
            if (specMatch) {
              specialization = specMatch[1].trim()
            } else if (cleanLine.includes('Computer Science') || cleanLine.includes('Information Technology') || 
                      cleanLine.includes('Electronics') || cleanLine.includes('Mechanical') || 
                      cleanLine.includes('Civil') || cleanLine.includes('Electrical')) {
              specialization = cleanLine
            }
          }
          
          // Extract university/college name
          if (!university) {
            const uniMatch = cleanLine.match(/([A-Z][a-zA-Z\s&.,]+(?:University|College|Institute|School|Academy|Polytechnic))/i)
            if (uniMatch) {
              university = uniMatch[1].trim()
            }
          }
          
          // Extract years
          if (!endYear) {
            const yearMatch = cleanLine.match(/(\d{4})\s*[-–—]\s*(\d{4}|Present|Current|Now)/i)
            if (yearMatch) {
              startYear = yearMatch[1]
              endYear = yearMatch[2]
            } else {
              const singleYearMatch = cleanLine.match(/(\d{4})/)
              if (singleYearMatch) {
                endYear = singleYearMatch[1]
              }
            }
          }
          
          // Extract percentage/grade
          if (!percentage) {
            const percentMatch = cleanLine.match(/(\d+(?:\.\d+)?%?|CGPA\s*:\s*\d+(?:\.\d+)?|GPA\s*:\s*\d+(?:\.\d+)?|pass|fail|distinction|first|second|third)/i)
            if (percentMatch) {
              percentage = percentMatch[0].trim()
            }
          }
          
          // Collect additional description
          if (cleanLine.length > 15 && !cleanLine.includes(degree) && !cleanLine.includes(university)) {
            description += cleanLine + " "
          }
        }
        
        // Only add if we have at least a degree or university
        if (degree || university) {
          education.push({
            degree: degree,
            specialization: specialization,
            university: university,
            startYear: startYear,
            endYear: endYear,
            percentage: percentage,
            description: description.trim()
          })
        }
      }
      
      break
    }
  }
        
  let degree = ""
  let university = ""
  let year = ""
  let specialization = ""
  let percentage = ""

  // If no education section found, try to find education info scattered in text
  if (education.length === 0) {
    const lines = text.split('\n')
    for (const line of lines) {
      const cleanLine = line.trim()
      
      // Look for degree patterns
      if (cleanLine.toLowerCase().includes('b.tech') || cleanLine.toLowerCase().includes('bachelor') || cleanLine.toLowerCase().includes('ba')) {
        degree = "Bachelor's"
        highestQualification = "Bachelor's"
      } else if (cleanLine.toLowerCase().includes('master') || cleanLine.toLowerCase().includes('ms')) {
        degree = "Master's"
        highestQualification = "Master's"
      } else if (cleanLine.toLowerCase().includes('mba')) {
        degree = "MBA"
        highestQualification = "MBA"
      } else if (cleanLine.toLowerCase().includes('phd')) {
        degree = "PhD"
        highestQualification = "PhD"
      } else if (cleanLine.toLowerCase().includes('diploma')) {
        degree = "Diploma"
        highestQualification = "Diploma"
      }
      
      // Look for university names
      if (!university) {
        const uniMatch = cleanLine.match(/([A-Z][a-zA-Z\s&]+(?:University|College|Institute|School))/i)
        if (uniMatch) university = uniMatch[1]
      }
      
      // Look for years
      if (!year) {
        const yearMatch = cleanLine.match(/(\d{4})/)
        if (yearMatch) year = yearMatch[1]
      }
    }
    
    // Add found education if any
    if (degree) {
      education.push({
        degree: degree,
        specialization: specialization,
        institution: university || "Not specified",
        year: year || "Not specified",
        percentage: percentage || "Not specified"
      })
    }
  }

  return {
    education,
    highestQualification: highestQualification || "Not specified",
    degree: degree || "Not specified",
    specialization: specialization || "Not specified",
    university: university || "Not specified",
    year: year || "Not specified",
    percentage: percentage || "Not specified"
  }
}

// Helper function to extract work experience
function extractWorkExperience(text: string) {
  const workExperience = []

  // Look for work experience section with multiple patterns
  const experiencePatterns = [
    /work\s+experience[:\-]?\s*([^]*?)(?=education|skills|projects|achievements|$)/i,
    /experience[:\-]?\s*([^]*?)(?=education|skills|projects|achievements|$)/i,
    /employment[:\-]?\s*([^]*?)(?=education|skills|projects|achievements|$)/i,
    /work\s+history[:\-]?\s*([^]*?)(?=education|skills|projects|achievements|$)/i,
    /professional\s+experience[:\-]?\s*([^]*?)(?=education|skills|projects|achievements|$)/i
  ]

  for (const pattern of experiencePatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const experienceText = match[1]
      
      // Split by potential company or role indicators to separate different experiences
      const experienceBlocks = experienceText.split(/(?=\b(?:[A-Z][A-Z\s&]+|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|Present|Current|Now)))/i)
        .filter(block => block.trim().length > 10)
      
      for (const block of experienceBlocks) {
        const lines = block.split('\n').filter(line => line.trim().length > 0)
        
        let company = ""
        let role = ""
        let duration = ""
        let description = ""
        let responsibilities = []
        let achievements = []
        let technologies = []
        
        // First pass to identify company, role and duration
        for (let i = 0; i < Math.min(5, lines.length); i++) {
          const cleanLine = lines[i].trim()
          
          // Look for company names (usually in caps or followed by dates)
          if (!company && cleanLine.match(/^[A-Z][A-Z\s&.,]+$/) && cleanLine.length > 3) {
            company = cleanLine
            continue
          }
          
          // Look for job titles with more patterns
          if (!role && (
              /(?:executive|manager|engineer|developer|analyst|specialist|coordinator|assistant|officer|supervisor|lead|operator|technician|consultant|director|head|chief|associate|intern)/i.test(cleanLine)
          )) {
            role = cleanLine
            continue
          }
          
          // Look for duration (dates)
          if (!duration && (
              (cleanLine.match(/\d{4}/) && (cleanLine.includes('-') || cleanLine.includes('–') || cleanLine.includes('to') || cleanLine.includes('present'))) ||
              /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\s*[-–—]\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|Present|Current|Now)/i.test(cleanLine)
          )) {
            duration = cleanLine
            continue
          }
        }
        
        // If we couldn't find a company name in the first few lines, try to extract from the block
        if (!company) {
          const companyMatch = block.match(/\b([A-Z][A-Za-z\s&.,]+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Co\.|Group|GmbH)?)\b/)
          if (companyMatch) {
            company = companyMatch[1].trim()
          }
        }
        
        // Second pass to collect description, responsibilities, achievements and technologies
        let inResponsibilities = false
        let inAchievements = false
        let inTechnologies = false
        
        for (let i = 0; i < lines.length; i++) {
          const cleanLine = lines[i].trim()
          
          // Skip lines that are likely part of the header info we already processed
          if (i < 5 && (cleanLine === company || cleanLine === role || cleanLine === duration)) {
            continue
          }
          
          // Check for section indicators
          if (/^responsibilities|^duties|^key\s+responsibilities/i.test(cleanLine)) {
            inResponsibilities = true
            inAchievements = false
            inTechnologies = false
            continue
          } else if (/^achievements|^accomplishments|^key\s+achievements/i.test(cleanLine)) {
            inResponsibilities = false
            inAchievements = true
            inTechnologies = false
            continue
          } else if (/^technologies|^tech\s+stack|^tools|^skills\s+used/i.test(cleanLine)) {
            inResponsibilities = false
            inAchievements = false
            inTechnologies = true
            continue
          }
          
          // Collect information based on current section
          if (inResponsibilities && cleanLine.length > 10) {
            responsibilities.push(cleanLine)
          } else if (inAchievements && cleanLine.length > 10) {
            achievements.push(cleanLine)
          } else if (inTechnologies && cleanLine.length > 3) {
            technologies.push(cleanLine)
          } else if (cleanLine.length > 15) {
            // If line starts with bullet point or number, it's likely a responsibility
            if (cleanLine.match(/^[•\-\*\d\.\[\]]\s+/)) {
              responsibilities.push(cleanLine.replace(/^[•\-\*\d\.\[\]]\s+/, ''))
            } else {
              description += cleanLine + " "
            }
          }
        }
        
        // Only add if we have at least a company or role
        if (company || role) {
          workExperience.push({
            company: company,
            role: role,
            duration: duration,
            description: description.trim(),
            responsibilities: responsibilities,
            achievements: achievements,
            technologies: technologies
          })
        }
      }
      
      break
    }
  }

  // If no experience section found, try to find experience info scattered in text
  if (workExperience.length === 0) {
    const lines = text.split('\n')
    let currentCompany = ""
    let currentRole = ""
    let currentDuration = ""
    
    for (const line of lines) {
      const cleanLine = line.trim()
      
      // Look for company names in caps
      if (cleanLine.match(/^[A-Z][A-Z\s&]+$/) && cleanLine.length > 3 && 
          !cleanLine.toLowerCase().includes('resume') && 
          !cleanLine.toLowerCase().includes('curriculum') &&
          !cleanLine.toLowerCase().includes('vitae')) {
        if (currentCompany && currentRole) {
          workExperience.push({
            company: currentCompany,
            role: currentRole,
            duration: currentDuration,
            description: ""
          })
        }
        currentCompany = cleanLine
        currentRole = ""
        currentDuration = ""
      }
      
      // Look for job titles
      if (cleanLine.toLowerCase().includes('executive') || 
          cleanLine.toLowerCase().includes('manager') || 
          cleanLine.toLowerCase().includes('engineer') || 
          cleanLine.toLowerCase().includes('developer') || 
          cleanLine.toLowerCase().includes('analyst') ||
          cleanLine.toLowerCase().includes('specialist') ||
          cleanLine.toLowerCase().includes('coordinator') ||
          cleanLine.toLowerCase().includes('assistant') ||
          cleanLine.toLowerCase().includes('officer') ||
          cleanLine.toLowerCase().includes('supervisor') ||
          cleanLine.toLowerCase().includes('lead') ||
          cleanLine.toLowerCase().includes('operator') ||
          cleanLine.toLowerCase().includes('technician') ||
          cleanLine.toLowerCase().includes('consultant') ||
          cleanLine.toLowerCase().includes('director') ||
          cleanLine.toLowerCase().includes('head') ||
          cleanLine.toLowerCase().includes('chief')) {
        currentRole = cleanLine
      }
      
      // Look for duration
      if (cleanLine.match(/\d{4}/) && (cleanLine.includes('-') || cleanLine.includes('to') || cleanLine.includes('present'))) {
        currentDuration = cleanLine
      }
    }
    
    // Add the last experience
    if (currentCompany && currentRole) {
      workExperience.push({
        company: currentCompany,
        role: currentRole,
        duration: currentDuration,
        description: ""
      })
    }
  }

  return workExperience
}

// Helper function to extract skills from text
function extractSkillsFromText(text: string) {
  const technicalSkills = []
  const softSkills = []

  // Look for skills section with multiple patterns
  const skillPatterns = [
    /skills?[:\-]?\s*([^]*?)(?=education|work|experience|projects|achievements|$)/i,
    /technical\s+skills?[:\-]?\s*([^]*?)(?=education|work|experience|projects|achievements|$)/i,
    /competencies?[:\-]?\s*([^]*?)(?=education|work|experience|projects|achievements|$)/i,
    /expertise[:\-]?\s*([^]*?)(?=education|work|experience|projects|achievements|$)/i,
    /key\s+skills?[:\-]?\s*([^]*?)(?=education|work|experience|projects|achievements|$)/i,
    /core\s+skills?[:\-]?\s*([^]*?)(?=education|work|experience|projects|achievements|$)/i
  ]

  for (const pattern of skillPatterns) {
    const matches = text.match(pattern)
    if (matches) {
      const skillsText = matches[1]
      const extractedSkills = skillsText
        .split(/[,;|]/)
        .map(skill => skill.trim())
        .filter(skill => skill.length > 2 && skill.length < 50)
      
      // Categorize skills
      for (const skill of extractedSkills) {
        const lowerSkill = skill.toLowerCase()
        
        // Technical skills
        if (lowerSkill.includes('management') || 
            lowerSkill.includes('system') || 
            lowerSkill.includes('software') || 
            lowerSkill.includes('technology') ||
            lowerSkill.includes('operation') ||
            lowerSkill.includes('logistics') ||
            lowerSkill.includes('supply') ||
            lowerSkill.includes('warehouse') ||
            lowerSkill.includes('transport') ||
            lowerSkill.includes('fleet') ||
            lowerSkill.includes('inventory') ||
            lowerSkill.includes('tracking') ||
            lowerSkill.includes('gps') ||
            lowerSkill.includes('erp') ||
            lowerSkill.includes('sap') ||
            lowerSkill.includes('excel') ||
            lowerSkill.includes('analysis') ||
            lowerSkill.includes('reporting') ||
            lowerSkill.includes('automation') ||
            lowerSkill.includes('database') ||
            lowerSkill.includes('sql') ||
            lowerSkill.includes('javascript') ||
            lowerSkill.includes('python') ||
            lowerSkill.includes('java') ||
            lowerSkill.includes('react') ||
            lowerSkill.includes('node') ||
            lowerSkill.includes('aws') ||
            lowerSkill.includes('docker') ||
            lowerSkill.includes('git') ||
            lowerSkill.includes('html') ||
            lowerSkill.includes('css') ||
            lowerSkill.includes('typescript') ||
            lowerSkill.includes('angular') ||
            lowerSkill.includes('vue') ||
            lowerSkill.includes('php') ||
            lowerSkill.includes('c++') ||
            lowerSkill.includes('c#') ||
            lowerSkill.includes('ruby') ||
            lowerSkill.includes('go') ||
            lowerSkill.includes('rust') ||
            lowerSkill.includes('kubernetes') ||
            lowerSkill.includes('jenkins') ||
            lowerSkill.includes('jira') ||
            lowerSkill.includes('confluence')) {
          if (technicalSkills.length < 8) {
            technicalSkills.push(skill)
          }
        }
        // Soft skills
        else if (lowerSkill.includes('leadership') || 
                 lowerSkill.includes('communication') || 
                 lowerSkill.includes('teamwork') || 
                 lowerSkill.includes('problem') ||
                 lowerSkill.includes('planning') ||
                 lowerSkill.includes('organization') ||
                 lowerSkill.includes('time') ||
                 lowerSkill.includes('project') ||
                 lowerSkill.includes('customer') ||
                 lowerSkill.includes('relationship') ||
                 lowerSkill.includes('multi') ||
                 lowerSkill.includes('adaptability') ||
                 lowerSkill.includes('flexibility')) {
          if (softSkills.length < 8) {
            softSkills.push(skill)
          }
        }
        // Default to technical if unclear
        else {
          if (technicalSkills.length < 8) {
            technicalSkills.push(skill)
          }
        }
      }
      break
    }
  }

  // If no skills found in sections, try to extract from scattered text
  if (technicalSkills.length === 0 && softSkills.length === 0) {
    const lines = text.split('\n')
    for (const line of lines) {
      const cleanLine = line.trim()
      
      // Look for skill-like patterns
      if (cleanLine.length > 3 && cleanLine.length < 50 && 
          !cleanLine.includes('@') && 
          !cleanLine.match(/\d{4}/) &&
          !cleanLine.toLowerCase().includes('resume') &&
          !cleanLine.toLowerCase().includes('curriculum') &&
          !cleanLine.toLowerCase().includes('vitae') &&
          !cleanLine.toLowerCase().includes('phone') &&
          !cleanLine.toLowerCase().includes('email') &&
          !cleanLine.toLowerCase().includes('location') &&
          !cleanLine.toLowerCase().includes('address')) {
        
        const lowerLine = cleanLine.toLowerCase()
        
        // Technical skills
        if (lowerLine.includes('management') || 
            lowerLine.includes('system') || 
            lowerLine.includes('software') || 
            lowerLine.includes('technology') ||
            lowerLine.includes('operation') ||
            lowerLine.includes('logistics') ||
            lowerLine.includes('supply') ||
            lowerLine.includes('warehouse') ||
            lowerLine.includes('transport') ||
            lowerLine.includes('fleet') ||
            lowerLine.includes('inventory') ||
            lowerLine.includes('tracking') ||
            lowerLine.includes('gps') ||
            lowerLine.includes('erp') ||
            lowerLine.includes('sap') ||
            lowerLine.includes('excel') ||
            lowerLine.includes('analysis') ||
            lowerLine.includes('reporting')) {
          if (technicalSkills.length < 8) {
            technicalSkills.push(cleanLine)
          }
        }
        // Soft skills
        else if (lowerLine.includes('leadership') || 
                 lowerLine.includes('communication') || 
                 lowerLine.includes('teamwork') || 
                 lowerLine.includes('problem') ||
                 lowerLine.includes('planning') ||
                 lowerLine.includes('organization') ||
                 lowerLine.includes('time') ||
                 lowerLine.includes('project') ||
                 lowerLine.includes('customer') ||
                 lowerLine.includes('relationship') ||
                 lowerLine.includes('multi') ||
                 lowerLine.includes('adaptability') ||
                 lowerLine.includes('flexibility')) {
          if (softSkills.length < 8) {
            softSkills.push(cleanLine)
          }
        }
      }
    }
  }

  return { technicalSkills, softSkills }
}

// Helper function to extract languages
function extractLanguages(text: string): string[] {
  const languages = []
  
  // Look for language section
  const languagePatterns = [
    /languages?[:\-]?\s*([^]*?)(?=education|work|experience|skills|projects|$)/i,
    /language[:\-]?\s*([^]*?)(?=education|work|experience|skills|projects|$)/i
  ]

  for (const pattern of languagePatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const languageText = match[1]
      const extractedLanguages = languageText
        .split(/[,;|]/)
        .map(lang => lang.trim())
        .filter(lang => lang.length > 2 && lang.length < 20)
      
      languages.push(...extractedLanguages)
      break
    }
  }

  // Default languages if none found
  if (languages.length === 0) {
    languages.push("English")
  }

  return languages
}

// Helper function to extract certifications
function extractCertifications(text: string): string[] {
  const certifications = []
  
  // Look for certification section
  const certPatterns = [
    /certifications?[:\-]?\s*([^]*?)(?=education|work|experience|skills|projects|$)/i,
    /certificates?[:\-]?\s*([^]*?)(?=education|work|experience|skills|projects|$)/i
  ]

  for (const pattern of certPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const certText = match[1]
      const extractedCerts = certText
        .split(/[,;|]/)
        .map(cert => cert.trim())
        .filter(cert => cert.length > 2 && cert.length < 100)
      
      certifications.push(...extractedCerts)
      break
    }
  }

  return certifications
}

// Helper function to extract achievements
function extractAchievements(text: string): string[] {
  const achievements = []
  
  // Look for achievements section
  const achievementPatterns = [
    /achievements?[:\-]?\s*([^]*?)(?=education|work|experience|skills|projects|$)/i,
    /accomplishments?[:\-]?\s*([^]*?)(?=education|work|experience|skills|projects|$)/i
  ]

  for (const pattern of achievementPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const achievementText = match[1]
      const extractedAchievements = achievementText
        .split(/[,;|]/)
        .map(achievement => achievement.trim())
        .filter(achievement => achievement.length > 5 && achievement.length < 200)
      
      achievements.push(...extractedAchievements)
      break
    }
  }

  return achievements
}

// Helper function to extract projects
function extractProjects(text: string): string[] {
  const projects = []
  
  // Look for projects section
  const projectPatterns = [
    /projects?[:\-]?\s*([^]*?)(?=education|work|experience|skills|achievements|$)/i
  ]

  for (const pattern of projectPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const projectText = match[1]
      const extractedProjects = projectText
        .split(/[,;|]/)
        .map(project => project.trim())
        .filter(project => project.length > 5 && project.length < 200)
      
      projects.push(...extractedProjects)
      break
    }
  }

  return projects
}

// Helper function to extract summary
function extractSummary(text: string): string {
  // Look for summary section
  const summaryPatterns = [
    /summary[:\-]?\s*([^]*?)(?=education|work|experience|skills|projects|$)/i,
    /objective[:\-]?\s*([^]*?)(?=education|work|experience|skills|projects|$)/i,
    /profile[:\-]?\s*([^]*?)(?=education|work|experience|skills|projects|$)/i
  ]

  for (const pattern of summaryPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const summary = match[1].trim()
      if (summary.length > 10 && summary.length < 500) {
        return summary
      }
    }
  }

  return ""
}

async function parseResumeBasic(file: File, preExtractedText?: string) {
  console.log("Using enhanced basic parsing method...")

  try {
    const text = typeof preExtractedText === "string" ? preExtractedText : await extractTextFromFile(file)
    console.log("Basic parsing - extracted text length:", text.length)

    // Enhanced name extraction - look for actual person names, not section headers
    let name = extractNameFromText(text) || ""
    
    // If the enhanced method didn't work, try the new actual person name extraction
    if (!name || name === "Unknown" || name.toLowerCase().includes("skills") || name.toLowerCase().includes("resume")) {
      console.log("Enhanced name extraction failed, trying actual person name extraction...")
      
      const actualName = extractActualPersonName(text)
      if (actualName) {
        name = actualName
        console.log("✅ Found actual person name:", name)
      } else {
        console.log("Actual person name extraction failed, trying pattern-based extraction...")
        
        // First, try to find name in the first few lines (most resumes have name at top)
        const lines = text.split('\n').slice(0, 10)
        for (const line of lines) {
          const trimmedLine = line.trim()
          // Look for lines that look like names (2-4 words, proper case, no special chars)
          if (trimmedLine.length > 3 && trimmedLine.length < 50 &&
              /^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(trimmedLine) &&
              !trimmedLine.toLowerCase().includes('resume') &&
              !trimmedLine.toLowerCase().includes('curriculum') &&
              !trimmedLine.toLowerCase().includes('vitae') &&
              !trimmedLine.toLowerCase().includes('skills') &&
              !trimmedLine.toLowerCase().includes('experience') &&
              !trimmedLine.toLowerCase().includes('education') &&
              !trimmedLine.toLowerCase().includes('phone') &&
              !trimmedLine.toLowerCase().includes('email') &&
              !trimmedLine.toLowerCase().includes('@') &&
              !trimmedLine.toLowerCase().includes('+91') &&
              !trimmedLine.toLowerCase().includes('github') &&
              !trimmedLine.toLowerCase().includes('linkedin')) {
            name = trimmedLine
            console.log("Found name in first lines:", name)
            break
          }
        }
        
        // If still no name, look for patterns like "DEEPAK KUMAR" (all caps names)
        if (!name || name === "Unknown") {
          const allCapsNameMatch = text.match(/([A-Z]{2,}\s+[A-Z]{2,})/g)
          if (allCapsNameMatch && allCapsNameMatch.length > 0) {
            // Filter out common non-name patterns
            const validNames = allCapsNameMatch.filter(n => 
              !n.toLowerCase().includes("resume") && 
              !n.toLowerCase().includes("curriculum") && 
              !n.toLowerCase().includes("vitae") &&
              !n.toLowerCase().includes("skills") &&
              !n.toLowerCase().includes("experience") &&
              !n.toLowerCase().includes("education") &&
              !n.toLowerCase().includes("phone") &&
              !n.toLowerCase().includes("email") &&
              !n.toLowerCase().includes("github") &&
              !n.toLowerCase().includes("linkedin") &&
              n.split(' ').length >= 2 &&
              n.split(' ').length <= 4
            )
            if (validNames.length > 0) {
              name = validNames[0]
              console.log("Found name from all-caps pattern:", name)
            }
          }
        }
        
        // If still no name, try to find it near contact information
        if (!name || name === "Unknown") {
          // Look for specific name patterns like "Bipul Sikder"
          const specificNameMatch = text.match(/(?:Name|Full Name)[:\s]*([A-Z][a-z]+\s+[A-Z][a-z]+)/i)
          if (specificNameMatch && specificNameMatch[1]) {
            name = specificNameMatch[1].trim()
            console.log("Found name from specific pattern:", name)
          }
          
          // If still no name, try to find it near phone number
          if (!name || name === "Unknown") {
            const phoneMatch = text.match(/(?:phone|mobile|tel)[:\s]*(\+?\d[\d\s\-\(\)]+)/i)
            if (phoneMatch) {
              // Look for name above or below phone number
              const lines = text.split('\n')
              const phoneLineIndex = lines.findIndex(line => line.toLowerCase().includes('phone') || line.toLowerCase().includes('mobile'))
              if (phoneLineIndex > 0) {
                // Check lines above phone for name
                for (let i = phoneLineIndex - 1; i >= Math.max(0, phoneLineIndex - 3); i--) {
                  const line = lines[i].trim()
                  if (line.length > 3 && line.length < 50 && 
                      !line.toLowerCase().includes('@') && 
                      !line.toLowerCase().includes('phone') &&
                      !line.toLowerCase().includes('mobile') &&
                      !line.toLowerCase().includes('email') &&
                      !line.toLowerCase().includes('location') &&
                      !line.toLowerCase().includes('address') &&
                      !line.toLowerCase().includes('experience') &&
                      !line.toLowerCase().includes('education') &&
                      !line.toLowerCase().includes('skills')) {
                    name = line
                    console.log("Found name near phone:", name)
                    break
                  }
                }
              }
            }
          }
        }
      }
    }
    
    // Final fallback: use filename if still no name found
    if (!name || name === "Unknown" || name.trim() === "" || name.toLowerCase().includes("skills")) {
      // Last resort: look for any name-like pattern in the text
      const nameLikePatterns = [
        /([A-Z][a-z]+\s+[A-Z][a-z]+)/g,
        /([A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+)/g
      ]
      
      for (const pattern of nameLikePatterns) {
        const matches = text.match(pattern)
        if (matches && matches.length > 0) {
          // Filter out common non-name patterns
          const potentialNames = matches.filter(match => 
            match.length > 3 && match.length < 50 &&
            !match.toLowerCase().includes('resume') &&
            !match.toLowerCase().includes('curriculum') &&
            !match.toLowerCase().includes('vitae') &&
            !match.toLowerCase().includes('skills') &&
            !match.toLowerCase().includes('experience') &&
            !match.toLowerCase().includes('education') &&
            !match.toLowerCase().includes('phone') &&
            !match.toLowerCase().includes('email') &&
            !match.toLowerCase().includes('github') &&
            !match.toLowerCase().includes('linkedin') &&
            !match.toLowerCase().includes('railway') &&
            !match.toLowerCase().includes('infrastructure') &&
            !match.toLowerCase().includes('projects')
          )
          
          if (potentialNames.length > 0) {
            name = potentialNames[0]
            console.log("Found name from fallback pattern:", name)
            break
          }
        }
      }
      
      // If still no name, use filename
      if (!name || name === "Unknown" || name.trim() === "" || name.toLowerCase().includes("skills")) {
        const fileName = file.name.replace(/\.[^/.]+$/, "")
        name = fileName.replace(/[_-]/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).replace(/\d+/g, "").trim()
        console.log("Using filename as name:", name)
      }
    }

    // Enhanced email extraction
    const emails = text.match(emailRegex) || []
    const email = emails[0] || ""

    // Enhanced phone extraction
    const phones = text.match(phoneRegex) || []
    const phone = phones[0] || ""

    // Enhanced location extraction
    let location = "Not specified"
    const locationPatterns = [
      /(?:location|address|city)[:\s]*([A-Z][a-zA-Z\s,]+(?:City|Town|District|State|Country|India|INDIA))/i,
      /(?:in|at|from)\s+([A-Z][a-zA-Z\s]+(?:City|Town|District|State|Country|India|INDIA))/i,
      /([A-Z][a-zA-Z\s]+(?:City|Town|District|State|Country|India|INDIA))/i,
      /(?:location|address|city)[:\s]*([A-Z][a-zA-Z\s,]+)/i,
      /(?:in|at|from)\s+([A-Z][a-zA-Z\s]+)/i
    ]
    
    for (const pattern of locationPatterns) {
      const match = text.match(pattern)
      if (match && match[1]) {
        const extractedLocation = match[1].trim()
        // Filter out common non-location patterns
        if (extractedLocation.length > 3 && 
            extractedLocation.length < 100 &&
            !extractedLocation.toLowerCase().includes('phone') &&
            !extractedLocation.toLowerCase().includes('email') &&
            !extractedLocation.toLowerCase().includes('resume') &&
            !extractedLocation.toLowerCase().includes('curriculum') &&
            !extractedLocation.toLowerCase().includes('vitae')) {
          location = extractedLocation
          break
        }
      }
    }

    // Enhanced education extraction
    const educationSection = extractEducationSection(text)
    
    // Enhanced work experience extraction
    const workExperience = extractWorkExperience(text)
    
    // Enhanced skills extraction
    const { technicalSkills, softSkills } = extractSkillsFromText(text)
    
    // Determine current role from work experience with better logic
    let currentRole = "Not specified"
    if (workExperience.length > 0) {
      currentRole = workExperience[0].role || "Not specified"
    } else {
      // Try to find role from text if no work experience found
      const rolePatterns = [
        /(?:current\s+role|current\s+position|current\s+job)[:\s]*([^.\n]+)/i,
        /(?:role|position|job)[:\s]*([^.\n]+)/i,
        /(?:working\s+as|employed\s+as)[:\s]*([^.\n]+)/i
      ]
      
      for (const pattern of rolePatterns) {
        const match = text.match(pattern)
        if (match && match[1]) {
          const extractedRole = match[1].trim()
          if (extractedRole.length > 3 && extractedRole.length < 100) {
            currentRole = extractedRole
            break
          }
        }
      }
      
      // If still no role found, look for common job titles in text
      if (currentRole === "Not specified") {
        const commonRoles = [
          'executive', 'manager', 'engineer', 'developer', 'analyst', 'specialist',
          'coordinator', 'assistant', 'officer', 'supervisor', 'lead', 'operator',
          'technician', 'consultant', 'director', 'head', 'chief', 'associate'
        ]
        
        for (const role of commonRoles) {
          const roleMatch = text.match(new RegExp(`\\b${role}\\b`, 'i'))
          if (roleMatch) {
            // Get the full job title
            const line = text.split('\n').find(line => 
              line.toLowerCase().includes(role.toLowerCase())
            )
            if (line) {
              currentRole = line.trim()
              break
            }
          }
        }
      }
    }
    
    // Determine total experience
    let totalExperience = "Not specified"
    const experienceMatch = text.match(/(?:experience|exp)[:\s]*(\d+)\s*(?:years?|yrs?)/i)
    if (experienceMatch) {
      totalExperience = `${experienceMatch[1]} years`
    } else if (workExperience.length > 0) {
      // Try to calculate from work experience dates
      const totalYears = workExperience.reduce((total: number, exp: any) => {
        if (exp.duration) {
          const yearMatch = exp.duration.match(/(\d+)/)
          if (yearMatch) total += parseInt(yearMatch[1])
        }
        return total
      }, 0)
      if (totalYears > 0) {
        totalExperience = `${totalYears} years`
      }
    }

    // Determine current company from work experience
    let currentCompany = ""
    if (workExperience.length > 0) {
      currentCompany = workExperience[0].company || ""
    } else {
      // Try to find company from text if no work experience found
      const companyPatterns = [
        /(?:current\s+company|current\s+employer|company)[:\s]*([^.\n]+)/i,
        /(?:working\s+at|employed\s+at|at)[:\s]*([^.\n]+)/i
      ]
      
      for (const pattern of companyPatterns) {
        const match = text.match(pattern)
        if (match && match[1]) {
          const extractedCompany = match[1].trim()
          if (extractedCompany.length > 2 && extractedCompany.length < 100) {
            currentCompany = extractedCompany
            break
          }
        }
      }
    }

    // Create the final parsed data object with CORRECT field mapping to match Google Sheets columns
    const parsedData = {
      // Basic Information - Columns A-G
      name: name || "Unknown Name",                                    // Column B: Name
      email: email || "",                                              // Column C: Email
      phone: phone || "",                                              // Column D: Phone
      dateOfBirth: "",                                                 // Column E: Date of Birth
      gender: "",                                                      // Column F: Gender
      maritalStatus: "",                                               // Column G: Marital Status
      
      // Professional Information - Columns H-P
      currentRole: currentRole || "Not specified",                     // Column H: Current Role
      desiredRole: "",                                                 // Column I: Desired Role
      currentCompany: currentCompany || "",                            // Column J: Current Company
      location: location || "Not specified",                          // Column K: Location
      preferredLocation: "",                                           // Column L: Preferred Location
      totalExperience: totalExperience || "Not specified",             // Column M: Total Experience
      currentSalary: "",                                               // Column N: Current Salary
      expectedSalary: "",                                              // Column O: Expected Salary
      noticePeriod: "",                                                // Column P: Notice Period
      
      // Education Details - Columns Q-V
      highestQualification: educationSection.highestQualification || "", // Column Q: Highest Qualification
      degree: educationSection.degree || "",                            // Column R: Degree
      specialization: educationSection.specialization || "",            // Column S: Specialization
      university: educationSection.university || "",                    // Column T: University/College
      educationYear: educationSection.year || "",                       // Column U: Education Year
      educationPercentage: educationSection.percentage || "",           // Column V: Education Percentage/CGPA
      additionalQualifications: "",                                     // Column W: Additional Qualifications
      
      // Skills & Expertise - Columns X-AA
      technicalSkills: technicalSkills,                                // Column X: Technical Skills
      softSkills: softSkills,                                          // Column Y: Soft Skills
      languagesKnown: extractLanguages(text),                          // Column Z: Languages Known
      certifications: extractCertifications(text),                      // Column AA: Certifications
      
      // Work Experience - Columns AB-AE
      previousCompanies: workExperience.map(exp => exp.company).filter(Boolean), // Column AB: Previous Companies
      jobTitles: workExperience.map(exp => exp.role).filter(Boolean),           // Column AC: Job Titles
      workDuration: workExperience.map(exp => exp.duration).filter(Boolean),    // Column AD: Work Duration
      keyAchievements: extractAchievements(text),                               // Column AE: Key Achievements
      workExperience: workExperience,                                           // Column AF: Work Experience Details
      education: educationSection.education,                                    // Column AG: Education Details
      
      // Additional Information - Columns AH-AM
      projects: extractProjects(text),                                 // Column AH: Projects
      awards: [],                                                       // Column AI: Awards
      publications: [],                                                 // Column AJ: Publications
      references: [],                                                   // Column AK: References
      linkedinProfile: "",                                              // Column AL: LinkedIn Profile
      portfolioUrl: "",                                                 // Column AM: Portfolio URL
      githubProfile: "",                                                // Column AN: GitHub Profile
      summary: extractSummary(text),                                    // Column AO: Summary/Objective
      
      // File Information - Columns AP-AT
      resumeText: text,                                                 // Column AP: Resume Text
      fileName: file.name,                                              // Column AQ: File Name
      driveFileId: "",                                                  // Column AR: Drive File ID
      driveFileUrl: "",                                                 // Column AS: Drive File URL
      
                // System Fields - Columns AT-BB
          status: "new" as const,                                          // Column AT: Status
          tags: [],                                                         // Column AU: Tags
          rating: undefined,                                                // Column AV: Rating
          notes: "",                                                        // Column AW: Notes
          uploadedAt: new Date().toISOString(),                             // Column AX: Uploaded At
          updatedAt: new Date().toISOString(),                              // Column AY: Updated At
          lastContacted: "",                                                // Column AZ: Last Contacted
          interviewStatus: "not-scheduled" as const,                        // Column BA: Interview Status
          feedback: "",                                                     // Column BB: Feedback
    }

    // Enhanced field validation and correction
    console.log("🔍 Validating parsed data fields...")
    
    // Ensure critical fields have meaningful values
    if (parsedData.name === "Unknown Name" || parsedData.name.trim().length < 2) {
      // Try to extract name from other patterns
      const namePatterns = [
        /(?:^|\n)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})(?:\s*[-|]\s*|$)/,
        /(?:^|\n)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})(?:\s*[A-Z][a-z]+)/,
      ]
      
      for (const pattern of namePatterns) {
        const match = text.match(pattern)
        if (match && match[1] && match[1].trim().length > 2) {
          parsedData.name = match[1].trim()
          console.log("✅ Name corrected from pattern:", parsedData.name)
          break
        }
      }
    }

    // Improve location extraction if not found
    if (!parsedData.location || parsedData.location === "Not specified") {
      const locationPatterns = [
        /(?:from|at|in|based in|located in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*[A-Z]{2}/g,
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+[A-Z]{2}/g,
      ]
      
      for (const pattern of locationPatterns) {
        const match = text.match(pattern)
        if (match && match[1] && match[1].trim().length > 2) {
          parsedData.location = match[1].trim()
          console.log("✅ Location corrected from pattern:", parsedData.location)
          break
        }
      }
    }

    // Improve current role extraction
    if (!parsedData.currentRole || parsedData.currentRole === "Not specified") {
      const rolePatterns = [
        /(?:currently|presently|working as|employed as)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
        /(?:position|role|title):\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
      ]
      
      for (const pattern of rolePatterns) {
        const match = text.match(pattern)
        if (match && match[1] && match[1].trim().length > 3) {
          parsedData.currentRole = match[1].trim()
          console.log("✅ Current role corrected from pattern:", parsedData.currentRole)
          break
        }
      }
    }

    // Improve experience extraction
    if (!parsedData.totalExperience || parsedData.totalExperience === "Not specified") {
      const expPatterns = [
        /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\s*(?:of\s+)?experience/gi,
        /experience[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/gi,
        /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\s*in\s+[A-Za-z\s]+/gi,
      ]
      
      for (const pattern of expPatterns) {
        const match = text.match(pattern)
        if (match && match[1]) {
          parsedData.totalExperience = `${match[1]} years`
          console.log("✅ Experience corrected from pattern:", parsedData.totalExperience)
          break
        }
      }
    }

    console.log("✅ Enhanced basic parsing completed:", parsedData.name)
    console.log("Extracted data summary:")
    console.log("- Name:", parsedData.name)
    console.log("- Email:", parsedData.email)
    console.log("- Phone:", parsedData.phone)
    console.log("- Current Role:", parsedData.currentRole)
    console.log("- Current Company:", parsedData.currentCompany)
    console.log("- Location:", parsedData.location)
    console.log("- Total Experience:", parsedData.totalExperience)
    console.log("- Education:", parsedData.highestQualification)
    console.log("- University:", parsedData.university)
    console.log("- Education Year:", parsedData.educationYear)
    console.log("- Technical Skills:", parsedData.technicalSkills.length, "->", parsedData.technicalSkills)
    console.log("- Soft Skills:", parsedData.softSkills.length, "->", parsedData.softSkills)
    console.log("- Work Experience:", parsedData.workExperience.length, "->", parsedData.workExperience.map(exp => `${exp.role} at ${exp.company}`))
    console.log("- Languages:", parsedData.languagesKnown)
    console.log("- Certifications:", parsedData.certifications)
    console.log("- Achievements:", parsedData.keyAchievements)
    console.log("- Projects:", parsedData.projects)
    console.log("- Summary:", parsedData.summary ? parsedData.summary.substring(0, 100) + "..." : "None")
    
    return parsedData
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`❌ Enhanced basic parsing failed: ${msg}`)
    throw error
  }
}

async function extractTextFromFile(file: File): Promise<string> {
  try {
    console.log(`🔄 Extracting text from ${file.type} file: ${file.name}`)
    console.log(`📁 File details: name=${file.name}, type=${file.type}, size=${file.size} bytes`)

    // Enhanced file type detection
    const fileType = file.type.toLowerCase()
    const fileName = file.name.toLowerCase()
    
    // Check for text files
    if (fileType === "text/plain" || fileName.endsWith('.txt')) {
      console.log("📝 Processing as text file...")
      const text = await file.text()
      console.log("✅ Text file extracted successfully")
      return text
    }
    
    // Check for PDF files
    if (fileType === "application/pdf" || fileName.endsWith('.pdf')) {
      console.log("📄 Processing as PDF file...")
      const arrayBuffer = await file.arrayBuffer()
      const text = await extractPDFText(arrayBuffer)
      console.log(`✅ PDF text extracted (${text.length} chars)`)
      return text
    }
    
    // Check for Word documents (DOCX, DOC)
    if (
      fileType.includes("word") ||
      fileType.includes("document") ||
      fileType.includes("docx") ||
      fileName.endsWith(".docx")
    ) {
      console.log(`📝 Processing DOCX document: ${file.name} (${file.type})`)
      const arrayBuffer = await file.arrayBuffer()
      const text = await extractDocxText(arrayBuffer)
      console.log("✅ DOCX text extracted")
      return text
    }
    // Handle legacy .doc separately
    if (fileType.includes("msword") || fileType.includes("doc") || fileName.endsWith(".doc")) {
      console.log(`📝 Processing legacy DOC document: ${file.name} (${file.type})`)
      const arrayBuffer = await file.arrayBuffer()
      const text = await extractDocText(arrayBuffer)
      console.log("✅ DOC text extracted (legacy)")
      return text
    }
    
    // If file type is unknown but filename suggests a supported format, try to process it
    if (fileName.endsWith('.docx') || fileName.endsWith('.doc') || fileName.endsWith('.pdf')) {
      console.log(`⚠️ Unknown file type but filename suggests supported format: ${fileName}`)
      console.log(`🔄 Attempting to process as: ${fileName.endsWith('.docx') ? 'DOCX' : fileName.endsWith('.doc') ? 'DOC' : 'PDF'}`)
      
      const arrayBuffer = await file.arrayBuffer()
      
      if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
        if (fileName.endsWith('.docx')) {
          return await extractDocxText(arrayBuffer)
        }
        return await extractDocText(arrayBuffer)
      } else if (fileName.endsWith('.pdf')) {
        return await extractPDFText(arrayBuffer)
      }
    }
    
    // If we get here, the file type is not supported
    throw new Error(`Unsupported file type: ${file.type}. Supported types: PDF, DOCX, DOC, TXT`)
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`❌ Text extraction error: ${msg}`)
    console.error(`File: ${file.name}, Type: ${file.type}, Size: ${file.size}`)
    
    // Return a more helpful error message
    return `Error extracting text from ${file.name}: ${msg}`
  }
}

// Best-effort extraction for legacy .doc (binary) without external tools
async function extractDocText(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    console.log("🔄 Starting DOC (legacy) text extraction...")
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error("Invalid or empty ArrayBuffer")
    }
    const uint8 = new Uint8Array(arrayBuffer)
    // Heuristic decode: try windows-1252 via TextDecoder fallback; if not, use latin1
    let decoded = ""
    try {
      // Some environments support 'windows-1252'
      const decoder = new TextDecoder("windows-1252" as any, { fatal: false })
      decoded = decoder.decode(uint8)
    } catch {
      decoded = new TextDecoder("latin1").decode(uint8)
    }
    // Remove binary/control noise, collapse whitespace
    let text = sanitizeExtractedText(decoded)
    // Legacy DOC often embeds null bytes; strip remaining low ASCII
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    // If still too short, extract ASCII word sequences as last resort
    if (!text || text.length < 100) {
      const ascii = Array.from(uint8)
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : " "))
        .join("")
      text = sanitizeExtractedText(ascii)
    }
    if (!text || text.length < 50) {
      throw new Error("DOC processing produced insufficient text")
    }
    return text
  } catch (error) {
    console.error("❌ DOC legacy extraction failed:", error)
    // Return an error marker so upstream can handle gracefully
    return `DOC processing error: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function extractPDFText(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    // Use pdf-parse for robust PDF text extraction
    const data = await pdfParse(Buffer.from(arrayBuffer))
    const text = sanitizeExtractedText(data.text)
    if (text && text.length >= 80 && !looksLikePdfStructure(text)) {
      return text
    }

    // If the PDF is scanned/image-based, pdf-parse often returns little or no text.
    // Try Gemini on the PDF bytes to OCR/extract visible text.
    if (genAI) {
      try {
        const ocrText = await extractPDFTextWithGemini(arrayBuffer)
        const out = sanitizeExtractedText(ocrText)
        const base = looksLikePdfStructure(text) ? "" : text
        return out.length > base.length ? out : base
      } catch (e) {
        const status = getGeminiErrorStatus(e as any)
        const msg = String((e as any)?.message || e)
        console.warn(`⚠️ Gemini PDF OCR failed (${status || "unknown"}): ${msg}`)
      }
    }

    return looksLikePdfStructure(text) ? "" : text
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn(`PDF extraction warning with pdf-parse: ${msg}`)
    if (genAI) {
      try {
        const ocrText = await extractPDFTextWithGemini(arrayBuffer)
        const out = sanitizeExtractedText(ocrText)
        if (out && out.length >= 80 && !looksLikePdfStructure(out)) return out
      } catch (e) {
        const status = getGeminiErrorStatus(e as any)
        const emsg = String((e as any)?.message || e)
        console.warn(`⚠️ Gemini PDF OCR failed (${status || "unknown"}): ${emsg}`)
      }
    }
    return ""
  }
}

async function extractPDFTextWithGemini(arrayBuffer: ArrayBuffer): Promise<string> {
  if (!genAI) {
    throw new Error("Gemini API not configured")
  }
  const modelName = process.env.GEMINI_OCR_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash"
  const model = genAI.getGenerativeModel({ model: modelName })
  const pdfBase64 = Buffer.from(arrayBuffer).toString("base64")

  const prompt =
    "Extract all visible text from this resume PDF. Return plain text only with line breaks. Do not add, infer, or rename anything. If no text is readable, return an empty string."

  const result = await runGeminiCall(
    () =>
      model.generateContent([
        prompt,
        {
          inlineData: {
            data: pdfBase64,
            mimeType: "application/pdf",
          },
        },
      ]),
    { minSpacingMs: 1200, maxAttempts: 6 },
  )

  return result.response.text()
}

async function extractDocxText(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    console.log("🔄 Starting DOCX text extraction...")
    console.log("ArrayBuffer size:", arrayBuffer.byteLength)
    console.log("ArrayBuffer constructor:", arrayBuffer.constructor.name)
    
    // Environment checks
    console.log("Environment check - Node.js:", typeof process !== 'undefined' && process.versions && process.versions.node)
    console.log("Environment check - Browser:", typeof window !== 'undefined')
    console.log("Environment check - Global:", typeof global !== 'undefined')
    
    // Validate ArrayBuffer
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error("Invalid or empty ArrayBuffer")
    }
    
    // Check if it's a valid DOCX file by checking the file signature
    const uint8Array = new Uint8Array(arrayBuffer)
    const signature = Array.from(uint8Array.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('')
    console.log("File signature:", signature)
    
    // DOCX files start with PK (50 4B) - ZIP file format
    if (!signature.startsWith('504b')) {
      console.warn("⚠️ File signature doesn't match DOCX format, but attempting extraction anyway...")
      // Don't throw error immediately, try to extract anyway
    }
    
    // Check if mammoth is available
    if (!mammoth) {
      console.error("❌ Mammoth.js library not available")
      console.error("Mammoth import result:", mammoth)
      throw new Error("Mammoth.js library not available")
    }
    
    if (typeof mammoth.extractRawText !== 'function') {
      console.error("❌ Mammoth.js extractRawText function not available")
      console.error("Available mammoth properties:", Object.getOwnPropertyNames(mammoth))
      console.error("Mammoth type:", typeof mammoth)
      throw new Error("Mammoth.js extractRawText function not available")
    }
    
    console.log("✅ Mammoth.js is available, attempting text extraction...")
    console.log("Mammoth object:", mammoth)
    console.log("extractRawText function:", mammoth.extractRawText)
    
    // Try multiple approaches for mammoth.js
    let result = null
    let lastError = null
    
    // Approach 1: Direct arrayBuffer
    try {
      console.log("🔄 Attempt 1: Direct arrayBuffer...")
      result = await mammoth.extractRawText({ arrayBuffer })
      console.log("✅ Direct arrayBuffer approach successful")
    } catch (error1) {
      console.log("❌ Direct arrayBuffer failed:", error1 instanceof Error ? error1.message : error1)
      lastError = error1
      
      // Approach 2: Buffer conversion
      try {
        console.log("🔄 Attempt 2: Buffer conversion...")
        const buffer = Buffer.from(arrayBuffer)
        result = await mammoth.extractRawText({ arrayBuffer: buffer as any })
        console.log("✅ Buffer conversion approach successful")
      } catch (error2) {
        console.log("❌ Buffer conversion failed:", error2 instanceof Error ? error2.message : error2)
        lastError = error2
        
        // Approach 3: Uint8Array conversion
        try {
          console.log("🔄 Attempt 3: Uint8Array conversion...")
          result = await mammoth.extractRawText({ arrayBuffer: uint8Array as any })
          console.log("✅ Uint8Array conversion approach successful")
        } catch (error3) {
          console.log("❌ Uint8Array conversion failed:", error3 instanceof Error ? error3.message : error3)
          lastError = error3
        }
      }
    }
    
    if (result && result.value && result.value.trim().length > 0) {
      console.log("✅ DOCX text extracted successfully!")
      console.log("Extracted text length:", result.value.length)
      console.log("First 200 characters:", result.value.substring(0, 200))
      return sanitizeExtractedText(result.value)
    } else {
      console.warn("⚠️ Mammoth extraction returned empty or invalid result")
      throw new Error("No text content found in DOCX file")
    }
    
  } catch (error) {
    console.error("❌ All mammoth.js approaches failed:", error)

    // Robust fallback using ZIP parsing to read document.xml
    console.log("🔄 Attempting ZIP-based DOCX text extraction fallback...")
    try {
      const zip = await JSZip.loadAsync(arrayBuffer)
      const xmlFiles = [
        "word/document.xml",
        "word/header1.xml",
        "word/header2.xml",
        "word/footer1.xml",
        "word/footer2.xml"
      ]
      let combined = ""
      for (const path of xmlFiles) {
        if (zip.file(path)) {
          const xmlContent = await zip.file(path)!.async("string")
          // Extract all text nodes from w:t tags
          const matches = xmlContent.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi) || []
          const textNodes = matches
            .map((m) => m.replace(/<w:t[^>]*>/i, "").replace(/<\/w:t>/i, ""))
            .join(" ")
          combined += " " + textNodes
        }
      }
      const cleaned = sanitizeExtractedText(combined)
      if (cleaned && cleaned.length > 50) {
        console.log("✅ ZIP-based DOCX text extraction successful!")
        console.log("Fallback text length:", cleaned.length)
        console.log("First 200 characters:", cleaned.substring(0, 200))
        return cleaned
      }
      throw new Error("ZIP fallback produced insufficient text")
    } catch (fallbackError) {
      console.error("❌ ZIP-based DOCX extraction failed:", fallbackError)
      const details = {
        originalError: error instanceof Error ? error.message : String(error),
        fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      }
      throw new Error(`DOCX processing completely failed. Details: ${JSON.stringify(details)}`)
    }
  }
}

function sanitizeExtractedText(input: string): string {
  if (!input) return ""
  // Replace non-printable/binary, collapse whitespace, trim
  let text = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  // Guard against extremely long content causing Sheets 50k cell limit.
  const MAX_LEN = 30000
  if (text.length > MAX_LEN) {
    text = text.slice(0, MAX_LEN)
  }
  return text
}

function getFallbackParsedData(file: File) {
  const fileName = file.name.replace(/\.[^/.]+$/, "")

  return {
    // Basic Information - Columns A-G
    name: fileName.replace(/[_-]/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).replace(/\d+/g, "").trim(), // Column B: Name
    email: "",                                                                                                   // Column C: Email
    phone: "",                                                                                                   // Column D: Phone
    dateOfBirth: "",                                                                                            // Column E: Date of Birth
    gender: "",                                                                                                  // Column F: Gender
    maritalStatus: "",                                                                                           // Column G: Marital Status
    
    // Professional Information - Columns H-P
    currentRole: "Not specified",                                                                                // Column H: Current Role
    desiredRole: "",                                                                                             // Column I: Desired Role
    currentCompany: "",                                                                                          // Column J: Current Company
    location: "Not specified",                                                                                   // Column K: Location
    preferredLocation: "",                                                                                       // Column L: Preferred Location
    totalExperience: "Not specified",                                                                            // Column M: Total Experience
    currentSalary: "",                                                                                           // Column N: Current Salary
    expectedSalary: "",                                                                                          // Column O: Expected Salary
    noticePeriod: "",                                                                                            // Column P: Notice Period
    
    // Education Details - Columns Q-V
    highestQualification: "",                                                                                    // Column Q: Highest Qualification
    degree: "",                                                                                                  // Column R: Degree
    specialization: "",                                                                                          // Column S: Specialization
    university: "",                                                                                              // Column T: University/College
    educationYear: "",                                                                                           // Column U: Education Year
    educationPercentage: "",                                                                                     // Column V: Education Percentage/CGPA
    additionalQualifications: "",                                                                                // Column W: Additional Qualifications
    
    // Skills & Expertise - Columns X-AA
    technicalSkills: [],                                                                                         // Column X: Technical Skills
    softSkills: [],                                                                                              // Column Y: Soft Skills
    languagesKnown: [],                                                                                          // Column Z: Languages Known
    certifications: [],                                                                                          // Column AA: Certifications
    
    // Work Experience - Columns AB-AE
    previousCompanies: [],                                                                                       // Column AB: Previous Companies
    jobTitles: [],                                                                                               // Column AC: Job Titles
    workDuration: [],                                                                                            // Column AD: Work Duration
    keyAchievements: [],                                                                                         // Column AE: Key Achievements
    workExperience: [],                                                                                          // Column AF: Work Experience Details
    education: [],                                                                                               // Column AG: Education Details
    
    // Additional Information - Columns AH-AM
    projects: [],                                                                                                // Column AH: Projects
    awards: [],                                                                                                  // Column AI: Awards
    publications: [],                                                                                            // Column AJ: Publications
    references: [],                                                                                              // Column AK: References
    linkedinProfile: "",                                                                                         // Column AL: LinkedIn Profile
    portfolioUrl: "",                                                                                            // Column AM: Portfolio URL
    githubProfile: "",                                                                                           // Column AN: GitHub Profile
    summary: "",                                                                                                 // Column AO: Summary/Objective
    
    // File Information - Columns AP-AT
    resumeText: `Resume file: ${file.name} (${file.size} bytes, ${file.type})`,                                   // Column AP: Resume Text
    fileName: file.name,                                                                                         // Column AQ: File Name
    filePath: "",                                                                                                // Column AR: Supabase Storage File Path
    fileUrl: "",                                                                                                // Column AS: Supabase Storage File URL
    
    // System Fields - Columns AT-BB
    status: "new" as const,                                                                                     // Column AT: Status
    tags: [],                                                                                                    // Column AU: Tags
    rating: undefined,                                                                                           // Column AV: Rating
    notes: "",                                                                                                   // Column AW: Notes
    uploadedAt: new Date().toISOString(),                                                                        // Column AX: Uploaded At
    updatedAt: new Date().toISOString(),                                                                         // Column AY: Updated At
    lastContacted: "",                                                                                           // Column AZ: Last Contacted
    interviewStatus: "not-scheduled" as const,                                                                   // Column BA: Interview Status
    feedback: "",                                                                                                // Column BB: Feedback
  }
}

// Parse resume using OpenRouter API
async function parseResumeWithOpenRouter(file: File): Promise<ComprehensiveCandidateData> {
  if (!openRouterApiKey) {
    throw new Error("OpenRouter API not configured")
  }
    
  try {
    console.log("🔄 Starting OpenRouter parsing...")
    const text = await extractTextFromFile(file)
    console.log(`📄 Extracted text length: ${text.length} characters`)
    console.log(`📄 First 200 characters: ${text.substring(0, 200)}...`)

    // Limit text to avoid token limits but provide enough context
    const limitedText = text.substring(0, 5000)
    
    const prompt = `You are an expert resume parser with 10+ years of experience in HR and recruitment. Your task is to extract accurate information from this resume and return ONLY a valid JSON object.

CRITICAL INSTRUCTIONS:
1. Return ONLY valid JSON - no explanations, no markdown, no extra text
2. If a field is not found, use empty string "" for text or empty array [] for lists
3. For arrays, use the correct types: skills/companies -> strings; workExperience/education -> objects exactly matching schema
4. For experience, calculate total years from all work experience and use format like "5 years" or "3.5 years"
5. For skills, extract ONLY actual skills mentioned in the resume, don't make up generic ones
6. For location, use format like "Mumbai, Maharashtra" or "Delhi, India"
7. For name, extract the actual person's name from the resume header or personal details section
8. For current role, extract the job title they currently hold (most recent position)
9. For current company, extract the company they currently work for (most recent employer)
10. For education, extract ALL education history as structured objects
11. For previous companies, list all companies mentioned in work experience (excluding current)
12. Be very careful with name extraction - look for patterns like "Name:", "Full Name:", or prominent text at the top

NAME EXTRACTION RULES:
- Look for the person's name at the very top of the resume, usually in large/bold text
- Common patterns: "Name: [Name]", "Full Name: [Name]", or just the name prominently displayed
- The name is usually the first thing you see, not project names or company names
- Do not confuse headings, companies, job titles, or projects as the person's name
- Look for personal contact information section which usually contains the name
- The name is typically followed by contact details like phone, email, or address
- DO NOT extract project names, company names, or other text as the person's name
- The name should be a person's name (2-4 words), not a company, project, or section header
- If you see text like "Railway infrastructure projects" or "Tech Lead", that's NOT a person's name

EXTRACT THESE FIELDS WITH HIGH ACCURACY:
{
  "name": "Full name (required - must be extracted from resume header or personal details)",
  "email": "Email address if found (look for @ symbol)",
  "phone": "Phone number with country code if available (look for patterns like +91, 10 digits)",
  "currentRole": "Current job title/position (most recent work experience)",
  "currentCompany": "Current employer company name (most recent work experience)",
  "location": "Current location (city, state, country) - look for address or location fields",
  "totalExperience": "Total years of experience calculated from all work experience",
  "highestQualification": "Highest education level achieved (e.g., 'Master's Degree', 'Bachelor's Degree')",
  "degree": "Specific degree name (e.g., 'B.Tech Computer Science', 'MBA Finance')",
  "university": "University/College name where highest degree was obtained",
  "educationYear": "Year of graduation for highest degree",
  "technicalSkills": ["actual technical skills mentioned in resume"],
  "softSkills": ["actual soft skills mentioned in resume"],
  "languagesKnown": ["languages mentioned in resume"],
  "certifications": ["certifications mentioned in resume"],
  "previousCompanies": ["all companies from work experience excluding current"],
  "keyAchievements": ["key achievements mentioned in resume"],
  "projects": ["projects mentioned in resume"],
  "summary": "Professional summary or objective statement if present",
  "workExperience": [
    {
      "company": "Company name",
      "role": "Job title/position",
      "duration": "Start-End or years format",
      "description": "Key responsibilities/achievements"
    }
  ],
  "education": [
    {
      "degree": "Degree name (e.g., B.Tech, MBA)",
      "specialization": "Specialization/major",
      "university": "University/College name",
      "startYear": "Start year if available",
      "endYear": "Graduation year or 'Present'",
      "percentage": "Percentage/CGPA/GPA if available",
      "description": "Any extra details"
    }
  ]
}

RESUME TEXT:
${limitedText}

Return ONLY the JSON object:`

    console.log("🔄 Sending request to OpenRouter API...")
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "anthropic/claude-3-opus:beta", // Using Claude 3 Opus for best document parsing
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 4000
      },
      {
        headers: {
          "Authorization": `Bearer ${openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://truckinzy.com", // Replace with your actual domain
          "X-Title": "Truckinzy Resume Parser"
        }
      }
    )

    const content = response.data.choices[0].message.content
    // Extract JSON from the response - try multiple approaches
    let parsedData = null
    
    // Method 1: Look for JSON between curly braces
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        parsedData = JSON.parse(jsonMatch[0])
      } catch (e) {
      }
    }
    
    // Method 2: Look for JSON after "Return ONLY the JSON object:"
    if (!parsedData) {
      const afterPrompt = content.split("Return ONLY the JSON object:")
      if (afterPrompt.length > 1) {
        try {
          const jsonPart = afterPrompt[1].trim()
          const jsonMatch2 = jsonPart.match(/\{[\s\S]*\}/)
          if (jsonMatch2) {
            parsedData = JSON.parse(jsonMatch2[0])
          }
        } catch (e) {
        }
      }
    }
    
    // Method 3: Try to find any valid JSON in the content
    if (!parsedData) {
      const jsonMatches = content.match(/\{[^{}]*\}/g)
      if (jsonMatches) {
        for (const match of jsonMatches) {
          try {
            parsedData = JSON.parse(match)
            if (parsedData.name && parsedData.name !== "Unknown") {
              break
            }
          } catch (e) {
            continue
          }
        }
      }
    }

    if (!parsedData) {
      throw new Error("No valid JSON found in OpenRouter response")
    }
    
    // Validate the extracted name - it should not be a project name or company name
    if (parsedData.name) {
      const suspiciousNames = [
        'railway', 'infrastructure', 'projects', 'tech', 'company', 'ltd', 'pvt', 'inc',
        'corporation', 'enterprise', 'solutions', 'systems', 'platform', 'app', 'web',
        'resume', 'curriculum', 'vitae', 'cv', 'skills', 'experience', 'education',
        'lead', 'engineer', 'developer', 'manager', 'specialist', 'coordinator'
      ]
      
      const nameLower = parsedData.name.toLowerCase()
      const isSuspicious = suspiciousNames.some(word => nameLower.includes(word))
      
      if (isSuspicious) {
        // Try to find a better name in the text
        const namePatterns = [
          /name\s*:\s*([^\n]+)/i,
          /full\s*name\s*:\s*([^\n]+)/i,
          /^([A-Z][a-z]+\s+[A-Z][a-z]+)/m,
          /^([A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+)/m
        ]
        
        for (const pattern of namePatterns) {
          const match = text.match(pattern)
          if (match && match[1]) {
            const potentialName = match[1].trim()
            if (potentialName.length > 2 && !suspiciousNames.some(word => potentialName.toLowerCase().includes(word))) {
              parsedData.name = potentialName
              break
            }
          }
        }
        
        // If still suspicious, try to find the actual person's name from the resume
        if (isSuspicious) {
          const actualName = extractActualPersonName(text)
          if (actualName) {
            parsedData.name = actualName
          }
        }
      }
    }

    // Validate and clean the parsed data
    const cleanedData = {
      name: cleanString(parsedData.name),
      email: cleanString(parsedData.email),
      phone: cleanString(parsedData.phone),
      currentRole: cleanString(parsedData.currentRole),
      currentCompany: cleanString(parsedData.currentCompany),
      location: cleanString(parsedData.location),
      totalExperience: cleanString(parsedData.totalExperience),
      highestQualification: cleanString(parsedData.highestQualification),
      degree: cleanString(parsedData.degree),
      university: cleanString(parsedData.university),
      educationYear: cleanString(parsedData.educationYear),
      technicalSkills: cleanArray(parsedData.technicalSkills),
      softSkills: cleanArray(parsedData.softSkills),
      languagesKnown: cleanArray(parsedData.languagesKnown),
      certifications: cleanArray(parsedData.certifications),
      previousCompanies: cleanArray(parsedData.previousCompanies),
      keyAchievements: cleanArray(parsedData.keyAchievements),
      projects: cleanArray(parsedData.projects),
      summary: cleanString(parsedData.summary)
    }

    // Enhanced validation and correction
    if (!cleanedData.name || cleanedData.name === "Unknown" || cleanedData.name.length < 2) {
      // Try to extract name from resume text if OpenRouter failed
      const nameFromText = extractNameFromText(text)
      if (nameFromText) {
        cleanedData.name = nameFromText
      }
    }

    // Improve location if not found
    if (!cleanedData.location || cleanedData.location === "Not specified") {
      const locationFromText = extractLocationFromText(text)
      if (locationFromText) {
        cleanedData.location = locationFromText
      }
    }

    // Improve current role if not found
    if (!cleanedData.currentRole || cleanedData.currentRole === "Not specified") {
      const roleFromText = extractRoleFromText(text)
      if (roleFromText) {
        cleanedData.currentRole = roleFromText
      }
    }

    // Improve experience if not found
    if (!cleanedData.totalExperience || cleanedData.totalExperience === "Not specified") {
      const expFromText = extractExperienceFromText(text)
      if (expFromText) {
        cleanedData.totalExperience = expFromText
      }
    }
    
    // Map to ComprehensiveCandidateData format with CORRECT field mapping
    const candidateData: ComprehensiveCandidateData = {
      // Basic Information - Columns A-G
      name: cleanedData.name || "Unknown Name",                    // Column B: Name
      email: cleanedData.email || "",                              // Column C: Email
      phone: cleanedData.phone || "",                              // Column D: Phone
      dateOfBirth: "",                                             // Column E: Date of Birth
      gender: "",                                                  // Column F: Gender
      maritalStatus: "",                                           // Column G: Marital Status
      
      // Professional Information - Columns H-P
      currentRole: cleanedData.currentRole || "Not specified",     // Column H: Current Role
      desiredRole: "",                                             // Column I: Desired Role
      currentCompany: cleanedData.currentCompany || "",            // Column J: Current Company
      location: cleanedData.location || "Not specified",          // Column K: Location
      preferredLocation: "",                                       // Column L: Preferred Location
      totalExperience: cleanedData.totalExperience || "Not specified", // Column M: Total Experience
      currentSalary: "",                                           // Column N: Current Salary
      expectedSalary: "",                                          // Column O: Expected Salary
      noticePeriod: "",                                            // Column P: Notice Period
      
      // Education Details - Columns Q-V
      highestQualification: cleanedData.highestQualification || "", // Column Q: Highest Qualification
      degree: cleanedData.degree || "",                            // Column R: Degree
      specialization: "",                                          // Column S: Specialization
      university: cleanedData.university || "",                    // Column T: University/College
      educationYear: cleanedData.educationYear || "",              // Column U: Education Year
      educationPercentage: "",                                     // Column V: Education Percentage/CGPA
      additionalQualifications: "",                                // Column W: Additional Qualifications
      
      // Skills & Expertise - Columns X-AA
      technicalSkills: cleanedData.technicalSkills,                // Column X: Technical Skills
      softSkills: cleanedData.softSkills,                         // Column Y: Soft Skills
      languagesKnown: cleanedData.languagesKnown,                  // Column Z: Languages Known
      certifications: cleanedData.certifications,                  // Column AA: Certifications
      
      // Work Experience - Columns AB-AE
      previousCompanies: cleanedData.previousCompanies,            // Column AB: Previous Companies
      jobTitles: [],                                               // Column AC: Job Titles
      workDuration: [],                                            // Column AD: Work Duration
      keyAchievements: cleanedData.keyAchievements,                // Column AE: Key Achievements
      workExperience: (Array.isArray(parsedData.workExperience) ? parsedData.workExperience.map((it: any) => ({ company: cleanString(it?.company), role: cleanString(it?.role), duration: cleanString(it?.duration), description: cleanString(it?.description) })) : extractWorkExperience(text)),                                          // Column AF: Work Experience Details
      education: (Array.isArray(parsedData.education) ? parsedData.education.map((it: any) => ({ degree: cleanString(it?.degree), specialization: cleanString(it?.specialization), university: cleanString(it?.university), startYear: cleanString(it?.startYear), endYear: cleanString(it?.endYear), percentage: cleanString(it?.percentage), description: cleanString(it?.description) })) : extractEducationSection(text).education),                                               // Column AG: Education Details
      
      // Additional Information - Columns AH-AM
      projects: cleanedData.projects,                              // Column AH: Projects
      awards: [],                                                  // Column AI: Awards
      publications: [],                                            // Column AJ: Publications
      references: [],                                              // Column AK: References
      linkedinProfile: "",                                         // Column AL: LinkedIn Profile
      portfolioUrl: "",                                            // Column AM: Portfolio URL
      githubProfile: "",                                           // Column AN: GitHub Profile
      summary: cleanedData.summary || "",                          // Column AO: Summary/Objective
      
      // File Information - Columns AP-AT
      resumeText: text,                                            // Column AP: Resume Text
      fileName: file.name,                                         // Column AQ: File Name
      filePath: "",                                             // Column AR: Supabase Storage File Path
       fileUrl: "",                                                // Column AS: Supabase Storage File URL
      
      // System Fields - Columns AT-BB
      status: "new" as const,                                     // Column AT: Status
      tags: [],                                                    // Column AU: Tags
      rating: undefined,                                           // Column AV: Rating
      notes: "",                                                   // Column AW: Notes
      uploadedAt: new Date().toISOString(),                        // Column AX: Uploaded At
      updatedAt: new Date().toISOString(),                         // Column AY: Updated At
      lastContacted: "",                                           // Column AZ: Last Contacted
      interviewStatus: "not-scheduled" as const,                   // Column BA: Interview Status
      feedback: "",                                                // Column BB: Feedback
    }

    console.log("✅ OpenRouter parsing completed successfully")
    console.log("Final parsed data:", {
      name: candidateData.name,
      email: candidateData.email,
      phone: candidateData.phone,
      currentRole: candidateData.currentRole,
      currentCompany: candidateData.currentCompany,
      location: candidateData.location,
      totalExperience: candidateData.totalExperience,
      technicalSkills: candidateData.technicalSkills?.length || 0,
          softSkills: candidateData.softSkills?.length || 0
    })
    
    return candidateData

  } catch (error) {
    console.error("❌ OpenRouter parsing failed:", error)
    throw error
  }
}

// Helper functions for data cleaning and extraction
function cleanString(value: any): string {
  if (!value || typeof value !== 'string') return ""
  const cleaned = value.trim()
  if (cleaned.toLowerCase() === 'unknown' || cleaned.toLowerCase() === 'not specified' || cleaned.toLowerCase() === 'n/a') {
    return ""
  }
  return cleaned
}

function cleanArray(value: any): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => item && typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
    .filter(item => item.toLowerCase() !== 'unknown' && item.toLowerCase() !== 'not specified' && item.toLowerCase() !== 'n/a')
}

// Parse resume using OpenAI GPT-3.5-turbo (Free tier alternative)
