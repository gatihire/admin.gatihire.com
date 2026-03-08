"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Trash2, Loader2, RefreshCw, Mail, Phone, Calendar } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

export default function GoogleCandidatesPage() {
  const [candidates, setCandidates] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const { toast } = useToast()

  const fetchCandidates = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/google-candidates")
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to fetch")
      setCandidates(data)
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const deleteCandidate = async (id: string) => {
    if (!confirm("Are you sure you want to delete this user and all associated data? This cannot be undone.")) return

    setDeletingId(id)
    try {
      const res = await fetch("/api/admin/google-candidates", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to delete")
      
      setCandidates(candidates.filter(c => c.id !== id))
      toast({
        title: "Success",
        description: "Candidate and associated data deleted successfully.",
      })
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      })
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => {
    fetchCandidates()
  }, [])

  const getInitials = (name: string) => {
    return (name || "U")
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2)
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Google Auth Candidates</h1>
          <p className="text-sm text-muted-foreground">Manage users who signed up via board-app (Google Login)</p>
        </div>
        <Button variant="outline" onClick={fetchCandidates} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Candidates List</CardTitle>
          <CardDescription>
            Candidates with an active Google Auth account. Deleting here removes the profile, resume, and extracted text.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center items-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : candidates.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No Google Auth candidates found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Role / Location</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((candidate) => (
                  <TableRow key={candidate.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9">
                          <AvatarFallback className="bg-primary/10 text-primary">
                            {getInitials(candidate.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{candidate.name}</p>
                          <Badge variant="outline" className="text-[10px] h-4">
                            ID: {candidate.id.slice(0, 8)}...
                          </Badge>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1 text-sm">
                        <div className="flex items-center gap-2">
                          <Mail className="h-3 w-3 text-muted-foreground" />
                          <span>{candidate.email}</span>
                        </div>
                        {candidate.phone && (
                          <div className="flex items-center gap-2">
                            <Phone className="h-3 w-3 text-muted-foreground" />
                            <span>{candidate.phone}</span>
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1 text-sm">
                        <div className="font-medium">{candidate.currentRole || "N/A"}</div>
                        <div className="text-muted-foreground">{candidate.location || "N/A"}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        {new Date(candidate.uploadedAt).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => deleteCandidate(candidate.id)}
                        disabled={deletingId === candidate.id}
                      >
                        {deletingId === candidate.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
