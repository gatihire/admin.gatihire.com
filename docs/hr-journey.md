# HR Recruiter Journey — Complete Guide

> End-to-end walkthrough of how a recruiter uses the GatiHire admin portal, from client onboarding to hire.

---

## 1. Client Onboarding

### Creating a Client
1. Navigate to **Clients → New Client**
2. Fill in:
   - Company name (e.g., "SureShip.in")
   - Industry (e.g., Transportation & Fleet)
   - Sub-category (e.g., Car Carrier, 3PL, Warehousing)
   - Website
   - Primary contact (name, email, phone)
3. Click **Search Company** to auto-generate a candidate-friendly description from the website
4. Save — client now appears in the Clients list

### Client Profile
- View company logo, website, about section, and contact details
- Track active jobs, total hires, and client health score
- Edit client details at any time

---

## 2. Job Creation

### Creating a Job Opening
1. Navigate to **Jobs → New Job**
2. Fill in:
   - **Job Title** (e.g., "Corporate Relationship Manager")
   - **Industry + Sub-category** (e.g., Transportation & Fleet → Logistics Sales)
   - **Location** (city, state)
   - **Employment type** (full-time, contract, etc.)
   - **Salary range** (min/max, monthly/yearly)
   - **Experience range** (min/max years)
   - **Skills** — must-have and good-to-have (from suggested tags)
   - **Description** — full JD text
3. Click **Generate with AI** to auto-create a JD based on title, skills, and similar candidates in the database
4. Save — the job is now open and matching begins automatically

### What Happens After Saving
- The system extracts structured criteria from the JD (title, skills, experience, location)
- A vector embedding is generated for semantic search
- DB matching runs against the entire candidate database
- Candidates are scored and ranked by fit percentage

---

## 3. Sourcing Candidates

There are four ways to source candidates for a job:

### 3a. DB Matches (AI Matching)
The system automatically scores every candidate in the database against the job requirements.

1. Open the job → **DB Matches** tab
2. View ranked candidates with fit percentages and score breakdowns
3. Use filters: tier (Excellent/Strong/Good/etc.), location, experience, callable-only
4. For each candidate, see:
   - Match percentage with breakdown (Role / Skills / Experience / Location)
   - AI Insight (on-demand Gemini analysis of CV vs JD fit)
   - Skills, experience, current role
5. Actions:
   - **WhatsApp** — send a WhatsApp nudge (candidate gets job context + "Call Me Now" button)
   - **Direct Call** — immediately trigger an AI screening call via Bolna
   - **Add to Pipeline** — skip screening, add directly to shortlist
   - **Reject** — remove from consideration

### 3b. Resume Upload (Inbound)
For candidates who applied on external job boards (Apna, Naukri, WorkIndia, etc.).

1. Open the job → click **Upload Resume** in the header
2. Select **Inbound** origin
3. Choose source: Apna / Naukri / WorkIndia / Portal / Other
4. Drag & drop resume files (PDF, DOCX, DOC, TXT — max 10MB each)
5. Each resume is:
   - Parsed via AI (extracts name, skills, experience, education, etc.)
   - Stored in Supabase Storage
   - Created as a candidate in the database (or updated if duplicate)
   - Linked to this job with `origin=inbound, source=<board>`
6. After upload, candidates appear in the Pipeline tab with "Applied" status

### 3c. Resume Upload (Outbound)
For sourced profiles from external databases or manually collected resumes.

1. Open the job → click **Upload Resume** in the header
2. Select **Outbound** origin
3. Choose source: Sourced Profile / Database Match
4. Drag & drop resume files
5. Each resume is:
   - Parsed, stored, and created as a candidate
   - Linked to this job with `origin=outbound, source=recruiter_upload`
6. After upload, candidates appear in the Pipeline tab

### 3d. Juicebox/LinkedIn Import
For premium LinkedIn search results.

1. Open the job → **DB Matches** tab → switch to **LinkedIn** sub-view
2. Click **Import JSON** (from Juicebox browser extension export)
3. Drop the `result.json` file
4. Profiles are imported with LinkedIn data (name, role, company, skills)
5. PeakAI enrichment adds phone numbers and emails
6. Candidates appear in the LinkedIn profiles list

---

## 4. AI Screening

### How It Works
1. Select candidates in the Pipeline or DB Matches tab
2. Choose screening mode:
   - **WhatsApp First** → sends a context message via WhatsApp, then calls if candidate opts in
   - **Direct Call** → Bolna AI immediately calls the candidate
3. The AI agent ("Bipul, Senior Talent Acquisition Specialist") screens the candidate:
   - Inbound intro: "Thank you for applying..."
   - Outbound intro: "We came across your profile..."
4. Asks JD-specific questions (experience, salary, notice period, availability)
5. Outputs a structured verdict:
   - **Score** (0-10)
   - **Recommendation**: Advance / Further Review / Not a Fit
   - **Key answers**: salary, notice period, experience
   - **Strengths and concerns**

### Screening Pipeline Stages
```
Applied → AI Screen → Pending HR Review → Shortlist → Client Review → Interview → Offer → Hired
```

### Sub-Filters in AI Screen
| Filter | Meaning |
|--------|---------|
| WhatsApp Sent | Context message sent, waiting for candidate response |
| To Call | Ready to be called |
| Calling | AI call in progress |
| **Awaiting Approval** | Call completed, recruiter needs to review AI results |
| Approved | Recruiter reviewed and approved |
| Declined | Recruiter rejected or candidate unreachable |

---

## 5. Pipeline Management

### Stage Transitions
- **Manual**: Use the stage dropdown on any candidate card
- **Bulk**: Select multiple candidates → move to a stage
- **Automatic**: AI screening completion moves candidates to "Awaiting Approval"

### Candidate Card Information
Each card shows:
- Name, current role, company, location
- Origin badge (Inbound/Outbound — clickable to re-tag)
- Call status badge (WhatsApp sent, Calling, Completed, etc.)
- Match score (for DB matches)
- AI verdict (for screened candidates)
- Actions: Nudge dropdown, stage selector

### Filtering
- **By stage**: All, Applied, AI Screen, Pending HR Review, Shortlist, Interview, Offer, Hired, Rejected
- **By origin**: All, Inbound, Outbound, Database, Board-app
- **By call status**: WhatsApp Sent, To Call, Calling, Awaiting Approval, Approved, Declined

---

## 6. Shortlist & Client Share

### Adding to Shortlist
1. Review candidates in "Pending HR Review" or "Awaiting Approval"
2. Approve promising candidates → they move to **Shortlist** stage
3. Shortlisted candidates are ready to share with the client

### Sharing with Client
1. Click **Share Shortlist** in the job header
2. The system:
   - Generates a unique tokenized link
   - Sends an email to the client with the link
   - CC's the GatiHire recruiter and account manager
3. The client sees a clean, branded page with:
   - Candidate names, roles, experience
   - AI screening summary (pros, concerns, recommendation)
   - Contact info (phone, email)
   - **Approve** / **Pass** buttons for each candidate

### Client Decisions
- Client approves → candidate moves to **Interview** stage
- Client passes → candidate is marked as rejected
- Recruiter can see all client decisions in real-time
- Resend link, add notes, or update the shortlist at any time

---

## 7. Interview & Offer

### Interview Management
1. After client approval, candidates appear in the **Interviews** tab
2. Track interview rounds (Round 1, Round 2, etc.)
3. Record status: Scheduled, Completed, Passed, Failed
4. Add notes and feedback after each round

### Offer Management
1. After successful interviews, move candidates to **Offer** stage
2. Track offer details (salary, start date, etc.)
3. Monitor offer acceptance

### Hiring
1. Once candidate accepts and joins, move to **Hired**
2. The hire is tracked in client analytics and recruiter metrics

---

## 8. Analytics & Metrics

### Recruiter Dashboard
- Total jobs, active jobs, hires this month
- Pipeline funnel (applied → screened → shortlisted → hired)
- Sourcing effectiveness (which boards produce the best candidates)
- AI screening accuracy (advance rate, not-a-fit rate)

### Per-Job Metrics
- Total candidates sourced (by origin)
- Screening completion rate
- Shortlist-to-client-approval ratio
- Time-to-hire

### Client Metrics
- Jobs posted, candidates reviewed, hires made
- Client satisfaction score
- Repeat business rate

---

## 9. WhatsApp & Call Flow

### WhatsApp Context Outreach
1. Recruiter selects candidates → "Start AI Calls" with WhatsApp toggle on
2. Aisensy sends a WhatsApp message with:
   - Job title, location, salary budget
   - "Call Me Now" / "Schedule" / "Not Interested" buttons
3. If candidate taps "Call Me Now" → Bolna calls immediately
4. If candidate taps "Schedule" → QStash schedules the call
5. If candidate taps "Not Interested" → marked as declined

### Direct Call Flow
1. Recruiter selects candidates → "Start AI Calls" with Direct mode
2. Bolna immediately calls the candidate
3. If no answer → retry at 15min, 60min (max 4 attempts)
4. If unreachable after retries → marked as "needs manual followup"

### Non-Responder Follow-Up
- t+4h: WhatsApp reminder nudge #1
- t+8h: Escalated to human recruiter queue (no more AI calls)

---

## 10. Rejection Handling

### Inbound Candidates
- When rejected, an automated email is sent:
  - "Thank you for applying to [Company]. Unfortunately, we've decided to move forward with other candidates..."
  - Professional, branded email

### Outbound Candidates
- No rejection email (they didn't apply — we reached out)
- Status updated silently in the system

---

## Quick Reference: Key Actions

| Action | Where | What Happens |
|--------|-------|-------------|
| Upload Resume | Job header → Upload Resume | Parse + create candidate + link to job |
| WhatsApp Nudge | DB Matches / Pipeline → WhatsApp | Send context message + opt-in call |
| Direct Call | DB Matches / Pipeline → Direct Call | Bolna calls immediately |
| Add to Pipeline | DB Matches → Add to Pipeline | Skip screening, go to shortlist |
| Approve | Pipeline → Awaiting Approval | Move to HR Review or Shortlist |
| Reject | Pipeline → any stage | Move to Rejected |
| Share Shortlist | Job header → Share Shortlist | Email client with tokenized link |
| Client Approve | Public shortlist link | Move candidate to Interview |
