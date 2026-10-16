// Job ownership + collaboration helpers.
//
// Ownership is deliberately simple and lives in two places:
//   * `jobs.owner_auth_user_id`  — the single "concerned person" for an opening.
//   * `job_assignees`            — optional collaborators (role = collaborator).
//
// The jobs list and job detail both need the same "who owns this / who else is
// on it" projection, so it is computed once here rather than in two routes.

import { supabaseAdmin } from "@/lib/supabase"

export interface AssignmentUser {
  auth_user_id: string
  name: string | null
  email: string | null
}

export interface JobAssignment {
  ownerAuthUserId: string | null
  owner: AssignmentUser | null
  collaborators: Array<AssignmentUser & { role: string }>
}

const EMPTY: JobAssignment = { ownerAuthUserId: null, owner: null, collaborators: [] }

/** id -> profile, for any set of auth user ids. Missing users come back absent. */
export async function getInternalUsersByIds(ids: string[]): Promise<Map<string, AssignmentUser>> {
  const out = new Map<string, AssignmentUser>()
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (unique.length === 0) return out

  // Chunk to keep the PostgREST `in` list reasonable.
  const CHUNK = 200
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK)
    const { data } = await supabaseAdmin
      .from("internal_users")
      .select("auth_user_id, name, email")
      .in("auth_user_id", slice)
    for (const u of data ?? []) {
      out.set(String((u as any).auth_user_id), {
        auth_user_id: String((u as any).auth_user_id),
        name: (u as any).name ?? null,
        email: (u as any).email ?? null,
      })
    }
  }
  return out
}

/** Assignment projection for a set of jobs, keyed by job id. */
export async function getAssignmentMap(jobIds: string[]): Promise<Map<string, JobAssignment>> {
  const map = new Map<string, JobAssignment>()
  const ids = Array.from(new Set(jobIds.filter(Boolean)))
  if (ids.length === 0) return map

  const [{ data: jobs }, { data: assigneeRows }] = await Promise.all([
    supabaseAdmin.from("jobs").select("id, owner_auth_user_id").in("id", ids),
    supabaseAdmin.from("job_assignees").select("job_id, auth_user_id, role").in("job_id", ids),
  ])

  const userIds: string[] = []
  for (const j of jobs ?? []) if ((j as any).owner_auth_user_id) userIds.push(String((j as any).owner_auth_user_id))
  for (const a of assigneeRows ?? []) if ((a as any).auth_user_id) userIds.push(String((a as any).auth_user_id))
  const users = await getInternalUsersByIds(userIds)

  for (const id of ids) map.set(id, { ...EMPTY, collaborators: [] })

  for (const j of jobs ?? []) {
    const jobId = String((j as any).id)
    const ownerId = (j as any).owner_auth_user_id ? String((j as any).owner_auth_user_id) : null
    const entry = map.get(jobId)!
    entry.ownerAuthUserId = ownerId
    entry.owner = ownerId ? users.get(ownerId) ?? { auth_user_id: ownerId, name: null, email: null } : null
  }

  for (const a of assigneeRows ?? []) {
    const jobId = String((a as any).job_id)
    const userId = String((a as any).auth_user_id || "")
    if (!userId) continue
    const entry = map.get(jobId)
    if (!entry) continue
    const role = String((a as any).role || "collaborator")
    // The owner is represented on `jobs`, not duplicated here.
    if (role === "owner") continue
    entry.collaborators.push({
      ...(users.get(userId) ?? { auth_user_id: userId, name: null, email: null }),
      role,
    })
  }

  for (const entry of map.values()) {
    entry.collaborators.sort((a, b) => displayName(a).localeCompare(displayName(b)))
  }

  return map
}

export function displayName(u: { name?: string | null; email?: string | null; auth_user_id?: string }): string {
  return u.name || (u.email ? u.email.split("@")[0] : "") || (u.auth_user_id ? u.auth_user_id.slice(0, 8) : "Unknown")
}

/** Attach `owner`, `owner_name`, `assignees` to each job row (additive). */
export async function attachAssignments<T extends { id: string }>(jobs: T[]): Promise<Array<T & {
  owner: AssignmentUser | null
  owner_name: string | null
  assignees: Array<AssignmentUser & { role: string }>
}>> {
  if (jobs.length === 0) return []
  const map = await getAssignmentMap(jobs.map((j) => j.id))
  return jobs.map((job) => {
    const a = map.get(String(job.id)) ?? EMPTY
    return {
      ...job,
      owner: a.owner,
      owner_name: a.owner ? displayName(a.owner) : null,
      assignees: a.collaborators,
    }
  })
}

export interface AssignableUser extends AssignmentUser {
  roleNames: string[]
}

/** Internal users eligible to be an owner/collaborator, with their role names. */
export async function listAssignableUsers(): Promise<AssignableUser[]> {
  const [{ data: users }, { data: roleRows }] = await Promise.all([
    supabaseAdmin
      .from("internal_users")
      .select("auth_user_id, name, email, disabled")
      .order("name", { ascending: true }),
    supabaseAdmin.from("user_roles").select("auth_user_id, roles(name)"),
  ])

  const rolesByUser = new Map<string, string[]>()
  for (const r of roleRows ?? []) {
    const uid = String((r as any).auth_user_id || "")
    const name = (r as any).roles?.name
    if (!uid || !name) continue
    if (!rolesByUser.has(uid)) rolesByUser.set(uid, [])
    rolesByUser.get(uid)!.push(String(name))
  }

  return (users ?? [])
    .filter((u: any) => u.disabled !== true)
    .map((u: any) => ({
      auth_user_id: String(u.auth_user_id),
      name: u.name ?? null,
      email: u.email ?? null,
      roleNames: (rolesByUser.get(String(u.auth_user_id)) ?? []).sort(),
    }))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)))
}

export interface SetAssigneesInput {
  jobId: string
  ownerAuthUserId: string | null
  collaboratorIds: string[]
  actorId: string
}

export interface SetAssigneesResult {
  ok: boolean
  error?: string
  previousOwnerAuthUserId?: string | null
}

/**
 * Set the owner and replace the collaborator set for a job in one go.
 * Audited to `analytics_events` so "who moved this job to whom" survives.
 */
export async function setJobAssignees(input: SetAssigneesInput): Promise<SetAssigneesResult> {
  const { data: job } = await supabaseAdmin
    .from("jobs")
    .select("id, owner_auth_user_id")
    .eq("id", input.jobId)
    .maybeSingle()
  if (!job) return { ok: false, error: "Job not found" }

  const previousOwner = (job as any).owner_auth_user_id ?? null

  // Never let the owner also sit in the collaborator list.
  const collaboratorIds = Array.from(
    new Set(input.collaboratorIds.map(String).filter((id) => id && id !== input.ownerAuthUserId))
  )

  const { error: updateErr } = await supabaseAdmin
    .from("jobs")
    .update({ owner_auth_user_id: input.ownerAuthUserId })
    .eq("id", input.jobId)
  if (updateErr) return { ok: false, error: updateErr.message }

  // Replace collaborators wholesale — simpler and race-free versus diffing.
  const { error: delErr } = await supabaseAdmin.from("job_assignees").delete().eq("job_id", input.jobId)
  if (delErr) return { ok: false, error: delErr.message }

  if (collaboratorIds.length > 0) {
    const rows = collaboratorIds.map((auth_user_id) => ({
      job_id: input.jobId,
      auth_user_id,
      role: "collaborator",
      assigned_by: input.actorId,
      assigned_at: new Date().toISOString(),
    }))
    const { error: insErr } = await supabaseAdmin.from("job_assignees").insert(rows)
    if (insErr) return { ok: false, error: insErr.message }
  }

  await supabaseAdmin
    .from("analytics_events")
    .insert({
      actor_auth_user_id: input.actorId,
      event_name: "job.reassigned",
      entity_type: "jobs",
      entity_id: input.jobId,
      metadata: {
        previous_owner_auth_user_id: previousOwner,
        owner_auth_user_id: input.ownerAuthUserId,
        collaborator_ids: collaboratorIds,
      },
    })
    .then(() => {})

  return { ok: true, previousOwnerAuthUserId: previousOwner }
}
