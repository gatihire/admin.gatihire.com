import assert from "node:assert/strict"
import { test } from "node:test"
import { analyzeCallCoverage, MIN_EXPECTED_SECONDS } from "../lib/call-coverage"
import { buildTemplatePlan, PLAN_VERSION } from "../lib/interview-plan"

const plan: any = {
  version: 2,
  language: "bilingual",
  topics: [
    {
      id: "rate",
      label: "Rate negotiation",
      ask: "Kis shipment ka rate compare kiya — kaunsi line, kitna difference?",
      ask_en: "Which shipment did you compare rates for, and how much was the difference?",
      digs: [
        { key: "volume", prompt: "Us rate par kitna cargo volume tha?", prompt_en: "What cargo volume was on that rate?" },
        { key: "result", prompt: "Us negotiation ka result kya raha?", prompt_en: "What was the result of that negotiation?" },
      ],
      strong: "Names a shipment, a line and a number",
      weak: "Only theory",
      resume_hook: null,
      if_no_experience: "Yeh kaam nahi kiya to kaun sa rate task kiya?",
      if_no_experience_en: "If you have not done that, which rate task did you do?",
    },
    {
      id: "mode",
      label: "FCL and LCL",
      ask: "Internship mein kaun sa mode handle kiya — us shipment mein kya kiya?",
      ask_en: "In your internship, which mode did you handle, and what did you do on that shipment?",
      digs: [
        { key: "docs", prompt: "Kaun sa document sabse mushkil tha?", prompt_en: "Which document was the hardest?" },
        { key: "issue", prompt: "Us shipment mein kya issue aaya?", prompt_en: "What issue came up on that shipment?" },
      ],
      strong: "Names a real mode and task",
      weak: "No example",
      resume_hook: null,
      if_no_experience: "Yeh mode nahi tha to kaun sa task kiya?",
      if_no_experience_en: "If that mode was not there, which task did you do?",
    },
    {
      id: "client",
      label: "Client communication",
      ask: "Kis client ko quotation bheja — kya rate diya?",
      ask_en: "Which client did you send a quotation to, and what rate did you give?",
      digs: [
        { key: "query", prompt: "Client ki kaun si query aayi thi?", prompt_en: "Which query did the client ask?" },
        { key: "outcome", prompt: "Uska final outcome kya raha?", prompt_en: "What was the final outcome?" },
      ],
      strong: "Names a client and a real query",
      weak: "Generic politeness",
      resume_hook: null,
      if_no_experience: "Client work nahi kiya to kaun sa task kiya?",
      if_no_experience_en: "If you did no client work, which task did you do?",
    },
  ],
}

function completeTranscript(): string {
  return [
    "assistant: Hi, this is Ayush from Truckinzy. Is now a good time to talk?",
    "candidate: yes",
    "assistant: Thanks. Which shipment did you compare rates for, and how much was the difference?",
    "candidate: I compared three shipping lines for one air export shipment and saved about forty dollars on the rate.",
    "assistant: What cargo volume was on that rate?",
    "candidate: It was around three hundred kilos of air cargo for a regular client in Delhi.",
    "assistant: In your internship, which mode did you handle, and what did you do on that shipment?",
    "candidate: I handled air export shipments and prepared the booking and the air waybill for each consignment.",
    "assistant: Which document was the hardest?",
    "candidate: The air waybill was the hardest because the airline changed the cut off time twice that week.",
    "assistant: Which client did you send a quotation to, and what rate did you give?",
    "candidate: I sent a quotation to a garment exporter and gave a rate of two hundred dollars for the shipment.",
    "assistant: Which query did the client ask?",
    "candidate: The client asked about the transit time and whether we could hold the space for two more days.",
    "assistant: Thank you for your time. If you're shortlisted, we'll let you know on WhatsApp. Goodbye.",
    "candidate: thank you, goodbye",
  ].join("\n")
}

test("a complete, evidence-rich call passes coverage", () => {
  const c = analyzeCallCoverage({
    transcript: completeTranscript(),
    plan,
    durationSec: MIN_EXPECTED_SECONDS + 20,
  })
  assert.equal(c.assessable, true)
  assert.equal(c.topics_asked, 3)
  assert.equal(c.topics_with_evidence, 3)
  assert.equal(c.digs_asked, 3)
  assert.equal(c.coverage_ok, true)
  assert.equal(c.closed_before_coverage, false)
})

test("'yes' does not count as a language switch when the assistant stays in English", () => {
  const c = analyzeCallCoverage({
    transcript: completeTranscript(),
    plan,
    durationSec: MIN_EXPECTED_SECONDS + 20,
  })
  assert.equal(c.early_language_switch, false)
})

test("assistant Hinglish after a bare 'yes' is flagged as an early language switch", () => {
  const transcript = [
    "assistant: Hi, this is Ayush from Truckinzy. Is now a good time to talk?",
    "candidate: yes",
    "assistant: Achha, shukriya. Kis shipment ka rate compare kiya?",
    "candidate: I compared three shipping lines and saved forty dollars.",
    "assistant: Us rate par kitna cargo volume tha?",
    "candidate: Around three hundred kilos of air cargo for a regular client.",
    "assistant: Aapka bahut shukriya. Dhanyavaad, goodbye.",
  ].join("\n")
  const c = analyzeCallCoverage({ transcript, plan, durationSec: 124 })
  assert.equal(c.early_language_switch, true)
  assert.equal(c.closed_before_coverage, true)
})

test("'haan ji' is a genuine Hindi answer, so a switch after it is not early", () => {
  const transcript = [
    "assistant: Hi, this is Ayush from Truckinzy. Is now a good time to talk?",
    "candidate: haan ji",
    "assistant: Theek hai, shukriya. Kis shipment ka rate compare kiya?",
    "candidate: Maine teen shipping line ka rate compare kiya aur chalis dollar bachaye.",
    "assistant: Us rate par kitna cargo volume tha?",
    "candidate: Lagbhag teen sau kilo air cargo tha ek regular client ke liye.",
    "assistant: Aapka bahut shukriya. Dhanyavaad, goodbye.",
  ].join("\n")
  const c = analyzeCallCoverage({ transcript, plan, durationSec: 124 })
  assert.equal(c.early_language_switch, false)
})

test("a closing line at 2:04 with skipped digs is incomplete", () => {
  // The exact v1 plan the 27 Nov call ran, so the ask text matches what was said.
  const legacyPlan: any = {
    version: 1,
    language: "hinglish",
    topics: [
      {
        id: "rate_negotiation",
        label: "Freight Rate Negotiation",
        ask: "Bataiye aapne kisi shipment ke liye shipping line ya airline se rate kaise negotiate kiya?",
        digs: [
          { key: "volume", prompt: "Us rate par kitna cargo volume handle kiya tha?" },
          { key: "outcome", prompt: "Negotiation ka final saving ya profit kitna raha?" },
        ],
      },
      {
        id: "fcl_lcl_handling",
        label: "FCL and LCL Operations",
        ask: "Ek baar bataiye aapne FCL aur LCL shipments ke beech ka antar kaise handle kiya?",
        digs: [
          { key: "coordination", prompt: "Overseas agent ke saath coordination mein kya challenge aaya?" },
          { key: "documentation", prompt: "Kaun sa document sabse zyada complex laga us shipment mein?" },
        ],
      },
      {
        id: "internship_communication",
        label: "Client Communication Skills",
        ask: "Bataiye internship ke dauran aapne client communication ko kaise manage kiya?",
        digs: [
          { key: "client_type", prompt: "Kis tarah ke clients ya partners ke saath baat karte the?" },
          { key: "problem_solving", prompt: "Client ki kisi specific query ko kaise resolve kiya?" },
        ],
      },
    ],
  }
  const transcript = [
    "assistant: Hi, this is Ayush from Truckinzy. Is now a good time to talk?",
    "candidate: yes",
    "assistant: Achha, shukriya. Bataiye aapne kisi shipment ke liye rate kaise negotiate kiya?",
    "candidate: shipping line se humne rate comparison kiya tha.",
    "assistant: Samajh gaya. Us rate par kitna cargo volume handle kiya tha?",
    "candidate: sir but isme time nahi kabhi humne.",
    "assistant: Ek baar bataiye aapne FCL aur LCL shipments ke beech ka antar kaise handle kiya?",
    "candidate: itni badi shipment aati hi nahi thi, air cargo mostly.",
    "assistant: Samajh gaya. Bataiye internship ke dauran aapne client communication kaise manage kiya?",
    "candidate: yes sir",
    "assistant: Aapka bahut shukriya. Dhanyavaad, goodbye.",
  ].join("\n")
  const c = analyzeCallCoverage({ transcript, plan: legacyPlan, durationSec: 124 })
  assert.equal(c.topics_asked, 3)
  assert.equal(c.closed_before_coverage, true)
  assert.equal(c.coverage_ok, false)
  assert.ok(c.reasons.some((r) => r.includes("4m 30s")))
})

test("no stored plan is not assessable, so old rows are never gated", () => {
  const c = analyzeCallCoverage({ transcript: completeTranscript(), plan: null, durationSec: 124 })
  assert.equal(c.assessable, false)
  assert.equal(c.closed_before_coverage, false)
})

test("template plans are v2, bilingual and carry a no-experience bridge", () => {
  const built = buildTemplatePlan(
    {
      id: "job-1",
      title: "Export Executive",
      skills_must_have: ["Freight negotiation", "Client communication"],
      key_responsibilities: ["Handle export quotations and bookings"],
      experience_min_years: 0,
    },
    { id: "cand-1", name: "Test", current_role: "Intern", total_experience: 0.25, resume_text: "3 month internship" }
  )
  assert.equal(built.version, PLAN_VERSION)
  assert.equal(built.language, "bilingual")
  for (const topic of built.topics) {
    assert.ok(topic.ask_en, `topic ${topic.id} has English ask`)
    assert.ok(topic.if_no_experience, `topic ${topic.id} has bridge`)
    assert.ok(topic.if_no_experience_en, `topic ${topic.id} has English bridge`)
    for (const dig of topic.digs) assert.ok(dig.prompt_en, `dig ${dig.key} has English wording`)
  }
})
