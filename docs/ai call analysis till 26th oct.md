# GatiHire × Bolna — Call Quality Fix Plan

Paste this file into OpenCode. Part A is manual (Bolna dashboard, done by a human). Part B is repo work for OpenCode. Part C is the new prompt. Part D is the validation plan.

Agent: `Ananya 2` (`46af6ab9-dd69-41b2-98d8-3e107e813199`), webhook `https://admin.gatihire.com/api/bolna/webhook/execution`.

---

## 0. What the data said (155 call attempts, Oct 19–24, 84 connected)

| Finding | Evidence |
|---|---|
| 67% of connected calls are ended by Plivo with `synthesizer_error` | 56 of 84, unchanged before and after the Oct 23 edit |
| Likely cause: the prompt makes the LLM emit a JSON blob as its last message, and that goes to the Sarvam TTS | 40 of the 56 errors have the JSON in the transcript |
| 16 calls (19%) are hard drops mid-interview: the candidate talks, the agent never answers, the call dies | Half occur right after the notice/joining answer, i.e. when the model starts wrapping up. Inference only: Bolna doesn't log the text that crashed TTS |
| Interruptions got worse after the edit | 5.6 → 9.6 per call, agent sentences cut off 18% → 34%. Only 9 post-change conversational calls, so treat it as a signal |
| Endpointing 150 ms splits Hindi answers into fragments | Up to 5 consecutive user fragments in one answer |
| The model ignores the prompt | Still asks "kab tak join kar sakte hain" despite "no joining question"; breaks the 2-sentence rule in about 20% of turns; says "rachout"; reads names in CAPS |
| Prompt contradicts itself | "Busy → agree a callback time" vs "Never agree a call time"; wrap-up line differs from the `call_cancellation_prompt` closing lines, so Bolna's auto-hangup never fires |
| Calls are short | Avg 2.4 min connected vs the 4–6 min the prompt promises |
| Pickup is weak | 37 busy + 33 no-answer of 155 (45% never connect) |
| Latency is fine | LLM about 510 ms, TTS about 235 ms, so it is NOT the problem |

---

## Part A — Manual steps (you, in the Bolna dashboard)

Do these in order. Change the minimum number of things on the live agent.

1. **Rotate the API key.** It was pasted in chat. Create a new key in Bolna, update `BOLNA_API_KEY` in your server env, and revoke the old one.
2. **Clone the agent.** Duplicate `Ananya 2` as `Ananya 3 (test)`. Do all the changes below on the clone. Keep `Ananya 2` untouched until the test passes.
3. **Replace the system prompt** on the clone with the one in Part C.
4. **Set the extraction** (Part B.3 gives the schema). In the clone's Analytics / Extraction tab, add the fields so Bolna extracts them after the call, instead of the LLM speaking JSON.
5. **Settings on the clone:**

| Setting | Now | Set to | Why |
|---|---|---|---|
| Transcriber endpointing | 150 | 350 | Stops splitting Hindi answers mid-pause |
| `number_of_words_for_interruption` | 2 | 3 | "haan" / "ji" no longer cuts the agent off |
| `interruption_backoff_period` | 0 | 300 | Gives a beat before the agent resumes |
| `hangup_after_silence` | 12 | 20 | Fewer premature hangups on slow answerers |
| `trigger_user_online_message_after` | 7 | 10 | Fewer "are you there?" |
| LLM `max_tokens` | 370 | 150 | Spoken turns are short once the JSON is gone |
| LLM model | gpt-4o-mini | gpt-4.1 or gpt-4o | Better instruction following; compare cost on the test batch |
| Backchanneling | off | leave off | Keep variables down for the first test |
| Voice (Sarvam bulbul:v3, Ashutosh) | | leave as is | TTS latency is fine |

6. **Update `call_cancellation_prompt`** on the clone: replace the closing lines in it with the exact closing lines in Part C ("CLOSING LINES"). The hangup check matches on them.
7. **Run the test** (Part D). If it passes, apply the same settings to `Ananya 2`, or point the backend at the new agent ID.
8. **Two non-code improvements for pickup:** send a WhatsApp "we'll call you at HH:MM from +91 80318 05503, please save the number" 15 minutes before. Retry no-answer and busy calls at a different time of day (e.g. 1–2 hours later, max 3 tries).

---

## Part B — Repo tasks (OpenCode)

Find the code first; do not guess paths.

### B.1 Locate

- Search for `bolna`, `BOLNA_`, `/api/bolna/webhook`, `webhook/execution`, `already_collected_`, `{questions}`, `resume_text`.
- Report back: where the call is triggered (payload sent to Bolna `POST /call`), where the webhook is handled, and where the transcript JSON is parsed.

### B.2 Webhook: stop depending on JSON spoken by the LLM

Today the handler most likely parses the final JSON object out of `transcript`. After the new prompt, that JSON no longer exists.

1. Read results from the execution payload's `extracted_data` (and `custom_extractions` if present) instead.
2. Keep a backward-compatible fallback: if `extracted_data` lacks the fields, try to parse a trailing JSON object from `transcript`. Wrap it in try/catch and never crash on bad JSON.
3. **Never treat `telephony_data.hangup_reason == "synthesizer_error"` as a candidate failure.** Classify outcomes with this precedence:
   - `status` in (`busy`, `no-answer`, `failed`, `canceled`) → retry flow
   - `answered_by_voice_mail` true or `hangup_reason == "voicemail_detected"` → retry flow
   - `conversation_duration < 45` or fewer than 3 user turns → "not screened", re-queue
   - transcript has the closing line, or extraction `recommendation` is set → "screened"
   - otherwise (candidate was mid-answer when the call died) → "interrupted, needs human callback or retry". This is the 19% bucket; surface it to HRs so no candidate is lost.
4. Store `hangup_reason`, `hangup_by`, `conversation_duration`, `recording_url` and `latency_data.interruption_stats` per call so quality can be tracked on a dashboard.
5. Make the handler idempotent on the execution `id` (webhooks can repeat), and verify `BOLNA_WEBHOOK_TOKEN`.

### B.3 Extraction schema (configure in Bolna, mirror in the backend types)

Fields: `recommendation` (advance | further_review | not_a_fit), `score` (0–10), `next_round_ready` (bool), `verdict_explanation`, `pluses` (list), `minuses` (list), `callback_requested` (bool), `callback_time` (YYYY-MM-DD HH:MM, candidate local), `callback_preference_text`, `decline_reason`, `summary`.

Fields that were previously "copied" from the old NEVER ASK block (CTC, notice period, experience, relocation) should come from your own database, not from the call. Merge them in the backend. Do not ask the LLM to echo them.

Scoring rule to put in the extraction instruction: 8–10 advance (concrete proof of doing the job); 5–7 further_review; 0–4 not_a_fit (cannot do the work, red flags, or not interested). If the candidate hung up before the first question, use `further_review` with a note, not `not_a_fit`.

### B.4 Call-trigger payload (variables sent to Bolna)

1. Title-case the candidate name before sending (`SANTOSH` → `Santosh`). All-caps names are being read oddly by TTS.
2. Send `candidate_first_name` as well, and use it in the greeting. "Rahul Kumar Singh ji" is long to say. The new prompt uses `{candidate_first_name}`, so this variable is required.
3. Truncate `resume_text` to the most recent two roles and about 1,200 characters. The full resume bloats the prompt and makes the model less obedient.
4. Send at most 4 to 5 questions in `{questions}`, each under 25 words, one per line, numbered. Questions must be answerable by speaking (no "list all…").
5. The new prompt no longer uses the `{already_collected_*}` variables. Stop sending them to the call (keep them in your DB).
6. Pass `{origin}` as exactly `inbound` or `outbound`.
7. Validate that no `{placeholder}` is left unfilled before dialing. If one is, log and skip the call.
8. Update the agent's welcome message to use `{candidate_first_name}` too (currently "Hello {candidate_name} ji, Ayush bol raha hu GatiHire se. Do minute baat ho sakti hai kya?"). The prompt's line check then must not repeat the greeting; the prompt's step 1 is for when the welcome message is not used, so keep only one of them. Recommended: keep the welcome message and delete step 1's greeting wording during testing.

### B.5 Retry and scheduling

- On `busy` / `no-answer`, schedule up to 3 retries on different time bands, not minutes apart.
- On an "interrupted" outcome (B.2.3), re-queue one retry within 30 minutes.

### B.6 Tests

Add unit tests for the webhook classifier with fixtures: completed with closing line, hard drop (last turn is user), voicemail, busy, candidate hangup within 20 s, and a transcript containing legacy JSON.

---

## Part C — New prompt (paste into the Bolna agent)

Why it is shorter: the old prompt was about 10,000 characters and the model ignored parts of it. Changes made:

- Removed the JSON output block (the main suspect for the drops).
- Fixed the contradictions: the callback rule now says "ask when, don't promise a slot".
- Added exact closing lines that match the hangup check.
- Added rules for incomplete answers, one-word replies, names, and pronunciation.
- Removed rules the platform already handles (silence check).

```
ROLE
Aap Ayush hain, Truckinzy Infotech Private Limited (GatiHire, India ka logistics aur supply chain jobs platform) mein Talent Acquisition Specialist. Yeh ek chhoti pehli screening call hai. Aap warm, respectful aur efficient hain.

CONTEXT (WhatsApp pe pehle hi ho chuka hai)
Candidate ki interest, CTC, notice period, experience, location, relocation aur switch ki wajah pehle hi collect ho chuki hai. Is call ka sirf ek kaam hai: neeche ke sawaal pooch kar samajhna ki candidate ne apna kaam actually kaise kiya hai.

CANDIDATE
Naam: {candidate_first_name} (poora naam: {candidate_name})
Abhi ka role: {current_role}, {current_company}
Skills: {skills}
Resume ke important points: {resume_text}
Source: {origin} (inbound = unhone apply kiya tha, outbound = humne profile dekhi)

ROLE JO HIRE HO RAHA HAI
{job_title}, {hiring_company_name}, {job_location}
Company: {business_type_context}
Role: {job_gist}
Must-have skills: {must_have_skills}
Experience chahiye: {experience_min} se {experience_max} saal
Salary range: {salary_range}

BOLNE KA TARIKA
- Natural Hinglish, respectful "aap". Agar candidate English bole to English mein jaaiye.
- Har turn mein sirf ek ya do chhote vaakya, aur sirf ek sawaal. 25 shabd se zyada nahi.
- Candidate ko bolne dein. Beech mein na kaatein. Jab tak woh baat poori na kare, agla sawaal na poochein.
- Agar jawab adhoora lage ya sirf "haan", "ji" jaisa ho, to bas "Ji, boliye" kahein aur sunein. Naya sawaal nahi.
- Candidate ke jawab ko dohrana nahi. Ek chhota sa acknowledgement ("Achha", "Samajh gaya", "Theek hai") aur seedha agla sawaal.
- Naam sirf shuruat mein aur closing mein lein, har turn mein nahi.
- Koi list, bullet, markdown ya emoji nahi. Numbers shabdon mein bolein. Acronym ko ek baar poora bolein.
- Sawaal dobara nahi poochna. Agar candidate ne already jawab de diya hai to woh sawaal skip karein.

CALL KA FLOW
1. Line check (agar welcome message mein pehle hi ho chuka hai to dobara na bolein): "Kya abhi do minute baat ho sakti hai?"
   - Agar abhi busy hain: "Koi baat nahi. Aap kis din aur kis time free honge?" Unka jawab note karein, kuch promise na karein: "Theek hai, hum us hisaab se koshish karenge." Phir closing (RESCHEDULE).
   - Agar galat number hai: maafi maangein aur closing (WRONG NUMBER).
2. Ek line mein reason:
   - inbound: "Aapne {job_title} role ke liye apply kiya tha, uski chhoti si screening hai, teen-chaar minute lagenge."
   - outbound: "Aapki profile {job_title} role ke liye achhi lagi, isliye chhoti si screening ke liye call kiya hai."
3. Neeche ke sawaal ek-ek karke, order mein poochein:
{questions}
   - Jawab vague ho to sirf ek follow-up poochein, phir agle sawaal par jaayein. Resume ki koi ek concrete baat follow-up ke liye best hai.
   - Poori call 4 se 6 minute mein khatam karein. Time kam ho to sabse zaroori sawaal poochkar closing par jaayein.
4. Closing (sirf yeh lines, phir ruk jaayein, call dobara na kholein).

CLOSING LINES (exact)
- Screening poori hui: "Aapka bahut shukriya. Agar aap next round ke liye shortlist hote hain, to hum aapko WhatsApp par bata denge. Dhanyavaad, goodbye."
- Interested nahi / DND: "Theek hai, koi baat nahi. Aapka samay dene ke liye dhanyavaad. Goodbye."
- Reschedule: "Samajh gaya. Humne aapki baat note kar li hai. Dhanyavaad, goodbye."
- Galat number: "Maaf kijiye, galti ke liye sorry. Dhanyavaad, goodbye."

JO KABHI NAHI KARNA
- Interest, CTC, expected CTC, notice period, total experience, current city, relocation, switch ki wajah, designation, company, phone number nahi poochna. Yeh sab pehle se hamare paas hai. "Joining kab kar sakte hain" bhi nahi poochna.
- Koi interview date, offer ya selection promise nahi. Koi call time confirm nahi, sirf note karna. Slots team WhatsApp par bhejti hai.
- Salary range ke bahar kuch nahi bolna. Candidate ki current salary nahi poochni.
- Age, religion, marital status, caste nahi poochna. Bank, Aadhaar, PAN jaisi cheezein nahi maangni.
- Khud se AI hone ka zikr nahi. Agar seedha poochein to: "Main Truckinzy ki AI assistant hoon."
- Kisi sawaal ka jawab na pata ho to: "Iska poora jawab hamari team aapko dengi." Kuch invent nahi karna.

COMMON SAWAAL
- Kaun bol raha hai? "Main Ayush, Truckinzy Infotech Private Limited se, jo GatiHire chalata hai, logistics jobs ka platform."
- Number kahan se mila? inbound: "Aapne GatiHire par {job_title} ke liye apply kiya tha." outbound: "Aapki profile ek job portal par is logistics role ke liye match hui."
- Salary? "Is role ki salary range {salary_range} hai. Exact figure recruiter next step mein confirm karenge."
- Aage kya hoga? "Team dekhegi, aur kuch hoga to WhatsApp par bata diya jayega."

OBJECTIONS (ek baar respectfully, phir maan lein)
- Interested nahi / already employed: ek baar wajah poochein ("Kya aap bata sakte hain kyun?"), note karein, "Interested nahi" closing.
- Location suit nahi karti: acknowledge karein, closing.
- Salary mismatch: "Recruiter final CTC par aapse baat kar lenge." Agar phir bhi na, closing.
- "Sochke bataunga": "Koi baat nahi, kab baat karna theek rahega?" Note karein, Reschedule closing.
- DND: turant confirm karke closing, koi persuasion nahi.
- Abusive: ek baar chetawani, dobara ho to closing.
- Purani Truckinzy/client shikayat: "Main yeh note kar leta hoon, team follow up karegi." Closing.

RULES
- Closing line ke baad kuch aur nahi bolna.
- Output sirf bole jaane wale shabd hon. Kabhi JSON, code, ya brackets nahi bolna, kyunki aapka har shabd voice mein badal kar candidate ko sunaya jata hai.
```

**Pronunciation:** if "WhatsApp" or job titles sound off on test calls, use Bolna's `pronunciation_rules` rather than spelling words oddly in the prompt (the old "rachout" hack is gone).

---

## Part D — Validation plan

1. **Test on the clone (`Ananya 3`)** with your own phone, three scenarios: full cooperative candidate; candidate who talks with long pauses; candidate who says "not interested". Listen for: the call lasting 4 minutes or more, no silence after your answers, a spoken closing line, and the call ending cleanly.
2. **Pilot batch:** route about 30 real candidates to the clone, the rest stay on `Ananya 2`.
3. **Compare on these metrics** (pull via `GET /v2/agent/{id}/executions`; ask Claude to rerun the analysis):

| Metric | Baseline | Target |
|---|---|---|
| `synthesizer_error` share of connected calls | 67% | under 5% |
| Hard drops (candidate spoke last, no reply) | 19% | under 3% |
| Agent sentences cut off | 18–34% | under 10% |
| Interruptions per call | 5.6–9.6 | under 5 |
| Avg connected duration | 2.4 min | 4+ min |
| Calls where a closing line was spoken | about 0% of error calls | over 90% |
| Questions asked per completed call | | all of the configured 4–5 |

4. **Ask the HRs** for feedback on the pilot candidates specifically ("did the call cut in the middle?"), since that is the original complaint.
5. If hard drops persist with the JSON gone, the cause is on the Sarvam side. Fallbacks, in order: switch the synthesizer to another provider/voice on the clone, lower `buffer_size` from 230, and raise a ticket to Bolna with 3 execution IDs (for example `bdf1cba7-1045-4d12-8c75-ce1ac0cf9171`, plus the two hard-drop calls `304f0a09…` and `b5802fec…`; fetch full IDs from the executions list).

## Known uncertainty

- The root cause of the hard drops is inferred from patterns, not proven. The clone test in Part D is what confirms it.
- I haven't seen your backend code, so Part B tells OpenCode to find things rather than assuming file names.
- Settings values in Part A are starting points; tune them on the clone using the pilot metrics.
