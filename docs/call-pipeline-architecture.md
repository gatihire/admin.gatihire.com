# Call Pipeline Architecture — WhatsApp (Aisensy) + Bolna AI Voice (Current Design)

> **Purpose:** Document how the WhatsApp-nudge flow, the Bolna direct-call flow, and the **new inbound call flow** fit together in the current admin.gatihire.com architecture.

> **Provider map (important):**
> - **Aisensy** — WhatsApp (nudges, schedule options, delivery status).
> - **Bolna** — AI voice calls (all flows: direct, WhatsApp-nudge, **inbound**) + call-backs/retries.
> - **Plivo** — **only used to purchase/own the phone number**. It is *not* the WhatsApp
>   provider and *not* the voice provider. The `lib/plivo.ts` API paths are dormant legacy code
>   and are not on the live call path.

---

## 1. The big picture

There are **three** ways an AI screening call gets placed today, selectable per batch in the admin UI:

| Flow | Call mode | Who makes the call | WhatsApp needed? | Best for |
| ---- | --------- | ------------------ | ---------------- | -------- |
| **WhatsApp Nudge → Auto Call** | `whatsapp_first` | **Bolna** after candidate opts in via WhatsApp | Yes (Aisensy) | Inbound applicants, and outbound profiles you don't want blind-called |
| **Direct Call (Skip WhatsApp)** | `call_now` | **Bolna** (voice agent) immediately | No | Outbound cold outreach where speed matters and opt-in isn't expected |
| **Inbound Call** | `inbound` (webhook) | **Bolna** when candidate calls back | No | Candidates calling back after missed/unanswered calls |

All three flows share the same pipeline tables (`phone_screening_campaigns`, `phone_screening_participants`),
the same origin tag (`applications.origin`), and the same QStash scheduler for call-backs and retries.
All flows place the actual voice call through **Bolna** using the same Bipul prompt.

```
                        +----------------------------+
                        |   Admin UI (per batch)      |
                        |  Direct / WhatsApp Nudge?   |
                        +-------------+--------------+
                                      |
                                      v
                        POST /api/phone-screening/trigger
                                      |
                                      v
                       lib/call-orchestrator.ts
                      (creates campaign + participants)
                                      |
                  +-------------------+-------------------+
                  |                                       |
        callMode = "call_now"                 callMode = "whatsapp_first"
                  |                                       |
                  v                                       v
        placeBolnaCall(user_data)            Aisensy WhatsApp nudge
        (origin in user_data)                (outreach vs shortlist copy)
                  |                                       |
                  |                              candidate replies "call me now"
                  |                                       |
                  |                                       v
                  |                              Aisensy webhook -> scheduleBolnaCall
                  |                                       |
                  +-------------------+-------------------+
                                      |
                                      v
                        Bolna agent runs the Bipul intro
                        (origin-aware: "thanks for applying" / "we found your profile")
                                      |
                                      v
              webhook/execution (Bolna)
              -> verdict JSON, transcript, status updates
                                      |
                                      v
          Busy / no-answer / failed -> QStash schedules retry/callback
          (lib/scheduled-call.ts -> placeCallForParticipant -> placeBolnaCall)
```

### Inbound Call Flow (NEW)

```
+----------------------------+
| Candidate dials Bolna      |
| inbound number             |
+-------------+--------------+
              |
              v
POST /api/bolna/webhook/inbound
  (finds participant by phone)
              |
              v
placeBolnaCall(inbound_resume: true)
              |
              v
Bolna agent continues screening
(from where it left off)
              |
              v
webhook/execution (Bolna)
-> verdict JSON, transcript, status updates
              |
              v
        QStash schedules retry/callback if needed
```

---

## 2. Flow A — WhatsApp nudge (Aisensy) first, then Bolna voice call

```
1. Recruiter selects candidates, chooses "WhatsApp nudge".
2. POST /api/phone-screening/trigger  { jobId, candidateIds, callMode: "whatsapp_first" }
3. orchestrateScreening() creates campaign + participants (status = "whatsapp_sent").
4. For each candidate it sends an Aisensy WhatsApp template message:
     - inbound  -> shortlist template  (they applied; "your application is being reviewed")
     - outbound -> outreach template   (cold; "we found your profile, interested?")
   Job link points to {boardBase}/board/{jobId}.
5. Aisensy webhook (/api/whatsapp/webhook/aisensy) records delivery/read and, on a matching
   button/free-text reply, drives the opt-in funnel.
6. WhatsApp reply is classified:
     - "call_me_now"  -> scheduleBolnaCall(participantId, ~60s)  [Bolna voice]
     - "interested"   -> Aisensy schedule-options message, then a reply triggers the call
     - "not_interested"-> status = "not_interested"
     - "in_10_min" / "today_evening" -> status = "call_scheduled", QStash re-dials later
7. The scheduled call is placed by Bolna (/api/phone-screening/call/trigger ->
   placeCallForParticipant -> placeBolnaCall) with origin in user_data.
8. Bolna runs the Bipul prompt, branching the intro on origin, and POSTs the execution
   payload to /api/bolna/webhook/execution (verdict JSON, transcript, status).
```

**Key property:** *no blind calls.* A candidate who never engages with WhatsApp never gets
called; silent outbound profiles get one WhatsApp reminder (+4h) then a human follow-up (+8h).

---

## 3. Flow B — Bolna direct call (no WhatsApp)

```
1. Recruiter selects candidates, chooses "Direct call".
2. POST /api/phone-screening/trigger  { jobId, candidateIds, callMode: "call_now" }
3. orchestrateScreening() creates campaign + participants (status = "calling").
4. For each candidate: placeBolnaCall({ to, user_data }) -> Bolna /call API.
     user_data includes origin = applications.origin for that candidate.
5. Bolna agent runs BOLNA_MASTER_PROMPT (Bipul prompt). It reads {origin} and branches
   the opening (CALL FLOW step 3 + "Why are you calling").
6. Bolna POSTs execution payload to /api/bolna/webhook/execution:
     - status + transcript written to participant
     - verdict JSON (score, recommendation, callback_requested, callback_time, key_answers)
       extracted from the transcript and stored in verdict_json
     - if callback_requested -> participant = "call_scheduled", QStash re-dials at that time
     - if no-answer/busy/failed -> participant = "failed", QStash retries (max 4 attempts)
```

**Key property:** *immediate.* No candidate action required before the first call.

---

## 4. Rejection Emails (Inbound/Board-app Only)

When a recruiter moves a candidate to **Rejected**:
1. Confirmation dialog shows dropdown with 10 standard reasons.
2. **Email is sent ONLY for** `origin = "inbound"` OR `source = "board-app"`.
3. Outbound (sourced) candidates do **not** receive rejection emails — they were cold-sourced and never "applied".

This prevents sending "thanks for applying" emails to candidates we cold-contacted.

---

## 5. What all flows share

- **Origin is the single source of truth.** `applications.origin` (set at upload or via the
  re-tag toggle) is copied onto the participant and into `user_data`. The agent intro branches
  on it in *all three* flows.
- **One voice agent.** All flows call through Bolna with the same Bipul prompt
  (`lib/bolna.ts`). There is only one voice persona and one verdict contract to maintain.
- **One scheduler for call-backs/retries.** `lib/scheduled-call.ts` (QStash) drives:
  - WhatsApp reminder / human-escalation timers (WhatsApp flow only)
  - scheduled call-backs from "Call me now → schedule"
  - retry backoff after failed Bolna calls
  - **inbound call re-triggering** when candidate calls back
- **One results pipeline.** Transcripts, verdicts, JD-fit, and team review live on the same
  `phone_screening_participants` rows regardless of which flow placed the call.

---

## 6. Honest engineering assessment

### What's good

1. **No blind calls by default.** The "no blind calls" rule (WhatsApp nudge first, escalate to
   human after silence) is a genuinely good compliance + experience decision for cold outreach.
   Random cold voice calls get high DND/annoyance; letting the candidate opt in first is smarter.
2. **Origins are cleanly threaded end to end.** The inbound/outbound distinction is not a UI
   cosmetic — it flows from `applications.origin` → participant → agent prompt → spoken intro in
   both flows. That is the right design.
3. **Failover is Bolna-native.** Even in the WhatsApp flow, call-backs and retries go through
   Bolna, so there's a single voice-agent contract (prompt + verdict JSON) to maintain.
4. **Operator control.** The per-batch Direct/WhatsApp toggle gives the recruiter judgment at
   the moment of launch instead of baking one policy into code.

### What's fragile / worth a second look

1. **Two text surfaces to keep in sync: the Aisensy WhatsApp template and the Bolna prompt.**
   The WhatsApp nudge copy and the Bolna voice intro are authored in two different places
   (Aisensy dashboard vs `lib/bolna.ts`). They can drift (different tone, different name,
   different job details). **Recommendation:** keep the nudge copy tight and consistent with the
   Bipul persona (Section 7 of the Bolna guide), and treat the Bolna prompt as the source of
   truth for what the candidate hears.

2. **The WhatsApp flow depends on Aisensy templates being approved and reliable.**
   If a template isn't approved or Aisensy delivery degrades, the nudge never reaches the
   candidate and no call is scheduled — no automatic fallback to a direct Bolna call. Silent
   outbound profiles get one WhatsApp reminder (+4h) then a human follow-up (+8h), but nothing
   self-heals to voice.

3. **Origin defaulting can silently mis-tag.** `deriveOrigin()` falls back to `inbound`, and the
   candidates-tab trigger passes no explicit origin (it reads the application). If an upload was
   mis-tagged at the source, the whole AI-call intro is wrong for that candidate. The re-tag
   toggle mitigates this, but a "confirm origin before call" checkpoint in the trigger path would
   close the loop.

4. **QStash is a hard dependency for the whole retry/callback story.** If QStash is down or
   misconfigured (`QSTASH_TOKEN`/signing keys missing), no retries or scheduled call-backs fire.
   Worth a degraded-path fallback (e.g. a periodic reconciliation cron as a backstop).

5. **Operational complexity for a v1.** Maintaining Aisensy templates *and* Bolna is two vendors.
   The value of the WhatsApp flow is real (opt-in, no blind calls), but you could get 80% of
   that value from Bolna's own pre-call SMS/WhatsApp features if they support interactive opt-in,
   dropping Aisensy entirely. (Plivo is only a number vendor and adds no runtime dependency.)

### My verdict

**The combined approach is reasonable but over-engineered for a v1.** The right long-term shape is:

- **Default everything to Bolna direct calls** (`call_now`) — one provider, one prompt, one
  verdict contract, origin-aware intros already in place.
- **Keep WhatsApp only as an opt-in accelerator**, and only if Aisensy is reliably delivering;
  treat it as an enhancement, not a requirement.
- **If you can, collapse to one provider.** If Bolna supports an SMS/WhatsApp opt-in step before
  its own call, use it and retire Aisensy. Two text surfaces (nudge + prompt) is the biggest
  drift risk here — Plivo isn't in the live path.

Practically: ship Flow B (Bolna direct) as the default, keep the toggle so recruiters can force
Flow A where compliance/experience demands it, and keep the Aisensy nudge copy aligned with the
Bipul prompt until it's retired.

---

## 6. Open questions to resolve

- [ ] Do you trust Bolna direct calls for outbound cold outreach (accepting higher non-answer /
      DND rates)? If yes, WhatsApp becomes optional.
- [ ] Can Bolna send an opt-in WhatsApp/SMS before its own call (so Aisensy can be retired)?
- [ ] Should the trigger API enforce a "confirm origin" step before placing calls?
- [ ] Do we need a reconciliation backstop cron in case QStash misses a publish?