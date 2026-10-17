# Team update — the Today board & the WhatsApp inbox

Two things are now live in the admin portal (`admin.gatihire.com`). This doc has
ready-to-paste Google Chat messages, then what each thing is and how to use it.

---

## 1. Google Chat messages (copy & paste)

These are written as instructions — the reader can follow them top to bottom
without any training.

### Message A — how to use the Today board

> 📋 **Your day now starts on the *Today* page**
>
> Open the new **Today** tab at the top of the left sidebar. It's one list of everything that needs **you** today — most urgent first. Here's all you do:
>
> **1. Look at the chips across the top.** Start with the red ones — *Needs a human* and *Replied*. A real person is waiting on us there. (*No reply*, *Declined* and the rest are quieter — get to them after.)
>
> **2. Press the blue button on the row.** It's already the next step — *Take over*, *Nudge on WhatsApp*, *Open conversation*, *Send to the client*, *Schedule interview*… Just follow it.
>
> **3. Not now?** Open the **⋯** menu on the row → *Snooze*. It'll come back later. Nothing gets lost.
>
> **4. Same job, lots of people?** Tick several rows → *Nudge on WhatsApp* / *Snooze 1 day* — one click for all of them.
>
> **5. Done = gone.** When you act, the row clears itself. When the list is empty, you're caught up. 🎉
>
> **Admins only:** use the switch at the top right to see **My accounts** (just yours) or the whole **Team**.

### Message B — how to use the WhatsApp inbox

> 💬 **The new WhatsApp inbox — where you answer candidates**
>
> Look for **WhatsApp** in the left sidebar. **The number on it = how many people are still waiting on a reply from us.** Aim to get it to zero.
>
> **1. Click it.** Newest conversations are at the top.
>
> **2. Open the *Needs a human* chip first** — these are people who asked for a call, or that the AI handed to a person.
>
> **3. Click *Open* on a row** to read the whole conversation, then hit **Nudge** to send a quick WhatsApp follow-up, or **Call now**.
>
> **4. That's it — answering clears the thread.** Nothing to "mark as read".
>
> **5. Can't find someone?** Use the **search** box (name, job or client).
>
> **Also new:** the **Today** page now shows **Replied / Declined / No reply** at *every* stage — so a reply that comes in after shortlisting no longer gets missed.

---

## 2. The Today board (`/today`)

**What it is.** One queue of everything the pipeline says needs a human, most
urgent first — owned candidates for your role, or the whole team's if you're an
admin. It replaces scanning each pipeline column looking for the next thing.

**How to use it**

1. Open **Today** in the sidebar.
2. Read the header — *"N items need you across M open jobs."*
3. Use the **chips** to focus. Start with **Needs a human** and **Replied** —
   those are people actively waiting on us.
4. On each row, hit the **primary button** (the next step), or open **⋯** for
   *log a call*, *snooze*, etc.
5. Tick several rows to act in bulk: **Nudge on WhatsApp**, **Snooze 1 day**, or
   (admins) **Drop**.
6. Tick **Show snoozed** if you want to see things you've parked.

**What's on the page**

- **Stat strip:** Waiting on you · Candidates · Shortlisted or later · Hired.
- **Chips** (only kinds with work show): Needs a human, No reply, Replied,
  Declined, AI flagged, Calls to review, Reschedule, Ready to send, Client
  approved, Client overdue, Offers.
- **Rows** carry small pills for context — *Nudged*, *Calls 2*, *AI 7/10*, a
  recommendation.
- **Right rail:** Interviews this week · Ready to send to the client · On the line.

**Rules of thumb**

- **Needs a human** = a person, not a template.
- **Replied** = answer it; it clears itself once you reply.
- **No reply** = going cold; a nudge or a call usually revives it.
- **Declined** = done; stop chasing.

---

## 3. The WhatsApp inbox (`/whatsapp`)

**What it is.** One row per conversation (a candidate thread), not per
application — because a candidate can be talking to us on a thread with no live
application. Same conversation viewer as the board, live via Realtime.

**How to use it**

1. Watch the **badge** on the sidebar **WhatsApp** item — it's the number of
   threads still waiting on us.
2. Open it and work **Needs a human** first (a person asked for a call, or the AI
   handed it over).
3. Per row: **Open** to read the thread, then **Nudge** or **Call now**.
   Answering a *Needs reply* thread clears it automatically.
4. **Search** by candidate, role or client across all threads.
5. **Load more** at the bottom to page through older threads.

**Note:** *unread* means *still waiting on us* — it clears itself when we reply,
so there's nothing to mark as read.

---

## 4. For reference — what changed under the hood

**Replies now surface at every stage.** Before, reply detection only ran during
AI screening, so a reply that landed at shortlist / interview / offer appeared
nowhere, and a `not_interested` reply produced no row at all. Now **Today** shows
Replied / Declined / No reply at every active stage (a live call still wins).

**"Replied" now means *unanswered*** — it compares the candidate's last message
against our last outbound one and clears the moment we reply (previously any
reply text kept the row until the stage moved).

**Manual sends are tracked** — sending a message or a call nudge by hand now
records the outbound time, like the automated senders already did.

**Scalable inbox** — classification and counts run in Postgres (a view +
function), so the inbox pages, filters and searches server-side, the sidebar
count is one fast query, and the badge is cached for a minute. No visible change,
just far less work per page view. Migration:
`supabase/migrations/20261016_whatsapp_inbox.sql` (applied).
