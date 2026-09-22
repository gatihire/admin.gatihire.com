import { GoogleGenerativeAI } from '@google/generative-ai';
import { InfoStepKey, getStep } from './steps';
import { logger } from '@/lib/logger';
import { extractCtcNumber, extractNoticePeriod } from './validators';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

interface ExtractionResult {
  extracted_value: string | null;
  confidence: number;
  normalized_value: string | null;
  is_valid: boolean;
  error_message: string | null;
}

interface ExtractionContext {
  stepKey: InfoStepKey;
  question: string;
  userReply: string;
  infoData: Record<string, any>;
  conversationHistory?: Array<{ role: 'assistant' | 'user'; content: string }>;
}

const VALIDATION_RULES: Record<string, string> = {
  current_ctc: 'Current CTC in LPA format. Accept: "8 LPA", "8 L", "800000", "8L", "800000", "80K". Return normalized as "X LPA".',
  expected_ctc: 'Expected CTC in LPA format. Same formats as current_ctc.',
  notice_period: 'Notice period. Accept: "30 days", "1 month", "2 weeks", "Immediate", "ASAP", "45 days", "2 months". Normalize to "X days" or "Immediate".',
  total_experience: 'Total work experience. Accept: "4 years", "3.5 years", "48 months", "4 yrs", "4 yoe", "4 y". Normalize to "X years".',
  location: 'City name. Normalize to proper case (e.g., "mumbai" → "Mumbai", "bangalore" → "Bangalore").',
  willing_to_relocate: 'Boolean. Accept: "yes", "y", "yes please", "sure", "ok", "willing", "can relocate" → "yes". "no", "n", "nope", "not willing", "cannot" → "no".',
  reason_for_switching: 'Free text. Minimum 3 characters. Return as-is with proper capitalization.'
};

const EXAMPLES: Record<string, Array<{ input: string; output: any }>> = {
  current_ctc: [
    { input: '8 LPA', output: { extracted_value: '8 LPA', normalized_value: '8 LPA', is_valid: true } },
    { input: '8L', output: { extracted_value: '8 LPA', normalized_value: '8 LPA', is_valid: true } },
    { input: '800000', output: { extracted_value: '8 LPA', normalized_value: '8 LPA', is_valid: true } },
    { input: '80K', output: { extracted_value: '8 LPA', normalized_value: '8 LPA', is_valid: true } },
    { input: '8', output: { extracted_value: '8 LPA', normalized_value: '8 LPA', is_valid: true } },
  ],
  expected_ctc: [
    { input: '12 LPA', output: { extracted_value: '12 LPA', normalized_value: '12 LPA', is_valid: true } },
    { input: '15 L', output: { extracted_value: '15 LPA', normalized_value: '15 LPA', is_valid: true } },
    { input: '1500000', output: { extracted_value: '15 LPA', normalized_value: '15 LPA', is_valid: true } },
  ],
  notice_period: [
    { input: '30 days', output: { extracted_value: '30 days', normalized_value: '30 days', is_valid: true } },
    { input: '1 month', output: { extracted_value: '30 days', normalized_value: '30 days', is_valid: true } },
    { input: 'immediate', output: { extracted_value: 'Immediate', normalized_value: 'Immediate', is_valid: true } },
    { input: 'ASAP', output: { extracted_value: 'Immediate', normalized_value: 'Immediate', is_valid: true } },
    { input: '2 months', output: { extracted_value: '60 days', normalized_value: '60 days', is_valid: true } },
  ],
  total_experience: [
    { input: '4 years', output: { extracted_value: '4 years', normalized_value: '4 years', is_valid: true } },
    { input: '3.5 years', output: { extracted_value: '3.5 years', normalized_value: '3.5 years', is_valid: true } },
    { input: '48 months', output: { extracted_value: '4 years', normalized_value: '4 years', is_valid: true } },
    { input: '4 yrs', output: { extracted_value: '4 years', normalized_value: '4 years', is_valid: true } },
    { input: '4 yoe', output: { extracted_value: '4 years', normalized_value: '4 years', is_valid: true } },
  ],
  location: [
    { input: 'mumbai', output: { extracted_value: 'Mumbai', normalized_value: 'Mumbai', is_valid: true } },
    { input: 'BANGALORE', output: { extracted_value: 'Bangalore', normalized_value: 'Bangalore', is_valid: true } },
    { input: 'delhi ncr', output: { extracted_value: 'Delhi Ncr', normalized_value: 'Delhi Ncr', is_valid: true } },
  ],
  willing_to_relocate: [
    { input: 'yes', output: { extracted_value: 'yes', normalized_value: 'yes', is_valid: true } },
    { input: 'y', output: { extracted_value: 'yes', normalized_value: 'yes', is_valid: true } },
    { input: 'sure', output: { extracted_value: 'yes', normalized_value: 'yes', is_valid: true } },
    { input: 'no', output: { extracted_value: 'no', normalized_value: 'no', is_valid: true } },
    { input: 'nope', output: { extracted_value: 'no', normalized_value: 'no', is_valid: true } },
    { input: 'not willing', output: { extracted_value: 'no', normalized_value: 'no', is_valid: true } },
  ],
  reason_for_switching: [
    { input: 'better growth', output: { extracted_value: 'Better growth', normalized_value: 'Better growth', is_valid: true } },
    { input: 'career growth', output: { extracted_value: 'Career growth', normalized_value: 'Career growth', is_valid: true } },
  ]
};

function buildExtractionPrompt(context: {
  stepKey: string;
  question: string;
  userReply: string;
  infoData: Record<string, any>;
  validationRules: string;
  examples: Array<{ input: string; output: any }>;
}): string {
  const step = context.stepKey;
  const examples = context.examples.map(ex => 
    `Input: "${ex.input}"\nOutput: ${JSON.stringify(ex.output)}`
  ).join('\n\n');

  return `You are an AI assistant extracting structured information from a candidate's WhatsApp reply.

CURRENT STEP: ${context.stepKey}
QUESTION ASKED: ${context.question}
CANDIDATE REPLY: "${context.userReply}"

PREVIOUS COLLECTED DATA: ${JSON.stringify(context.infoData)}

VALIDATION RULES FOR ${context.stepKey}:
${context.validationRules}

EXAMPLES:
${examples}

TASK: Extract the answer for the CURRENT STEP ONLY from the user's reply.
Return ONLY valid JSON with:
{
  "extracted_value": "extracted answer or null",
  "confidence": 0.0-1.0,
  "normalized_value": "standardized format for storage or null",
  "is_valid": true/false,
  "error_message": "user-friendly error if invalid or null"
}

IMPORTANT:
- Only extract the CURRENT step's information
- Be lenient with natural language
- If unclear or irrelevant, set is_valid: false with helpful error_message
- Return ONLY valid JSON, no extra text`;
}

export async function extractStepValue(
  stepKey: string,
  userReply: string,
  question: string,
  infoData: Record<string, any>
): Promise<{
  extracted_value: string | null;
  confidence: number;
  normalized_value: string | null;
  is_valid: boolean;
  error_message: string | null;
}> {
  const stepInfo = getStep(stepKey as InfoStepKey);
  
  if (!process.env.GEMINI_API_KEY) {
    // Fallback to regex-based extraction
    return fallbackExtract(stepKey, userReply);
  }

  try {
    const model = genAI.getGenerativeModel({ 
      model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500,
        responseMimeType: 'application/json',
      }
    });

    const context = {
      stepKey,
      question,
      userReply,
      infoData,
      validationRules: VALIDATION_RULES[stepKey] || '',
      examples: EXAMPLES[stepKey] || []
    };

    const prompt = buildExtractionPrompt({
      stepKey,
      question,
      userReply,
      infoData,
      validationRules: VALIDATION_RULES[stepKey] || '',
      examples: EXAMPLES[stepKey] || []
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    const parsed = JSON.parse(text);
    
    // Validate response structure
    if (typeof parsed.is_valid !== 'boolean') {
      throw new Error('Invalid LLM response structure');
    }
    
    return {
      extracted_value: parsed.extracted_value ?? null,
      confidence: parsed.confidence ?? 0.5,
      normalized_value: parsed.normalized_value ?? null,
      is_valid: parsed.is_valid,
      error_message: parsed.error_message ?? null,
    };
  } catch (error) {
    logger.warn('LLM extraction failed, falling back to regex', { 
      stepKey, 
      error: error instanceof Error ? error.message : String(error) 
    });
    return fallbackExtract(stepKey, userReply);
  }
}

// NEW: Extract all fields from a single multi-field reply
export async function extractAllFieldsFromReply(
  userReply: string,
  infoData: Record<string, any>
): Promise<{
  current_ctc?: string;
  expected_ctc?: string;
  notice_period?: string;
  total_experience?: string;
  location?: string;
  willing_to_relocate?: string;
  reason_for_switching?: string;
}> {
  if (!process.env.GEMINI_API_KEY) {
    return fallbackExtractAllFields(userReply);
  }

  try {
    const model = genAI.getGenerativeModel({ 
      model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500,
        responseMimeType: 'application/json',
      }
    });

    const prompt = `Extract ALL screening fields from the candidate's SINGLE reply.
Candidate reply: "${userReply}"

Fields to extract (return null if not mentioned):
- current_ctc: Current CTC (e.g., "8 LPA", "800000")
- expected_ctc: Expected CTC (e.g., "12 LPA", "1500000")
- notice_period: Notice period (e.g., "30 days", "1 month", "Immediate")
- total_experience: Total experience (e.g., "4 years", "48 months")
- location: Current city (e.g., "Mumbai", "Bangalore")
- willing_to_relocate: "yes" or "no"
- reason_for_switching: Free text reason

Return ONLY valid JSON:
{
  "current_ctc": "8 LPA" or null,
  "expected_ctc": "12 LPA" or null,
  "notice_period": "30 days" or null,
  "total_experience": "4 years" or null,
  "location": "Mumbai" or null,
  "willing_to_relocate": "yes" or null,
  "reason_for_switching": "Better growth" or null
}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);
    
    // Normalize each field
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'string') {
        // Use existing single-field extraction to normalize
        const single = await extractStepValue(key as any, value, '', infoData);
        if (single.is_valid && single.normalized_value) {
          normalized[key] = single.normalized_value;
        } else {
          normalized[key] = value;
        }
      }
    }
    return normalized;
  } catch (error) {
    logger.warn('LLM multi-field extraction failed, falling back to regex', { error: String(error) });
    return fallbackExtractAllFields(userReply);
  }
}

function fallbackExtractAllFields(userReply: string): {
  current_ctc?: string;
  expected_ctc?: string;
  notice_period?: string;
  total_experience?: string;
  location?: string;
  willing_to_relocate?: string;
  reason_for_switching?: string;
} {
  const result: Record<string, string> = {};
  const lower = userReply.toLowerCase();
  
  // Extract CTC values (current and expected)
  const ctcMatches = userReply.match(/(\d+(?:\.\d+)?)\s*(?:lpa|l|k|kpa)?/gi);
  if (ctcMatches && ctcMatches.length >= 1) {
    const first = extractCtcNumber(ctcMatches[0]);
    if (first) result.current_ctc = `${first} LPA`;
  }
  if (ctcMatches && ctcMatches.length >= 2) {
    const second = extractCtcNumber(ctcMatches[1]);
    if (second) result.expected_ctc = `${second} LPA`;
  }
  
  // Extract notice period
  const notice = extractNoticePeriod(userReply);
  if (notice) result.notice_period = notice;
  
  // Extract experience
  const expMatch = userReply.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|yoe)/i);
  if (expMatch) {
    result.total_experience = `${parseFloat(expMatch[1])} years`;
  } else {
    const monthMatch = userReply.match(/(\d+)\s*months?/i);
    if (monthMatch) {
      result.total_experience = `${parseInt(monthMatch[1]) / 12} years`;
    }
  }
  
  // Extract location (common Indian cities)
  const cities = ['mumbai', 'bangalore', 'delhi', 'chennai', 'hyderabad', 'pune', 'kolkata', 'gurgaon', 'noida', 'faridabad', 'ghaziabad'];
  for (const city of cities) {
    if (lower.includes(city)) {
      result.location = city.charAt(0).toUpperCase() + city.slice(1);
      break;
    }
  }
  
  // Extract willing to relocate
  if (/yes|y|sure|willing|can relocate/i.test(lower)) result.willing_to_relocate = 'yes';
  else if (/no|n|nope|not willing|cannot/i.test(lower)) result.willing_to_relocate = 'no';
  
  // Extract reason (remaining text after known patterns)
  // Simple approach: if long enough text, use as reason
  if (userReply.trim().length > 20 && !result.reason_for_switching) {
    const reason = userReply.trim();
    if (reason.length > 3) result.reason_for_switching = reason;
  }
  
  return result;
}

function fallbackExtract(stepKey: string, userInput: string): {
  extracted_value: string | null;
  confidence: number;
  normalized_value: string | null;
  is_valid: boolean;
  error_message: string | null;
} {
  const input = userInput.trim().toLowerCase();
  
  switch (stepKey) {
    case 'current_ctc':
    case 'expected_ctc': {
      const num = extractCtcNumber(userInput);
      if (num === null) {
        return { extracted_value: null, confidence: 0, normalized_value: null, is_valid: false, error_message: 'Please provide CTC like "8 LPA" or "800000"' };
      }
      return { extracted_value: `${num} LPA`, confidence: 0.8, normalized_value: `${num} LPA`, is_valid: true, error_message: null };
    }
    
    case 'notice_period': {
      const period = extractNoticePeriod(userInput);
      if (!period) {
        return { extracted_value: null, confidence: 0, normalized_value: null, is_valid: false, error_message: 'Please provide notice period like "30 days" or "Immediate"' };
      }
      return { extracted_value: period, confidence: 0.8, normalized_value: period, is_valid: true, error_message: null };
    }
    
    case 'total_experience': {
      const text = userInput.toLowerCase().trim();
      const yearMatch = userInput.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|yoe|experience)/i);
      if (yearMatch) {
        return { extracted_value: `${parseFloat(yearMatch[1])} years`, confidence: 0.9, normalized_value: `${parseFloat(yearMatch[1])} years`, is_valid: true, error_message: null };
      }
      const monthMatch = userInput.match(/(\d+)\s*months?/i);
      if (monthMatch) {
        const years = parseInt(monthMatch[1]) / 12;
        return { extracted_value: `${years} years`, confidence: 0.8, normalized_value: `${years} years`, is_valid: true, error_message: null };
      }
      const numMatch = userInput.match(/^(\d+(?:\.\d+)?)$/);
      if (numMatch) {
        const years = parseFloat(numMatch[1]);
        if (years > 0 && years <= 50) {
          return { extracted_value: `${years} years`, confidence: 0.8, normalized_value: `${years} years`, is_valid: true, error_message: null };
        }
      }
      return { extracted_value: null, confidence: 0, normalized_value: null, is_valid: false, error_message: 'Please provide experience like "4 years" or "48 months"' };
    }
    
    case 'location': {
      const input = userInput.trim();
      if (input.length < 2) {
        return { extracted_value: null, confidence: 0, normalized_value: null, is_valid: false, error_message: 'Please provide a valid city name' };
      }
      const normalized = input
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
      return { extracted_value: normalized, confidence: 0.9, normalized_value: normalized, is_valid: true, error_message: null };
    }
    
    case 'willing_to_relocate': {
      const input = userInput.toLowerCase().trim();
      const yes = /^(yes|y|yeah|sure|ok|okay|willing|can relocate|relocate)$/i.test(input);
      const no = /^(no|n|nope|not willing|cannot relocate|not willing)$/i.test(input);
      
      if (yes) return { extracted_value: 'yes', confidence: 0.95, normalized_value: 'yes', is_valid: true, error_message: null };
      if (no) return { extracted_value: 'no', confidence: 0.95, normalized_value: 'no', is_valid: true, error_message: null };
      return { extracted_value: null, confidence: 0, normalized_value: null, is_valid: false, error_message: 'Please reply "yes" or "no"' };
    }
    
    case 'reason_for_switching': {
      const input = userInput.trim();
      if (input.length < 3) {
        return { extracted_value: null, confidence: 0, normalized_value: null, is_valid: false, error_message: 'Please provide a brief reason (at least 3 characters)' };
      }
      const normalized = input.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      return { extracted_value: normalized, confidence: 0.9, normalized_value: normalized, is_valid: true, error_message: null };
    }
    
    default:
      return { extracted_value: userInput.trim(), confidence: 0.5, normalized_value: userInput.trim(), is_valid: true, error_message: null };
  }
}