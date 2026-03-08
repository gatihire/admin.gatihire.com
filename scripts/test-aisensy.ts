
import * as dotenv from "dotenv";
import path from "path";

// Load environment variables from .env.local
const result = dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

if (result.error) {
  console.error("Error loading .env.local", result.error);
}

async function testAisensy() {
  // Dynamic import to ensure env vars are loaded first
  const { aisensyService } = await import("../lib/aisensy");

  const phoneNumber = process.argv[2] || "919932338847"; // Default to user's number if not provided
  console.log(`Sending test message to ${phoneNumber}...`);

  // Test Invite Template
  console.log("Testing Invite Template (Talent_Invite)...");
  const inviteResult = await aisensyService.sendWhatsAppMessage(
    {
      phoneNumber,
      candidateName: "Test Candidate",
      jobTitle: "Software Engineer",
      companyName: "Truckinzy Test",
      uniqueLink: "https://talent.gatihire.com/invite/test-token",
    },
    {
      campaignName: "Talent_Invite", // Override explicitly for test
      templateParams: [
        "Test Candidate",
        "Software Engineer",
        "Truckinzy Test",
        "https://talent.gatihire.com/invite/test-token",
      ],
    }
  );

  console.log("Invite Result:", inviteResult);

  // Test Outreach Template
  console.log("Testing Outreach Template (Talent_Outreach)...");
  const outreachResult = await aisensyService.sendWhatsAppMessage(
    {
      phoneNumber,
      candidateName: "Test Candidate",
      jobTitle: "Software Engineer",
      companyName: "Truckinzy Test",
      uniqueLink: "https://talent.gatihire.com/apply/test-token",
    },
    {
      campaignName: "Talent_Outreach", // Override explicitly for test
      templateParams: [
        "Test Candidate",
        "Software Engineer",
        "Truckinzy Test",
        "95", // Match Score
        "React, Node.js", // Skills
        "https://talent.gatihire.com/apply/test-token",
      ],
    }
  );

  console.log("Outreach Result:", outreachResult);
}

testAisensy().catch(console.error);
