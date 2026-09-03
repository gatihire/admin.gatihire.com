# Bolna + Aisensy — Setup Checklist (Do This From Your Side)

> **Who this is for:** you (the operator). Follow this doc top to bottom — **only this doc**.
> Every step tells you exactly what to click, what value to copy, and where to paste it.
> Estimated effort: 1–2 hours, most of it waiting for WhatsApp template approval.
>
> **Where we stand:** ✅ **Database is done** (all migrations applied, all tables exist).
> Everything below is external credentials + configuration on your side.
>
> **Provider roles (read once):**
>
> - **Bolna** = the AI voice agent (makes the calls). *Required.*
> - **Aisensy** = WhatsApp messages. *Required only if you use the "WhatsApp nudge" toggle.*
> - **QStash** (Upstash) = scheduler for retries/call-backs. *Required* (free tier is fine).
> - **Plivo** = only to buy the phone number once. No code config.

***

## Checklist at a glance

| # | Task                               | Where                          | Required for       | Status |
| - | ---------------------------------- | ------------------------------ | ------------------ | ------ |
| 0 | Open `.env.local`                  | repo                           | everything         | ⬜      |
| 1 | Supabase migrations                | Supabase                       | everything         | ✅ Done |
| 2 | Buy a phone number                 | Bolna platform                 | calls              | ⬜      |
| 3 | Create Bolna API key               | Bolna platform                 | calls              | ⬜      |
| 4 | Provision the Bipul agent          | `POST /api/bolna/agent` (code) | calls              | ⬜      |
| 5 | Set Bolna webhooks + IP allowlist  | Bolna dashboard / hosting      | verdicts + inbound | ⬜      |
| 6 | Create QStash keys                 | upstash.com                    | retries/call-backs | ⬜      |
| 7 | Create Aisensy account + templates | Aisensy dashboard              | WhatsApp flow      | ⬜      |
| 8 | Full `.env.local` check + restart  | repo                           | everything         | ⬜      |
| 9 | Verify with a test call            | admin UI                       | everything         | ⬜      |

***

## Step 0 — Open your `.env.local` (one-time setup)

You'll add values to this file as you go through the steps. It lives at:

```
/Users/bipulsikder16/Developer/TRUCKINZY/Admin Portal/admin.gatihire.com/.env.local
```

1. Open it in your editor (e.g. `open -e .env.local` or open it in VS Code).
2. You'll append lines to it in Steps 3, 4, 6, 7.
3. To check a variable is present at any time, run in the project folder:
   ```
   grep BOLNA .env.local
   ```
   Any line that starts with `#` is a comment (ignored) — that's fine.

> **Important:** do **not** paste your real API keys anywhere except this file. Never commit it.

***

## Step 1 — Supabase migrations ✅ (already applied)

**No action needed.** Verified against the live DB:

- All 65 tables exist, incl. `phone_screening_campaigns`, `phone_screening_participants`
  (36 cols: `origin`, `verdict_json`, `call_payload_json`, `bolna_*`, `transcript_json`…),
  `applications.origin`, and the AI-learning tables.
- Live data already present: **174 jobs**, **4,203 candidates**, **233 applications**
  (0 calls placed yet — expected).

***

## Step 2 — Buy a phone number (Bolna) → this value = `BOLNA_FROM_NUMBER`

1. Go to <https://platform.bolna.ai> → sign up → add payment → fund your wallet.
2. Buy a **phone number** (Dashboard → Numbers → Buy). Indian numbers route via Plivo/Vobiz,
   US via Twilio. Buy an **Indian** number if your candidates are in India.
   See [Buy Phone Numbers](https://www.bolna.ai/docs/guides/inbound/buying-phone-numbers.md).
3. Copy the full number **with country code**, e.g. `+918035739222`.
4. Keep it handy — you'll paste it into `.env.local` in Step 3.

***

## Step 3 — Create Bolna API key → add to `.env.local`

1. In Bolna dashboard → **Account / API settings** → **Create token**.
2. Copy the token immediately (shown once).
3. In `.env.local`, append these two lines (replace the values):
   ```env
   BOLNA_API_KEY=paste-your-bolna-api-token-here
   BOLNA_FROM_NUMBER=+918035739222
   ```
   > `BOLNA_FROM_NUMBER` is the number from Step 2.
4. Also append the webhook base — the URL Bolna will call back to. For production:
   ```env
   PHONE_SCREENING_WEBHOOK_BASE=https://admin.gatihire.com
   ```
   (If you're testing locally, use your ngrok URL here instead, e.g. `https://abc123.ngrok.app`.)
5. Save the file. Verify:
   ```
   grep -E "BOLNA_API_KEY|BOLNA_FROM_NUMBER|PHONE_SCREENING_WEBHOOK_BASE" .env.local
   ```
   All three should print with values.

> **You need these 3 set before Step 4** — the agent-provisioning endpoint reads them.

***

## Step 4 — Provision the Bipul agent (one-time create)

The master prompt (Bipul persona, inbound/outbound origin-branch, JSON verdict contract) is
baked into `lib/bolna.ts`. This endpoint creates the agent in your Bolna account with the exact
prompt, welcome message, voice (ElevenLabs Nila), transcriber (Deepgram nova-3), guardrails,
and webhook.

### 4a. Make sure the dev server is running

In the project folder (`admin.gatihire.com`):

```
npm run dev
```

Keep it running. It must be running **after** you saved `.env.local` (Step 3) so the new env is
loaded.

### 4b. Log into the admin UI

The endpoint requires you to be logged into the admin. Open <http://localhost:3000> in your
browser and sign in (your `NEXT_PUBLIC_ADMIN_EMAIL` / `NEXT_PUBLIC_ADMIN_PASSWORD` from
`.env.local`).

### 4c. Create the agent

In a second terminal tab, run:

```
curl -X POST http://localhost:3000/api/bolna/agent \
  -H "Content-Type: application/json" \
  -d '{"language": "hinglish"}'
```

- `"hinglish"` = Hinglish prompt (default; for Indian logistics roles).
- `"english"` = English-only prompt. Use one; you can't mix later without `force:true`.

**Expected response:**

```json
{ "agent_id": "ag_xxxxxxxx", "created": true }
```

If you get `{"error":"Unauthorized"}` → you're not logged into the admin (Step 4b).
If you get `{"error":"webhookBase is required..."}` → `PHONE_SCREENING_WEBHOOK_BASE` isn't set
in `.env.local` (Step 3).

### 4d. Save the agent id

Copy the `agent_id` value into `.env.local`:

```env
BOLNA_AGENT_ID=ag_xxxxxxxx
```

Save. That's the one-time setup done.

### 4e. What happens from now on (important)

- **Calls do NOT send the prompt.** `placeBolnaCall()` sends only
  `{ agent_id, recipient_phone_number, user_data }` — Bolna runs whatever prompt is currently
  configured on the agent in the dashboard.
- **The Bolna dashboard is your live editor.** After this step, edit the prompt / voice /
  guardrails directly in Bolna → changes apply to the very next call. No code change, no deploy.
- **Re-hitting the endpoint does nothing** (create-only). It returns
  `{ "created": false, "overwritten": false }` and never touches dashboard edits.
- To deliberately re-sync the prompt from code, pass `force: true` (wipes dashboard prompt edits):
  ```
  curl -X POST http://localhost:3000/api/bolna/agent \
    -H "Content-Type: application/json" \
    -d '{"language": "hinglish", "force": true}'
  ```

> **One guardrail:** whatever you edit in the dashboard, keep the **FINAL OUTPUT JSON block**
> (the `score` / `recommendation` / `callback_time` / `key_answers` object) intact — the webhook
> parses exactly that JSON from the transcript. If it's removed or renamed, verdicts silently
> stop being recorded. The prompt in `lib/bolna.ts` is the verified reference for the contract.

***

## Step 5 — Bolna webhooks + source IP (so results come back)

### 5a. Execution webhook (required for ALL call flows)

1. In the Bolna dashboard → your agent → **Webhook** ("Push all execution data") set it to:
   ```
   https://admin.gatihire.com/api/bolna/webhook/execution
   ```
   (If testing locally, use `https://<your-ngrok>.ngrok.app/api/bolna/webhook/execution`.)
2. Allowlist Bolna's source IP **`13.203.39.153`** on your edge (Vercel / Cloudflare / nginx) so
   webhook verification passes.

   **Simpler alternative (recommended):** set a shared token in `.env.local`:
   ```env
   BOLNA_WEBHOOK_TOKEN=<any-long-random-string>
   ```
   then in the Bolna dashboard configure the webhook header `x-bolna-token: <same string>`.
   The code accepts either the IP or the token.

> If neither is set, the webhook is rejected with 401 and **verdicts never arrive**.

### 5b. Inbound call webhook (for candidates calling back)

If you want candidates to be able to call back after a missed/unanswered call:

1. Buy/assign a **phone number on Bolna for inbound** (same platform → Numbers → Buy).
2. Configure that number's webhook to:
   ```
   https://admin.gatihire.com/api/bolna/webhook/inbound
   ```
3. The webhook finds the participant by `from_number`, resets status to `calling`,
   increments attempts, and triggers a new Bolna call with `inbound_resume: true`.
4. The agent receives `inbound_resume: true` in userData and continues the screening flow.

> **Optional:** if behind a proxy, set `BOLNA_WEBHOOK_TOKEN` and add `x-bolna-token` header.

***

## Step 6 — QStash keys (Upstash) → add to `.env.local`

Retries and scheduled call-backs are driven by QStash. If skipped, calls still fire immediately
but **no retries / call-backs / WhatsApp reminders** run.

1. Go to <https://console.upstash.com/qstash> → sign up (free tier is fine) → **Create** a database.
2. Copy these 3 values → append to `.env.local`:
   ```env
   QSTASH_TOKEN=paste-qstash-token
   QSTASH_CURRENT_SIGNING_KEY=paste-current-signing-key
   QSTASH_NEXT_SIGNING_KEY=paste-next-signing-key
   ```
3. Save and verify:
   ```
   grep QSTASH .env.local
   ```

***

## Step 7 — Aisensy account + WhatsApp templates

**Only needed if you'll use the "WhatsApp nudge" toggle.** If you're starting with **Direct call**
only, you can skip this and come back later.

1. Create an account at Aisensy, connect your **WhatsApp number**, get an **API key**.
2. In Aisensy → **Templates**, create each template below with the exact body. **Params order
   matters** — the code sends values in this exact sequence, so `{{1}}` / `{{2}}` … must match.

   **Template 1 — OUTBOUND nudge** (cold outreach) → env `AISENSY_OUTREACH_TEMPLATE`
   Params: `{{1}}` name, `{{2}}` title, `{{3}}` location, `{{4}}` budget, `{{5}}` job link.
   Add Quick Replies `[ Interested ] [ Not interested ]`.
   > Hi `{{1}}`, this is **Bipul** from the recruitment team at **Gati**. We came across your
   > profile for the **`{{2}}`** role (`{{3}}`, budget `{{4}}`). Would you be interested in a quick
   > AI screening call to discuss it? You can see the full details here: `{{5}}`. Reply
   > *Interested* or *Not interested*.
   **Template 2 — INBOUND shortlist** (applicant already applied) → env `AISENSY_SHORTLIST_TEMPLATE`
   Same param order as above.
   > Hi `{{1}}`, this is **Bipul** from **Gati**. Congratulations — your application for the
   > **`{{2}}`** role (`{{3}}`, budget `{{4}}`) has been shortlisted! We'd love to schedule your AI
   > screening call. Details here: `{{5}}`. Reply *Interested* or *Not interested*.
   **Template 3 — Schedule options** → env `AISENSY_SCHEDULE_OPTIONS_TEMPLATE`
   Params: `{{1}}` name. Quick Replies `[ Call me now ] [ In 10 minutes ] [ Today evening ]`.
   > Hi `{{1}}`, great to hear you're interested! When would you like our AI recruiter **Bipul** to
   > call you? Reply *Call me now*, *In 10 minutes*, or *Today evening*.
   **Template 4 — Call nudge** → env `AISENSY_CALL_NUDGE_TEMPLATE`
   Params: `{{1}}` name, `{{2}}` title, `{{3}}` company. (Used before a scheduled call.)
   > Hi `{{1}}`, a quick heads-up — **Bipul** from **Gati** will call you shortly about the
   > `{{2}}` role at `{{3}}`. Reply *Now* to skip the wait.
   **Template 5 — Missed-call nudge** → env `AISENSY_MISSED_CALL_TEMPLATE`
   Same param order as Template 4.
   > Hi `{{1}}`, we missed you. Reply *yes/no *and our recruiter will call you back about the `{{2}}`
   > role at `{{3}}`.
   **Template 6 — Reminder** → env `AISENSY_REMINDER_TEMPLATE`
   Params: `{{1}}` name, `{{2}}` title, `{{3}}` location. (Sent after \~4h of no reply.)
   > Hi `{{1}}`, just a friendly reminder about the `{{2}}` role (`{{3}}`). Reply *Interested* or
   > *Not interested*.
3. All templates must pass **Meta approval** — start them early; they take a few hours.
4. Append to `.env.local` the template **names** (the names you gave them in Aisensy):
   ```env
   AISENSY_API_KEY=paste-your-aisensy-api-key
   AISENSY_SENDER_ID=<your-sender-id-or-source>
   AISENSY_TEMPLATE_ID=<default-campaign-or-template-name>
   AISENSY_OUTREACH_TEMPLATE=outbound_nudge_template_name
   AISENSY_SHORTLIST_TEMPLATE=inbound_shortlist_template_name
   AISENSY_SCHEDULE_OPTIONS_TEMPLATE=schedule_options_template_name
   AISENSY_CALL_NUDGE_TEMPLATE=call_nudge_template_name
   AISENSY_MISSED_CALL_TEMPLATE=missed_call_template_name
   AISENSY_REMINDER_TEMPLATE=reminder_template_name
   AISENSY_CAMPAIGN_NAME=Job_Recruitment
   AISENSY_SOURCE=<source-label>
   ```
5. (Optional but recommended) Point Aisensy's delivery webhook at
   `https://admin.gatihire.com/api/whatsapp/webhook/aisensy` to record sent/delivered/read.

***

## Step 8 — Full `.env.local` check + restart

1. After all steps, confirm everything is present in one shot:
   ```
   grep -E "BOLNA_|QSTASH_|AISENSY_|PHONE_SCREENING_WEBHOOK_BASE" .env.local
   ```
2. **Required** for calls to work at all:
   - `BOLNA_API_KEY`, `BOLNA_AGENT_ID`, `BOLNA_FROM_NUMBER`
   - `PHONE_SCREENING_WEBHOOK_BASE`
   - `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
3. **Required only for the WhatsApp nudge flow:**
   - `AISENSY_API_KEY` + the `AISENSY_*_TEMPLATE` names from Step 7
4. **Optional for inbound calls:**
   - Same `BOLNA_WEBHOOK_TOKEN` (shared with execution webhook)
5. Restart the dev server so the new env loads:
   ```
   # stop the running npm run dev (Ctrl+C), then:
   npm run dev
   ```

> Don't set `PLIVO_*` — they're legacy. Plivo is only your number vendor.

***

## Step 9 — Verify with a real test call

1. Open <http://localhost:3000> (or your admin URL) → a job → **Candidates** tab (or **DB
   Matches**) → **Start AI Calls**.
2. Confirm the confirmation shows the **Inbound/Outbound split**.
3. Pick a candidate whose phone **you control** (use a test number).
4. Choose **Direct Call (Skip WhatsApp)** first (no WhatsApp dependency) → **Start**.
5. Expected:
   - Participant status flips to `calling` (or `failed`).
   - Your phone rings \~1–2 min later; **Bipul** introduces himself and screens.
   - After the call: `verdict_json`, `transcript`, and status land on the participant row.
6. If the call **fails**, check the server log for `Bolna call failed` / `Bolna not configured`
   and re-check `BOLNA_API_KEY`, `BOLNA_AGENT_ID`, wallet balance.
7. Then test **WhatsApp Nudge → Auto Call** once templates are approved.
8. **Test inbound call** (optional): call the Bolna inbound number from the candidate's phone.
   - Expected: participant resets to `calling`, new Bolna call triggered, Bipul continues screening.
9. **Test rejection email**: move an **inbound** candidate to **Rejected**, pick a reason.
   - Expected: rejection email sent to candidate (check mail logs).
10. **Test interview flow**: move a candidate to **Move to Next Round**.
    - Expected: UI auto-switches to next round.
11. **Test notes separation**: check Candidate Notes (read-only) vs Recruiter Notes (editable).

### Common failure → fix

| Symptom                                                 | Cause                                           | Fix                                 |
| ------------------------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| `Bolna not configured (BOLNA_API_KEY / BOLNA_AGENT_ID)` | env missing                                     | Step 8                              |
| `Bolna call failed ... HTTP 4xx`                        | bad key / no balance / invalid number           | check key + wallet + E.164          |
| Call rings but hangs / wrong persona                    | agent built manually, prompt stale              | re-run with `force: true` (Step 4e) |
| Verdicts never arrive                                   | webhook not set / IP not allowlisted            | Step 5                              |
| No retries / call-backs                                 | QStash keys missing                             | Step 6                              |
| WhatsApp nudge never sends                              | template not approved / wrong name              | Step 7, check Aisensy dashboard     |
| Status `needs_manual_followup` right after trigger      | outreach template missing/unapproved            | set `AISENSY_OUTREACH_TEMPLATE`     |
| Inbound call doesn't trigger                            | inbound webhook not set / number not configured | Step 5b                             |
| Rejection email not sent                                | candidate not inbound/board-app                 | only inbound/board-app get emails   |
| Interview round doesn't auto-switch                     | UI cache                                        | refresh page                        |

***

## Reference

- `docs/bolna-end-to-end-guide.md` — full Bolna config details + the exact prompt edits
- `docs/bolna-outbound-screening.md` — Bolna outbound specifics + migration notes
- `docs/call-pipeline-architecture.md` — WhatsApp + Bolna architecture and honest assessment
- `lib/bolna.ts` — prompts, welcome messages, `placeBolnaCall`, agent provisioning payload
- `lib/aisensy.ts` — WhatsApp template calls and param order
- `lib/scheduled-call.ts` — QStash retries/call-backs

