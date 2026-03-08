import { supabaseAdmin } from "@/lib/supabase"

export type TemplateKey = "invite_email" | "outreach_email" | "invite_whatsapp" | "outreach_whatsapp"

type TemplateChannel = "email" | "whatsapp"

type TemplateMetadata = {
  campaignName?: string
  paramOrder?: string[]
}

export type MessageTemplate = {
  templateKey: TemplateKey
  channel: TemplateChannel
  subject?: string | null
  body: string
  metadata?: TemplateMetadata | null
}

const DEFAULT_INVITE_EMAIL_BODY = `
<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.5;color:#111827">
  <p style="margin:0 0 16px">Hi {{candidate_name}},</p>
  <p style="margin:0 0 16px">You’ve been invited to apply for <strong>{{job_title}}</strong> at {{company_name}}.</p>
  <p style="margin:0 0 18px">
    <a href="{{invite_link}}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:9999px">
      View invite & apply
    </a>
  </p>
  <p style="margin:0 0 8px;color:#6b7280;font-size:13px">If the button doesn’t work, copy and paste this link:</p>
  <p style="margin:0;color:#374151;font-size:13px;word-break:break-all">{{invite_link}}</p>
</div>
`.trim()

const DEFAULT_OUTREACH_EMAIL_BODY = `
<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.5;color:#111827">
  <p style="margin:0 0 16px">Hi {{candidate_name}},</p>
  <p style="margin:0 0 12px">We found a role that matches your profile: <strong>{{job_title}}</strong> at {{company_name}}.</p>
  <p style="margin:0 0 12px;color:#374151">Match score: <strong>{{match_score}}</strong></p>
  <p style="margin:0 0 16px;color:#374151">Relevant skills: <strong>{{skills}}</strong></p>
  <p style="margin:0 0 18px">
    <a href="{{apply_link}}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:9999px">
      Apply now
    </a>
  </p>
  <p style="margin:0 0 8px;color:#6b7280;font-size:13px">If the button doesn’t work, copy and paste this link:</p>
  <p style="margin:0;color:#374151;font-size:13px;word-break:break-all">{{apply_link}}</p>
</div>
`.trim()

const DEFAULT_INVITE_WHATSAPP_BODY = `
Hi {{candidate_name}},

You’ve been invited to apply for {{job_title}} at {{company_name}}.

Apply here: {{invite_link}}
`.trim()

const DEFAULT_OUTREACH_WHATSAPP_BODY = `
Hi {{candidate_name}},

We found a role that matches your profile: {{job_title}} at {{company_name}}.

Match score: {{match_score}}
Relevant skills: {{skills}}

Apply here: {{apply_link}}
`.trim()

const DEFAULT_PARAM_ORDER = ["candidate_name", "job_title", "company_name", "invite_link"]
const DEFAULT_OUTREACH_PARAM_ORDER = ["candidate_name", "job_title", "company_name", "match_score", "skills", "apply_link"]

export const DEFAULT_TEMPLATES: Record<TemplateKey, MessageTemplate> = {
  invite_email: {
    templateKey: "invite_email",
    channel: "email",
    subject: "Truckinzy: Invitation to apply — {{job_title}}",
    body: DEFAULT_INVITE_EMAIL_BODY,
    metadata: null
  },
  outreach_email: {
    templateKey: "outreach_email",
    channel: "email",
    subject: "Truckinzy: Apply for {{job_title}}",
    body: DEFAULT_OUTREACH_EMAIL_BODY,
    metadata: null
  },
  invite_whatsapp: {
    templateKey: "invite_whatsapp",
    channel: "whatsapp",
    subject: null,
    body: DEFAULT_INVITE_WHATSAPP_BODY,
    metadata: { paramOrder: DEFAULT_PARAM_ORDER }
  },
  outreach_whatsapp: {
    templateKey: "outreach_whatsapp",
    channel: "whatsapp",
    subject: null,
    body: DEFAULT_OUTREACH_WHATSAPP_BODY,
    metadata: { paramOrder: DEFAULT_OUTREACH_PARAM_ORDER }
  }
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function renderTemplate(template: string, variables: Record<string, string>, escape = false) {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => {
    const raw = variables[key] ?? ""
    const value = escape ? escapeHtml(String(raw)) : String(raw)
    return value
  })
}

export function buildTemplateParams(order: string[] | null | undefined, variables: Record<string, string>) {
  const keys = Array.isArray(order) && order.length ? order : DEFAULT_PARAM_ORDER
  return keys.map((key) => String(variables[key] ?? ""))
}

export function mergeTemplates(rows: Array<any>) {
  const merged: Record<TemplateKey, MessageTemplate> = {
    invite_email: { ...DEFAULT_TEMPLATES.invite_email },
    outreach_email: { ...DEFAULT_TEMPLATES.outreach_email },
    invite_whatsapp: { ...DEFAULT_TEMPLATES.invite_whatsapp },
    outreach_whatsapp: { ...DEFAULT_TEMPLATES.outreach_whatsapp }
  }

  for (const row of rows || []) {
    const key = row?.template_key as TemplateKey
    if (!key || !merged[key]) continue
    const base = merged[key]
    merged[key] = {
      templateKey: key,
      channel: row?.channel || base.channel,
      subject: typeof row?.subject === "string" ? row.subject : base.subject,
      body: typeof row?.body === "string" && row.body.trim() ? row.body : base.body,
      metadata: row?.metadata && typeof row.metadata === "object" ? row.metadata : base.metadata
    }
  }

  return merged
}

export async function loadMessageTemplates() {
  const { data } = await supabaseAdmin.from("message_templates").select("template_key, channel, subject, body, metadata")
  return mergeTemplates(Array.isArray(data) ? data : [])
}

export function getDefaultParamOrder(templateKey: TemplateKey) {
  return templateKey === "outreach_whatsapp" ? DEFAULT_OUTREACH_PARAM_ORDER : DEFAULT_PARAM_ORDER
}
