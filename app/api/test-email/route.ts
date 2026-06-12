import { NextRequest, NextResponse } from "next/server";
import { sendInviteEmail } from "@/lib/mailer";
import crypto from "crypto";

export const runtime = "nodejs";

function createToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export async function GET(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams;
  const to = searchParams.get("to");
  
  if (!to) {
    return NextResponse.json({ error: "Missing 'to' parameter" }, { status: 400 });
  }

  const from = process.env.INVITES_FROM || "Truckinzy Hiring <hr.truckinzy@gmail.com>";
  const base = process.env.NEXT_PUBLIC_BOARD_APP_BASE_URL || "https://talent.gatihire.com";
  const token = createToken();
  const inviteLink = `${base}/invite/${token}`;
  
  try {
    const result = await sendInviteEmail({
      to,
      from,
      subject: "Demo Invite - Test Job at Truckinzy",
      jobTitle: "Senior Fleet Operations Manager",
      candidateName: "Test Candidate",
      inviteLink,
      companyName: "Truckinzy",
      jobDescription: "You'll manage long-haul fleet operations across North India, coordinating with 20+ drivers and ensuring on-time deliveries. You'll oversee route optimization, driver schedules, and compliance with safety regulations.",
      location: "Delhi, India",
      experience: "5–8 years",
      compensation: "₹8–12 LPA",
      clientName: "Bipul Sikder",
      phone: "+91 98765 43210",
      website: "https://truckinzy.com"
    });
    
    return NextResponse.json({ 
      success: true, 
      to, 
      from, 
      inviteLink, 
      result 
    });
  } catch (error: any) {
    console.error("Test email error:", error);
    return NextResponse.json({ 
      success: false, 
      error: error?.message || "Unknown error", 
      stack: error?.stack 
    }, { status: 500 });
  }
}
