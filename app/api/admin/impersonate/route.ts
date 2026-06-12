import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export const runtime = "nodejs"

export async function GET(req: Request) {
  try {
    await requireAnyInternalPermission(["jobs.view", "jobs.edit", "jobs.post"])

    const { searchParams } = new URL(req.url)
    const clientId = searchParams.get("clientId")

    if (!clientId) {
      return NextResponse.json({ error: "Missing clientId" }, { status: 400 })
    }

    // Get the client's primary contact email or an associated user's email
    const { data: client, error: clientError } = await supabaseAdmin
      .from("clients")
      .select("primary_contact_email, name")
      .eq("id", clientId)
      .single()

    if (clientError) {
      return new NextResponse("Client not found.", { status: 404 })
    }

    // Find a user associated with this client
    const { data: clientUser } = await supabaseAdmin
      .from("client_users")
      .select("auth_user_id")
      .eq("client_id", clientId)
      .limit(1)
      .maybeSingle()

    let targetEmail = client?.primary_contact_email

    if (clientUser?.auth_user_id) {
      const { data: authUserData } = await supabaseAdmin.auth.admin.getUserById(clientUser.auth_user_id)
      if (authUserData?.user?.email) {
        targetEmail = authUserData.user.email
      }
    }

    if (!targetEmail) {
      return new NextResponse("Client has no associated user email to impersonate.", { status: 404 })
    }

    // Generate a magic link for the user
    // This requires the user to exist in Supabase Auth
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: targetEmail,
    })

    if (linkError || !linkData?.properties?.action_link) {
      console.error("Failed to generate magic link:", linkError)
      return new NextResponse(`Failed to generate impersonation link. The user (${targetEmail}) might not exist in Supabase Auth yet.`, { status: 400 })
    }

    // Determine the client app URL
    const isProd = process.env.NODE_ENV === "production"
    const fallbackUrl = isProd ? "https://client.gatihire.com" : "http://localhost:3001"
    const clientAppUrl = process.env.CLIENT_APP_URL || fallbackUrl
    
    // The action_link is a Supabase Auth URL that verifies the token.
    // We can append a redirect_to query parameter to tell Supabase where to redirect after verification.
    const actionLink = new URL(linkData.properties.action_link)
    actionLink.searchParams.set("redirect_to", `${clientAppUrl}/dashboard`)

    return NextResponse.redirect(actionLink.toString())
  } catch (error: any) {
    console.error("Impersonate error:", error)
    // If redirect throws (which it does in Next.js), we must re-throw it
    if (error?.message === 'NEXT_REDIRECT') {
      throw error;
    }
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
