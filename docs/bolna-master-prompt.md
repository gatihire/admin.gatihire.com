# Superseded — see `docs/screener-prompt.md`

This file held a copy of the screening-call prompt. It now points at
**[`docs/screener-prompt.md`](./screener-prompt.md)**, which is the readable form
of the live constants in `lib/bolna.ts`.

> **The Bolna dashboard overrides code.** A prompt pasted into the agent on the
> Bolna dashboard wins over anything in `lib/bolna.ts`, so after changing the
> prompt you must also re-push it — `POST /api/bolna/agent` recreates or updates
> the agent with the current constants. Until that call is made, the agent keeps
> running whatever text is stored on the dashboard.

Keep only one copy of the prompt in the repo. Edit `lib/bolna.ts`, then sync
`docs/screener-prompt.md`.
