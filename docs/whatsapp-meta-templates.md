# WhatsApp Meta Templates — Complete Reference

> All WhatsApp message templates for GatiHire AI Screening, configured directly via Meta WhatsApp Business API.

---

## Table of Contents

1. [Template Inventory](#template-inventory)
2. [Meta Business Suite Setup](#meta-business-suite-setup)
3. [Template Details](#template-details)
4. [Environment Variables](#environment-variables)
5. [API Integration](#api-integration)
6. [Flow Diagrams](#flow-diagrams)
7. [Testing Guide](#testing-guide)

---

## Template Inventory

| # | Template Name | Category | When Sent | Parameters |
|---|---|---|---|---|
| 1 | `talent_outreach` | MARKETING | Outbound candidate matching role | candidate_name, job_title, company_name, location, salary, match_score, skills, apply_link |
| 2 | `screening_invite` | UTILITY | Inbound candidate screening | candidate_name, job_title, company_name |
| 3 | `schedule_options` | UTILITY | After candidate says "Interested" | candidate_name, job_title |
| 4 | `call_nudge` | UTILITY | Pre-call notification | candidate_name, job_title, company_name |
| 5 | `tried_calling` | UTILITY | After call fails — retry | candidate_name, job_title, company_name |
| 6 | `missed_call_reschedule` | UTILITY | After Bolna call fails | candidate_name, job_title, company_name |
| 7 | `reminder_nudge` | UTILITY | 4h silence after outreach | candidate_name, job_title, company_name, location |
| 8 | `inbound_screening_invite` | UTILITY | Inbound from board-app | candidate_name, job_title, company_name |

---

## Meta Business Suite Setup

### Access WhatsApp Manager

1. Go to: `https://business.facebook.com/latest/whatsapp_manager/overview/?asset_id=2347186219423427`
2. Navigate to **Message Templates** → **Create Template**

### Create Templates

For each template:

1. Click **Create Template**
2. Enter template name (lowercase with underscores, max 512 chars)
3. Select category:
   - **MARKETING**: For promotional messages (outreach)
   - **UTILITY**: For transactional messages (screening, notifications)
4. Add body text with `{{1}}`, `{{2}}`, etc.
5. Add quick reply buttons (if applicable)
6. Add example values for each variable
7. Submit for review

### Approval Process

- Meta reviews templates (usually 24-48 hours)
- Status will be `PENDING` → `APPROVED` or `REJECTED`
- Only `APPROVED` templates can be sent
- Monitor status via WhatsApp Manager → Message Templates

---

## Template Details

### 1. Talent Outreach (`talent_outreach`)

**Category:** MARKETING

**Purpose:** Mass outreach to candidates matching a role

**Body:**
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

**Variables:**
| Index | Name | Type | Example |
|-------|------|------|---------|
| `{{1}}` | candidate_name | text | Rahul Sharma |
| `{{2}}` | job_title | text | AI Engineer |
| `{{3}}` | company_name | text | TechCorp India |
| `{{4}}` | location | text | Bangalore, India |
| `{{5}}` | salary | text | 25-35 LPA |
| `{{6}}` | match_score | text | 8 |
| `{{7}}` | skills | text | Python, LLMs, RAG |
| `{{8}}` | apply_link | text | https://gatihire.com/apply/abc123 |

**Buttons:**
- `[Interested]` (quick reply)
- `[Not Interested]` (quick reply)

**Tags:** `["ai_outreach", "job_recruitment"]`

---

### 2. Screening Invite (`screening_invite`)

**Category:** UTILITY

**Purpose:** Inbound candidate screening invite

**Body:**
```
Hi {{1}},

Thank you for applying for {{2}} at {{3}}.

Our AI assistant will conduct a brief screening call to discuss your experience and the role requirements. This typically takes 5-10 minutes.

Please select a convenient time below, or reply with your preference.
```

**Variables:**
| Index | Name | Type | Example |
|-------|------|------|---------|
| `{{1}}` | candidate_name | text | Priya Patel |
| `{{2}}` | job_title | text | Full Stack Developer |
| `{{3}}` | company_name | text | StartupXYZ |

**Buttons:**
- `[Call Now]` (quick reply)
- `[In 10 min]` (quick reply)
- `[In 30 min]` (quick reply)
- `[Today Evening]` (quick reply)
- `[Custom Time]` (quick reply)

**Tags:** `["ai_screening", "inbound"]`

---

### 3. Schedule Options (`schedule_options`)

**Category:** UTILITY

**Purpose:** After candidate says "Interested"

**Body:**
```
Great, {{1}}!

Let us schedule your screening call for the {{2}} position.

Please select a convenient time below.
```

**Variables:**
| Index | Name | Type | Example |
|-------|------|------|---------|
| `{{1}}` | candidate_name | text | Amit Kumar |
| `{{2}}` | job_title | text | Backend Engineer |

**Buttons:**
- `[Call Now]` (quick reply)
- `[In 10 min]` (quick reply)
- `[In 30 min]` (quick reply)
- `[Today Evening]` (quick reply)

**Tags:** `["ai_screening", "schedule"]`

---

### 4. Call Nudge (`call_nudge`)

**Category:** UTILITY

**Purpose:** Pre-call notification (informational)

**Body:**
```
Hi {{1}},

This is a reminder that our AI assistant will call you shortly for your screening regarding the {{2}} position at {{3}}.

The call will last approximately 5-10 minutes. Please answer when we call.
```

**Variables:**
| Index | Name | Type | Example |
|-------|------|------|---------|
| `{{1}}` | candidate_name | text | Sneha Gupta |
| `{{2}}` | job_title | text | Data Scientist |
| `{{3}}` | company_name | text | DataCo |

**Buttons:** None (informational only)

**Tags:** `["ai_call", "nudge"]`

---

### 5. Tried Calling (`tried_calling`)

**Category:** UTILITY

**Purpose:** After call fails — retry notification

**Body:**
```
Hi {{1}},

We attempted to call you regarding the {{2}} position at {{3}}, but were unable to connect.

Please select a convenient time for us to try again, or reply with your preferred time.
```

**Variables:**
| Index | Name | Type | Example |
|-------|------|------|---------|
| `{{1}}` | candidate_name | text | Vikram Singh |
| `{{2}}` | job_title | text | DevOps Engineer |
| `{{3}}` | company_name | text | CloudFirst |

**Buttons:**
- `[Call Now]` (quick reply)
- `[In 10 min]` (quick reply)
- `[In 1 hour]` (quick reply)

**Tags:** `["ai_call", "retry"]`

---

### 6. Missed Call Reschedule (`missed_call_reschedule`)

**Category:** UTILITY

**Purpose:** After Bolna call fails — reschedule options

**Body:**
```
Hi {{1}},

We missed you for the {{2}} screening at {{3}}.

Please select a convenient time to reschedule, or reply with your preferred time.
```

**Variables:**
| Index | Name | Type | Example |
|-------|------|------|---------|
| `{{1}}` | candidate_name | text | Neha Reddy |
| `{{2}}` | job_title | text | Product Manager |
| `{{3}}` | company_name | text | InnovateInc |

**Buttons:**
- `[Call Now]` (quick reply)
- `[In 10 min]` (quick reply)
- `[In 1 hour]` (quick reply)
- `[Tomorrow Morning]` (quick reply)

**Tags:** `["ai_call", "reschedule"]`

---

### 7. Reminder Nudge (`reminder_nudge`)

**Category:** UTILITY

**Purpose:** 4 hours silence after outreach — gentle reminder

**Body:**
```
Hi {{1}},

Following up regarding the {{2}} position at {{3}} in {{4}}.

If you are interested, please reply here or select an option below.
```

**Variables:**
| Index | Name | Type | Example |
|-------|------|------|---------|
| `{{1}}` | candidate_name | text | Rohan Mehta |
| `{{2}}` | job_title | text | Frontend Developer |
| `{{3}}` | company_name | text | WebSolutions |
| `{{4}}` | location | text | Mumbai, India |

**Buttons:**
- `[Interested]` (quick reply)
- `[Not Interested]` (quick reply)

**Tags:** `["ai_outreach", "reminder"]`

---

### 8. Inbound Screening Invite (`inbound_screening_invite`)

**Category:** UTILITY

**Purpose:** Inbound candidate from board-app (professional tone)

**Body:**
```
Hi {{1}},

Thank you for applying for {{2}} at {{3}}.

Our AI assistant will conduct a brief screening call to assess your fit for this role. The call will last approximately 5-10 minutes.

Please select a convenient time below, or reply with your preference.
```

**Variables:**
| Index | Name | Type | Example |
|-------|------|------|---------|
| `{{1}}` | candidate_name | text | Karan Joshi |
| `{{2}}` | job_title | text | ML Engineer |
| `{{3}}` | company_name | text | AI Labs |

**Buttons:**
- `[Call Now]` (quick reply)
- `[In 10 min]` (quick reply)
- `[In 30 min]` (quick reply)
- `[Today Evening]` (quick reply)
- `[Custom Time]` (quick reply)

**Tags:** `["ai_screening", "inbound"]`

---

## Environment Variables

### Meta WhatsApp Business API

```env
# Meta WhatsApp Business API Configuration
WHATSAPP_PHONE_NUMBER_ID="your_phone_number_id"
WHATSAPP_BUSINESS_ACCOUNT_ID="2347186219423427"
WHATSAPP_ACCESS_TOKEN="your_system_user_access_token"
WHATSAPP_API_VERSION="v21.0"

# Webhook Configuration
WHATSAPP_VERIFY_TOKEN="gatihire_webhook_verify_2024"
WHATSAPP_APP_SECRET="your_app_secret"

# Template Names (must match Meta templates exactly)
WHATSAPP_TEMPLATE_TALENT_OUTREACH="talent_outreach"
WHATSAPP_TEMPLATE_SCREENING_INVITE="screening_invite"
WHATSAPP_TEMPLATE_SCHEDULE_OPTIONS="schedule_options"
WHATSAPP_TEMPLATE_CALL_NUDGE="call_nudge"
WHATSAPP_TEMPLATE_TRIED_CALLING="tried_calling"
WHATSAPP_TEMPLATE_MISSED_CALL_RESCHEDULE="missed_call_reschedule"
WHATSAPP_TEMPLATE_REMINDER_NUDGE="reminder_nudge"
WHATSAPP_TEMPLATE_INBOUND_SCREENING="inbound_screening_invite"
```

### Aisensy (Fallback)

```env
# Aisensy WhatsApp API Configuration (Fallback)
AISENSY_API_KEY="your_aisensy_api_key"
AISENSY_TEMPLATE_ID="Talent_Invite"
AISENSY_SENDER_ID="truckinzy"
```

---

## API Integration

### Send Template Message (Meta Cloud API)

```typescript
POST https://graph.facebook.com/{version}/{phone_number_id}/messages

Headers:
  Authorization: Bearer {access_token}
  Content-Type: application/json

Body:
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "{recipient_phone_number}",
  "type": "template",
  "template": {
    "name": "{template_name}",
    "language": {
      "code": "en"
    },
    "components": [
      {
        "type": "body",
        "parameters": [
          {
            "type": "text",
            "text": "{variable_value}"
          }
        ]
      }
    ]
  }
}
```

### With Quick Reply Buttons

```typescript
{
  "type": "button",
  "sub_type": "quick_reply",
  "index": 0,
  "parameters": [
    {
      "type": "payload",
      "payload": "interested"
    }
  ]
}
```

### Webhook Payload (Inbound Messages)

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WHATSAPP_BUSINESS_ACCOUNT_ID",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "15556745966",
              "phone_number_id": "PHONE_NUMBER_ID"
            },
            "contacts": [
              {
                "profile": {
                  "name": "Candidate Name"
                },
                "wa_id": "919876543210"
              }
            ],
            "messages": [
              {
                "from": "919876543210",
                "id": "wamid.HBgL...",
                "timestamp": "1234567890",
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
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

---

## Flow Diagrams

### Outbound Candidate Flow
```
1. talent_outreach (MARKETING)
   Quick Reply: [Interested] [Not Interested]
2. If "Interested" → schedule_options (UTILITY)
   Quick Reply: [Call Now] [In 10 min] [In 30 min] [Today Evening]
3. If candidate picks time → Schedule call via QStash
4. call_nudge (UTILITY) → Informational
5. Bolna AI call placed
6. If no response after 4h → reminder_nudge (UTILITY)
7. If no response after 8h → Escalate to HR
8. If call fails → missed_call_reschedule (UTILITY)
   Quick Reply: [Call Now] [In 10 min] [In 1 hour] [Tomorrow Morning]
9. Max 2 call attempts → then status: unreachable
```

### Inbound (Board-App/External) Flow
```
1. Candidate applies → status: applied
2. Admin triggers WhatsApp-first screening
3. inbound_screening_invite (UTILITY) sent
   Quick Reply: [Call Now] [In 10 min] [In 30 min] [Today Evening] [Custom Time]
4. Candidate picks time → Schedule call via QStash
5. call_nudge (UTILITY) → Informational
6. Bolna AI call placed
7. If no response after 4h → reminder_nudge (UTILITY)
8. If no response after 8h → Escalate to HR
9. If call fails → same as outbound
```

### Direct Call Flow (call_now mode)
```
1. Admin clicks "Call Now"
2. call_nudge (UTILITY) → Pre-call notification sent
3. Wait 60s (PRE_CALL_DELAY_MS)
4. Bolna AI call placed
5. If fails → missed_call_reschedule (UTILITY)
   Quick Reply: [Call Now] [In 10 min] [In 1 hour] [Tomorrow Morning]
6. Max 2 attempts → then status: unreachable
```

### Call Failure Flow
```
1. Bolna call fails (no-answer/busy/disconnected)
2. Increment retry_count
3. Store partial transcript if available
4. If retry_count < 2:
   - Send missed_call_reschedule (UTILITY)
   - Schedule retry via QStash (15min for no-answer/busy, 60min for other)
5. If retry_count >= 2:
   - Status → unreachable
   - No more WhatsApp messages
   - HR sees: "All retries exhausted — needs manual follow-up"
```

---

## Testing Guide

### Local Testing (Development)

1. **Start ngrok**
   ```bash
   ngrok http 3000
   ```

2. **Configure Webhooks**
   - Go to Meta App Dashboard → WhatsApp → Configuration
   - Set Webhook URL: `https://your-ngrok-url/api/whatsapp/webhook/meta`
   - Verify Token: `gatihire_webhook_verify_2024`
   - Subscribe to events: `messages`

3. **Test Each Template**
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

### Production Deployment

1. Set all environment variables in Vercel
2. Update webhook URL to `https://admin.gatihire.com/api/whatsapp/webhook/meta`
3. Deploy and test end-to-end

---

## Code References

| File | Purpose |
|---|---|
| `lib/whatsapp.ts` | Meta WhatsApp API integration |
| `app/api/whatsapp/webhook/meta/route.ts` | Meta webhook handler |
| `lib/aisensy.ts` | Aisensy integration (fallback) |
| `lib/call-orchestrator.ts` | Orchestrates screening campaigns |
| `lib/scheduled-call.ts` | QStash-based call scheduling |

---

*Last updated: 2026-09-04*
