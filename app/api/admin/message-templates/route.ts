import { NextRequest, NextResponse } from "next/server"
import { getInternalAuthContext, hasPermission } from "@/lib/internal-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { DEFAULT_TEMPLATES, TemplateKey, mergeTemplates } from "@/lib/message-templates"

const TEMPLATE_KEYS: TemplateKey[] = ["invite_email", "outreach_email", "invite_whatsapp", "outreach_whatsapp"]

function getChannel(key: TemplateKey) {
  return key.includes("email") ? "email" : "whatsapp"
}

export async function GET(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { data, error } = await supabaseAdmin
    .from("message_templates")
    .select("template_key, channel, subject, body, metadata")
    .in("template_key", TEMPLATE_KEYS)

  if (error) return NextResponse.json({ error: error.message || "Failed to load templates" }, { status: 500 })

  const templates = mergeTemplates(Array.isArray(data) ? data : [])
  return NextResponse.json({ templates })
}

export async function PUT(request: NextRequest) {
  const ctx = await getInternalAuthContext(request)
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hasPermission(ctx, "users.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const templates = Array.isArray(body?.templates) ? body.templates : null
  if (!templates) return NextResponse.json({ error: "templates is required" }, { status: 400 })

  const now = new Date().toISOString()
  const rows = templates
    .map((t: any) => {
      const key = String(t?.templateKey || "") as TemplateKey
      if (!TEMPLATE_KEYS.includes(key)) return null
      const bodyText = typeof t?.body === "string" ? t.body.trim() : ""
      if (!bodyText) return null
      const subject = typeof t?.subject === "string" ? t.subject.trim() : null
      const metadata = t?.metadata && typeof t.metadata === "object" ? t.metadata : null
      return {
        template_key: key,
        channel: getChannel(key),
        subject: getChannel(key) === "email" ? subject || DEFAULT_TEMPLATES[key].subject : null,
        body: bodyText,
        metadata: metadata || DEFAULT_TEMPLATES[key].metadata || {},
        updated_at: now
      }
    })
    .filter(Boolean)

  if (rows.length === 0) return NextResponse.json({ error: "No valid templates provided" }, { status: 400 })

  const { error } = await supabaseAdmin.from("message_templates").upsert(rows, { onConflict: "template_key" })
  if (error) return NextResponse.json({ error: error.message || "Failed to save templates" }, { status: 500 })

  const { data: saved } = await supabaseAdmin
    .from("message_templates")
    .select("template_key, channel, subject, body, metadata")
    .in("template_key", TEMPLATE_KEYS)

  const merged = mergeTemplates(Array.isArray(saved) ? saved : [])
  return NextResponse.json({ templates: merged })
}
