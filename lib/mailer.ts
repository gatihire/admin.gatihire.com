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
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
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
      html: input.html
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
      MessageStream: messageStream || undefined
    })
    return { messageId: res.MessageID }
  }

  throw new Error("Missing SMTP_USER/SMTP_PASS and POSTMARK_SERVER_TOKEN")
}

export async function sendInviteEmail(input: SendInviteEmailInput) {
  const candidateLine = input.candidateName ? `Hi ${escapeHtml(input.candidateName)},` : "Hi,"

  const defaultHtml = `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.5;color:#111827">
    <p style="margin:0 0 16px">${candidateLine}</p>
    <p style="margin:0 0 16px">You’ve been invited to apply for <strong>${escapeHtml(input.jobTitle)}</strong> at Truckinzy.</p>
    <p style="margin:0 0 18px">
      <a href="${escapeHtml(input.inviteLink)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:9999px">
        View invite & apply
      </a>
    </p>
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px">If the button doesn’t work, copy and paste this link:</p>
    <p style="margin:0;color:#374151;font-size:13px;word-break:break-all">${escapeHtml(input.inviteLink)}</p>
  </div>
  `.trim()

  let html = (input.html || "").trim()
  if (!html) {
    html = defaultHtml
  } else if (!html.includes(input.inviteLink)) {
    // Ensure there is always at least a plain-text link fallback, even if the template omitted it.
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
