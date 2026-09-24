export const INFO_STEPS: Array<{
  key: string;
  label: string;
  question: string;
  validator: string;
  required: boolean;
  example: string;
  helpText: string;
}> = [
  {
    key: 'current_ctc',
    label: 'Current CTC',
    question: 'Aapka current CTC (annual) kya hai?\n\nExample: "8 LPA", "800000", "80K"',
    validator: 'ctc',
    required: true,
    example: '8 LPA',
    helpText: 'Aapki current annual salary (e.g., 8 LPA, 800000, 80K)'
  },
  {
    key: 'expected_ctc',
    label: 'Expected CTC',
    question: 'Aapki expected CTC (annual) kya hai?\n\nExample: "12 LPA", "1500000"',
    validator: 'ctc',
    required: true,
    example: '12 LPA',
    helpText: 'Aapki expected annual salary'
  },
  {
    key: 'notice_period',
    label: 'Notice Period',
    question: 'Aapka notice period kya hai?\n\nExample: "30 days", "1 month", "Immediate"',
    validator: 'notice_period',
    required: true,
    example: '30 days',
    helpText: 'Kitne time me join kar sakte hain (e.g., 30 days, 1 month, Immediate)'
  },
  {
    key: 'total_experience',
    label: 'Total Experience',
    question: 'Aapka total work experience kya hai?\n\nExample: "4 years", "3.5 years", "48 months"',
    validator: 'experience',
    required: true,
    example: '4 years',
    helpText: 'Total years of work experience'
  },
  {
    key: 'location',
    label: 'Current Location',
    question: 'Aapka current city/location kya hai?\n\nExample: "Mumbai", "Bangalore", "Delhi NCR"',
    validator: 'location',
    required: true,
    example: 'Mumbai',
    helpText: 'Aapka current city/location'
  },
  {
    key: 'willing_to_relocate',
    label: 'Willing to Relocate',
    question: 'Kya aap is role ke liye relocate karne ko ready hain?\n\nReply "yes" ya "no"',
    validator: 'boolean',
    required: true,
    example: 'yes',
    helpText: 'Relocation ke liye ready hain? (yes/no)'
  },
  {
    key: 'reason_for_switching',
    label: 'Reason for Switching',
    question: 'Job switch karne ka reason kya hai? (Optional)\n\nExample: "Better growth opportunities", "Location change"',
    validator: 'text',
    required: false,
    example: 'Better growth opportunities',
    helpText: 'Job change ka karan (optional)'
  }
];

export type InfoStepKey = 'current_ctc' | 'expected_ctc' | 'notice_period' | 'total_experience' | 'location' | 'willing_to_relocate' | 'reason_for_switching';
export const STEP_KEYS = INFO_STEPS.map(s => s.key);
export const REQUIRED_STEPS = INFO_STEPS.filter(s => s.required).map(s => s.key);
export const STEP_COUNT = INFO_STEPS.length;

export function getStep(key: InfoStepKey) {
  return INFO_STEPS.find(s => s.key === key);
}

export function getStepIndex(key: InfoStepKey) {
  return INFO_STEPS.findIndex(s => s.key === key);
}

export function getNextStep(key: InfoStepKey) {
  const idx = getStepIndex(key);
  if (idx >= 0 && idx < INFO_STEPS.length - 1) {
    return INFO_STEPS[idx + 1].key;
  }
  return null;
}

export function getPreviousStep(key: InfoStepKey) {
  const idx = getStepIndex(key);
  if (idx > 0) {
    return INFO_STEPS[idx - 1].key;
  }
  return null;
}

export function isLastStep(key: InfoStepKey) {
  return getStepIndex(key) === INFO_STEPS.length - 1;
}

export function isFirstStep(key: InfoStepKey) {
  return getStepIndex(key) === 0;
}

export function getStepQuestion(key: InfoStepKey, candidateName: string, jobTitle: string, companyName: string): string {
  const step = getStep(key);
  if (!step) return '';
  
  let question = step.question;
  question = question.replace('{{candidateName}}', candidateName);
  question = question.replace('{{jobTitle}}', jobTitle);
  question = question.replace('{{companyName}}', companyName);
  
  return question;
}