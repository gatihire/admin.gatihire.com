# WhatsApp Setup Guide — End-to-End Configuration

> Complete guide to set up Meta WhatsApp Business API for GatiHire AI Screening.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Meta Business Suite Setup](#meta-business-suite-setup)
3. [Template Creation](#template-creation)
4. [Environment Variables](#environment-variables)
5. [Webhook Configuration](#webhook-configuration)
6. [Testing](#testing)
7. [Production Deployment](#production-deployment)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before you begin, ensure you have:

1. **Meta Business Account**
   - Business ID: `848352563883460`
   - Go to: `https://business.facebook.com`

2. **WhatsApp Business Account**
   - WABA ID: `2347186219423427`
   - Go to: WhatsApp Manager

3. **Meta App**
   - Created in Meta App Dashboard
   - Has `whatsapp_business_messaging` permission

4. **Production Domain**
   - `admin.gatihire.com`

---

## Meta Business Suite Setup

### Step 1: Access WhatsApp Manager

1. Go to: `https://business.facebook.com/latest/whatsapp_manager/overview/?asset_id=2347186219423427`
2. Navigate to **Phone Numbers**
3. Note your **Phone Number ID** (needed for environment variables)

### Step 2: Generate System User Access Token

1. Go to Meta App Dashboard → **System Users**
2. Click **Create System User**
3. Name: `GatiHire Backend`
4. Role: `Admin`
5. Click **Generate New Token**
6. Select your app
7. Select permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
8. Click **Generate Token**
9. **Copy and save the token** (shown only once)

### Step 3: Add Phone Number (if needed)

1. Go to WhatsApp Manager → **Phone Numbers**
2. Click **Add Phone Number**
3. Enter your production Indian number
4. Verify via SMS or call
5. Note the **Phone Number ID**

---

## Template Creation

### Step 1: Create Templates

1. Go to WhatsApp Manager → **Message Templates**
2. Click **Create Template**
3. For each template:

#### Template 1: `talent_outreach`
- **Name:** `talent_outreach`
- **Category:** MARKETING
- **Language:** English (Indian)
- **Body:**
  ```
  Hi {{1}},

  We found a role that matches your profile:

  Position: {{2}}
  Company: {{3}}
  Location: {{4}}
  Salary: {{5}}

  Match Score: {{6}}/10
  Key Skills: {{7}}

  If interested, please apply here: {{8}}
  ```
- **Buttons:**
  - Quick Reply: `Interested`
  - Quick Reply: `Not Interested`
- **Example Values:**
  - `{{1}}`: Rahul Sharma
  - `{{2}}`: AI Engineer
  - `{{3}}`: TechCorp India
  - `{{4}}`: Bangalore, India
  - `{{5}}`: 25-35 LPA
  - `{{6}}`: 8
  - `{{7}}`: Python, LLMs, RAG
  - `{{8}}`: https://gatihire.com/apply/abc123

#### Template 2: `screening_invite`
- **Name:** `screening_invite`
- **Category:** UTILITY
- **Language:** English (Indian)
- **Body:**
  ```
  Hi {{1}},

  Thank you for applying for {{2}} at {{3}}.

  Our AI assistant will conduct a brief screening call to discuss your experience and the role requirements. This typically takes 5-10 minutes.

  Please select a convenient time below, or reply with your preference.
  ```
- **Buttons:**
  - Quick Reply: `Call Now`
  - Quick Reply: `In 10 min`
  - Quick Reply: `In 30 min`
  - Quick Reply: `Today Evening`
  - Quick Reply: `Custom Time`
- **Example Values:**
  - `{{1}}`: Priya Patel
  - `{{2}}`: Full Stack Developer
  - `{{3}}`: StartupXYZ

#### Template 3: `schedule_options`
- **Name:** `schedule_options`
- **Category:** UTILITY
- **Language:** English (Indian)
- **Body:**
  ```
  Great, {{1}}!

  Let us schedule your screening call for the {{2}} position.

  Please select a convenient time below.
  ```
- **Buttons:**
  - Quick Reply: `Call Now`
  - Quick Reply: `In 10 min`
  - Quick Reply: `In 30 min`
  - Quick Reply: `Today Evening`
- **Example Values:**
  - `{{1}}`: Amit Kumar
  - `{{2}}`: Backend Engineer

#### Template 4: `call_nudge`
- **Name:** `call_nudge`
- **Category:** UTILITY
- **Language:** English (Indian)
- **Body:**
  ```
  Hi {{1}},

  This is a reminder that our AI assistant will call you shortly for your screening regarding the {{2}} position at {{3}}.

  The call will last approximately 5-10 minutes. Please answer when we call.
  ```
- **Buttons:** None
- **Example Values:**
  - `{{1}}`: Sneha Gupta
  - `{{2}}`: Data Scientist
  - `{{3}}`: DataCo

#### Template 5: `tried_calling`
- **Name:** `tried_calling`
- **Category:** UTILITY
- **Language:** English (Indian)
- **Body:**
  ```
  Hi {{1}},

  We attempted to call you regarding the {{2}} position at {{3}}, but were unable to connect.

  Please select a convenient time for us to try again, or reply with your preferred time.
  ```
- **Buttons:**
  - Quick Reply: `Call Now`
  - Quick Reply: `In 10 min`
  - Quick Reply: `In 1 hour`
- **Example Values:**
  - `{{1}}`: Vikram Singh
  - `{{2}}`: DevOps Engineer
  - `{{3}}`: CloudFirst

#### Template 6: `missed_call_reschedule`
- **Name:** `missed_call_reschedule`
- **Category:** UTILITY
- **Language:** English (Indian)
- **Body:**
  ```
  Hi {{1}},

  We missed you for the {{2}} screening at {{3}}.

  Please select a convenient time to reschedule, or reply with your preferred time.
  ```
- **Buttons:**
  - Quick Reply: `Call Now`
  - Quick Reply: `In 10 min`
  - Quick Reply: `In 1 hour`
  - Quick Reply: `Tomorrow Morning`
- **Example Values:**
  - `{{1}}`: Neha Reddy
  - `{{2}}`: Product Manager
  - `{{3}}`: InnovateInc

#### Template 7: `reminder_nudge`
- **Name:** `reminder_nudge`
- **Category:** UTILITY
- **Language:** English (Indian)
- **Body:**
  ```
  Hi {{1}},

  Following up regarding the {{2}} position at {{3}} in {{4}}.

  If you are interested, please reply here or select an option below.
  ```
- **Buttons:**
  - Quick Reply: `Interested`
  - Quick Reply: `Not Interested`
- **Example Values:**
  - `{{1}}`: Rohan Mehta
  - `{{2}}`: Frontend Developer
  - `{{3}}`: WebSolutions
  - `{{4}}`: Mumbai, India

#### Template 8: `inbound_screening_invite`
- **Name:** `inbound_screening_invite`
- **Category:** UTILITY
- **Language:** English (Indian)
- **Body:**
  ```
  Hi {{1}},

  Thank you for applying for {{2}} at {{3}}.

  Our AI assistant will conduct a brief screening call to assess your fit for this role. The call will last approximately 5-10 minutes.

  Please select a convenient time below, or reply with your preference.
  ```
- **Buttons:**
  - Quick Reply: `Call Now`
  - Quick Reply: `In 10 min`
  - Quick Reply: `In 30 min`
  - Quick Reply: `Today Evening`
  - Quick Reply: `Custom Time`
- **Example Values:**
  - `{{1}}`: Karan Joshi
  - `{{2}}`: ML Engineer
  - `{{3}}`: AI Labs

### Step 2: Submit for Review

1. After creating each template, click **Submit**
2. Wait for Meta approval (usually 24-48 hours)
3. Monitor status in WhatsApp Manager → Message Templates

### Step 3: Verify Approval

1. Go to WhatsApp Manager → Message Templates
2. Check status for each template
3. Only `APPROVED` templates can be sent

---

## Environment Variables

### Update `.env.local`

```env
# Meta WhatsApp Business API Configuration (Primary)
WHATSAPP_PHONE_NUMBER_ID="YOUR_PHONE_NUMBER_ID"
WHATSAPP_BUSINESS_ACCOUNT_ID="2347186219423427"
WHATSAPP_ACCESS_TOKEN="YOUR_SYSTEM_USER_ACCESS_TOKEN"
WHATSAPP_API_VERSION="v21.0"

# Webhook Configuration
WHATSAPP_VERIFY_TOKEN="gatihire_webhook_verify_2024"
WHATSAPP_APP_SECRET="YOUR_APP_SECRET"

# Template Names (must match Meta templates exactly)
WHATSAPP_TEMPLATE_TALENT_OUTREACH="talent_outreach"
WHATSAPP_TEMPLATE_SCREENING_INVITE="screening_invite"
WHATSAPP_TEMPLATE_SCHEDULE_OPTIONS="schedule_options"
WHATSAPP_TEMPLATE_CALL_NUDGE="call_nudge"
WHATSAPP_TEMPLATE_TRIED_CALLING="tried_calling"
WHATSAPP_TEMPLATE_MISSED_CALL_RESCHEDULE="missed_call_reschedule"
WHATSAPP_TEMPLATE_REMINDER_NUDGE="reminder_nudge"
WHATSAPP_TEMPLATE_INBOUND_SCREENING="inbound_screening_invite"

# Aisensy WhatsApp API Configuration (Fallback)
AISENSY_API_KEY="your_aisensy_api_key"
AISENSY_TEMPLATE_ID="Talent_Invite"
AISENSY_SENDER_ID="truckinzy"
```

### Update Vercel Environment Variables

1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Add all variables above for:
   - Production
   - Preview
   - Development
3. Redeploy the project

---

## Webhook Configuration

### Step 1: Start Local Server (for testing)

```bash
cd admin.gatihire.com
npm run dev
```

### Step 2: Start ngrok

```bash
ngrok http 3000
```

Note the ngrok URL (e.g., `https://abc123.ngrok.io`)

### Step 3: Configure Webhook in Meta

1. Go to Meta App Dashboard → **WhatsApp** → **Configuration**
2. Under **Webhook**, click **Edit**
3. Enter:
   - **Callback URL:** `https://your-ngrok-url/api/whatsapp/webhook/meta`
   - **Verify Token:** `gatihire_webhook_verify_2024`
4. Click **Verify and Save**
5. Under **Webhook fields**, subscribe to:
   - `messages`
   - `message_template_status_update`

### Step 4: Test Webhook

1. In Meta App Dashboard → WhatsApp → Configuration
2. Click **Test** next to Webhook
3. Select **messages** field
4. Click **Send Test Message**
5. Check your server logs for the webhook event

---

## Testing

### Local Testing

1. **Start ngrok**
   ```bash
   ngrok http 3000
   ```

2. **Start dev server**
   ```bash
   npm run dev
   ```

3. **Test each template**
   - Go to a candidate in the pipeline
   - Click "WhatsApp Nudge" or "Call Now"
   - Check Meta dashboard for delivery status
   - Check ngrok for webhook events

### Test Flow Checklist

- [ ] **Outbound Flow:**
  - [ ] Send `talent_outreach`
  - [ ] Reply "Interested" → should send `schedule_options`
  - [ ] Reply "Not Interested" → should stop
  - [ ] Wait 4h → should send `reminder_nudge`
  - [ ] Wait 8h → should escalate to HR

- [ ] **Inbound Flow:**
  - [ ] Apply via board-app
  - [ ] Trigger WhatsApp-first screening
  - [ ] Candidate picks time → schedule call
  - [ ] Call completes → show results

- [ ] **Direct Call Flow:**
  - [ ] Click "Call Now"
  - [ ] `call_nudge` sent
  - [ ] Bolna call placed
  - [ ] Call fails → `missed_call_reschedule` sent

- [ ] **Retry Logic:**
  - [ ] First call fails → reschedule options
  - [ ] Second call fails → status: unreachable
  - [ ] No more WhatsApp after max retries

### Verify Webhook Events

Check ngrok for these events:

1. **Message Delivered:**
   ```json
   {
     "statuses": [
       {
         "id": "wamid.xxx",
         "status": "delivered"
       }
     ]
   }
   ```

2. **Message Read:**
   ```json
   {
     "statuses": [
       {
         "id": "wamid.xxx",
         "status": "read"
       }
     ]
   }
   ```

3. **Button Reply:**
   ```json
   {
     "messages": [
       {
         "from": "919876543210",
         "type": "interactive",
         "interactive": {
           "type": "button_reply",
           "button_reply": {
             "id": "interested",
             "title": "Interested"
           }
         }
       }
     ]
   }
   ```

---

## Production Deployment

### Step 1: Update Webhook URL

1. Go to Meta App Dashboard → WhatsApp → Configuration
2. Update Webhook URL to:
   ```
   https://admin.gatihire.com/api/whatsapp/webhook/meta
   ```
3. Verify Token: `gatihire_webhook_verify_2024`
4. Click **Verify and Save**

### Step 2: Update Vercel Environment Variables

1. Set all environment variables in Vercel
2. Ensure `WHATSAPP_PHONE_NUMBER_ID` is your production number
3. Ensure `WHATSAPP_ACCESS_TOKEN` is a permanent system user token

### Step 3: Deploy

```bash
git push origin main
```

Vercel will automatically deploy.

### Step 4: Verify Production

1. Go to Meta App Dashboard → WhatsApp → Configuration
2. Click **Test** next to Webhook
3. Select **messages** field
4. Click **Send Test Message**
5. Check Vercel function logs for the webhook event

### Step 5: Test End-to-End

1. Go to admin.gatihire.com
2. Select a candidate
3. Click "WhatsApp Nudge"
4. Verify message is sent
5. Reply to the message
6. Verify webhook processes the reply

---

## Troubleshooting

### Issue: Webhook verification fails

**Solution:**
1. Check that `WHATSAPP_VERIFY_TOKEN` matches in:
   - `.env.local`
   - Meta App Dashboard → WhatsApp → Configuration
2. Ensure your server is running and accessible
3. Check ngrok is running and URL is correct

### Issue: Templates not approved

**Solution:**
1. Check template content follows Meta guidelines
2. Ensure example values are realistic
3. Resubmit for review
4. Contact Meta support if repeatedly rejected

### Issue: Messages not sending

**Solution:**
1. Check `WHATSAPP_ACCESS_TOKEN` is valid
2. Check `WHATSAPP_PHONE_NUMBER_ID` is correct
3. Check template name matches exactly
4. Check Meta dashboard for error messages
5. Check Vercel function logs

### Issue: Webhook events not received

**Solution:**
1. Ensure webhook is subscribed to `messages` field
2. Check Vercel function logs for errors
3. Verify webhook URL is correct
4. Check Meta App is in Live mode (not Dev mode)

### Issue: Aisensy fallback not working

**Solution:**
1. Check `AISENSY_API_KEY` is valid
2. Check `AISENSY_TEMPLATE_ID` matches Aisensy campaign
3. Check Aisensy dashboard for errors

---

## Code References

| File | Purpose |
|---|---|
| `lib/whatsapp.ts` | Meta WhatsApp API integration |
| `app/api/whatsapp/webhook/meta/route.ts` | Meta webhook handler |
| `lib/aisensy.ts` | Aisensy integration (fallback) |
| `lib/call-orchestrator.ts` | Orchestrates screening campaigns |
| `.env.local` | Environment variables |

---

*Last updated: 2026-09-04*
