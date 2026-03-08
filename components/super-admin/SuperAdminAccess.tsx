"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type Permission = { id: string; key: string; description: string | null }

type Role = {
  id: string
  name: string
  description: string | null
  role_permissions: Array<{ permission_id: string; permissions: Permission | null }> | null
}

type InternalUser = {
  auth_user_id: string
  email: string
  name: string | null
  disabled: boolean
  created_at: string
  last_active_at: string | null
  user_roles: Array<{ role_id: string; roles: { id: string; name: string } | null }> | null
}

type UserPermissionsResponse = {
  userId: string
  roleNames: string[]
  overridePermissionKeys: string[]
  availablePermissionKeys: string[]
}

function groupPermissions(keys: string[]) {
  const groups = new Map<string, string[]>()
  for (const k of keys) {
    const head = k.split(".")[0] || "other"
    groups.set(head, [...(groups.get(head) ?? []), k])
  }
  return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))
}

export function SuperAdminAccess() {
  const [roles, setRoles] = useState<Role[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [users, setUsers] = useState<InternalUser[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const [rolesRes, permsRes, usersRes] = await Promise.all([
        fetch("/api/super-admin/roles"),
        fetch("/api/super-admin/permissions"),
        fetch("/api/super-admin/users"),
      ])
      const [rolesJson, permsJson, usersJson] = await Promise.all([rolesRes.json(), permsRes.json(), usersRes.json()])
      if (!rolesRes.ok) throw new Error(rolesJson?.error || "Failed to load roles")
      if (!permsRes.ok) throw new Error(permsJson?.error || "Failed to load permissions")
      if (!usersRes.ok) throw new Error(usersJson?.error || "Failed to load users")

      setRoles(Array.isArray(rolesJson?.roles) ? rolesJson.roles : [])
      setPermissions(Array.isArray(permsJson?.permissions) ? permsJson.permissions : [])
      setUsers(Array.isArray(usersJson?.users) ? usersJson.users : [])
    } catch (e: any) {
      setError(String(e?.message || "Failed to load"))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const [createEmail, setCreateEmail] = useState("")
  const [createName, setCreateName] = useState("")
  const [createPassword, setCreatePassword] = useState("")
  const [createRole, setCreateRole] = useState<string>("recruiter")
  const [lastCreatedCreds, setLastCreatedCreds] = useState<{ email: string; password: string } | null>(null)
  const [showCreatedPassword, setShowCreatedPassword] = useState(false)

  const createUser = useCallback(async () => {
    setError("")
    try {
      const res = await fetch("/api/super-admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: createEmail,
          ...(createPassword ? { password: createPassword } : {}),
          name: createName || null,
          ...(createRole && createRole !== "none" ? { roleName: createRole } : {}),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || "Failed to create user")
      if (json?.password) {
        setLastCreatedCreds({ email: createEmail.trim().toLowerCase(), password: String(json.password) })
        setShowCreatedPassword(false)
      } else {
        setLastCreatedCreds(null)
        setShowCreatedPassword(false)
      }
      setCreateEmail("")
      setCreateName("")
      setCreatePassword("")
      setCreateRole("recruiter")
      await load()
    } catch (e: any) {
      setError(String(e?.message || "Failed to create user"))
    }
  }, [createEmail, createName, createPassword, createRole, load])

  const [selectedUserId, setSelectedUserId] = useState<string>("")
  const selectedUser = useMemo(() => users.find((u) => u.auth_user_id === selectedUserId) ?? null, [users, selectedUserId])
  const primaryRole = useMemo(() => {
    const role = (selectedUser?.user_roles ?? []).map((r) => r.roles?.name).filter(Boolean)[0]
    return String(role || "")
  }, [selectedUser])

  const [selectedUserPermissions, setSelectedUserPermissions] = useState<UserPermissionsResponse | null>(null)
  const [userPermissionDraft, setUserPermissionDraft] = useState<Set<string>>(new Set())
  const [permSearch, setPermSearch] = useState("")

  const loadUserPermissions = useCallback(
    async (userId: string) => {
      const res = await fetch(`/api/super-admin/users/${userId}/permissions`)
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || "Failed to load permissions")
      setSelectedUserPermissions(json)
      setUserPermissionDraft(new Set(Array.isArray(json?.overridePermissionKeys) ? json.overridePermissionKeys : []))
    },
    []
  )

  useEffect(() => {
    if (!selectedUserId) return
    loadUserPermissions(selectedUserId).catch((e: any) => setError(String(e?.message || "Failed")))
  }, [selectedUserId, loadUserPermissions])

  const saveUserRole = useCallback(
    async (roleName: string) => {
      if (!selectedUserId) return
      setError("")
      try {
        const res = await fetch(`/api/super-admin/users/${selectedUserId}/roles`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roleNames: roleName ? [roleName] : [] }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok) throw new Error(json?.error || "Failed to set role")
        await load()
      } catch (e: any) {
        setError(String(e?.message || "Failed to set role"))
      }
    },
    [load, selectedUserId]
  )

  const saveUserOverrides = useCallback(async () => {
    if (!selectedUserId) return
    setError("")
    try {
      const res = await fetch(`/api/super-admin/users/${selectedUserId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissionKeys: Array.from(userPermissionDraft) }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || "Failed to save overrides")
      await loadUserPermissions(selectedUserId)
    } catch (e: any) {
      setError(String(e?.message || "Failed to save overrides"))
    }
  }, [loadUserPermissions, selectedUserId, userPermissionDraft])

  const permissionKeys = useMemo(() => permissions.map((p) => p.key), [permissions])
  const grouped = useMemo(() => groupPermissions(permissionKeys), [permissionKeys])
  const filteredPermissionKeys = useMemo(() => {
    const q = permSearch.trim().toLowerCase()
    if (!q) return null
    return new Set(permissionKeys.filter((k) => k.toLowerCase().includes(q)))
  }, [permSearch, permissionKeys])

  if (loading) return <div className="text-sm text-zinc-600">Loading…</div>

  return (
    <div className="space-y-4">
      {error ? <div className="text-sm text-red-600">{error}</div> : null}

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="text-sm font-medium mb-3">Create User</div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <Input placeholder="Email" value={createEmail} onChange={(e) => setCreateEmail(e.target.value)} />
          <Input placeholder="Name" value={createName} onChange={(e) => setCreateName(e.target.value)} />
          <Input placeholder="Password (optional)" type="password" value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} />
          <Select value={createRole} onValueChange={setCreateRole}>
            <SelectTrigger>
              <SelectValue placeholder="Role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No role</SelectItem>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.name}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={createUser} disabled={!createEmail.trim()}>
            Create
          </Button>
        </div>
        {lastCreatedCreds ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-amber-900">Temporary password</div>
              <Button variant="outline" onClick={() => setShowCreatedPassword((prev) => !prev)}>
                {showCreatedPassword ? "Hide" : "View"}
              </Button>
            </div>
            <div className="mt-1 text-amber-900">{lastCreatedCreds.email}</div>
            <div className="mt-1 font-mono text-amber-900">
              {showCreatedPassword ? lastCreatedCreds.password : "••••••••••"}
            </div>
          </div>
        ) : null}
      </div>

      <Tabs defaultValue="users">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="space-y-4">
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
              <div className="p-3 border-b border-zinc-200 text-sm font-medium">Team</div>
              <div className="max-h-[520px] overflow-auto">
                {users.map((u) => (
                  <button
                    key={u.auth_user_id}
                    type="button"
                    onClick={() => setSelectedUserId(u.auth_user_id)}
                    className={`w-full text-left px-3 py-2 text-sm border-b border-zinc-100 ${
                      selectedUserId === u.auth_user_id ? "bg-zinc-100" : "hover:bg-zinc-50"
                    }`}
                  >
                    <div className="font-medium">{u.name || u.email}</div>
                    <div className="text-xs text-zinc-500">{u.email}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="xl:col-span-2 space-y-4">
              {!selectedUser ? (
                <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-600">Select a user.</div>
              ) : (
                <>
                  <div className="rounded-lg border border-zinc-200 bg-white p-4 flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium">{selectedUser.name || selectedUser.email}</div>
                      <div className="text-xs text-zinc-500">{selectedUser.auth_user_id}</div>
                    </div>
                    <div className="w-[240px]">
                      <div className="text-xs text-zinc-500 mb-1">Primary role</div>
                      <Select value={primaryRole || "none"} onValueChange={(v) => saveUserRole(v === "none" ? "" : v)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {roles.map((r) => (
                            <SelectItem key={r.id} value={r.name}>
                              {r.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
                    <div className="p-3 border-b border-zinc-200 flex items-center justify-between gap-3">
                      <div className="text-sm font-medium">Permission Overrides</div>
                      <Button variant="outline" onClick={saveUserOverrides} disabled={!selectedUserPermissions}>
                        Save
                      </Button>
                    </div>
                    <div className="p-3">
                      <Input placeholder="Search permissions…" value={permSearch} onChange={(e) => setPermSearch(e.target.value)} />
                      <div className="mt-3 max-h-[420px] overflow-auto space-y-4">
                        {grouped.map(([groupName, keys]) => {
                          const visible = filteredPermissionKeys ? keys.filter((k) => filteredPermissionKeys.has(k)) : keys
                          if (!visible.length) return null
                          return (
                            <div key={groupName} className="rounded border border-zinc-200 p-3">
                              <div className="text-sm font-medium mb-2">{groupName.toUpperCase()}</div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                {visible.map((k) => {
                                  const checked = userPermissionDraft.has(k)
                                  return (
                                    <label key={k} className="flex items-start gap-2 text-sm">
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={(e) => {
                                          setUserPermissionDraft((prev) => {
                                            const next = new Set(prev)
                                            if (e.target.checked) next.add(k)
                                            else next.delete(k)
                                            return next
                                          })
                                        }}
                                      />
                                      <span className="leading-5">{k}</span>
                                    </label>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="roles" className="space-y-4">
          <RoleEditor roles={roles} permissions={permissions} onReload={load} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function RoleEditor(props: { roles: Role[]; permissions: Permission[]; onReload: () => Promise<void> }) {
  const [selectedRoleId, setSelectedRoleId] = useState<string>("")
  const [error, setError] = useState<string>("")
  const [newRoleName, setNewRoleName] = useState("")
  const [newRoleDescription, setNewRoleDescription] = useState("")
  const [search, setSearch] = useState("")

  const selectedRole = useMemo(() => props.roles.find((r) => r.id === selectedRoleId) || null, [props.roles, selectedRoleId])
  const selectedRolePermissionKeys = useMemo(() => {
    const keys = (selectedRole?.role_permissions ?? [])
      .map((rp) => rp.permissions?.key)
      .filter((k): k is string => typeof k === "string")
    return new Set(keys)
  }, [selectedRole])

  const [draft, setDraft] = useState<Set<string>>(new Set())

  useEffect(() => {
    setDraft(new Set(selectedRolePermissionKeys))
  }, [selectedRolePermissionKeys])

  const permissions = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return props.permissions
    return props.permissions.filter((p) => p.key.toLowerCase().includes(q))
  }, [props.permissions, search])

  const grouped = useMemo(() => {
    return groupPermissions(permissions.map((p) => p.key)).map(([groupName, keys]) => [
      groupName,
      keys.map((k) => props.permissions.find((p) => p.key === k)!).filter(Boolean),
    ] as const)
  }, [permissions, props.permissions])

  const createRole = useCallback(async () => {
    setError("")
    try {
      const res = await fetch("/api/super-admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newRoleName, description: newRoleDescription || null, permissionKeys: [] }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || "Failed to create role")
      setNewRoleName("")
      setNewRoleDescription("")
      await props.onReload()
    } catch (e: any) {
      setError(String(e?.message || "Failed to create role"))
    }
  }, [newRoleDescription, newRoleName, props])

  const saveRolePermissions = useCallback(async () => {
    if (!selectedRole) return
    setError("")
    try {
      const res = await fetch(`/api/super-admin/roles/${selectedRole.id}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissionKeys: Array.from(draft) }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || "Failed to save permissions")
      await props.onReload()
    } catch (e: any) {
      setError(String(e?.message || "Failed to save permissions"))
    }
  }, [draft, props, selectedRole])

  return (
    <div className="space-y-4">
      {error ? <div className="text-sm text-red-600">{error}</div> : null}

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="text-sm font-medium mb-3">Create Role</div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Input placeholder="Role name" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} />
          <Input placeholder="Description" value={newRoleDescription} onChange={(e) => setNewRoleDescription(e.target.value)} />
          <div className="md:col-span-2 flex justify-end">
            <Button onClick={createRole} disabled={!newRoleName.trim()}>
              Create
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
          <div className="p-3 border-b border-zinc-200 text-sm font-medium">Roles</div>
          <div className="max-h-[520px] overflow-auto">
            {props.roles.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedRoleId(r.id)}
                className={`w-full text-left px-3 py-2 text-sm border-b border-zinc-100 ${
                  selectedRoleId === r.id ? "bg-zinc-100" : "hover:bg-zinc-50"
                }`}
              >
                <div className="font-medium">{r.name}</div>
                {r.description ? <div className="text-xs text-zinc-500">{r.description}</div> : null}
              </button>
            ))}
          </div>
        </div>

        <div className="lg:col-span-2 rounded-lg border border-zinc-200 bg-white overflow-hidden">
          <div className="p-3 border-b border-zinc-200 flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Role Permissions</div>
            <div className="flex items-center gap-2">
              <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-[240px]" />
              <Button variant="outline" onClick={saveRolePermissions} disabled={!selectedRole}>
                Save
              </Button>
            </div>
          </div>
          <div className="p-3 max-h-[520px] overflow-auto space-y-4">
            {!selectedRole ? (
              <div className="text-sm text-zinc-600">Select a role to edit its permissions.</div>
            ) : (
              grouped.map(([groupName, perms]) => (
                <div key={groupName} className="rounded border border-zinc-200 p-3">
                  <div className="text-sm font-medium mb-2">{groupName.toUpperCase()}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {perms.map((p) => {
                      const checked = draft.has(p.key)
                      return (
                        <label key={p.id} className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setDraft((prev) => {
                                const next = new Set(prev)
                                if (e.target.checked) next.add(p.key)
                                else next.delete(p.key)
                                return next
                              })
                            }}
                          />
                          <span>
                            <div className="font-medium">{p.key}</div>
                            {p.description ? <div className="text-xs text-zinc-500">{p.description}</div> : null}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
