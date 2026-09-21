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
    question: 'What is your current CTC (annual)?\n\nExample: "8 LPA", "800000", "80K"',
    validator: 'ctc',
    required: true,
    example: '8 LPA',
    helpText: 'Your current annual compensation (e.g., 8 LPA, 800000, 80K)'
  },
  {
    key: 'expected_ctc',
    label: 'Expected CTC',
    question: 'What is your expected CTC (annual)?\n\nExample: "12 LPA", "1500000"',
    validator: 'ctc',
    required: true,
    example: '12 LPA',
    helpText: 'Your expected annual compensation'
  },
  {
    key: 'notice_period',
    label: 'Notice Period',
    question: 'What is your notice period?\n\nExample: "30 days", "1 month", "Immediate"',
    validator: 'notice_period',
    required: true,
    example: '30 days',
    helpText: 'How soon you can join (e.g., 30 days, 1 month, Immediate)'
  },
  {
    key: 'total_experience',
    label: 'Total Experience',
    question: 'What is your total work experience?\n\nExample: "4 years", "3.5 years", "48 months"',
    validator: 'experience',
    required: true,
    example: '4 years',
    helpText: 'Total years of work experience'
  },
  {
    key: 'location',
    label: 'Current Location',
    question: 'What is your current city/location?\n\nExample: "Mumbai", "Bangalore", "Delhi NCR"',
    validator: 'location',
    required: true,
    example: 'Mumbai',
    helpText: 'Your current city/location'
  },
  {
    key: 'willing_to_relocate',
    label: 'Willing to Relocate',
    question: 'Are you willing to relocate for this role?\n\nReply with "yes" or "no"',
    validator: 'boolean',
    required: true,
    example: 'yes',
    helpText: 'Are you open to relocating for this role? (yes/no)'
  },
  {
    key: 'reason_for_switching',
    label: 'Reason for Switching',
    question: 'Why are you looking to switch jobs? (Optional)\n\nExample: "Better growth opportunities", "Location change"',
    validator: 'text',
    required: false,
    example: 'Better growth opportunities',
    helpText: 'Brief reason for job change (optional)'
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