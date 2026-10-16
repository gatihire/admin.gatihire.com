"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/components/ui/use-toast"
import { Check, Loader2, UserCircle2, Users } from "lucide-react"

interface AssignmentUser {
  auth_user_id: string
  name: string | null
  email: string | null
}

interface AssignableUser extends AssignmentUser {
  roleNames: string[]
}

function displayName(u: { name?: string | null; email?: string | null; auth_user_id?: string }): string {
  return u.name || (u.email ? u.email.split("@")[0] : "") || (u.auth_user_id ? u.auth_user_id.slice(0, 8) : "Unknown")
}

function initials(u: { name?: string | null; email?: string | null }): string {
  const base = (u.name || u.email || "?").trim()
  const parts = base.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase()
}

export interface AssignOwnerDialogProps {
  jobId: string
  jobTitle?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  currentOwnerAuthUserId: string | null
  currentCollaboratorIds: string[]
  onSaved?: () => void
}

/**
 * Pick a primary owner and optional collaborators for a job. Only rendered for
 * users with `jobs.assign`; the API enforces it regardless.
 */
export function AssignOwnerDialog({
  jobId,
  jobTitle,
  open,
  onOpenChange,
  currentOwnerAuthUserId,
  currentCollaboratorIds,
  onSaved,
}: AssignOwnerDialogProps) {
  const { toast } = useToast()
  const [users, setUsers] = useState<AssignableUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ownerId, setOwnerId] = useState<string>(currentOwnerAuthUserId || "")
  const [collaborators, setCollaborators] = useState<Set<string>>(new Set(currentCollaboratorIds))

  useEffect(() => {
    if (!open) return
    setOwnerId(currentOwnerAuthUserId || "")
    setCollaborators(new Set(currentCollaboratorIds))
  }, [open, currentOwnerAuthUserId, currentCollaboratorIds])

  useEffect(() => {
    if (!open) return
    let active = true
    setLoadingUsers(true)
    fetch("/api/jobs/assignable-users", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Could not load users"))))
      .then((data) => {
        if (active) setUsers(Array.isArray(data?.users) ? data.users : [])
      })
      .catch((e) => {
        if (active) toast({ title: "Error", description: e?.message || "Could not load users", variant: "destructive" })
      })
      .finally(() => {
        if (active) setLoadingUsers(false)
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggleCollaborator = useCallback((id: string, on: boolean) => {
    setCollaborators((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/assignees`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerAuthUserId: ownerId || null,
          collaboratorIds: Array.from(collaborators).filter((id) => id !== ownerId),
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to update assignment")
      toast({ title: "Assignment updated", description: "The new owner sees this job in their Today queue." })
      onOpenChange(false)
      onSaved?.()
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Failed to update assignment", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Assign job</DialogTitle>
          <DialogDescription>
            {jobTitle ? `${jobTitle} — ` : ""}Choose the concerned person and anyone collaborating on it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Primary owner</div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setOwnerId("")}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${
                  ownerId === "" ? "bg-blue-50 dark:bg-blue-950/30" : ""
                }`}
              >
                <span className="text-zinc-500">Unassigned (team-owned)</span>
                {ownerId === "" && <Check className="h-4 w-4 text-blue-600" />}
              </button>
              {loadingUsers && (
                <div className="flex items-center gap-2 px-3 py-3 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading people…
                </div>
              )}
              {!loadingUsers &&
                users.map((u) => (
                  <button
                    key={u.auth_user_id}
                    type="button"
                    onClick={() => setOwnerId(u.auth_user_id)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${
                      ownerId === u.auth_user_id ? "bg-blue-50 dark:bg-blue-950/30" : ""
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[10px] font-bold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
                        {initials(u)}
                      </span>
                      <span className="truncate">
                        {displayName(u)}
                        {u.roleNames.length > 0 && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-zinc-400">{u.roleNames.join(", ")}</span>
                        )}
                      </span>
                    </span>
                    {ownerId === u.auth_user_id && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
                  </button>
                ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <Users className="h-3.5 w-3.5" /> Collaborators (optional)
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              {loadingUsers && (
                <div className="px-3 py-3 text-sm text-zinc-500">Loading people…</div>
              )}
              {!loadingUsers && users.length === 0 && (
                <div className="px-3 py-3 text-sm text-zinc-500">No internal users found.</div>
              )}
              {!loadingUsers &&
                users.map((u) => (
                  <label
                    key={u.auth_user_id}
                    className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                  >
                    <Checkbox
                      checked={collaborators.has(u.auth_user_id)}
                      disabled={u.auth_user_id === ownerId}
                      onCheckedChange={(v) => toggleCollaborator(u.auth_user_id, v === true)}
                    />
                    <span className="truncate">{displayName(u)}</span>
                    {u.auth_user_id === ownerId && (
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-zinc-400">Owner</span>
                    )}
                  </label>
                ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save assignment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface JobAssignmentCardProps {
  jobId: string
  jobTitle?: string
  owner: AssignmentUser | null
  assignees: Array<AssignmentUser & { role: string }>
  canAssign: boolean
  canClaim: boolean
  viewerId?: string | null
  onChanged?: () => void
}

/** Compact card showing who owns a job, with assign/claim controls. */
export function JobAssignmentCard({
  jobId,
  jobTitle,
  owner,
  assignees,
  canAssign,
  canClaim,
  viewerId,
  onChanged,
}: JobAssignmentCardProps) {
  const { toast } = useToast()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const unassigned = !owner
  const isMine = !!owner && !!viewerId && owner.auth_user_id === viewerId

  const claim = async () => {
    setClaiming(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/claim`, { method: "POST", credentials: "include" })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Could not claim this job")
      toast({ title: "Job claimed", description: "It now shows in your Today queue." })
      onChanged?.()
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Could not claim this job", variant: "destructive" })
    } finally {
      setClaiming(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-5 py-3.5 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        <UserCircle2 className="h-4 w-4" /> Assigned to
      </div>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {owner ? (
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-sm ${
              isMine
                ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300"
                : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-200"
            }`}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] font-bold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-100">
              {initials(owner)}
            </span>
            {displayName(owner)}
            {isMine && <span className="text-[10px] font-bold uppercase tracking-wide">You</span>}
          </span>
        ) : (
          <span className="rounded-full border border-dashed border-zinc-300 px-2.5 py-1 text-sm text-zinc-500 dark:border-zinc-700">
            Unassigned
          </span>
        )}

        {assignees.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-zinc-500">
            <Users className="h-3.5 w-3.5" />
            {assignees.map((a, i) => (
              <span key={a.auth_user_id} className="text-zinc-600 dark:text-zinc-300">
                {displayName(a)}
                {i < assignees.length - 1 ? "," : ""}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {canAssign && (
          <Button variant="outline" size="sm" className="h-8 text-xs font-bold" onClick={() => setDialogOpen(true)}>
            {unassigned ? "Assign" : "Reassign"}
          </Button>
        )}
        {canClaim && unassigned && (
          <Button size="sm" className="h-8 text-xs font-bold" onClick={claim} disabled={claiming}>
            {claiming && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Claim
          </Button>
        )}
      </div>

      {canAssign && (
        <AssignOwnerDialog
          jobId={jobId}
          jobTitle={jobTitle}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          currentOwnerAuthUserId={owner?.auth_user_id ?? null}
          currentCollaboratorIds={assignees.map((a) => a.auth_user_id)}
          onSaved={onChanged}
        />
      )}
    </div>
  )
}
