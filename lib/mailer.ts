import nodemailer from "nodemailer"
import { ServerClient } from "postmark"

type SendInviteEmailInput = {
  to: string
  from: string
  subject: string
  jobTitle: string
  inviteLink: string
  candidateName?: string | null
  html?: string
  companyName?: string | null
  jobDescription?: string | null
  location?: string | null
  experience?: string | null
  compensation?: string | null
  clientName?: string | null
  phone?: string | null
  website?: string | null
}

type SendOutreachEmailInput = {
  to: string
  from: string
  subject: string
  jobTitle: string
  applyLink: string
  candidateName?: string | null
  matchScorePercent?: number | null
  matchedSkills?: string[] | null
  html?: string
}

type SendEmailInput = {
  to: string
  from: string
  subject: string
  html: string
  cc?: string[]
}

type SendClientShortlistEmailInput = {
  to: string
  cc?: string[]
  from: string
  subject: string
  clientName?: string | null
  jobTitle?: string | null
  location?: string | null
  candidates: Array<{
    name?: string | null
    currentRole?: string | null
    currentCompany?: string | null
    fitScore?: number | null
  }>
  notes?: string | null
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com"
  const port = Number(process.env.SMTP_PORT || 465)
  const secure = String(process.env.SMTP_SECURE || "true") === "true"
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  return { host, port, secure, user, pass }
}

function requireSmtpAuth() {
  const cfg = getSmtpConfig()
  if (!cfg.user || !cfg.pass) {
    throw new Error("Missing SMTP_USER/SMTP_PASS")
  }
  return cfg
}

function getPostmarkConfig() {
  const serverToken = process.env.POSTMARK_SERVER_TOKEN || ""
  const messageStream = process.env.POSTMARK_MESSAGE_STREAM || ""
  return { serverToken, messageStream }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

async function sendEmail(input: SendEmailInput) {
  const { serverToken, messageStream } = getPostmarkConfig()
  const smtpCfg = getSmtpConfig()
  if (smtpCfg.user && smtpCfg.pass) {
    const transporter = nodemailer.createTransport({
      host: smtpCfg.host,
      port: smtpCfg.port,
      secure: smtpCfg.secure,
      auth: { user: smtpCfg.user, pass: smtpCfg.pass }
    })

    const info = await transporter.sendMail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.cc?.length ? { cc: input.cc.join(", ") } : {})
    })

    return { messageId: info.messageId }
  }

  if (serverToken) {
    const client = new ServerClient(serverToken)
    const res = await client.sendEmail({
      From: input.from,
      To: input.to,
      Subject: input.subject,
      HtmlBody: input.html,
      ...(input.cc?.length ? { Cc: input.cc.join(", ") } : {}),
      MessageStream: messageStream || undefined
    })
    return { messageId: res.MessageID }
  }

  throw new Error("Missing SMTP_USER/SMTP_PASS and POSTMARK_SERVER_TOKEN")
}

export async function sendInviteEmail(input: SendInviteEmailInput) {
  const candidateGreeting = input.candidateName ? `Hi ${escapeHtml(input.candidateName)},` : "Hi,"
  const companyName = input.companyName || "Truckinzy"
  const expiryDate = new Date()
  expiryDate.setDate(expiryDate.getDate() + 7) // Expires in 7 days
  const formattedExpiry = expiryDate.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })

  // Extract 1-2 lines from job description
  let jobDescriptionSnippet = ""
  if (input.jobDescription) {
    const sentences = input.jobDescription.trim().split(/(?<=[.!?])\s+/).filter(s => s.length > 0)
    if (sentences.length > 0) {
      jobDescriptionSnippet = sentences.slice(0, 2).map(s => s.trim()).join(" ")
      if (jobDescriptionSnippet.length > 250) {
        jobDescriptionSnippet = jobDescriptionSnippet.substring(0, 247) + "..."
      }
    }
  }

  const defaultHtml = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Job Invite from ${escapeHtml(companyName)}</title>
    <style>
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        line-height: 1.6;
        color: #111827;
        background-color: #f9fafb;
        margin: 0;
        padding: 20px;
      }
      .container {
        max-width: 600px;
        margin: 0 auto;
        background-color: #ffffff;
        padding: 40px;
        border-radius: 12px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      }
      .header {
        margin-bottom: 24px;
      }
      .greeting {
        font-size: 18px;
        font-weight: 600;
        margin: 0 0 16px;
      }
      .lead {
        font-size: 16px;
        margin: 0 0 20px;
      }
      .snippet {
        background-color: #f3f4f6;
        padding: 16px;
        border-radius: 8px;
        margin: 0 0 24px;
      }
      .details {
        margin: 0 0 28px;
      }
      .detail-row {
        display: flex;
        gap: 8px;
        margin: 8px 0;
      }
      .detail-label {
        font-weight: 600;
        color: #4b5563;
        min-width: 100px;
      }
      .cta {
        display: inline-block;
        background-color: #4a6cf7;
        color: #ffffff !important;
        text-decoration: none !important;
        padding: 14px 32px;
        border-radius: 8px;
        font-size: 16px;
        font-weight: 600;
        margin: 0 0 20px;
      }
      .link-fallback {
        font-size: 14px;
        color: #6b7280;
        margin: 0 0 8px;
      }
      .link-url {
        color: #4a6cf7;
        word-break: break-all;
        font-size: 14px;
      }
      .expiry {
        margin: 20px 0;
        padding: 16px;
        background-color: #fff3cd;
        border-radius: 8px;
        border: 1px solid #ffc107;
      }
      .footer {
        margin-top: 32px;
        padding-top: 24px;
        border-top: 1px solid #e5e7eb;
      }
      .signature {
        margin: 0 0 8px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <p class="greeting">${candidateGreeting}</p>
      </div>
      <p class="lead">
        We came across your profile and were impressed by your background — it closely matches what we're looking for in our <strong>${escapeHtml(input.jobTitle)}</strong> role at <strong>${escapeHtml(companyName)}</strong>.
      </p>
      <p class="lead">
        A quick snapshot of the role:
      </p>
      ${jobDescriptionSnippet ? `
        <div class="snippet">
          ${escapeHtml(jobDescriptionSnippet)}
        </div>
      ` : ""}
      <div class="details">
        ${input.location ? `
          <div class="detail-row">
            <span class="detail-label">Location:</span>
            <span>${escapeHtml(input.location)}</span>
          </div>
        ` : ""}
        ${input.experience ? `
          <div class="detail-row">
            <span class="detail-label">Experience:</span>
            <span>${escapeHtml(input.experience)}</span>
          </div>
        ` : ""}
        ${input.compensation ? `
          <div class="detail-row">
            <span class="detail-label">Compensation:</span>
            <span>${escapeHtml(input.compensation)}</span>
          </div>
        ` : ""}
      </div>
      <p style="margin: 0 0 16px;">
        If this sounds like the right fit, we'd love to hear from you. Applying takes less than 2 minutes:
      </p>
      <a href="${escapeHtml(input.inviteLink)}" class="cta">
        View Invite & Apply
      </a>
      <p class="link-fallback">If the button doesn't work, copy and paste this link into your browser:</p>
      <p class="link-url">${escapeHtml(input.inviteLink)}</p>
      <div class="expiry">
        This invitation is exclusive to you and expires on <strong>${escapeHtml(formattedExpiry)}</strong>, so don't wait too long!
      </div>
      <p style="margin: 0 0 24px;">
        Have questions before applying? Just reply to this email — we're happy to help.
      </p>
      <div class="footer">
        <p class="signature">Warm regards,</p>
        ${input.clientName ? `<p class="signature">${escapeHtml(input.clientName)}</p>` : ""}
        <p class="signature">Hiring Team, ${escapeHtml(companyName)}</p>
        ${input.phone || input.website ? `
          <p style="margin: 8px 0 0; font-size: 14px; color: #6b7280;">
            ${input.phone ? `Phone: ${escapeHtml(input.phone)}` : ""}
            ${input.phone && input.website ? " | " : ""}
            ${input.website ? `<a href="${escapeHtml(input.website)}" style="color: #4a6cf7; text-decoration: none;">${escapeHtml(input.website)}</a>` : ""}
          </p>
        ` : ""}
      </div>
    </div>
  </body>
  </html>
  `.trim()

  let html = (input.html || "").trim()
  if (!html) {
    html = defaultHtml
  } else if (!html.includes(input.inviteLink)) {
    html = `
      ${html}
      <div style="margin-top:16px;color:#6b7280;font-size:13px">
        <p style="margin:0 0 4px;">If the button doesn’t work, copy and paste this link:</p>
        <p style="margin:0;color:#374151;word-break:break-all">${escapeHtml(input.inviteLink)}</p>
      </div>
    `.trim()
  }

  return sendEmail({ to: input.to, from: input.from, subject: input.subject, html })
}

export async function sendOutreachEmail(input: SendOutreachEmailInput) {
  const candidateLine = input.candidateName ? `Hi ${escapeHtml(input.candidateName)},` : "Hi,"
  const skills = Array.isArray(input.matchedSkills) ? input.matchedSkills.filter(Boolean).slice(0, 6) : []
  const score = typeof input.matchScorePercent === "number" ? input.matchScorePercent : null

  const defaultHtml = `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.5;color:#111827">
    <p style="margin:0 0 16px">${candidateLine}</p>
    <p style="margin:0 0 12px">We found a role that matches your profile: <strong>${escapeHtml(input.jobTitle)}</strong>.</p>
    ${score !== null ? `<p style="margin:0 0 12px;color:#374151">Match score: <strong>${escapeHtml(String(score))}%</strong></p>` : ""}
    ${skills.length ? `<p style="margin:0 0 16px;color:#374151">Relevant skills: <strong>${escapeHtml(skills.join(", "))}</strong></p>` : ""}
    <p style="margin:0 0 18px">
      <a href="${escapeHtml(input.applyLink)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:9999px">
        Apply now
      </a>
    </p>
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px">If the button doesn’t work, copy and paste this link:</p>
    <p style="margin:0;color:#374151;font-size:13px;word-break:break-all">${escapeHtml(input.applyLink)}</p>
  </div>
  `.trim()

  let html = (input.html || "").trim()
  if (!html) {
    html = defaultHtml
  } else if (!html.includes(input.applyLink)) {
    html = `
      ${html}
      <div style="margin-top:16px;color:#6b7280;font-size:13px">
        <p style="margin:0 0 4px;">If the button doesn’t work, copy and paste this link:</p>
        <p style="margin:0;color:#374151;word-break:break-all">${escapeHtml(input.applyLink)}</p>
      </div>
    `.trim()
  }

  return sendEmail({ to: input.to, from: input.from, subject: input.subject, html })
}

export async function sendRejectionEmail(input: {
  to: string
  from: string
  subject: string
  candidateName?: string | null
  jobTitle?: string | null
  companyName?: string | null
  rejectionReason?: string | null
  html?: string
}) {
  const candidateGreeting = input.candidateName ? `Hi ${escapeHtml(input.candidateName)},` : "Hi,"
  const jobRef = input.jobTitle ? ` for the <strong>${escapeHtml(input.jobTitle)}</strong> position` : ""
  const companyRef = input.companyName ? ` at <strong>${escapeHtml(input.companyName)}</strong>` : ""
  const reasonText = input.rejectionReason ? `<p style="margin:0 0 12px;color:#374151">Reason: <strong>${escapeHtml(input.rejectionReason)}</strong></p>` : ""

  const defaultHtml = `
  <!DOCTYPE html>
  <html>
  <body style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.5;color:#111827;background:#f9fafb;padding:24px">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <p style="margin:0 0 16px">${candidateGreeting}</p>
      <p style="margin:0 0 12px">Thank you for your interest in the role${jobRef}${companyRef}.</p>
      <p style="margin:0 0 12px">After careful consideration, we regret to inform you that we will not be moving forward with your application at this time.</p>
      ${reasonText}
      <p style="margin:0 0 16px">We appreciate the time you invested in the process and wish you the very best in your job search and future endeavors.</p>
      <p style="margin:0;color:#6b7280;font-size:13px">This is an automated message from GatiHire. Please do not reply directly to this email.</p>
    </div>
  </body>
  </html>
  `.trim()

  let html = (input.html || "").trim()
  if (!html) html = defaultHtml

  return sendEmail({ to: input.to, from: input.from, subject: input.subject, html })
}

export async function sendClientShortlistEmail(input: SendClientShortlistEmailInput) {
  const clientName = input.clientName || "the client"
  const jobTitle = input.jobTitle || "the role"
  const rows = input.candidates
    .map((c) => {
      const role = [c.currentRole, c.currentCompany].filter(Boolean).join(" at ")
      const score = typeof c.fitScore === "number" ? ` &nbsp;&middot;&nbsp; <strong>Fit ${c.fitScore}/100</strong>` : ""
      return `<li style="margin:8px 0"><strong>${escapeHtml(c.name || "Candidate")}</strong>${role ? ` &mdash; ${escapeHtml(role)}` : ""}${score}</li>`
    })
    .join("")

  const defaultHtml = `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.5;color:#111827;max-width:620px">
    <p style="margin:0 0 16px">Hi ${escapeHtml(clientName)},</p>
    <p style="margin:0 0 16px">
      Here is the shortlist for the <strong>${escapeHtml(jobTitle)}</strong>${input.location ? ` (${escapeHtml(input.location)})` : ""}.
      Each candidate has cleared our AI screening round and is ready for the next interview round.
    </p>
    <ol style="margin:0 0 16px;padding-left:20px">${rows}</ol>
    ${input.notes ? `<p style="margin:0 0 16px;color:#374151">${escapeHtml(input.notes)}</p>` : ""}
    <p style="margin:0 0 8px">Review the profiles and share your approval to proceed with interviews.</p>
    <p style="margin:0;color:#6b7280;font-size:13px">This email was sent by your Tzy recruitment partner. Your Account Manager and Tzy Recruiter are copied for continuity.</p>
  </div>
  `.trim()

  return sendEmail({
    to: input.to,
    from: input.from,
    subject: input.subject,
    html: defaultHtml,
    cc: input.cc,
  })
}
