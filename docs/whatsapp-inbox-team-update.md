# WhatsApp inbox — team update

Two changes shipped to the admin portal (`admin.gatihire.com`). This doc has a
ready-to-paste Google Chat message plus the detail behind it.

---

## 1. Google Chat message (copy & paste)

> 🚀 **New: WhatsApp inbox, and reply alerts that don't miss anything**
>
> **Where:** there's a new **WhatsApp** item in the left sidebar (with an unread badge). Also on the **Today** board.
>
> **What it is:** one row per candidate conversation, newest first, grouped into chips:
> • *Needs a human* — they asked for a call, or the AI handed it to a person
> • *Needs reply* — they messaged us and we haven't answered yet
> • *Declined* — not interested
> • *No reply* — we messaged, they went quiet
> • *All*
>
> **What you do from a row:**
> • **Open** → the full conversation (live, updates as messages come in)
> • **Nudge** → send a WhatsApp follow-up
> • **Call now** → start a call
> • **⋯ → Open job** → jump to that candidate on the job
>
> **Also:** the **Today** board now shows **Replied**, **Declined** and **No reply** at **every stage** — not just during AI screening — so a reply that lands after shortlisting no longer slips through.
>
> Search by candidate, role or client. Counts update live.

---

## 2. What changed

### Change 1 — Replies surface at every stage, plus a WhatsApp inbox

**Before:** reply detection only ran during the AI screening step. A candidate
who replied later — at shortlist, interview or offer — appeared nowhere in
**Today**. And a `not_interested` reply produced no row at all. There was also no
single place to see WhatsApp conversations.

**Now:**

- **Today** shows **Replied**, **Declined** and **No reply** rows at *every*
  active stage, not just `ai_screen`. A live call still takes priority.
- **"Replied" now means *unanswered*.** Previously any reply text counted, even
  after we'd already answered — so the row stuck around until the stage moved.
  It now compares the last inbound message against our last outbound one, and
  clears the moment we reply.
- **Manual messages count.** Sending a message or a call nudge by hand now
  records the outbound time, exactly like the automated senders already did.
- **New `Declined` work-item kind** for `not_interested` replies.
- **New `/whatsapp` inbox** — one row per *conversation* (not per application),
  because a candidate can be chatting on a thread with no live application. It
  reuses the same conversation viewer as the board and updates live.

### Change 2 — Inbox performance (scalable)

**Before:** the inbox and the sidebar badge classified every candidate record in
the app on **every** page load, and sent the whole list even though the screen
only shows a page. That got slower as the data grew.

**Now:** the classification and counts run in the database (Postgres view +
function), so the inbox:

- loads **a page at a time** ("Load more") instead of everything,
- **filters and searches server-side** (candidate / role / client),
- reads the chip and sidebar counts as **a single fast query**, and
- the sidebar badge is cached for a minute so navigating doesn't re-run it.

No user-visible behaviour change — just a lot less work per page view.

Applied migration: `supabase/migrations/20261016_whatsapp_inbox.sql`.

---

## 3. How to use it (day to day)

1. **Start the day on `/today`.** Work the **Replied** and **Declined** rows
   first — they're the candidates actively waiting.
2. **Check the WhatsApp item** in the sidebar. The badge is the number of
   conversations still waiting on us. Tap it to open the inbox.
3. Open the **Needs a human** chip first — these are candidates who asked for a
   call or were handed over by the AI.
4. For each row: **Open** to read the thread, then **Nudge** or **Call now**.
   Answering a *Needs reply* thread clears it from the list automatically.
5. Use the **search** box to find a candidate, job or client across all threads.
6. If a candidate declines, they land in **Declined** — no need to hunt for them.

**Rules of thumb**

- If it's in **Needs reply**, they're waiting on us — answer it.
- **Needs a human** = a person, not a template.
- **No reply** is going cold — a nudge or a call usually revives it.
- **Declined** is a done deal; stop chasing.
