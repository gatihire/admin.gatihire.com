"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Building2, Briefcase, CreditCard, Users } from "lucide-react"

export function ClientAdminDashboard() {
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch("/api/clients/stats/dashboard")
        if (res.ok) {
          const data = await res.json()
          setStats(data)
        }
      } catch (e) {
        console.error("Failed to fetch client stats", e)
      } finally {
        setLoading(false)
      }
    }
    fetchStats()
  }, [])

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Client Intelligence Hub</h2>
          <p className="text-muted-foreground">Loading metrics...</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map(i => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="h-20" />
              <CardContent className="h-10" />
            </Card>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Client Intelligence Hub</h2>
        <p className="text-muted-foreground">Overview of client acquisition, job pipeline, and credit usage.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Clients</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalClients || 0}</div>
            <p className="text-xs text-muted-foreground">
              +{stats?.newClients || 0} in the last 7 days
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Client Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalClientUsers || 0}</div>
            <p className="text-xs text-muted-foreground">
              Total registered logistics client users
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Jobs</CardTitle>
            <Briefcase className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.openClientJobs || 0}</div>
            <p className="text-xs text-muted-foreground">
              Out of {stats?.totalClientJobs || 0} total client jobs
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Profile Unlocks</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalUnlocks || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.pendingCreditRequests || 0} pending credit requests
            </p>
          </CardContent>
        </Card>
      </div>
      
      {/* We can expand this with more detailed tables/charts later if needed */}
    </div>
  )
}
