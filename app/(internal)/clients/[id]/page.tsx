import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { normalizeExternalUrl } from "@/lib/utils"
import { requireAnyInternalPermission } from "@/lib/server-internal-permissions"

export const runtime = "nodejs"
export const revalidate = 0

function clamp(text: string, max = 520) {
  const t = (text || "").trim()
  if (t.length <= max) return t
  return `${t.slice(0, max).trim()}…`
}

export default async function ClientDetailPage(props: { params: Promise<{ id: string }> }) {
  await requireAnyInternalPermission(["jobs.view", "jobs.edit", "jobs.post"])
  const { id } = await props.params

  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (!client?.id) notFound()

  const { data: jobs, count } = await supabaseAdmin
    .from("jobs")
    .select("*", { count: "exact" })
    .eq("client_id", client.id)
    .order("created_at", { ascending: false })

  const openCount = Array.isArray(jobs) ? jobs.filter((j: any) => j.status === "open").length : 0
  const totalJobs = typeof count === "number" ? count : Array.isArray(jobs) ? jobs.length : 0

  return (
    <div className="w-full">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/clients" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to clients
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={`/clients?edit=${client.id}`}
            className="rounded-full border bg-white px-4 py-2 text-sm hover:bg-gray-50 dark:bg-zinc-900 dark:border-zinc-800"
          >
            Edit client
          </Link>
          <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
            Jobs
          </Link>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-8 shadow-sm dark:bg-zinc-900 dark:border-zinc-800">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-4">
            {client.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={client.logo_url} alt={client.name} className="h-16 w-16 rounded-2xl border bg-white object-cover" />
            ) : (
              <div className="h-16 w-16 rounded-2xl border bg-gray-100 dark:bg-zinc-800 dark:border-zinc-700" />
            )}
            <div>
              <div className="text-3xl font-bold tracking-tight text-blue-700 dark:text-blue-300">{client.name}</div>
              <div className="mt-1 text-sm text-muted-foreground">/{client.slug}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border bg-white p-4 dark:bg-zinc-900 dark:border-zinc-800">
              <div className="text-xs font-medium text-muted-foreground">Website</div>
              <a
                href={normalizeExternalUrl(client.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-sm font-medium text-blue-600 hover:underline"
              >
                {client.website}
              </a>
              <div className="mt-2 text-sm">{client.company_type || "—"}</div>
              <div className="text-sm text-muted-foreground">{client.location || "—"}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border bg-white p-4 dark:bg-zinc-900 dark:border-zinc-800">
                <div className="text-xs font-medium text-muted-foreground">Open Jobs</div>
                <div className="mt-1 text-2xl font-semibold">{openCount}</div>
              </div>
              <div className="rounded-xl border bg-white p-4 dark:bg-zinc-900 dark:border-zinc-800">
                <div className="text-xs font-medium text-muted-foreground">Total Jobs</div>
                <div className="mt-1 text-2xl font-semibold">{totalJobs}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="rounded-2xl border bg-white p-6 dark:bg-zinc-900 dark:border-zinc-800">
              <div className="text-sm font-semibold">About {client.name}</div>
              <div className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{client.about ? clamp(client.about, 900) : "—"}</div>
            </div>

            <div className="mt-6 rounded-2xl border bg-white p-6 dark:bg-zinc-900 dark:border-zinc-800">
              <div className="text-sm font-semibold">Open roles</div>
              <div className="mt-4 grid gap-3">
                {(jobs || []).length ? (
                  (jobs as any[])
                    .filter((j) => j.status === "open")
                    .map((j) => (
                      <div key={j.id} className="rounded-xl border bg-white p-4 dark:bg-zinc-900 dark:border-zinc-800">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold">{j.title}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {(j.location || "Remote")} • {(j.type || "")}
                            </div>
                          </div>
                          <Link href={`/jobs`} className="rounded-full border bg-white px-4 py-2 text-sm hover:bg-gray-50 dark:bg-zinc-900 dark:border-zinc-800">
                            View in Jobs
                          </Link>
                        </div>
                      </div>
                    ))
                ) : (
                  <div className="text-sm text-muted-foreground">No jobs assigned yet.</div>
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-5">
            <div className="rounded-2xl border bg-white p-6 dark:bg-zinc-900 dark:border-zinc-800">
              <div className="text-sm font-semibold">Contacts</div>
              <div className="mt-4 grid gap-3 text-sm">
                <div className="rounded-xl border bg-gray-50 p-4 dark:bg-zinc-800 dark:border-zinc-700">
                  <div className="text-xs font-medium text-muted-foreground">Primary contact</div>
                  <div className="mt-2 font-medium">{client.primary_contact_name || "—"}</div>
                  <div className="text-muted-foreground">{client.primary_contact_email || "—"}</div>
                  <div className="text-muted-foreground">{client.primary_contact_phone || "—"}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Additional contacts</div>
                  <div className="mt-2 grid gap-2">
                    {Array.isArray(client.additional_contacts) && client.additional_contacts.length ? (
                      client.additional_contacts.map((c: any, idx: number) => (
                        <div key={idx} className="rounded-xl border bg-white p-4 dark:bg-zinc-900 dark:border-zinc-800">
                          <div className="font-medium">{c?.name || "—"}</div>
                          <div className="text-muted-foreground">{c?.email || "—"}</div>
                          <div className="text-muted-foreground">{c?.phone || "—"}</div>
                        </div>
                      ))
                    ) : (
                      <div className="text-sm text-muted-foreground">No additional contacts.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
