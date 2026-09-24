const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "1292918636194299";
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${WABA_ID}/message_templates`;

if (!TOKEN) {
  console.error("WHATSAPP_ACCESS_TOKEN is required. Run with the .env.local values exported or via dotenv.");
  process.exit(1);
}

const templates = [
  {
    name: "talent_outreach_v2",
    language: "en",
    category: "MARKETING",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, We came across your profile and think you would be a great fit for: {{2}} at {{3}} Location: {{4}} Salary: {{5}} If this sounds interesting, let us know and we can schedule a quick screening call. Would you like to know more?",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics", "Mumbai", "8-10 LPA"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Interested" },
          { type: "QUICK_REPLY", text: "Not Interested" }
        ]
      }
    ]
  },
  {
    name: "screening_invite_v2",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Great, {{1}}! Let us schedule your screening call for the {{2}} position at {{3}}. Please select a convenient time below.",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Call Now" },
          { type: "QUICK_REPLY", text: "In 10 min" },
          { type: "QUICK_REPLY", text: "In 30 min" },
          { type: "QUICK_REPLY", text: "Today Evening" },
          { type: "QUICK_REPLY", text: "Custom Time" }
        ]
      }
    ]
  },
  {
    name: "schedule_options",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Great, {{1}}! Let us schedule your screening call for the {{2}} position. Please select a convenient time below.",
        example: { body_text: [["John", "Operations Manager"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Call Now" },
          { type: "QUICK_REPLY", text: "In 10 min" },
          { type: "QUICK_REPLY", text: "In 30 min" },
          { type: "QUICK_REPLY", text: "Today Evening" }
        ]
      }
    ]
  },
  {
    name: "call_nudge",
    language: "en",
    category: "MARKETING",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, This is a reminder that our Senior AI Agent will call you shortly for your screening regarding the {{2}} position at {{3}}. The call will last approximately 5-10 minutes. Please answer when we call.",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      }
    ]
  },
  {
    name: "tried_calling",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, We attempted to call you regarding the {{2}} position at {{3}}, but were unable to connect. Please select a convenient time for us to try again, or reply with your preferred time.",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Call Now" },
          { type: "QUICK_REPLY", text: "In 10 min" },
          { type: "QUICK_REPLY", text: "In 1 hour" }
        ]
      }
    ]
  },
  {
    name: "missed_call_reschedule",
    language: "en",
    category: "MARKETING",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, We missed you for the {{2}} screening at {{3}}. Please select a convenient time to reschedule, or reply with your preferred time.",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Call Now" },
          { type: "QUICK_REPLY", text: "In 10 min" },
          { type: "QUICK_REPLY", text: "In 1 hour" },
          { type: "QUICK_REPLY", text: "Tomorrow Morning" }
        ]
      }
    ]
  },
  {
    name: "reminder_nudge",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, Following up regarding the {{2}} position at {{3}}. If you are interested, please reply here or select an option below.",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Interested" },
          { type: "QUICK_REPLY", text: "Not Interested" }
        ]
      }
    ]
  },
  {
    name: "inbound_screening_invite",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, Thank you for applying for {{2}} at {{3}}. We would like to schedule a brief screening call to discuss your experience and the role. The call will take about 5-10 minutes. When would be a good time for you?",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Call Now" },
          { type: "QUICK_REPLY", text: "In 10 min" },
          { type: "QUICK_REPLY", text: "In 30 min" },
          { type: "QUICK_REPLY", text: "Today Evening" },
          { type: "QUICK_REPLY", text: "Custom Time" }
        ]
      }
    ]
  },
  {
    name: "outbound_info_request",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, We reached out to you about the {{2}} role at {{3}}. Before we schedule your screening call, could you share a few quick details? This helps us understand your fit better. Please reply with: 1. Current CTC (annual) 2. Expected CTC (annual) 3. Notice period (days) Example: \"8 LPA, 12 LPA, 30 days\"",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Provide Details" },
          { type: "QUICK_REPLY", text: "Skip — Schedule Call" }
        ]
      }
    ]
  },
  {
    name: "inbound_info_request_v2",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, Thank you for applying for {{2}} at {{3}}. Before we schedule your screening call, could you share a few quick details? This helps us understand your fit better. Please reply with: 1. Current CTC (annual) 2. Expected CTC (annual) 3. Notice period (days) Example: \"8 LPA, 12 LPA, 30 days\"",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Provide Details" },
          { type: "QUICK_REPLY", text: "Skip — Schedule Call" }
        ]
      }
    ]
  },
  {
    name: "info_received_confirm",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, Thank you! We have received your details: - Current CTC: {{2}} - Expected CTC: {{3}} - Notice Period: {{4}} Now let us schedule your screening call. It is a quick 5-10 minute chat about your experience. When would be a good time?",
        example: { body_text: [["John", "10 LPA", "14 LPA", "30 days"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Call Now" },
          { type: "QUICK_REPLY", text: "In 10 min" },
          { type: "QUICK_REPLY", text: "In 30 min" },
          { type: "QUICK_REPLY", text: "Today Evening" }
        ]
      }
    ]
  },
  {
    name: "ai_call_reassurance",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, Just a heads up — your screening call for {{2}} at {{3}} is coming up. Quick note: Our team will ask you a few questions about your experience. It is casual and conversational, not a test. Just be yourself and share your experience so far. See you soon!",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      }
    ]
  },
  {
    name: "not_interested_reason",
    language: "en",
    category: "MARKETING",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, We understand. Could you let us know the reason so we can improve our outreach? Pick one:",
        example: { body_text: [["John"]] }
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Not Looking to Switch" },
          { type: "QUICK_REPLY", text: "Compensation Mismatch" },
          { type: "QUICK_REPLY", text: "Location Issue" },
          { type: "QUICK_REPLY", text: "Already Placed" },
          { type: "QUICK_REPLY", text: "Role Not Relevant" },
          { type: "QUICK_REPLY", text: "Other" }
        ]
      }
    ]
  },
  {
    name: "detailed_info_request",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, Thank you for your interest in {{2}} at {{3}}. To help us match you better, please share the following in ONE reply: 1. Current CTC 2. Expected CTC 3. Total experience (years) 4. Notice period 5. Current city 6. Willing to relocate? (yes/no) 7. Reason for switching Example: \"8 LPA, 12 LPA, 5 years, 30 days, Mumbai, yes, better growth\"",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      }
    ]
  },
  {
    name: "screening_filtered_out",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, Thank you for sharing your details. After review, we feel this role may not be the best fit at this time. Reason: {{2}} We will keep your profile for future opportunities. All the best!",
        example: { body_text: [["John", "Expected CTC above range"]] }
      }
    ]
  },
  {
    name: "second_reminder_nudge",
    language: "en",
    category: "MARKETING",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, Just a quick reminder about the {{2}} opportunity at {{3}}. If you are still interested, please reply and we will connect you with our team. Looking forward to hearing from you!",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      }
    ]
  },
  {
    name: "info_review_pending",
    language: "en",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hi {{1}}, Thank you for sharing your details for the {{2}} position at {{3}}. Our team is reviewing your profile. We will get back to you shortly with next steps. We appreciate your patience!",
        example: { body_text: [["John", "Operations Manager", "ABC Logistics"]] }
      }
    ]
  },
  {
    name: "truckinzy_first_touch",
    language: "en",
    category: "MARKETING",
    components: [
      {
        type: "BODY",
        text: "Hi, noticed {{1}} is hiring for {{2}}. We're Truckinzy — we place logistics & supply chain roles fast, no upfront fee. Worth a quick chat?",
        example: { body_text: [["ABC Logistics", "Operations Manager"]] }
      }
    ]
  },
  {
    name: "hello_world",
    language: "en_US",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API, hosted by Meta. Thank you for taking the time to test with us."
      }
    ]
  }
];

async function createTemplate(template) {
  const response = await fetch(`https://graph.facebook.com/v21.0/1292918636194299/message_templates`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(template)
  });
  
  const result = await response.json();
  return { name: template.name, status: response.status, result };
}

async function createAll() {
  console.log(`Creating ${templates.length} templates in WABA 1292918636194299...`);
  
  for (const template of templates) {
    console.log(`\nCreating: ${template.name} (${template.category})...`);
    const result = await createTemplate(template);
    
    if (result.status === 200 || result.status === 201) {
      console.log(`✅ ${template.name}: SUCCESS - ${JSON.stringify(result.result)}`);
    } else {
      console.log(`❌ ${template.name}: FAILED (${result.status}) - ${JSON.stringify(result.result)}`);
    }
    
    // Small delay between requests
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log("\n✅ All templates submitted!");
}

createAll().catch(console.error);