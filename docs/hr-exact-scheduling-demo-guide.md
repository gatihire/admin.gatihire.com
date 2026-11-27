# HR exact-time scheduler — demo script and team note

The feature is live on `admin.gatihire.com` (Production) and Preview.
Both flags are on: `ENABLE_HR_EXACT_TIME_SCHEDULING` and
`NEXT_PUBLIC_ENABLE_HR_EXACT_TIME_SCHEDULING`. Removing both env vars and
redeploying turns the whole feature off again; no code change is needed.

## Where the control appears

- **Jobs → open a job → Candidates tab** — a **Schedule Call** button sits beside
  **Nudge** on each candidate row with a phone number.
- **Phone screening results sheet** — the same **Schedule Call** control in the
  header, so HR can book without leaving the screening view.
- **Phone Screening tab** — a booked row shows an indigo
  **HR slot · <time> IST** badge.
- **Today** — a booked row shows **Scheduled** with the IST time and booked-by name.

If no button appears, the browser is on a stale build or the client flag is off.
Hard-refresh first.

## Demo script (5–8 minutes, use a consenting test number)

1. **Get consent first.** Call the test candidate yourself and say: *“Our AI
   screener will call you at the time we agree — is that okay?”* Only book after
   a clear yes. Never book for a candidate who has not agreed.
2. Open **admin.gatihire.com → Jobs → <job> → Candidates**, find the test row,
   click **Schedule Call**.
3. In the dialog:
   - **Date and time (IST)** — pick 6–10 minutes ahead. Minimum is 5 minutes,
     maximum is 7 days. The field is always interpreted as **IST**, whatever the
     laptop's timezone.
   - **Candidate's words** (optional) — e.g. “Candidate said: after 3 pm tomorrow”.
   - **Why this exact time** (required, at least 10 characters) — e.g. “HR spoke
     to the candidate and they agreed to 4:20 pm”.
   - Click **Book exact slot**.
4. Confirm the UI changes: toast **“Exact slot booked — the AI call will fire at
   <time> IST.”** The row now shows **HR slot · <time> IST · <your name>** with a
   **Cancel slot** button. Nothing is dialled yet.
5. Show the **Phone Screening tab** badge and the **Today → Scheduled** item while
   waiting.
6. At the exact minute, QStash delivers one message and the call is placed once.
   Status moves to `calling`, then to the normal completed / incomplete outcome.
   Point out that this works even outside 10:00–19:00 IST because HR already has
   consent — automatic retries and the watchdog still obey the window.
7. To show cancellation, book a second test slot and click **Cancel slot** before
   it is due. Toast: **“Slot cancelled — no call will be placed.”** Once a call is
   live, cancellation is refused by design.
8. After the call:
   - connected + complete → normal review/decide item;
   - connected but thin → **Needs review — incomplete screening**, no score or fit;
   - no answer/busy → **No answer — re-slot needed** and the existing WhatsApp
     re-slot template goes out.

## Guardrails to call out in the demo

- One active slot per candidate: a second booking gets a conflict, not two calls.
- 5-minute minimum lead, 7-day maximum horizon (QStash ceiling).
- Attempt budget is unchanged; an attempt is spent when the provider accepts the
  call, not when HR books it.
- The booked time is stored as a UTC instant plus `Asia/Kolkata`; UI always shows IST.
- Every booking and cancellation is written to the candidate thread/timeline with
  who did it and why.
- A candidate-requested WhatsApp slot and an automatic retry still work exactly
  as before; this is a separate HR-authored path.

## Ready-to-send team message

> **New: HR-booked exact-time AI screening calls**
>
> If you speak to a candidate yourself and they suggest a specific time for the
> AI screening, you can now book that exact time in the admin portal instead of
> tracking it in Excel.
>
> **How to use**
> 1. Call the candidate and get a clear "yes" for the exact time first.
> 2. Go to **Jobs → your job → Candidates**, find the candidate, click
>    **Schedule Call** next to **Nudge**. (Same button is in the screening
>    results sheet.)
> 3. Enter the time **in IST** (at least 5 minutes from now, up to 7 days ahead),
>    optionally paste the candidate's own words, and fill **Why this exact time**
>    with at least 10 characters. Click **Book exact slot**.
> 4. The row changes to **HR slot · <time> IST · your name** and **Today** shows
>    **Scheduled**. The AI call fires once at that exact time — even outside
>    10:00–19:00 — because you already have the candidate's consent.
> 5. If plans change, click **Cancel slot** before the time. Once the call is
>    live it cannot be cancelled.
>
> **Rules**
> - Get consent before booking. Never schedule someone who did not agree.
> - Only one future slot per candidate; book again only after a miss or cancel.
> - If the call is incomplete, the card says **Needs review — incomplete
>   screening** with no score/fit. Do not treat it as a finished screening.
> - If nobody answers, the card says **No answer — re-slot needed**; the normal
>   WhatsApp re-slot message goes to the candidate.
> - Automatic retries still call only between 10:00 and 19:00 IST. HR-booked
>   slots are the only exception, because you have explicit consent.
>
> To pause the whole feature, ask Eng to remove the two flags and redeploy — no
> code change needed.
