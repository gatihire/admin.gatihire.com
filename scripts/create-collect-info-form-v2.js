// Creates the 5-field candidate details flow + its WhatsApp template and submits
// both to Meta for review.
//
// Why v2 exists: the 7-field form asked the candidate to confirm total experience
// and current location, which we already take from the resume and trust. Asking
// them created friction and inflated the "collected on WhatsApp" count with data
// the candidate was never asked for. v2 asks only the five fields we actually
// need confirmed, and is wired to fall back to the approved 7-field template
// (collect_info_form) until Meta approves it — see lib/whatsapp.ts
// sendCollectInfoForm().
//
// Usage:
//   node --env-file=.env.local scripts/create-collect-info-form-v2.js
//
// The flow JSON is also written to scripts/collect-info-form-v2.flow.json so the
// screen copy can be reviewed/edited before submitting.

const fs = require("node:fs")
const path = require("node:path")

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "1292918636194299"
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0"
const FLOW_NAME = "truckinzy_candidate_screening_v2"
const TEMPLATE_NAME = "collect_info_form_v2"
// 7.3 is Meta's recommended version and the one this WABA's existing flow uses.
// 3.0 and below are frozen — Meta rejects publishing them outright.
const FLOW_JSON_VERSION = process.env.WHATSAPP_FLOW_JSON_VERSION || "7.3"

if (!TOKEN) {
  console.error("WHATSAPP_ACCESS_TOKEN is required (node --env-file=.env.local ...)")
  process.exit(1)
}

const graph = (url, init) =>
  fetch(`https://graph.facebook.com/${API_VERSION}${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  })

// Five fields, one screen. Keys match CandidateInfo exactly, which is why the
// webhook can trust an nfm_reply submission without any Gemini extraction.
// Flow JSON 7.3 component/property names. Note the kebab-case property keys
// ("input-type", "data-source", "on-click-action") and the TextInput/TextArea
// component names — the older InputField/data_source/on_click_action spellings
// were renamed and are rejected on 6.x+.
const FLOW_JSON = {
  version: FLOW_JSON_VERSION,
  screens: [
    {
      id: "DETAILS_SCREEN",
      title: "Your details",
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "TextHeading",
            text: "Quick details",
          },
          {
            type: "TextBody",
            text: "Your experience and location are already on file — we only need these five to set up your screening call.",
          },
          {
            type: "TextInput",
            name: "current_ctc",
            label: "Current CTC (LPA)",
            "input-type": "text",
            required: true,
          },
          {
            type: "TextInput",
            name: "expected_ctc",
            label: "Expected CTC (LPA)",
            "input-type": "text",
            required: true,
          },
          {
            type: "TextInput",
            name: "notice_period",
            label: "Notice period (days)",
            "input-type": "number",
            required: true,
          },
          {
            type: "RadioButtonsGroup",
            name: "willing_to_relocate",
            label: "Willing to relocate?",
            "data-source": [
              { id: "yes", title: "Yes" },
              { id: "no", title: "No" },
            ],
            required: true,
          },
          {
            type: "TextArea",
            name: "reason_for_switching",
            label: "Reason for switching",
            required: false,
          },
          {
            type: "Footer",
            label: "Submit",
            "on-click-action": {
              name: "complete",
              payload: {},
            },
          },
        ],
      },
      terminal: true,
      refresh_on_back: false,
    },
  ],
}

const TEMPLATE = {
  name: TEMPLATE_NAME,
  language: "en",
  category: "UTILITY",
  components: [
    {
      type: "BODY",
      text: "Hi {{1}}, thank you for your interest in the {{2}} role at {{3}}. Please share five quick details so we can set up your screening call.",
      example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] },
    },
    {
      type: "BUTTONS",
      buttons: [
        {
          type: "FLOW",
          text: "Share details",
          flow_id: "__FLOW_ID__",
          // Match the approved 7-field template: this WABA rejects the older
          // flow_action_payload spelling.
          flow_action: "NAVIGATE",
          navigate_screen: "DETAILS_SCREEN",
        },
      ],
    },
  ],
}

async function listFlows() {
  const res = await graph(`/${WABA_ID}/flows?fields=id,name,status,validation_errors`, { method: "GET" })
  const body = await res.json()
  if (!res.ok) throw new Error(`list flows failed (${res.status}): ${JSON.stringify(body)}`)
  return body.data || []
}

/** Re-running after a schema fix must update the draft, not collide on its name. */
async function upsertFlow() {
  const existing = (await listFlows()).find((f) => f.name === FLOW_NAME)

  if (existing) {
    if (existing.status === "PUBLISHED") {
      // Publishing is the goal state, so a clean published flow is success, not
      // a conflict. Only bail if it still has validation errors.
      if ((existing.validation_errors || []).length === 0) {
        console.log(`♻️  flow "${FLOW_NAME}" already published and valid: ${existing.id}`)
        return { id: existing.id, created: false, published: true }
      }
      throw new Error(
        `flow "${FLOW_NAME}" is published but has validation errors (${existing.id}) — ` +
          `delete it in WhatsApp Manager, then re-run`
      )
    }
    const res = await graph(`/${existing.id}`, {
      method: "POST",
      body: JSON.stringify({ json_version: FLOW_JSON_VERSION, flow_json: JSON.stringify(FLOW_JSON) }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(`update flow failed (${res.status}): ${JSON.stringify(body)}`)
    return { id: existing.id, created: false }
  }

  const res = await graph(`/${WABA_ID}/flows`, {
    method: "POST",
    body: JSON.stringify({
      name: FLOW_NAME,
      categories: ["LEAD_GENERATION"],
      json_version: FLOW_JSON_VERSION,
      flow_json: JSON.stringify(FLOW_JSON),
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`create flow failed (${res.status}): ${JSON.stringify(body)}`)
  return { id: body.id, created: true }
}

async function publishFlow(flowId) {
  // ?action=publish is silently treated as a no-op update; the /publish
  // sub-resource is the endpoint Meta actually honours.
  const res = await graph(`/${flowId}/publish`, { method: "POST" })
  const body = await res.json()
  if (!res.ok) throw new Error(`publish flow failed (${res.status}): ${JSON.stringify(body)}`)
  return body.success === true
}

async function createTemplate(flowId) {
  const payload = JSON.parse(JSON.stringify(TEMPLATE).replace("__FLOW_ID__", flowId))
  const res = await graph(`/${WABA_ID}/message_templates`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`create template failed (${res.status}): ${JSON.stringify(body)}`)
  return body
}

async function main() {
  const out = path.join(__dirname, "collect-info-form-v2.flow.json")
  fs.writeFileSync(out, JSON.stringify(FLOW_JSON, null, 2))
  console.log(`Flow JSON written to ${out}`)

  const { id: flowId, created, published } = await upsertFlow()
  console.log(created ? `✅ flow created: ${flowId} (draft)` : `♻️  flow ${published ? "published" : "updated"}: ${flowId}`)

  // A draft with validation errors will not publish — fail loudly instead of
  // leaving a broken flow behind that looks configured.
  const after = (await listFlows()).find((f) => f.id === flowId)
  const errors = after?.validation_errors || []
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`   ❌ ${e.error}: ${e.message} ${JSON.stringify(e.pointers?.[0]?.path || "")}`)
    }
    throw new Error(`flow has ${errors.length} validation error(s) — fix the JSON above and re-run`)
  }

  if (published) {
    console.log(`✅ flow already published: ${flowId}`)
  } else {
    await publishFlow(flowId)
    console.log(`✅ flow published: ${flowId}`)
  }

  const existingTemplates = (
    await (
      await graph(`/${WABA_ID}/message_templates?name=${TEMPLATE_NAME}&fields=id,status`, { method: "GET" })
    ).json()
  ).data || []

  const template = existingTemplates.length > 0 ? existingTemplates[0] : await createTemplate(flowId)

  if (existingTemplates.length > 0) {
    console.log(`♻️  template already exists: ${TEMPLATE_NAME} (id ${template.id})`)
  } else {
    console.log(`✅ template submitted for review: ${TEMPLATE_NAME} (id ${template.id})`)
  }
  console.log(`   category=${template.category ?? "UTILITY"} status=${template.status}`)
  console.log(
    "\nUntil Meta approves it, lib/whatsapp.ts falls back to collect_info_form " +
      "(7-field). Set WHATSAPP_TEMPLATE_COLLECT_INFO_FORM=collect_info_form_v2 to pin it."
  )
}

main().catch((err) => {
  console.error(`❌ ${err.message}`)
  process.exit(1)
})
