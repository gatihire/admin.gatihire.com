import { supabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { mergeSources, stampSources } from '@/lib/info-provenance';
import { getWhatsAppService } from '@/lib/whatsapp';
import { scheduleOrPlaceCall, prepareScheduleOffer, markScheduleOffer } from '@/lib/scheduled-call';
import { getPublicJobUrl } from '@/lib/call-orchestrator';
import { appendWhatsappHistory, buttonLabel } from '@/lib/whatsapp-history';
import {
  INFO_STEPS,
  STEP_KEYS,
  REQUIRED_STEPS,
  InfoStepKey,
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
  /** Per-field provenance; see lib/info-provenance. */
  info_sources: Record<string, any>;
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

type OffTopicReply = 'greeting' | 'more_info';

/**
 * Classify a reply that is clearly not an attempt to answer the current field.
 *
 * The extractor is instructed to return is_valid:false when a reply is "unclear
 * or irrelevant", which is right for noise but wrong for ordinary conversation.
 * In a live run a candidate said "Hello" and "I want another info", and both were
 * scored as failed answers to an unrelated CTC question — the candidate was told
 * their own words "do not contain the requested information" for a field they
 * never declined to fill in.
 *
 * Deliberately conservative: short replies only, and never on a step whose own
 * answer could legitimately look like one of these. A real "yes" must still reach
 * the extractor.
 */
function classifyOffTopicReply(text: string, stepKey: string): OffTopicReply | null {
  const t = text.trim().toLowerCase().replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return null;

  // A greeting is never a field value, on any step. "Hello" cannot be a current
  // CTC, so this check is safe everywhere — and it has to be, because the live
  // failure was exactly this: "Hello" arriving while we were asking for
  // current_ctc. Guarding greetings behind a value-step exclusion left the
  // original bug in place.
  if (/^(hi|hey|hello|hiya|heyya|namaste|namaskar|good morning|good afternoon|good evening)\b/.test(t)) {
    return 'greeting';
  }

  // On a value step, a reply that actually looks like a value is never
  // intercepted — "9 LPA", "my CTC is 9 lakhs" and "salary negotiable?" must all
  // reach the extractor.
  //
  // The discriminator is whether the reply looks like a value at all, NOT the step
  // we happen to be on. Blanket-blocking every value step would have left the
  // original bug in place: the live candidate said "I want another info" while we
  // were asking for current_ctc, and that reply contains no figure, so it was
  // never an answer to the question we asked.
  const VALUE_STEPS = new Set(['current_ctc', 'expected_ctc', 'total_experience', 'notice_period']);
  if (VALUE_STEPS.has(stepKey)) {
    const looksLikeAValue = /\d|\b(lpa|lakh|lakhs|lac|crore|k\b|monthly|annual|ctc|salary|pay)\b/i.test(t);
    if (looksLikeAValue) return null;
  }

  // A yes/no step must be able to accept a bare "yes" or "no".
  const step = getStep(stepKey as InfoStepKey);
  if (step?.helpText && /\byes\b|\bno\b/i.test(step.helpText)) return null;

  if (/\b(more info|more information|more details|tell me more|another info|other info|details about (the )?(job|role|company)|about the (job|role|company))\b/.test(t)) {
    return 'more_info';
  }

  return null;
}

/**
 * Does this participant already have the details we would otherwise ask for?
 *
 * Portal applicants type current/expected CTC, notice period and relocation into
 * the apply form before we ever message them. Treating their reply as a request
 * to re-collect that data is both redundant and insulting — it is the "why is it
 * asking me my salary again" behaviour.
 *
 * Returns the keys we can already answer for, so the caller can ask only about
 * what is genuinely missing.
 */
export function knownScreeningFields(participant: any): string[] {
  const ctcKeys = ["current_ctc", "expected_ctc", "notice_period"]
  const info = (participant as any)?.info_data || {}
  const candidate = (participant as any)?.candidates || {}
  const known: string[] = []

  for (const k of ctcKeys) {
    const v = info[k] ?? candidate[k]
    if (v != null && String(v).trim() && !["void", "n/a", "na", "-"].includes(String(v).trim().toLowerCase())) {
      known.push(k)
    }
  }
  // Relocation is a boolean column; treat either a stored answer or a seeded
  // one as known.
  const reloc = info.willing_to_relocate ?? candidate.willing_to_relocate
  if (reloc === true || reloc === false || (typeof reloc === "string" && ["yes", "no"].includes(reloc.toLowerCase()))) {
    known.push("willing_to_relocate")
  }
  return known
}

/** True when we hold enough detail to screen without asking anything. */
export function hasEnoughToScreen(participant: any): boolean {
  const known = new Set(knownScreeningFields(participant))
  // CTC pair plus notice is the minimum the pre-screen actually reads.
  return known.has("current_ctc") && known.has("expected_ctc") && known.has("notice_period")
}

async function initializeInfoCollection(participant: any): Promise<{ success: boolean; error?: string; alreadyKnown?: string[] }> {
  // Never blank a profile that already carries apply-form data. The old
  // `info_data: {}` here silently deleted the seeded current/expected CTC and
  // notice period, which is precisely the information we would then ask the
  // candidate for.
  const alreadyKnown = knownScreeningFields(participant)
  const existingInfo = hasEnoughToScreen(participant) ? { ...((participant as any).info_data || {}) } : {}

  await supabaseAdmin
    .from('phone_screening_participants')
    .update({
      info_step: alreadyKnown.length ? 'collect_all' : 'current_ctc',
      info_data: existingInfo,
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
  
  return { success: true, alreadyKnown };
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
            // Every field parsed out of THIS reply was typed by the candidate on
            // WhatsApp, so it supersedes whatever the apply form seeded.
            info_sources: mergeSources(participant.info_sources, stampSources(Object.keys(allFields), 'whatsapp')),
            info_step: 'confirmed',
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
            info_sources: mergeSources(participant.info_sources, stampSources(Object.keys(allFields), 'whatsapp')),
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
    
    // Not every reply is an attempt to answer the field we're on. Handle greetings
    // and "tell me more about the role" as the human exchange they are, then
    // re-ask the current question — without scoring them as wrong and without
    // printing a rejection.
    const offTopic = classifyOffTopicReply(replyText, currentStepKey);
    if (offTopic) {
      const refreshedOffTopic = await getParticipantWithExtras(participantId);
      if (!refreshedOffTopic) {
        return { success: false, action: 'next_step' };
      }

      const firstName = (refreshedOffTopic.candidate_name || '').split(' ')[0];

      if (offTopic === 'more_info') {
        const jobUrl = refreshedOffTopic.jobs?.id ? getPublicJobUrl(refreshedOffTopic.jobs.id) : '';
        await sendSessionMessage(
          refreshedOffTopic.phone_number,
          jobUrl
            ? `Of course — here's the full role description${refreshedOffTopic.company_name ? ` for ${refreshedOffTopic.company_name}` : ''}:\n\n${jobUrl}\n\nHave a look, and we'll carry on with the next detail after.`
            : `Happy to share more about the role. Tell me what you'd like to know and we'll carry on with the next detail after.`
        );
      } else {
        await sendSessionMessage(
          refreshedOffTopic.phone_number,
          `Hi ${firstName || 'there'}! How can I help?`
        );
      }

      await sendStepQuestion(
        refreshedOffTopic,
        currentStepKey,
        participant.job_title,
        participant.company_name
      );

      await appendWhatsappHistory(participantId, {
        at: new Date().toISOString(),
        kind: 'info_offtopic_reply',
        direction: 'internal',
        text: `Candidate sent "${replyText.trim().slice(0, 120)}" while we were asking for ${currentStepKey}. Answered in-conversation and re-asked.`,
        status: 'sent',
        stepKey: currentStepKey,
        classifiedAs: offTopic,
      });

      return { success: true, action: 'next_step' };
    }

    // Extract value using LLM + regex fallback (original single-field logic)
    const step = getStep(currentStepKey);
    const question = getStepQuestion(currentStepKey, participant.candidate_name, participant.job_title, participant.company_name);
    
    const extraction = await extractStepValue(currentStepKey, replyText, question, participant.info_data || {});
    
    if (!extraction.is_valid) {
      // Re-ask ONCE, in a single message, with wording we control.
      //
      // Two defects lived here:
      //
      // 1. It sent the question, then sent a SECOND message containing the error
      //    plus the question again — so any reply Gemini couldn't parse produced
      //    a duplicate of the same question, back to back.
      // 2. The error text was `extraction.error_message`, which the extractor
      //    prompt explicitly asks Gemini to write ("user-friendly error if
      //    invalid"). That meant the model scolded candidates in its own voice
      //    and quoted their reply back at them: "❌ The reply 'Hello' does not
      //    contain the requested information." A candidate saying "hello" or
      //    "I want more info" got told they had failed a field they never
      //    refused to fill in. getValidationError() is curated per field and
      //    always shows the format we want, so we send that instead.
      const refreshedInvalid = await getParticipantWithExtras(participantId);
      if (!refreshedInvalid) {
        return { success: false, action: 'next_step' };
      }

      await sendStepQuestion(
        refreshedInvalid,
        currentStepKey,
        participant.job_title,
        participant.company_name,
        { prefix: getValidationError(currentStepKey) }
      );

      // Recorded as an internal event so a recruiter can see why we re-asked
      // instead of inferring it from a duplicate bubble.
      await appendWhatsappHistory(participantId, {
        at: new Date().toISOString(),
        kind: 'info_reask',
        direction: 'internal',
        text: `Could not read "${currentStepKey}" from the reply — re-asked once with a format hint.`,
        status: 'sent',
        stepKey: currentStepKey,
        modelError: extraction.error_message || null,
      });

      return { success: true, action: 'next_step' };
    }
    
    // Valid response - save and move to next step.
    // info_sources is written in the same update: a value the candidate just
    // typed on WhatsApp is "whatsapp", including when it overwrites a value
    // seeded from the apply form.
    const nextStep = getNextStep(currentStepKey);

    await supabaseAdmin
      .from('phone_screening_participants')
      .update({
        info_data: { ...participant.info_data, [currentStepKey]: extraction.normalized_value },
        info_sources: mergeSources(participant.info_sources, stampSources([currentStepKey], 'whatsapp')),
        info_step: nextStep || 'confirmed',
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

async function markScheduledAndFire(participantId: string, scheduledAt: Date): Promise<{ success: boolean; error?: string }> {
  const scheduledAtISO = scheduledAt.toISOString();
  const { error: updateError } = await supabaseAdmin
    .from('phone_screening_participants')
    .update({
      status: 'call_scheduled',
      scheduled_call_at: scheduledAtISO,
      updated_at: new Date().toISOString(),
    })
    .eq('id', participantId);

  if (updateError) {
    logger.error('Failed to mark participant scheduled', { participantId, error: updateError.message });
    return { success: false, error: updateError.message };
  }

  // A slot that is already due (or due within the next minute) is placed
  // directly — "Call Now" means now. A failed direct placement falls through to
  // a real enqueued callback inside the helper instead of being dropped.
  const delaySec = Math.max(0, Math.round((scheduledAt.getTime() - Date.now()) / 1000));
  const placed = await scheduleOrPlaceCall(participantId, delaySec);
  if (placed.success || placed.skipped) {
    await appendWhatsappHistory(participantId, {
      at: new Date().toISOString(),
      kind: 'call_booked',
      scheduledFor: scheduledAtISO,
      mode: placed.skipped ? 'already_placed' : 'queued',
    });
    return { success: true };
  }
  
  // scheduleOrPlaceCall reports scheduled:false when nothing is actually queued,
  // so we must not confirm a call that cannot happen.
  if (!placed.scheduled) {
    await appendWhatsappHistory(participantId, {
      at: new Date().toISOString(),
      kind: 'call_booking_failed',
      scheduledFor: scheduledAtISO,
      error: placed.error || 'Call could not be scheduled',
    });
    return { success: false, error: placed.error || 'Call could not be scheduled' };
  }
  return { success: true };
}

/**
 * Turn a scheduling failure into a throw.
 *
 * markScheduledAndFire reports failure in its return value rather than throwing,
 * which is convenient for its other callers but easy to discard by accident. A
 * discarded failure means the candidate's tap is acknowledged with no call
 * placed, so we raise instead and let the webhook's 5xx trigger a retry.
 */
function assertScheduled(result: { success: boolean; error?: string }): void {
  if (!result.success) {
    throw new Error(result.error || 'Call could not be scheduled');
  }
}

/**
 * Resolve a tapped quick-reply button to a canonical action key.
 *
 * The templates in WhatsApp Manager were created without an explicit button
 * payload, so Meta delivers the button TEXT as the reply id — a tap arrives as
 * "Call Now", not "call_now". The switch below only knew the canonical ids, so
 * every tap fell through to `default`, was logged as "Unknown button reply",
 * returned success, and got stamped as processed: the candidate saw the message
 * marked read and no call was ever placed. Match on the normalized title as
 * well as the id so a template edited in the UI can't silently orphan taps.
 */
function normalizeButtonAction(buttonId: string, buttonTitle: string): string {
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const actions: Record<string, string> = {
    'call now': 'call_now',
    'in 10 min': 'in_10_min',
    'in 20 min': 'in_20_min',
    'in 30 min': 'in_30_min',
    'in 1 hour': 'in_1_hour',
    'today evening': 'today_evening',
    'tomorrow morning': 'tomorrow_morning',
    interested: 'interested',
    'not interested': 'not_interested',
    'share details': 'provide_details',
    'provide details': 'provide_details',
    'skip schedule call': 'skip_schedule_call',
  };
  return actions[norm(buttonTitle)] || actions[norm(buttonId)] || buttonId;
}

async function handleIncomingCallNow(participantId: string): Promise<{ success: boolean; error?: string }> {
  try {
    return await markScheduledAndFire(participantId, new Date());
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function handleIncomingSchedule(participantId: string, delayMs: number): Promise<{ success: boolean; error?: string }> {
  try {
    return await markScheduledAndFire(participantId, new Date(Date.now() + delayMs));
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function handleInteractiveButton(participantId: string, buttonId: string, _buttonTitle: string, phoneOverride?: string): Promise<{ success: boolean; error?: string }> {
  try {
    const participant = await getParticipantWithExtras(participantId);
    if (!participant) return { success: false, error: 'Participant not found' };

    // Where to send the reply.
    //
    // The webhook passes the number the tap actually came from. Normally that is
    // identical to the participant's stored phone, but when the sender matched no
    // candidate row the webhook had to attribute the tap by fallback — and then
    // participant.candidates.phone belongs to somebody else entirely. Sending to
    // the stored phone there meant the person who tapped "Interested" got no
    // answer at all, and the tap looked like it had been dropped.
    const replyPhone = phoneOverride || participant.candidates?.phone;
    
    logger.info('Handling interactive button', { participantId, buttonId, buttonTitle: _buttonTitle });

    // Record the tap itself, before acting on it. Without this the recruiter
    // card could only ever show "read", so a dropped tap was indistinguishable
    // from a candidate who never responded. The raw id is kept verbatim (it may
    // be the button text) so a template/payload mismatch is visible in the UI.
    await appendWhatsappHistory(participantId, {
      at: new Date().toISOString(),
      kind: 'button_tap',
      buttonId,
      buttonTitle: _buttonTitle || buttonLabel(buttonId),
    });

    const action = buttonId.startsWith('reject_')
      ? buttonId
      : normalizeButtonAction(buttonId, _buttonTitle);

    switch (action) {
      case 'interested': {
        // Two different meanings, decided by whether we were waiting on consent.
        //
        // Outbound candidates are strangers we have not yet got permission to
        // screen, so "Interested" means "yes, tell me more" — the details form
        // is the next step, and the call is only offered once the pre-screen has
        // data to judge. Handling it here used to send call-slot buttons straight
        // away, which skipped the form entirely: the call had no CTC or notice to
        // screen against.
        //
        // Everyone else (portal applicants, external resumes) already opted in by
        // applying, so their "Interested" keeps its original meaning and goes
        // straight to scheduling.
        const awaitingInterest = !!(participant as any).screening_context?.awaitingInterest;

        if (!awaitingInterest) {
          await supabaseAdmin
            .from('phone_screening_participants')
            .update({
              status: 'interested',
              updated_at: new Date().toISOString()
            })
            .eq('id', participantId);

          const whatsapp = getWhatsAppService();
          // Interest is not consent to be called. Only hand over a picker when
          // the gate would actually place the call that follows it.
          const offer = await prepareScheduleOffer(participantId);
          if (!offer.ok) {
            logger.warn("No slot picker sent — call would be refused", {
              participantId,
              reason: offer.reason,
            });
            await appendWhatsappHistory(participantId, {
              at: new Date().toISOString(),
              kind: "internal",
              text: `No call slots offered: ${offer.reason}`,
            });
          }
          if (offer.ok && replyPhone) {
            const sent = await whatsapp.sendScheduleOptions({
              phoneNumber: replyPhone,
              candidateName: participant.candidate_name,
              jobTitle: participant.job_title,
            });
            if (sent.success) await markScheduleOffer(participantId);
          } else if (!replyPhone) {
            logger.error('Interested with no reachable phone', { participantId });
            await supabaseAdmin
              .from('phone_screening_participants')
              .update({
                needs_manual_followup: true,
                updated_at: new Date().toISOString()
              })
              .eq('id', participantId);
          }
          break;
        }

        // info_data is intentionally preserved. Blanking it discarded CTC/notice
        // details the candidate had already given and forced a restart of the
        // questionnaire.
        await supabaseAdmin
          .from('phone_screening_participants')
          .update({
            status: 'info_requested',
            screening_mode: 'collect_info_first',
            info_step: 'collect_form',
            info_confirmed: false,
            screening_context: {
              ...((participant as any).screening_context || {}),
              awaitingInterest: false,
              interestedAt: new Date().toISOString(),
            },
            updated_at: new Date().toISOString()
          })
          .eq('id', participantId);

        // Previously a hard throw. The catch turned it into a generic failure and
        // the row was left in info_requested with no form sent and no flag, so it
        // read as "form in progress" when nobody had been contacted.
        if (!replyPhone) {
          logger.error('Interested but no phone to send the details form to', { participantId });
          await supabaseAdmin
            .from('phone_screening_participants')
            .update({
              needs_manual_followup: true,
              updated_at: new Date().toISOString()
            })
            .eq('id', participantId);
          break;
        }

        const whatsapp = getWhatsAppService();
        const form = await whatsapp.sendCollectInfoForm({
          phoneNumber: replyPhone,
          candidateName: participant.candidate_name,
          jobTitle: participant.job_title,
          companyName: participant.company_name,
          flowToken: participantId,
        });
        if (!form.success) {
          throw new Error(form.error || 'failed to send details form');
        }

        await appendWhatsappHistory(participantId, {
          at: new Date().toISOString(),
          kind: 'schedule_buttons',
          direction: 'out',
          text: `Thanks for your interest in ${participant.job_title || 'the role'} — please share a few details so we can screen you.`,
          status: 'sent',
          messageId: form.messageId ?? null,
        });
        break;
      }
        
      case 'not_interested': {
        // A decline is a final answer, so close it politely and leave a door
        // open instead of interrogating them for a reason. The reason-asking
        // template reads as pressure and was what a tapped "Not Interested"
        // used to trigger.
        const phone = replyPhone;
        if (!phone) break;

        await supabaseAdmin
          .from('phone_screening_participants')
          .update({
            status: 'not_interested',
            updated_at: new Date().toISOString()
          })
          .eq('id', participantId);

        const { getPortalJobsUrl } = await import('@/lib/call-orchestrator');
        const closingText =
          "Thanks for your time, and for reading our message. 🙏\n\n" +
          "We'll reach out if something matching your profile comes up. " +
          `In the meantime, you can browse other open roles here: ${getPortalJobsUrl()}`;

        const sent = await sendSessionMessage(phone, closingText);
        await appendWhatsappHistory(participantId, {
          at: new Date().toISOString(),
          kind: 'not_interested_closing',
          direction: 'out',
          text: closingText,
          status: sent.success ? 'sent' : 'failed',
          messageId: sent.messageId ?? null,
          error: sent.error ?? null,
        });
        break;
      }
        
      // Every slot button must propagate a scheduling failure. These cases used
      // to await markScheduledAndFire and discard its result, so a slot that
      // could not actually be queued reported success and the tap was lost —
      // the recruiter saw "read" and no call. Throwing lets the webhook return
      // 5xx so Meta redelivers and the booking is retried.
      case 'call_now':
        await assertScheduled(await markScheduledAndFire(participant.id, new Date()));
        break;
        
      case 'in_10_min':
        await assertScheduled(await markScheduledAndFire(participant.id, new Date(Date.now() + 10 * 60 * 1000)));
        break;
        
      case 'in_20_min':
        await assertScheduled(await markScheduledAndFire(participant.id, new Date(Date.now() + 20 * 60 * 1000)));
        break;
        
      case 'in_30_min':
        await assertScheduled(await markScheduledAndFire(participant.id, new Date(Date.now() + 30 * 60 * 1000)));
        break;

      case 'in_1_hour':
        await assertScheduled(await markScheduledAndFire(participant.id, new Date(Date.now() + 60 * 60 * 1000)));
        break;
        
      case 'today_evening': {
        const now = new Date();
        const evening = new Date(now);
        evening.setUTCHours(12, 30, 0, 0);
        if (evening <= now) evening.setDate(evening.getDate() + 1);
        await assertScheduled(await markScheduledAndFire(participant.id, evening));
        break;
      }
        
      case 'tomorrow_morning': {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setUTCHours(3, 30, 0, 0);
        await assertScheduled(await markScheduledAndFire(participant.id, tomorrow));
        break;
      }
        
      case 'provide_details': {
        // A candidate who tapped "provide details" but whose apply form already
        // carries CTC/notice has opted in; they do not need to type it again.
        // Go to scheduling with what we hold instead of opening a form.
        if (hasEnoughToScreen(participant)) {
          logger.info('provide_details with details already on file — proceeding to schedule', {
            participantId,
            known: knownScreeningFields(participant),
          });
          await supabaseAdmin
            .from('phone_screening_participants')
            .update({
              status: 'interested',
              info_step: 'confirmed',
              info_confirmed: false,
              updated_at: new Date().toISOString(),
            })
            .eq('id', participantId);

          const offer = await prepareScheduleOffer(participantId);
          if (!offer.ok) {
            logger.warn("No slot picker sent — call would be refused", {
              participantId,
              reason: offer.reason,
            });
            await appendWhatsappHistory(participantId, {
              at: new Date().toISOString(),
              kind: "internal",
              text: `No call slots offered: ${offer.reason}`,
            });
          }
          if (offer.ok && participant.candidates?.phone) {
            const sent = await getWhatsAppService().sendScheduleOptions({
              phoneNumber: participant.candidates.phone,
              candidateName: participant.candidate_name,
              jobTitle: participant.job_title,
            });
            if (sent.success) await markScheduleOffer(participantId);
            await appendWhatsappHistory(participantId, {
              at: new Date().toISOString(),
              kind: 'schedule_buttons',
              direction: 'out',
              text: `Thanks ${participant.candidate_name || ''} — we already have your details from your application. Pick a slot for your screening call.`.trim(),
              status: 'sent',
            });
          }
          break;
        }

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