import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const MODEL_NAME = process.env.GEMINI_INTENT_MODEL || 'gemini-2.0-flash-lite';

export type Intent =
  | 'schedule_call_now'
  | 'schedule_call_later'
  | 'interested'
  | 'not_interested'
  | 'provide_details'
  | 'question'
  | 'unclear';

export interface IntentClassification {
  intent: Intent;
  confidence: number;
  delay_minutes: number | null;
  reasoning: string;
}

interface ParticipantContext {
  candidate_name: string;
  job_title: string;
  company_name: string;
  status: string;
  screening_mode: string | null;
  whatsapp_sent_at: string | null;
}

const INTENT_PROMPT = `You are a WhatsApp intent classifier for a job recruitment system called GatiHire.

CANDIDATE CONTEXT:
- Name: {candidateName}
- Job: {jobTitle} at {companyName}
- Current status: {status}
- Screening mode: {screeningMode}
- Outreach sent: {whatsappSentAt}

CANDIDATE MESSAGE: "{message}"

AVAILABLE INTENTS:
1. schedule_call_now - Candidate wants to talk immediately. Examples: "call now", "call me", "lets talk", "connect me", "yes call", "available now"
2. schedule_call_later - Candidate wants to schedule a call for later. Examples: "call in 10 min", "after 30 minutes", "tomorrow morning", "this evening", "in an hour"
3. interested - Candidate is interested in the role but not ready to schedule immediately. Examples: "interested", "tell me more", "what is the salary", "role details"
4. not_interested - Candidate is not interested. Examples: "not interested", "no thanks", "no", "pass", "not looking", "already placed"
5. provide_details - Candidate wants to share their details (CTC, notice period, experience). Examples: "let me share my details", "my CTC is", "i want to provide info"
6. question - Candidate is asking a question about the role, company, or process. Examples: "what is the salary range", "where is the office", "is this remote"
7. unclear - Cannot determine intent from the message

TIME EXTRACTION (only for schedule_call_later):
- "10 min" / "10 minutes" → delay_minutes: 10
- "30 min" / "30 minutes" → delay_minutes: 30
- "1 hour" / "one hour" / "in an hour" → delay_minutes: 60
- "tomorrow" / "tomorrow morning" → delay_minutes: 570 (9:30 AM IST next day)
- "evening" / "this evening" / "today evening" → delay_minutes: calculated until 18:00 IST
- "in 2 hours" → delay_minutes: 120

IMPORTANT RULES:
- Be lenient with natural language, typos, and casual speech
- "call now" means schedule_call_now even if phrased as "call me now" or "can you call"
- If the message contains both interest AND a scheduling intent, prefer schedule_call_now or schedule_call_later
- "interested" alone without scheduling = interested intent
- Questions about salary/role/location = question intent, NOT interested
- Single word "yes" after previous context is usually interested
- Single word "no" or "nah" is usually not_interested
- Gibberish, emojis only, or unrelated = unclear

Return ONLY valid JSON:
{
  "intent": "schedule_call_now|schedule_call_later|interested|not_interested|provide_details|question|unclear",
  "confidence": 0.0-1.0,
  "delay_minutes": null,
  "reasoning": "brief one-line explanation"
}`;

export async function classifyIntent(
  message: string,
  participant: ParticipantContext
): Promise<IntentClassification> {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('Gemini API key not set, falling back to keyword matching');
    return fallbackClassify(message);
  }

  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 200,
        responseMimeType: 'application/json',
      },
    });

    const prompt = INTENT_PROMPT
      .replace('{candidateName}', participant.candidate_name)
      .replace('{jobTitle}', participant.job_title)
      .replace('{companyName}', participant.company_name)
      .replace('{status}', participant.status)
      .replace('{screeningMode}', participant.screening_mode || 'unknown')
      .replace('{whatsappSentAt}', participant.whatsapp_sent_at || 'not yet')
      .replace('{message}', message);

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const parsed = JSON.parse(text);

    if (!parsed.intent || typeof parsed.confidence !== 'number') {
      throw new Error('Invalid LLM response structure');
    }

    const validIntents: Intent[] = [
      'schedule_call_now', 'schedule_call_later', 'interested',
      'not_interested', 'provide_details', 'question', 'unclear'
    ];
    if (!validIntents.includes(parsed.intent)) {
      throw new Error(`Invalid intent: ${parsed.intent}`);
    }

    const classification: IntentClassification = {
      intent: parsed.intent,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      delay_minutes: parsed.delay_minutes ?? null,
      reasoning: parsed.reasoning || '',
    };

    logger.info('AI intent classified', {
      message: message.substring(0, 100),
      intent: classification.intent,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
    });

    return classification;
  } catch (error) {
    logger.error('AI intent classification failed, falling back to keywords', {
      error: error instanceof Error ? error.message : String(error),
      message: message.substring(0, 100),
    });
    return fallbackClassify(message);
  }
}

function fallbackClassify(message: string): IntentClassification {
  const lower = message.toLowerCase().trim();

  if (lower === 'call now' || lower === 'call' || lower === 'callnow') {
    return { intent: 'schedule_call_now', confidence: 0.9, delay_minutes: null, reasoning: 'fallback: exact match' };
  }
  if (lower.match(/^(in\s+)?(10|ten)\s*(min|minutes?)$/)) {
    return { intent: 'schedule_call_later', confidence: 0.9, delay_minutes: 10, reasoning: 'fallback: exact match' };
  }
  if (lower.match(/^(in\s+)?(30|thirty)\s*(min|minutes?)$/)) {
    return { intent: 'schedule_call_later', confidence: 0.9, delay_minutes: 30, reasoning: 'fallback: exact match' };
  }
  if (lower.match(/^(in\s+)?(1\s+)?(hour|one\s+hour)$/)) {
    return { intent: 'schedule_call_later', confidence: 0.9, delay_minutes: 60, reasoning: 'fallback: exact match' };
  }
  if (lower === 'tomorrow' || lower === 'tomorrow morning') {
    return { intent: 'schedule_call_later', confidence: 0.9, delay_minutes: 570, reasoning: 'fallback: exact match' };
  }
  if (lower === 'evening' || lower === 'this evening' || lower === 'today evening') {
    return { intent: 'schedule_call_later', confidence: 0.9, delay_minutes: 480, reasoning: 'fallback: exact match' };
  }
  if (lower === 'interested' || lower === 'yes interested' || lower === 'yes i am interested') {
    return { intent: 'interested', confidence: 0.85, delay_minutes: null, reasoning: 'fallback: exact match' };
  }
  if (lower === 'not interested' || lower === 'no not interested' || lower === 'no thanks' || lower === 'no') {
    return { intent: 'not_interested', confidence: 0.85, delay_minutes: null, reasoning: 'fallback: exact match' };
  }
  if (lower.includes('share my details') || lower.includes('provide details') || lower.includes('my ctc') || lower.includes('my notice period')) {
    return { intent: 'provide_details', confidence: 0.8, delay_minutes: null, reasoning: 'fallback: keyword match' };
  }

  return { intent: 'unclear', confidence: 0.3, delay_minutes: null, reasoning: 'fallback: no match' };
}
