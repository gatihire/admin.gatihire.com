// Info Collector V2 - Step-by-step WhatsApp info collection
// Main entry point

export {
  INFO_STEPS,
  STEP_KEYS,
  REQUIRED_STEPS,
  getStep,
  getNextStep,
  isFirstStep,
  isLastStep,
  getStepQuestion,
} from './steps';

export type { InfoStepKey } from './steps';

export {
  validateStep,
  formatConfirmation,
  getValidationError,
} from './validators';

export type { ValidationResult, ValidationContext } from './validators';

export {
  extractStepValue,
  extractAllFieldsFromReply
} from './extractor';

export {
  sendFirstQuestion,
  sendStepQuestion,
  sendReminder,
  sendConfirmationAndScheduleCall,
  sendEditPrompt,
  handleEditResponse,
  sendSessionMessage,
} from './sender';

export type { ParticipantInfo } from './sender';

export {
  handleStepByStepReply,
  handleIncomingCallNow,
  handleIncomingSchedule,
  handleInteractiveButton,
  initializeInfoCollection,
  handleRejectionReason,
  getParticipantWithExtras,
} from './flow';

export type { HandleResult } from './flow';