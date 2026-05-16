"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cachedFetchJson } from "@/lib/utils"

type MeResponse = {
  user: { id: string; email: string | null }
  permissions: string[]
}

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

type OverviewResponse = {
  range: { from: string; to: string }
  totals: {
    candidates_uploaded: number
    jobs_created: number
    outreach_messages: number
    applications_created: number
  }
  perUser: Array<{
    user: { auth_user_id: string; email: string; name: string | null; created_at: string; last_active_at: string | null }
    totals: OverviewResponse["totals"]
  }>
}

type UserStatsResponse = {
  range: { from: string; to: string }
  userId: string
  totals: {
    candidates_uploaded: number
    jobs_created: number
    outreach_messages: number
    applications_created: number
  }
  recentJobs: Array<{ id: string; title: string; created_at: string; status: string | null; applications_count: number }>
}

type UserActivityResponse = {
  userId: string
  events: Array<{ id: string; event_name: string; entity_type: string | null; entity_id: string | null; metadata: any; created_at: string }>
}

type UserPermissionsResponse = {
  userId: string
  roleNames: string[]
  overridePermissionKeys: string[]
  availablePermissionKeys: string[]
}

function fmt(n: number) {
  return new Intl.NumberFormat().format(n)
}

function isoDateOnly(d: Date) {
  const x = new Date(d)
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset())
  return x.toISOString().slice(0, 10)
}

function groupPermissions(keys: string[]) {
  const groups = new Map<string, string[]>()
  for (const k of keys) {
    const head = k.split(".")[0] || "other"
    const group = head === "export" ? "admin" : head
    groups.set(group, [...(groups.get(group) ?? []), k])
  }
  return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))
}

export function SuperAdminDashboard() {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [roles, setRoles] = useState<Role[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [users, setUsers] = useState<InternalUser[]>([])
  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState<string>("")
  const [loading, setLoading] = useState(true)

  const canViewAnalytics = Boolean(me?.permissions?.includes("analytics.view"))
  const canManageUsers = Boolean(me?.permissions?.includes("users.manage"))
  const canManageRoles = Boolean(me?.permissions?.includes("roles.manage"))

  const [fromDate, setFromDate] = useState(() => isoDateOnly(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)))
  const [toDate, setToDate] = useState(() => isoDateOnly(new Date()))
  const [userFilter, setUserFilter] = useState<string>("all")

  const [createEmail, setCreateEmail] = useState("")
  const [createName, setCreateName] = useState("")
  const [createPassword, setCreatePassword] = useState("")
  const [createRole, setCreateRole] = useState<string>("recruiter")

  const [selectedUserId, setSelectedUserId] = useState<string>("")
  const [selectedUserStats, setSelectedUserStats] = useState<UserStatsResponse | null>(null)
  const [selectedUserActivity, setSelectedUserActivity] = useState<UserActivityResponse | null>(null)
  const [selectedUserPermissions, setSelectedUserPermissions] = useState<UserPermissionsResponse | null>(null)
  const [userPermissionDraft, setUserPermissionDraft] = useState<Set<string>>(new Set())
  const [permSearch, setPermSearch] = useState("")

  const selectedUser = useMemo(() => users.find(u => u.auth_user_id === selectedUserId) ?? null, [users, selectedUserId])
  const roleNamesForUser = useMemo(() => {
    return (selectedUser?.user_roles ?? []).map(r => r.roles?.name).filter((x): x is string => Boolean(x))
  }, [selectedUser])
  const primaryRoleForUser = roleNamesForUser[0] ?? ""

  const loadBase = useCallback(async (opts?: { force?: boolean }) => {
    setLoading(true)
    setError("")
    try {
      const meJson = await cachedFetchJson<any>("internal:super-admin:me", "/api/super-admin/me", undefined, { ttlMs: 5 * 60_000, force: Boolean(opts?.force), swr: true, onData: setMe })
      setMe(meJson)

      const reqs: Array<Promise<any>> = []
      if (meJson?.permissions?.includes("roles.manage")) {
        reqs.push(cachedFetchJson("internal:super-admin:roles", "/api/super-admin/roles", undefined, { ttlMs: 5 * 60_000, force: Boolean(opts?.force), swr: true }))
        reqs.push(cachedFetchJson("internal:super-admin:permissions", "/api/super-admin/permissions", undefined, { ttlMs: 5 * 60_000, force: Boolean(opts?.force), swr: true }))
      } else {
        reqs.push(Promise.resolve({ roles: [] }))
        reqs.push(Promise.resolve({ permissions: [] }))
      }
      if (meJson?.permissions?.includes("users.manage")) reqs.push(cachedFetchJson("internal:super-admin:users", "/api/super-admin/users", undefined, { ttlMs: 5 * 60_000, force: Boolean(opts?.force), swr: true }))
      else reqs.push(Promise.resolve({ users: [] }))

      const [rolesJson, permissionsJson, usersJson] = await Promise.all(reqs)
      setRoles(Array.isArray(rolesJson?.roles) ? rolesJson.roles : [])
      setPermissions(Array.isArray(permissionsJson?.permissions) ? permissionsJson.permissions : [])
      setUsers(Array.isArray(usersJson?.users) ? usersJson.users : [])
    } catch (e: any) {
      setError(String(e?.message || "Failed to load Super Admin data"))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadOverview = useCallback(async (opts?: { force?: boolean }) => {
    if (!canViewAnalytics) return
    const qs = new URLSearchParams({
      from: new Date(fromDate).toISOString(),
      to: new Date(toDate).toISOString(),
      ...(userFilter !== "all" ? { userId: userFilter } : {}),
    })
    const url = `/api/super-admin/overview?${qs.toString()}`
    try {
      const json = await cachedFetchJson<any>(`internal:super-admin:overview:${qs.toString()}`, url, undefined, { ttlMs: 5 * 60_000, force: Boolean(opts?.force), swr: true, onData: setOverview })
      setOverview(json)
    } catch (e: any) {
      throw new Error(e?.message || "Failed to load overview")
    }
  }, [canViewAnalytics, fromDate, toDate, userFilter])

  const loadUserDetails = useCallback(async (userId: string, opts?: { force?: boolean }) => {
    if (!userId) return
    const qs = new URLSearchParams({
      from: new Date(fromDate).toISOString(),
      to: new Date(toDate).toISOString(),
    })
    const force = Boolean(opts?.force)
    const [statsJson, actJson, permJson] = await Promise.all([
      cachedFetchJson<any>(`internal:super-admin:users:${userId}:stats:${qs.toString()}`, `/api/super-admin/users/${userId}/stats?${qs.toString()}`, undefined, { ttlMs: 5 * 60_000, force, swr: true, onData: setSelectedUserStats }),
      cachedFetchJson<any>(`internal:super-admin:users:${userId}:activity`, `/api/super-admin/users/${userId}/activity?limit=50`, undefined, { ttlMs: 5 * 60_000, force, swr: true, onData: setSelectedUserActivity }),
      cachedFetchJson<any>(`internal:super-admin:users:${userId}:permissions`, `/api/super-admin/users/${userId}/permissions`, undefined, { ttlMs: 5 * 60_000, force, swr: true, onData: (data) => {
        setSelectedUserPermissions(data)
        setUserPermissionDraft(new Set(Array.isArray(data?.overridePermissionKeys) ? data.overridePermissionKeys : []))
      } }),
    ])
    
    setSelectedUserStats(statsJson)
    setSelectedUserActivity(actJson)
    setSelectedUserPermissions(permJson)
    setUserPermissionDraft(new Set(Array.isArray(permJson?.overridePermissionKeys) ? permJson.overridePermissionKeys : []))
  }, [fromDate, toDate])

  useEffect(() => {
    loadBase()
  }, [loadBase])

  useEffect(() => {
    if (!canViewAnalytics) return
    loadOverview().catch((e: any) => setError(String(e?.message || "Failed to load overview")))
  }, [canViewAnalytics, loadOverview])

  useEffect(() => {
    if (!selectedUserId) return
    loadUserDetails(selectedUserId).catch((e: any) => setError(String(e?.message || "Failed to load user details")))
  }, [selectedUserId, loadUserDetails])

  async function createUser() {
    setError("")
    try {
      const res = await fetch("/api/super-admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: createEmail,
          password: createPassword,
          name: createName || null,
          roleName: createRole,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Failed to create user")
      setCreateEmail("")
      setCreateName("")
      setCreatePassword("")
      setCreateRole("recruiter")
      await loadBase()
    } catch (e: any) {
      setError(String(e?.message || "Failed to create user"))
    }
  }

  async function saveUserRole(roleName: string) {
    if (!selectedUserId) return
    setError("")
    try {
      const res = await fetch(`/api/super-admin/users/${selectedUserId}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleNames: roleName ? [roleName] : [] }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Failed to set role")
      await loadBase()
      await loadUserDetails(selectedUserId)
    } catch (e: any) {
      setError(String(e?.message || "Failed to set role"))
    }
  }

  async function saveUserPermissionOverrides() {
    if (!selectedUserId) return
    setError("")
    try {
      const res = await fetch(`/api/super-admin/users/${selectedUserId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissionKeys: Array.from(userPermissionDraft) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Failed to save overrides")
      await loadUserDetails(selectedUserId)
    } catch (e: any) {
      setError(String(e?.message || "Failed to save overrides"))
    }
  }

  const permissionKeys = permissions.map(p => p.key)
  const grouped = useMemo(() => groupPermissions(permissionKeys), [permissionKeys])
  const filteredPermissionKeys = useMemo(() => {
    const q = permSearch.trim().toLowerCase()
    if (!q) return null
    return new Set(permissionKeys.filter(k => k.toLowerCase().includes(q)))
  }, [permSearch, permissionKeys])

  if (loading) return <div className="text-sm text-zinc-600 dark:text-zinc-300">Loading…</div>

  if (error) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-red-600">{error}</div>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    )
  }

  if (!canViewAnalytics && !canManageUsers && !canManageRoles) {
    return <div className="text-sm text-zinc-600 dark:text-zinc-300">You do not have access to Super Admin.</div>
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <div className="md:col-span-2">
          <div className="text-xs text-zinc-500 mb-1">From</div>
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <div className="text-xs text-zinc-500 mb-1">To</div>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
        </div>
        <div>
          <div className="text-xs text-zinc-500 mb-1">User</div>
          <Select value={userFilter} onValueChange={setUserFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              {users.map(u => (
                <SelectItem key={u.auth_user_id} value={u.auth_user_id}>
                  {u.name ? `${u.name} (${u.email})` : u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="w-full justify-start">
          {(canViewAnalytics || canManageUsers || canManageRoles) && <TabsTrigger value="overview">Overview</TabsTrigger>}
          {(canManageUsers || canManageRoles) && <TabsTrigger value="team">Team & Access</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          {!overview ? (
            <div className="text-sm text-zinc-600 dark:text-zinc-300">No overview available.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 bg-white dark:bg-zinc-950">
                  <div className="text-sm text-zinc-500">Candidates Uploaded</div>
                  <div className="text-2xl font-semibold">{fmt(overview.totals.candidates_uploaded)}</div>
                </div>
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 bg-white dark:bg-zinc-950">
                  <div className="text-sm text-zinc-500">Jobs Created</div>
                  <div className="text-2xl font-semibold">{fmt(overview.totals.jobs_created)}</div>
                </div>
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 bg-white dark:bg-zinc-950">
                  <div className="text-sm text-zinc-500">Outreach Messages</div>
                  <div className="text-2xl font-semibold">{fmt(overview.totals.outreach_messages)}</div>
                </div>
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 bg-white dark:bg-zinc-950">
                  <div className="text-sm text-zinc-500">Applications Created</div>
                  <div className="text-2xl font-semibold">{fmt(overview.totals.applications_created)}</div>
                </div>
              </div>

              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-950">
                <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium">Who did what</div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead className="text-right">Uploads</TableHead>
                      <TableHead className="text-right">Jobs</TableHead>
                      <TableHead className="text-right">Outreach</TableHead>
                      <TableHead className="text-right">Applications</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.perUser.map(row => (
                      <TableRow key={row.user.auth_user_id}>
                        <TableCell className="font-medium">{row.user.name ? `${row.user.name} (${row.user.email})` : row.user.email}</TableCell>
                        <TableCell className="text-right">{fmt(row.totals.candidates_uploaded)}</TableCell>
                        <TableCell className="text-right">{fmt(row.totals.jobs_created)}</TableCell>
                        <TableCell className="text-right">{fmt(row.totals.outreach_messages)}</TableCell>
                        <TableCell className="text-right">{fmt(row.totals.applications_created)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="team" className="space-y-4">
          <Tabs defaultValue="users">
            <TabsList className="w-full justify-start">
              {canManageUsers && <TabsTrigger value="users">Users</TabsTrigger>}
              {canManageRoles && <TabsTrigger value="roles">Roles</TabsTrigger>}
            </TabsList>

            <TabsContent value="users" className="space-y-4">
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
                <div className="text-sm font-medium mb-3">Create User</div>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                  <Input placeholder="Email" value={createEmail} onChange={e => setCreateEmail(e.target.value)} />
                  <Input placeholder="Name" value={createName} onChange={e => setCreateName(e.target.value)} />
                  <Input placeholder="Password" type="password" value={createPassword} onChange={e => setCreatePassword(e.target.value)} />
                  <Select value={createRole} onValueChange={setCreateRole}>
                    <SelectTrigger>
                      <SelectValue placeholder="Role" />
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map(r => (
                        <SelectItem key={r.id} value={r.name}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button onClick={createUser} disabled={!createEmail.trim() || !createPassword}>
                    Create
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <div className="xl:col-span-1 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
                  <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium">Users</div>
                  <div className="max-h-[520px] overflow-auto">
                    {users.map(u => (
                      <button
                        key={u.auth_user_id}
                        type="button"
                        onClick={() => setSelectedUserId(u.auth_user_id)}
                        className={`w-full text-left px-3 py-2 text-sm border-b border-zinc-100 dark:border-zinc-900 ${
                          selectedUserId === u.auth_user_id ? "bg-zinc-100 dark:bg-zinc-900" : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                        }`}
                      >
                        <div className="font-medium">{u.name ? u.name : u.email}</div>
                        <div className="text-xs text-zinc-500">{u.email}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="xl:col-span-2 space-y-4">
                  {!selectedUser ? (
                    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 text-sm text-zinc-600 dark:text-zinc-300">
                      Select a user to see details.
                    </div>
                  ) : (
                    <>
                      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium">{selectedUser.name || selectedUser.email}</div>
                            <div className="text-xs text-zinc-500">{selectedUser.auth_user_id}</div>
                          </div>
                          <div className="w-[240px]">
                            <div className="text-xs text-zinc-500 mb-1">Primary role</div>
                            <Select value={primaryRoleForUser || "none"} onValueChange={v => saveUserRole(v === "none" ? "" : v)}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">None</SelectItem>
                                {roles.map(r => (
                                  <SelectItem key={r.id} value={r.name}>
                                    {r.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {selectedUserStats ? (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div className="rounded border border-zinc-200 dark:border-zinc-800 p-3">
                              <div className="text-xs text-zinc-500">Uploads</div>
                              <div className="text-lg font-semibold">{fmt(selectedUserStats.totals.candidates_uploaded)}</div>
                            </div>
                            <div className="rounded border border-zinc-200 dark:border-zinc-800 p-3">
                              <div className="text-xs text-zinc-500">Jobs</div>
                              <div className="text-lg font-semibold">{fmt(selectedUserStats.totals.jobs_created)}</div>
                            </div>
                            <div className="rounded border border-zinc-200 dark:border-zinc-800 p-3">
                              <div className="text-xs text-zinc-500">Outreach</div>
                              <div className="text-lg font-semibold">{fmt(selectedUserStats.totals.outreach_messages)}</div>
                            </div>
                            <div className="rounded border border-zinc-200 dark:border-zinc-800 p-3">
                              <div className="text-xs text-zinc-500">Applications</div>
                              <div className="text-lg font-semibold">{fmt(selectedUserStats.totals.applications_created)}</div>
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
                        <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3">
                          <div className="text-sm font-medium">Permission Overrides</div>
                          <Button variant="outline" onClick={saveUserPermissionOverrides} disabled={!selectedUserPermissions}>
                            Save
                          </Button>
                        </div>
                        <div className="p-3">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                            <Input placeholder="Search permissions…" value={permSearch} onChange={e => setPermSearch(e.target.value)} />
                            <div className="text-xs text-zinc-500 md:col-span-2 flex items-center">
                              Overrides add extra access (role permissions still apply).
                            </div>
                          </div>
                          <div className="max-h-[420px] overflow-auto space-y-4">
                            {grouped.map(([groupName, keys]) => {
                              const visibleKeys = filteredPermissionKeys ? keys.filter(k => filteredPermissionKeys.has(k)) : keys
                              if (visibleKeys.length === 0) return null
                              return (
                                <div key={groupName} className="rounded border border-zinc-200 dark:border-zinc-800 p-3">
                                  <div className="text-sm font-medium mb-2">{groupName.toUpperCase()}</div>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    {visibleKeys.map(k => {
                                      const checked = userPermissionDraft.has(k)
                                      return (
                                        <label key={k} className="flex items-start gap-2 text-sm">
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={e => {
                                              setUserPermissionDraft(prev => {
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

                      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
                        <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium">Recent Activity</div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Time</TableHead>
                              <TableHead>Event</TableHead>
                              <TableHead>Entity</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(selectedUserActivity?.events ?? []).map(e => (
                              <TableRow key={e.id}>
                                <TableCell className="text-xs text-zinc-600 dark:text-zinc-300">{new Date(e.created_at).toLocaleString()}</TableCell>
                                <TableCell className="font-medium">{e.event_name}</TableCell>
                                <TableCell className="text-xs text-zinc-600 dark:text-zinc-300">
                                  {e.entity_type || "-"} {e.entity_id ? `• ${e.entity_id}` : ""}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="roles" className="space-y-4">
              <RoleEditor roles={roles} permissions={permissions} onReload={loadBase} />
            </TabsContent>
          </Tabs>
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

  const selectedRole = useMemo(() => props.roles.find(r => r.id === selectedRoleId) || null, [props.roles, selectedRoleId])
  const selectedRolePermissionKeys = useMemo(() => {
    const keys = (selectedRole?.role_permissions ?? [])
      .map(rp => rp.permissions?.key)
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
    return props.permissions.filter(p => p.key.toLowerCase().includes(q))
  }, [props.permissions, search])

  const grouped = useMemo(() => {
    return groupPermissions(permissions.map(p => p.key)).map(([groupName, keys]) => [
      groupName,
      keys.map(k => props.permissions.find(p => p.key === k)!).filter(Boolean),
    ] as const)
  }, [permissions, props.permissions])

  async function createRole() {
    setError("")
    try {
      const res = await fetch("/api/super-admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newRoleName, description: newRoleDescription || null, permissionKeys: [] }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Failed to create role")
      setNewRoleName("")
      setNewRoleDescription("")
      await props.onReload()
    } catch (e: any) {
      setError(String(e?.message || "Failed to create role"))
    }
  }

  async function saveRolePermissions() {
    if (!selectedRole) return
    setError("")
    try {
      const res = await fetch(`/api/super-admin/roles/${selectedRole.id}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissionKeys: Array.from(draft) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Failed to save permissions")
      await props.onReload()
    } catch (e: any) {
      setError(String(e?.message || "Failed to save permissions"))
    }
  }

  return (
    <div className="space-y-4">
      {error ? <div className="text-sm text-red-600">{error}</div> : null}

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
        <div className="text-sm font-medium mb-3">Create Role</div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Input placeholder="Role name" value={newRoleName} onChange={e => setNewRoleName(e.target.value)} />
          <Input placeholder="Description (optional)" value={newRoleDescription} onChange={e => setNewRoleDescription(e.target.value)} />
          <div className="md:col-span-2 flex justify-end">
            <Button onClick={createRole} disabled={!newRoleName.trim()}>
              Create
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium">Roles</div>
          <div className="max-h-[520px] overflow-auto">
            {props.roles.map(r => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedRoleId(r.id)}
                className={`w-full text-left px-3 py-2 text-sm border-b border-zinc-100 dark:border-zinc-900 ${
                  selectedRoleId === r.id ? "bg-zinc-100 dark:bg-zinc-900" : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                }`}
              >
                <div className="font-medium">{r.name}</div>
                {r.description ? <div className="text-xs text-zinc-500">{r.description}</div> : null}
              </button>
            ))}
          </div>
        </div>

        <div className="lg:col-span-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Role Permissions</div>
            <div className="flex items-center gap-2">
              <Input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} className="w-[240px]" />
              <Button variant="outline" onClick={saveRolePermissions} disabled={!selectedRole}>
                Save
              </Button>
            </div>
          </div>
          <div className="p-3 max-h-[520px] overflow-auto space-y-4">
            {!selectedRole ? (
              <div className="text-sm text-zinc-600 dark:text-zinc-300">Select a role to edit its permissions.</div>
            ) : (
              grouped.map(([groupName, perms]) => (
                <div key={groupName} className="rounded border border-zinc-200 dark:border-zinc-800 p-3">
                  <div className="text-sm font-medium mb-2">{groupName.toUpperCase()}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {perms.map(p => {
                      const checked = draft.has(p.key)
                      return (
                        <label key={p.id} className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={e => {
                              setDraft(prev => {
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
