import { getWhatsAppService } from '@/lib/whatsapp';
import { supabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { InfoStepKey, getStep, getNextStep, getStepQuestion, STEP_KEYS } from './steps';

export interface ParticipantInfo {
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
  screening_context: Record<string, any>;
}

async function sendTemplateMessage(
  phoneNumber: string,
  templateName: string,
  components: Array<{ type: string; parameters: Array<{ type: string; text: string }> }>
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const whatsapp = getWhatsAppService();
  return whatsapp.sendTemplateMessage({
    to: phoneNumber,
    templateName,
    languageCode: 'en',
    components: components as any
  });
}

async function sendSessionMessage(phoneNumber: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v21.0';
  
  const normalizedPhone = phoneNumber.replace(/\D/g, '').replace(/^0+/, '');
  const recipient = normalizedPhone.startsWith('91') ? normalizedPhone : `91${normalizedPhone}`;
  
  try {
    const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { body: text }
      })
    });
    
    const data = await response.json().catch(() => ({}));
    
    if (!response.ok || data.error) {
      const error = data.error?.message || `HTTP ${response.status}`;
      logger.error('Failed to send session message', { phoneNumber, error, response: data });
      return { success: false, error };
    }
    
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (error: any) {
    logger.error('Exception sending session message', { phoneNumber, error: error.message });
    return { success: false, error: error.message };
  }
}

async function sendFirstQuestion(
  participant: ParticipantInfo,
  jobTitle: string,
  companyName: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const stepKey: InfoStepKey = 'current_ctc';
  
  const templateName = process.env.WHATSAPP_TEMPLATE_INBOUND_SCREENING || 'inbound_screening_invite';
  
  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: participant.candidate_name },
        { type: 'text', text: jobTitle },
        { type: 'text', text: companyName }
      ]
    }
  ];
  
  const result = await sendTemplateMessage(participant.phone_number, templateName, components);
  
  if (result.success) {
    await supabaseAdmin
      .from('phone_screening_participants')
      .update({
        info_step: stepKey,
        info_data: {},
        info_confirmed: false,
        status: 'info_requested',
        info_request_sent_at: new Date().toISOString(),
        whatsapp_message_id: result.messageId,
        whatsapp_outbound_template: templateName,
        whatsapp_sent_at: new Date().toISOString(),
        whatsapp_delivery_status: 'sent',
        updated_at: new Date().toISOString()
      })
      .eq('id', participant.id);
    
    logger.info('Sent first info question via template', { 
      participantId: participant.id, 
      stepKey,
      messageId: result.messageId 
    });
  }
  
  return result;
}

async function sendStepQuestion(
  participant: ParticipantInfo,
  stepKey: string,
  jobTitle: string,
  companyName: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const question = getStepQuestion(stepKey as InfoStepKey, participant.candidate_name, jobTitle, companyName);
  const step = getStep(stepKey as InfoStepKey);
  const text = `${question}\n\n💡 ${step?.helpText || ''}`;
  
  const result = await sendSessionMessage(participant.phone_number, text);
  
  if (result.success) {
    await supabaseAdmin
      .from('phone_screening_participants')
      .update({
        info_step: stepKey,
        whatsapp_outbound_template: null,
        whatsapp_sent_at: new Date().toISOString(),
        whatsapp_delivery_status: 'sent',
        updated_at: new Date().toISOString()
      })
      .eq('id', participant.id);
    
    logger.info('Sent step question via session message', { 
      participantId: participant.id, 
      stepKey 
    });
  }
  
  return { success: true, messageId: result.messageId };
}

async function sendReminder(participant: ParticipantInfo): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const templateName = process.env.WHATSAPP_TEMPLATE_INFO_REMINDER || 'info_reminder';
  
  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: participant.candidate_name }
      ]
    }
  ];
  
  const result = await sendTemplateMessage(participant.phone_number, templateName, components);
  
  if (result.success) {
    await supabaseAdmin
      .from('phone_screening_participants')
      .update({
        screening_context: {
          ...(participant.screening_context || {}),
          info_reminder_sent: true,
          reminder_sent_at: new Date().toISOString()
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', participant.id);
  }
  
  return { success: true, messageId: result.messageId };
}

function formatConfirmation(infoData: Record<string, any>): string {
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

async function sendConfirmationAndScheduleCall(
  participant: ParticipantInfo,
  jobTitle: string,
  companyName: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const result = await sendSessionMessage(participant.phone_number, formatConfirmation(participant.info_data));
  
  if (result.success) {
    await supabaseAdmin
      .from('phone_screening_participants')
      .update({
        info_confirmed: true,
        status: 'info_received',
        info_received_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', participant.id);
    
    const { scheduleBolnaCall } = await import('@/lib/scheduled-call');
    const callDelaySec = 60;
    const scheduled = await scheduleBolnaCall(participant.id, callDelaySec);
    
    if (scheduled.scheduled) {
      await supabaseAdmin
        .from('phone_screening_participants')
        .update({
          status: 'call_scheduled',
          scheduled_at: new Date(Date.now() + callDelaySec * 1000).toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', participant.id);
      
      logger.info('Auto-scheduled AI call after confirmation', { 
        participantId: participant.id, 
        delaySec: callDelaySec 
      });
    } else {
      logger.error('Failed to auto-schedule call after confirmation', { 
        participantId: participant.id, 
        error: scheduled.error 
      });
    }
  }
  
  return { success: true, messageId: result.messageId };
}

async function sendEditPrompt(participant: ParticipantInfo): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const infoData = participant.info_data;
  const lines = ['📝 **Current Details:**'];
  
  for (const key of Object.keys(infoData)) {
    const step = getStep(key as InfoStepKey);
    if (step && infoData[key]) {
      lines.push(`• ${step.label}: ${infoData[key]}`);
    }
  }
  
  lines.push('\n✏️ **Reply with the field name to edit:**');
  lines.push('e.g., "current_ctc", "expected_ctc", "notice_period", etc.');
  lines.push('Or reply "cancel" to keep current values.');
  
  return sendSessionMessage(participant.phone_number, lines.join('\n'));
}

async function handleEditResponse(
  participant: ParticipantInfo,
  replyText: string
): Promise<{ success: boolean; error?: string }> {
  const input = replyText.trim().toLowerCase();
  
  if (input === 'cancel') {
    await sendConfirmationAndScheduleCall(
      { ...participant, info_confirmed: false },
      participant.job_title,
      participant.company_name
    );
    return { success: true };
  }
  
  const validKeys = ['current_ctc', 'expected_ctc', 'notice_period', 'total_experience', 'location', 'willing_to_relocate', 'reason_for_switching'];
  const stepKey = replyText.trim();
  if (!validKeys.includes(stepKey)) {
    return { 
      success: false, 
      error: 'Invalid field. Please reply with a valid field name like "current_ctc", "expected_ctc", "notice_period", etc.' 
    };
  }
  
  await supabaseAdmin
    .from('phone_screening_participants')
    .update({
      info_step: stepKey,
      info_confirmed: false,
      updated_at: new Date().toISOString()
    })
    .eq('id', participant.id);
  
  return { success: true };
}

export { 
  sendFirstQuestion,
  sendStepQuestion,
  sendReminder,
  sendConfirmationAndScheduleCall,
  sendEditPrompt,
  handleEditResponse,
  sendSessionMessage
};
