"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent } from "@/components/ui/card"
import { SuperAdminAnalytics } from "./SuperAdminAnalytics"
import { SuperAdminAccess } from "./SuperAdminAccess"

type MeResponse = {
  user: { id: string; email: string | null }
  permissions: string[]
}

export function SuperAdminHub() {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>("")
  const [activeTab, setActiveTab] = useState<string>("analytics")

  const canViewAnalytics = Boolean(me?.permissions?.includes("analytics.view"))
  const canManageUsers = Boolean(me?.permissions?.includes("users.manage"))
  const canManageRoles = Boolean(me?.permissions?.includes("roles.manage"))

  const loadMe = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/super-admin/me")
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Failed to load session")
      setMe(json)
    } catch (e: any) {
      setError(String(e?.message || "Failed to load Super Admin"))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadMe()
  }, [loadMe])

  const defaultTab = useMemo(() => {
    if (canViewAnalytics) return "analytics"
    if (canManageUsers || canManageRoles) return "access"
    return "access"
  }, [canManageRoles, canManageUsers, canViewAnalytics])

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.sessionStorage.getItem("superadmin:tab") : null
    if (saved === "analytics" || saved === "access") {
      setActiveTab(saved)
    } else {
      setActiveTab(defaultTab)
    }
  }, [defaultTab])

  const onTabChange = useCallback((v: string) => {
    setActiveTab(v)
    try {
      window.sessionStorage.setItem("superadmin:tab", v)
    } catch {
      // ignore
    }
  }, [])

  if (loading)
    return (
      <Card className="border-zinc-200 bg-white">
        <CardContent className="p-4 space-y-3">
          <div className="h-9 w-56 rounded bg-zinc-100 animate-pulse" />
          <div className="h-4 w-72 rounded bg-zinc-100 animate-pulse" />
          <div className="h-64 rounded bg-zinc-100 animate-pulse" />
        </CardContent>
      </Card>
    )
  if (error) return <div className="text-sm text-red-600">{error}</div>
  if (!canViewAnalytics && !canManageUsers && !canManageRoles) {
    return <div className="text-sm text-zinc-600">You do not have access to Super Admin.</div>
  }

  return (
    <Card className="border-zinc-200 bg-white">
      <CardContent className="p-4">
        <Tabs value={activeTab} onValueChange={onTabChange}>
          <TabsList className="w-full justify-start">
            {canViewAnalytics ? <TabsTrigger value="analytics">Analytics</TabsTrigger> : null}
            {canManageUsers || canManageRoles ? <TabsTrigger value="access">Team & Access</TabsTrigger> : null}
          </TabsList>

          {canViewAnalytics ? (
            <TabsContent value="analytics">
              <SuperAdminAnalytics />
            </TabsContent>
          ) : null}

          {canManageUsers || canManageRoles ? (
            <TabsContent value="access">
              <SuperAdminAccess />
            </TabsContent>
          ) : null}
        </Tabs>
      </CardContent>
    </Card>
  )
}
