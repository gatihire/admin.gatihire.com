// Creates the CORRECTED 5-field candidate details flow + its WhatsApp template and
// submits both to Meta for review.
//
// Why v3 exists (the bug this fixes):
//   v2's footer was `{ "name": "complete", "payload": {} }`. A WhatsApp Flow
//   `complete` action returns ONLY the values explicitly mapped in its payload, so
//   an empty payload produced `response_json = "{}"` on every submission. The
//   candidate filled in all five fields, the webhook parsed an empty object, and
//   the pre-screen evaluated a blank profile — reporting "Salary / Notice missing"
//   as if the candidate had withheld them. v1 mapped every field and worked; v2
//   lost the mapping. v3 restores it: `${data.<field>}` for each input.
//
//   v2 stays untouched (Meta does not allow editing a PUBLISHED flow), so this
//   creates a new flow + template and lib/whatsapp.ts prefers v3, then v2, then
//   the 7-field v1.
//
// Usage:
//   node --env-file=.env.local scripts/create-collect-info-form-v3.js
//
// The flow JSON is also written to scripts/collect-info-form-v3.flow.json so the
// screen copy can be reviewed/edited before submitting.

const fs = require("node:fs")
const path = require("node:path")

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "1292918636194299"
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0"
const FLOW_NAME = "truckinzy_candidate_screening_v3"
const TEMPLATE_NAME = "collect_info_form_v3"
const FLOW_JSON_VERSION = process.env.WHATSAPP_FLOW_JSON_VERSION || "7.3"

if (!TOKEN) {
  console.error("❌ WHATSAPP_ACCESS_TOKEN is not set")
  process.exit(1)
}

// The five fields, declared once so the footer payload mapping can never drift
// from the inputs. `buildFooterPayload()` derives the `complete` action from this
// list — adding a field here automatically maps it.
const FIELDS = [
  { type: "TextInput", name: "current_ctc", label: "Current CTC (LPA)", inputType: "text" },
  { type: "TextInput", name: "expected_ctc", label: "Expected CTC (LPA)", inputType: "text" },
  { type: "TextInput", name: "notice_period", label: "Notice period (days)", inputType: "number" },
  {
    type: "RadioButtonsGroup",
    name: "willing_to_relocate",
    label: "Willing to relocate?",
    dataSource: [
      { id: "yes", title: "Yes" },
      { id: "no", title: "No" },
    ],
  },
  { type: "TextArea", name: "reason_for_switching", label: "Reason for switching", required: false },
]

// Inputs MUST live inside a `Form` component for `${form.<name>}` to resolve.
// v2 put them at the top level of the layout, so its footer had nothing to
// reference and returned an empty payload. This is the same shape v1 used.
const FORM_NAME = "details"

/**
 * The `complete` action must echo every input or Meta sends an empty
 * response_json — which is precisely the v2 bug that discarded candidate data.
 */
function buildFooterPayload() {
  const payload = {}
  for (const f of FIELDS) payload[f.name] = `\${form.${f.name}}`
  return payload
}

function buildInputComponent(f) {
  if (f.type === "RadioButtonsGroup") {
    return {
      type: f.type,
      name: f.name,
      label: f.label,
      "data-source": f.dataSource,
      required: f.required !== false,
    }
  }
  return {
    type: f.type,
    name: f.name,
    label: f.label,
    "input-type": f.inputType,
    required: f.required !== false,
  }
}

const FLOW_JSON = {
  version: FLOW_JSON_VERSION,
  screens: [
    {
      id: "DETAILS_SCREEN",
      title: "Your details",
      layout: {
        type: "SingleColumnLayout",
        children: [
          { type: "TextHeading", text: "Quick details" },
          {
            type: "TextBody",
            text: "Your experience and location are already on file — we only need these five to set up your screening call.",
          },
          {
            type: "Form",
            name: FORM_NAME,
            children: FIELDS.map(buildInputComponent),
          },
          {
            type: "Footer",
            label: "Submit",
            "on-click-action": {
              name: "complete",
              payload: buildFooterPayload(),
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
  language: "en_US",
  category: "UTILITY",
  components: [
    {
      type: "BODY",
      text: "Hi {{1}}, thank you for your interest in the {{2}} role at {{3}}. Please share five quick details so we can set up your screening call.",
      example: {
        body_text: [["John", "Operations Manager", "ABC Logistics"]],
      },
    },
    {
      type: "BUTTONS",
      buttons: [
        {
          type: "FLOW",
          text: "Share details",
          flow_id: "__FLOW_ID__",
          flow_action: "NAVIGATE",
          navigate_screen: "DETAILS_SCREEN",
        },
      ],
    },
  ],
}

async function graph(pathname, init) {
  const url = `https://graph.facebook.com/${API_VERSION}${pathname}${pathname.includes("?") ? "&" : "?"}access_token=${TOKEN}`
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(`${init?.method || "GET"} ${pathname} failed (${res.status}): ${JSON.stringify(body)}`)
    err.status = res.status
    err.body = body
  }
  return { ok: res.ok, status: res.status, body }
}

async function listFlows() {
  const res = await graph(`/${WABA_ID}/flows?fields=id,name,status,validation_errors`, { method: "GET" })
  if (!res.ok) throw new Error(`list flows failed: ${JSON.stringify(res.body)}`)
  return res.body.data || []
}

/**
 * Always create a FRESH flow instead of updating an existing draft.
 *
 * Meta returned HTTP 200 for a draft update and still kept serving the previous
 * flow.json — the downloaded asset came back with the stale `${data.*}` payload,
 * and the flow then failed to publish carrying the OLD validation errors. Only
 * recreating guarantees the published asset matches this file. Safe because the
 * flow is only reachable through the template created below, and a same-named
 * leftover (always a draft from a failed run) is deleted first.
 */
async function createFreshFlow() {
  for (const f of await listFlows()) {
    if (f.name !== FLOW_NAME) continue
    console.log(`🗑️  removing stale flow ${FLOW_NAME} (${f.id}, ${f.status})`)
    const del = await graph(`/${f.id}`, { method: "DELETE" })
    if (!del.ok) throw new Error(`delete stale flow failed: ${JSON.stringify(del.body)}`)
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
  if (!res.ok) throw new Error(`create flow failed: ${JSON.stringify(res.body)}`)
  return { id: res.body.id, created: true }
}

async function publishFlow(flowId) {
  const res = await graph(`/${flowId}/publish`, { method: "POST" })
  if (!res.ok) throw new Error(`publish flow failed: ${JSON.stringify(res.body)}`)
  return res.body.success === true
}

async function createTemplate(flowId) {
  const payload = JSON.parse(JSON.stringify(TEMPLATE).replace("__FLOW_ID__", flowId))
  const res = await graph(`/${WABA_ID}/message_templates`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`create template failed: ${JSON.stringify(res.body)}`)
  return res.body
}

async function main() {
  const out = path.join(__dirname, "collect-info-form-v3.flow.json")
  fs.writeFileSync(out, JSON.stringify(FLOW_JSON, null, 2))
  console.log(`Flow JSON written to ${out}`)
  console.log(`Footer payload maps: ${JSON.stringify(buildFooterPayload())}`)

  const { id: flowId } = await createFreshFlow()
  console.log(`✅ flow created: ${flowId} (draft)`)

  const after = (await listFlows()).find((f) => f.id === flowId)
  const errors = after?.validation_errors || []
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`   ❌ ${e.error}: ${e.message} ${JSON.stringify(e.pointers?.[0]?.path || "")}`)
    }
    throw new Error(`flow has ${errors.length} validation error(s) — fix the JSON above and re-run`)
  }

  await publishFlow(flowId)
  console.log(`✅ flow published: ${flowId}`)

  const existingTemplates = (
    await graph(`/${WABA_ID}/message_templates?name=${TEMPLATE_NAME}&fields=id,status`, { method: "GET" })
  ).body.data || []

  const template = existingTemplates.length > 0 ? existingTemplates[0] : await createTemplate(flowId)

  if (existingTemplates.length > 0) {
    console.log(`♻️  template already exists: ${TEMPLATE_NAME} (id ${template.id})`)
  } else {
    console.log(`✅ template submitted for review: ${TEMPLATE_NAME} (id ${template.id})`)
  }
  console.log(`   category=${template.category ?? "UTILITY"} status=${template.status}`)
  console.log(
    "\nUntil Meta approves it, lib/whatsapp.ts falls back to collect_info_form_v2 " +
      "(broken payload) then collect_info_form (7-field v1, works). " +
      "Set WHATSAPP_TEMPLATE_COLLECT_INFO_FORM=collect_info_form_v3 to pin it."
  )
}

main().catch((err) => {
  console.error(`❌ ${err.message}`)
  process.exit(1)
})
