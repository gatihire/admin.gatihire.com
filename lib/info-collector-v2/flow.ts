import { supabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { getWhatsAppService } from '@/lib/whatsapp';
import { scheduleBolnaCall, scheduleCall } from '@/lib/scheduled-call';
import { 
  INFO_STEPS, 
  STEP_KEYS, 
  REQUIRED_STEPS, 
  getStep, 
  getNextStep, 
  isFirstStep, 
  isLastStep,
  getStepQuestion
} from './steps';
import { 
  validateStep, 
  formatConfirmation, 
  getValidationError 
} from './validators';
import { 
  extractStepValue,
  extractAllFieldsFromReply
} from './extractor';
import {
  sendFirstQuestion,
  sendStepQuestion,
  sendReminder,
  sendConfirmationAndScheduleCall,
  sendEditPrompt,
  handleEditResponse,
  sendSessionMessage,
  ParticipantInfo
} from './sender';

export interface HandleResult {
  success: boolean;
  error?: string;
  action?: 'next_step' | 'confirmed' | 'edit_mode' | 'reminder_sent' | 'filtered_out' | 'needs_review' | 'proceed_to_call';
  message?: string;
}

interface ParticipantWithExtras {
  id: string;
  candidate_id: string;
  phone_number: string;
  candidate_name: string;
  job_title: string;
  company_name: string;
  status: string;
  info_step: string;
  info_data: Record<string, any>;
  info_confirmed: boolean;
  whatsapp_message_id: string | null;
  origin: string;
  screening_mode: string;
  screening_context: Record<string, any>;
  candidates: { id: string; name: string; phone: string; email: string } | null;
  jobs: { id: string; title: string; client_name: string; city: string } | null;
}

async function getParticipantWithExtras(participantId: string): Promise<ParticipantWithExtras | null> {
  const { data, error } = await supabaseAdmin
    .from('phone_screening_participants')
    .select(`
      *,
      candidates:candidate_id (id, name, phone, email),
      jobs:job_id (id, title, client_name, city)
    `)
    .eq('id', participantId)
    .maybeSingle();
  
  if (error || !data) return null;
  
  return {
    ...data,
    phone_number: data.candidates?.phone || '',
    candidate_name: data.candidates?.name || '',
    job_title: data.jobs?.title || '',
    company_name: data.jobs?.client_name || '',
  } as any;
}

async function initializeInfoCollection(participant: any): Promise<{ success: boolean; error?: string }> {
  // Reset info collection state
  await supabaseAdmin
    .from('phone_screening_participants')
    .update({
      info_step: 'current_ctc',
      info_data: {},
      info_confirmed: false,
      status: 'info_requested',
      info_request_sent_at: new Date().toISOString(),
      screening_context: {
        ...(participant.screening_context || {}),
        info_collection_started_at: new Date().toISOString()
      },
      updated_at: new Date().toISOString()
    })
    .eq('id', participant.id);
  
  return { success: true };
}

async function handleStepByStepReply(participantId: string, replyText: string): Promise<{
  success: boolean;
  error?: string;
  action?: 'next_step' | 'confirmed' | 'edit_mode' | 'reminder_sent' | 'filtered_out' | 'needs_review' | 'proceed_to_call';
  message?: string;
}> {
  try {
    const participant = await getParticipantWithExtras(participantId);
    if (!participant) {
      return { success: false, error: 'Participant not found' };
    }

    logger.info('Processing step-by-step reply', { 
      participantId, 
      replyText: replyText.substring(0, 100),
      currentStep: participant.info_step,
      status: participant.status,
      infoConfirmed: participant.info_confirmed 
    });

    const trimmed = replyText.toLowerCase().trim();

    // Handle edit mode - either explicitly triggered or participant is confirmed and replying with a field name
    if (trimmed === 'edit' || (participant.info_confirmed && participant.info_step !== 'confirmed')) {
      await supabaseAdmin
        .from('phone_screening_participants')
        .update({
          info_confirmed: false,
          updated_at: new Date().toISOString()
        })
        .eq('id', participantId);
      
      const refreshed = await getParticipantWithExtras(participantId);
      if (refreshed) {
        await sendEditPrompt(refreshed);
      }
      return { success: true, action: 'edit_mode' };
    }

    // Handle edit response - participant is in confirmed state but step is 'confirmed', process as edit
    if (participant.info_confirmed && participant.info_step === 'confirmed') {
      const editResult = await handleEditResponse(participant, replyText);
      if (editResult.success) {
        const refreshed = await getParticipantWithExtras(participantId);
        if (refreshed) {
          await sendStepQuestion(refreshed, refreshed.info_step, refreshed.job_title, refreshed.company_name);
        }
        return { success: true, action: 'edit_mode' };
      }
      return { success: false, error: editResult.error };
    }

    // Handle confirmation
    if (trimmed === 'confirm' || trimmed === 'yes confirm') {
      if (participant.info_confirmed) {
        return { success: true, action: 'confirmed', message: 'Already confirmed!' };
      }
      
      const missingRequired = REQUIRED_STEPS.filter(key => !participant.info_data[key]);
      if (missingRequired.length > 0) {
        return { 
          success: false, 
          error: `Please complete all required fields first. Missing: ${missingRequired.join(', ')}` 
        };
      }
      
      await supabaseAdmin
        .from('phone_screening_participants')
        .update({
          info_confirmed: true,
          status: 'info_received',
          info_received_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', participantId);
      
      const refreshed = await getParticipantWithExtras(participantId);
      if (refreshed) {
        await sendConfirmationAndScheduleCall(refreshed, refreshed.job_title, refreshed.company_name);
      }
      
      return { success: true, action: 'confirmed', message: 'Info confirmed! Scheduling call...' };
    }

    // Handle participant not in info collection flow
    if (participant.status !== 'info_requested' && participant.info_step === 'current_ctc' && Object.keys(participant.info_data || {}).length === 0) {
      await initializeInfoCollection(participant);
      
      const result = await sendFirstQuestion(
        { 
          id: participant.id, 
          candidate_id: participant.candidate_id,
          phone_number: participant.phone_number,
          candidate_name: participant.candidate_name,
          job_title: participant.job_title,
          company_name: participant.company_name,
          status: participant.status,
          info_step: 'current_ctc',
          info_data: {},
          info_confirmed: false,
          origin: participant.origin,
          whatsapp_message_id: null,
          screening_context: participant.screening_context || {}
        },
        participant.job_title,
        participant.company_name
      );
      
      if (result.success) {
        return { success: true, action: 'next_step', message: 'Started info collection' };
      }
      return { success: false, error: 'Failed to send first question' };
    }

    // Handle step-by-step response
    const currentStep = participant.info_step;
    const currentStepKey = participant.info_step as any;
    
    // NEW: Detect multi-field reply (CTC + notice period + experience in one message)
    // If user provides multiple fields at once, parse all and jump to confirmation
    const lowerReply = replyText.toLowerCase();
    const hasMultipleFields = (
      (lowerReply.match(/\d+\s*(?:lpa|l|k)/gi) || []).length >= 1 &&  // CTC pattern
      (lowerReply.includes('day') || lowerReply.includes('month') || lowerReply.includes('week') || lowerReply.includes('immediate') || lowerReply.includes('asap') || lowerReply.match(/\b\d+\b/))  // notice period pattern
    );
    
    // Also check for experience pattern
    const hasExperience = /(\d+(?:\.\d+)?)\s*(?:years?|yrs?|yoe)/i.test(replyText) || /\d+\s*months?/i.test(replyText);
    
    // If we're at first step (current_ctc) and user provided multiple fields, parse all at once
    if (currentStep === 'current_ctc' && (hasMultipleFields || hasExperience)) {
      logger.info('Detected multi-field reply, extracting all fields', { 
        participantId, 
        replyText: replyText.substring(0, 100),
        currentStep 
      });
      
      const allFields = await extractAllFieldsFromReply(replyText, participant.info_data || {});
      logger.info('Multi-field extraction result', { participantId, allFields });
      
      // Merge with existing info_data
      const mergedInfoData = { ...participant.info_data, ...allFields } as Record<string, any>;
      
      // Check if all required fields are now filled
      const missingRequired = REQUIRED_STEPS.filter(key => !mergedInfoData[key]);
      
      if (missingRequired.length === 0) {
        // All required fields filled - go to confirmation
        await supabaseAdmin
          .from('phone_screening_participants')
          .update({
            info_data: mergedInfoData,
            info_step: 'confirm',
            info_confirmed: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', participantId);
        
        const refreshed = await getParticipantWithExtras(participantId);
        if (refreshed) {
          await sendConfirmationAndScheduleCall(refreshed, participant.job_title, participant.company_name);
        }
        return { success: true, action: 'confirmed' };
      } else {
        // Some fields still missing - update what we have and ask for next missing
        const nextMissing = missingRequired[0];
        await supabaseAdmin
          .from('phone_screening_participants')
          .update({
            info_data: mergedInfoData,
            info_step: nextMissing,
            info_confirmed: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', participantId);
        
        const refreshed = await getParticipantWithExtras(participantId);
        if (refreshed) {
          await sendStepQuestion(refreshed, nextMissing, participant.job_title, participant.company_name);
        }
        return { success: true, action: 'next_step' };
      }
    }
    
    // Extract value using LLM + regex fallback (original single-field logic)
    const step = getStep(currentStepKey);
    const question = getStepQuestion(currentStepKey, participant.candidate_name, participant.job_title, participant.company_name);
    
    const extraction = await extractStepValue(currentStepKey, replyText, question, participant.info_data || {});
    
    if (!extraction.is_valid) {
      // Invalid response - show error and re-ask
      const errorMsg = extraction.error_message || getValidationError(currentStepKey);
      await sendStepQuestion(
        await getParticipantWithExtras(participantId) as any,
        currentStepKey,
        participant.job_title,
        participant.company_name
      );
      
      // Also send error message
      await sendSessionMessage(participant.phone_number, `❌ ${extraction.error_message || 'Invalid input. Please try again.'}\n\n${getStepQuestion(currentStepKey, participant.candidate_name, participant.job_title, participant.company_name)}`);
      
      return { success: true, action: 'next_step' };
    }
    
    // Valid response - save and move to next step
    const nextStep = getNextStep(currentStepKey);
    
    await supabaseAdmin
      .from('phone_screening_participants')
      .update({
        info_data: { ...participant.info_data, [currentStepKey]: extraction.normalized_value },
        info_step: nextStep || 'confirm',
        info_confirmed: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', participantId);
    
    logger.info('Step completed, moving to next', { 
      participantId, 
      currentStep, 
      nextStep,
      extractedValue: extraction.normalized_value 
    });
    
if (nextStep === null) {
      // All steps done - send confirmation
      const refreshed = await getParticipantWithExtras(participantId);
      if (refreshed) {
        await sendConfirmationAndScheduleCall(refreshed, participant.job_title, participant.company_name);
        return { success: true, action: 'confirmed' };
      }
    } else if (nextStep) {
      // Send next question
      await sendStepQuestion(
        await getParticipantWithExtras(participantId) as any,
        nextStep,
        participant.job_title,
        participant.company_name
      );
      return { success: true, action: 'next_step' };
    }
    
    return { success: true, action: 'next_step' };
  } catch (error: any) {
    logger.error('Error handling step-by-step reply', { participantId, error: error.message });
    return { success: false, error: error.message };
  }
}

async function handleIncomingCallNow(participantId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const participant = await getParticipantWithExtras(participantId);
    if (!participant) return { success: false, error: 'Participant not found' };
    
    // Schedule immediate call
    await scheduleCall(participant, 0);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function handleIncomingSchedule(participantId: string, delayMs: number): Promise<{ success: boolean; error?: string }> {
  try {
    const participant = await getParticipantWithExtras(participantId);
    if (!participant) return { success: false, error: 'Participant not found' };
    
    await scheduleCall(participant, delayMs);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function handleInteractiveButton(participantId: string, buttonId: string, _buttonTitle: string): Promise<{ success: boolean; error?: string }> {
  try {
    const participant = await getParticipantWithExtras(participantId);
    if (!participant) return { success: false, error: 'Participant not found' };
    
    logger.info('Handling interactive button', { participantId, buttonId, buttonTitle: _buttonTitle });
    
    switch (buttonId) {
      case 'interested': {
        await supabaseAdmin
          .from('phone_screening_participants')
          .update({ 
            status: 'interested',
            updated_at: new Date().toISOString()
          })
          .eq('id', participantId);
        
        const whatsapp = getWhatsAppService();
        if (participant.candidates?.phone) {
          await whatsapp.sendScheduleOptions({
            phoneNumber: participant.candidates.phone,
            candidateName: participant.candidate_name,
            jobTitle: participant.job_title,
          });
        }
        break;
      }
        
      case 'not_interested': {
        const ws = getWhatsAppService();
        if (participant.candidates?.phone) {
          await ws.sendNotInterestedReason({
            phoneNumber: participant.candidates.phone,
            candidateName: participant.candidate_name,
          });
        }
        break;
      }
        
      case 'call_now':
        await scheduleCall(participant, 0);
        break;
        
      case 'in_10_min':
        await scheduleCall(participant, 10 * 60 * 1000);
        break;
        
      case 'in_30_min':
        await scheduleCall(participant, 30 * 60 * 1000);
        break;
        
      case 'today_evening':
        const now = new Date();
        const evening = new Date(now);
        evening.setUTCHours(12, 30, 0, 0);
        if (evening <= now) evening.setDate(evening.getDate() + 1);
        await scheduleCall(participant, evening.getTime() - now.getTime());
        break;
        
      case 'tomorrow_morning':
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setUTCHours(3, 30, 0, 0);
        await scheduleCall(participant, tomorrow.getTime() - Date.now());
        break;
        
      case 'provide_details': {
        await initializeInfoCollection({
          id: participant.id,
          candidate_id: participant.candidate_id,
          phone_number: participant.phone_number,
          candidate_name: participant.candidate_name,
          job_title: participant.job_title,
          company_name: participant.company_name,
          status: participant.status,
          origin: participant.origin
        });
        
        await sendFirstQuestion(
          { id: participant.id, candidate_id: participant.candidate_id, phone_number: participant.phone_number, candidate_name: participant.candidate_name, job_title: participant.job_title, company_name: participant.company_name, status: 'applied', info_step: 'current_ctc', info_data: {}, info_confirmed: false, origin: participant.origin, whatsapp_message_id: null, screening_context: {} },
          participant.job_title,
          participant.company_name
        );
        break;
      }
        
      case 'skip_schedule_call':
        await supabaseAdmin
          .from('phone_screening_participants')
          .update({ 
            status: 'whatsapp_sent',
            updated_at: new Date().toISOString()
          })
          .eq('id', participantId);
        break;
        
      // Rejection reasons
      case 'reject_not_looking':
      case 'reject_comp_mismatch':
      case 'reject_location':
      case 'reject_placed':
      case 'reject_role_not_relevant':
      case 'reject_other':
        const reason = buttonId.replace('reject_', '');
        await handleRejectionReason(participant.id, reason as any);
        break;
        
      default:
        logger.warn('Unknown button reply', { buttonId });
    }
    
    return { success: true };
  } catch (error: any) {
    logger.error('Error handling interactive button', { buttonId, error: error.message });
    return { success: false, error: error.message };
  }
}

// Re-export handleRejectionReason and handleRejectionReason from info-collector
async function handleRejectionReason(participantId: string, reason: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { handleRejectionReason: handleRej } = await import('@/lib/info-collector');
    return await handleRej(participantId, reason);
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export {
  handleStepByStepReply,
  handleIncomingCallNow,
  handleIncomingSchedule,
  handleInteractiveButton,
  initializeInfoCollection,
  handleRejectionReason,
  getParticipantWithExtras,
};