import { InfoStepKey } from './steps';

export interface ValidationResult {
  valid: boolean;
  normalized?: string;
  error?: string;
}

export interface ValidationContext {
  stepKey: string;
  userInput: string;
  infoData?: Record<string, any>;
}

export function extractCtcNumber(text: string): number | null {
  const cleaned = text
    .replace(/(current|expected|ctc|lpa|per annum|pa|annual|lakhs|lakh|k|inr|rs|rupees|salary)/gi, '')
    .trim();
  const numMatch = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!numMatch) return null;
  
  const num = parseFloat(numMatch[1]);
  if (num < 100) return num;
  if (num > 100000) return num / 100000;
  if (num > 1000 && num < 100000) return num / 1000;
  return num;
}

export function extractNoticePeriod(text: string): string | null {
  const lower = text.toLowerCase().trim();
  
  if (/immediate|immed|asap|join now|available now/.test(text)) {
    return 'Immediate';
  }
  
  const dayMatch = text.match(/(\d+)\s*(day|days)/i);
  if (dayMatch) return `${dayMatch[1]} days`;
  
  const weekMatch = text.match(/(\d+)\s*(week|weeks)/i);
  if (weekMatch) return `${parseInt(weekMatch[1]) * 7} days`;
  
  const monthMatch = text.match(/(\d+)\s*(month|months)/i);
  if (monthMatch) return `${parseInt(monthMatch[1]) * 30} days`;
  
  const numMatch = text.match(/^(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1]);
    if (num >= 1 && num <= 90) return `${num} days`;
    if (num > 90) return `${Math.round(num / 30)} months`;
  }
  
  return null;
}

export function validateStep(stepKey: string, userInput: string): { valid: boolean; normalized?: string; error?: string } {
  switch (stepKey) {
    case 'current_ctc':
    case 'expected_ctc':
      return validateCtc(userInput);
    case 'notice_period':
      return validateNoticePeriod(userInput);
    case 'total_experience':
      return validateExperience(userInput);
    case 'location':
      return validateLocation(userInput);
    case 'willing_to_relocate':
      return validateBoolean(userInput);
    case 'reason_for_switching':
      return validateText(userInput);
    default:
      return { valid: true, normalized: userInput };
  }
}

export function validateCtc(input: string): { valid: boolean; normalized?: string; error?: string } {
  const num = extractCtcNumber(input);
  if (num === null) {
    return { valid: false, error: 'Please provide CTC like "8 LPA", "800000", or "80K"' };
  }
  return { valid: true, normalized: `${num} LPA` };
}

export function validateNoticePeriod(input: string): { valid: boolean; normalized?: string; error?: string } {
  const period = extractNoticePeriod(input);
  if (!period) {
    return { valid: false, error: 'Please provide notice period like "30 days", "1 month", or "Immediate"' };
  }
  return { valid: true, normalized: period };
}

export function validateExperience(input: string): { valid: boolean; normalized?: string; error?: string } {
  const text = input.toLowerCase().trim();
  
  // Try years first
  const yearMatch = input.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|yoe|experience)/i);
  if (yearMatch) {
    const years = parseFloat(yearMatch[1]);
    return { valid: true, normalized: `${years} years` };
  }
  
  // Try months
  const monthMatch = input.match(/(\d+)\s*(?:months?|months?)/i);
  if (monthMatch) {
    const months = parseInt(monthMatch[1]);
    return { valid: true, normalized: `${months / 12} years` };
  }
  
  // Just a number - assume years
  const numMatch = input.match(/^(\d+(?:\.\d+)?)$/);
  if (numMatch) {
    const years = parseFloat(numMatch[1]);
    if (years > 0 && years <= 50) {
      return { valid: true, normalized: `${years} years` };
    }
  }
  
  return { valid: false, error: 'Please provide experience like "4 years", "3.5 years", or "48 months"' };
}

export function validateLocation(input: string): { valid: boolean; normalized?: string; error?: string } {
  const val = input.trim();
  if (val.length < 2) {
    return { valid: false, error: 'Please provide a valid city name' };
  }
  const normalized = val
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return { valid: true, normalized };
}

export function validateBoolean(input: string): { valid: boolean; normalized?: string; error?: string } {
  const val = input.toLowerCase().trim();
  const yes = /^(yes|y|yeah|sure|ok|okay|willing|can relocate|relocate)$/i.test(val);
  const no = /^(no|n|nope|not willing|cannot relocate|not willing)$/i.test(val);
  
  if (yes) return { valid: true, normalized: 'yes' };
  if (no) return { valid: true, normalized: 'no' };
  
  return { valid: false, error: 'Please reply "yes" or "no"' };
}

export function validateText(input: string): { valid: boolean; normalized?: string; error?: string } {
  const val = input.trim();
  if (val.length < 3) {
    return { valid: false, error: 'Please provide a brief reason (at least 3 characters)' };
  }
  return { valid: true, normalized: val };
}

export function getValidationError(stepKey: string): string {
  const errors: Record<string, string> = {
    current_ctc: 'Please provide CTC like "8 LPA", "800000", or "80K"',
    expected_ctc: 'Please provide expected CTC like "12 LPA", "1500000", "12 LPA"',
    notice_period: 'Please provide notice period like "30 days", "1 month", or "Immediate"',
    total_experience: 'Please provide experience like "4 years", "3.5 years", or "48 months"',
    location: 'Please provide a valid city name',
    willing_to_relocate: 'Please reply "yes" or "no"',
    reason_for_switching: 'Please provide a brief reason (at least 3 characters)',
  };
  return errors[stepKey] || 'Please provide a valid answer';
}

export function formatConfirmation(infoData: Record<string, any>): string {
  const lines = ['📋 **Your Details:**'];
  
  const displayMap: Record<string, string> = {
    current_ctc: 'Current CTC',
    expected_ctc: 'Expected CTC',
    notice_period: 'Notice Period',
    total_experience: 'Experience',
    location: 'Current Location',
    willing_to_relocate: 'Willing to Relocate',
    reason_for_switching: 'Reason for Switching',
  };
  
  for (const [key, value] of Object.entries(infoData)) {
    if (value !== undefined && value !== null && value !== '') {
      const label = displayMap[key] || key;
      lines.push(`• ${label}: ${value}`);
    }
  }
  
  lines.push('\n✅ **Reply "confirm" to submit** or reply "edit" to change any answer.');
  
  return lines.join('\n');
}