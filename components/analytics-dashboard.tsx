"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Search, Upload, Clock, Download, Filter, RefreshCw, Eye, FileText, ExternalLink } from "lucide-react"
import { cachedFetchJson, invalidateSessionCache } from "@/lib/utils"

interface AnalyticsData {
  upload_count: number
  search_count: number
  recent_searches: {
    search_query: string
    created_at: string
    results_count: number
  }[]
  recent_uploads: {
    name: string
    created_at: string
    status: string
  }[]
}

type AnalyticsTab = "summary" | "search" | "uploads"

function getCurrentMonthValue() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  return `${y}-${m}`
}

function buildFilterParams(month: string, startDate: string, endDate: string) {
  const params = new URLSearchParams()
  if (startDate) params.set("startDate", startDate)
  if (endDate) params.set("endDate", endDate)
  if (!startDate && !endDate && month) params.set("month", month)
  return params
}

function toCsv(headers: string[], rows: string[][]) {
  const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n")
}

export function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const [activeTab, setActiveTab] = useState<AnalyticsTab>("summary")
  const [month, setMonth] = useState(getCurrentMonthValue())
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [filterError, setFilterError] = useState("")

  const [searchLogs, setSearchLogs] = useState<any[]>([])
  const [uploadLogs, setUploadLogs] = useState<any[]>([])
  const [logsLoading, setLogsLoading] = useState(false)

  const [selectedUploadLog, setSelectedUploadLog] = useState<any | null>(null)
  const [uploadDetailOpen, setUploadDetailOpen] = useState(false)

  useEffect(() => {
    fetchAnalytics()
    fetchSearchLogs(true)
    fetchUploadLogs(true)
  }, [])

  useEffect(() => {
    if (activeTab === "search") {
      fetchSearchLogs()
    }
    if (activeTab === "uploads") {
      fetchUploadLogs()
    }
  }, [activeTab])

  const fetchAnalytics = async (opts?: { force?: boolean }) => {
    try {
      const jsonData = await cachedFetchJson<AnalyticsData>(`internal:analytics:/api/hr/analytics`, "/api/hr/analytics", undefined, {
        ttlMs: 60_000,
        force: Boolean(opts?.force),
        swr: true,
        onData: (freshData) => setData(freshData)
      })
      setData(jsonData)
    } catch (err: any) {
      console.error(err)
      setError(err.message || "Failed to load analytics data")
    } finally {
      setLoading(false)
    }
  }

  const fetchSearchLogs = async (silent?: boolean, opts?: { force?: boolean }) => {
    if (!silent) setLogsLoading(true)
    try {
      const params = buildFilterParams(month, startDate, endDate)
      const url = `/api/hr/analytics/logs?${params.toString()}`
      const json = await cachedFetchJson<any>(`internal:analytics:${url}`, url, undefined, {
        ttlMs: 60_000,
        force: Boolean(opts?.force),
        swr: true,
        onData: (freshData) => setSearchLogs(freshData.logs || [])
      })
      setSearchLogs(json.logs || [])
    } catch (e) {
    } finally {
      if (!silent) setLogsLoading(false)
    }
  }

  const fetchUploadLogs = async (silent?: boolean, opts?: { force?: boolean }) => {
    if (!silent) setLogsLoading(true)
    try {
      const params = buildFilterParams(month, startDate, endDate)
      const url = `/api/hr/analytics/upload-logs?${params.toString()}`
      const json = await cachedFetchJson<any>(`internal:analytics:${url}`, url, undefined, {
        ttlMs: 60_000,
        force: Boolean(opts?.force),
        swr: true,
        onData: (freshData) => setUploadLogs(freshData.logs || [])
      })
      setUploadLogs(json.logs || [])
    } catch (e) {
    } finally {
      if (!silent) setLogsLoading(false)
    }
  }

  const applyFilters = async () => {
    setFilterError("")
    if (startDate && endDate && startDate > endDate) {
      setFilterError("From date must be earlier than To date")
      return
    }
    setLogsLoading(true)
    try {
      if (activeTab === "search") {
        invalidateSessionCache("internal:analytics:/api/hr/analytics/logs?", { prefix: true })
        await fetchSearchLogs(true, { force: true })
      }
      if (activeTab === "uploads") {
        invalidateSessionCache("internal:analytics:/api/hr/analytics/upload-logs?", { prefix: true })
        await fetchUploadLogs(true, { force: true })
      }
    } finally {
      setLogsLoading(false)
    }
  }

  const resetRange = async () => {
    setFilterError("")
    setStartDate("")
    setEndDate("")
    if (activeTab === "search") await fetchSearchLogs()
    if (activeTab === "uploads") await fetchUploadLogs()
  }

  const downloadActiveCsv = () => {
    if (activeTab === "search") {
      if (!searchLogs.length) return
      const headers = ["Date & Time", "Search Query", "Results Count"]
      const rows = searchLogs.map((log) => [
        new Date(log.created_at).toLocaleString(),
        String(log.search_query || ""),
        String(log.results_count ?? ""),
      ])
      const csv = toCsv(headers, rows)
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
      const link = document.createElement("a")
      const url = URL.createObjectURL(blob)
      link.setAttribute("href", url)
      link.setAttribute("download", `search_logs_${new Date().toISOString().split("T")[0]}.csv`)
      link.style.visibility = "hidden"
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      return
    }

    if (activeTab === "uploads") {
      if (!uploadLogs.length) return
      const headers = [
        "Date & Time",
        "File Name",
        "Status",
        "Result",
        "Candidate ID",
        "Parsing Method",
        "Message",
        "Error Code",
        "Error Message",
      ]
      const rows = uploadLogs.map((log) => [
        new Date(log.created_at).toLocaleString(),
        String(log.file_name || ""),
        String(log.status || ""),
        String(log.result_type || ""),
        String(log.candidate_id || ""),
        String(log.parsing_method || ""),
        String(log.message || ""),
        String(log.error_code || ""),
        String(log.error_message || ""),
      ])
      const csv = toCsv(headers, rows)
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
      const link = document.createElement("a")
      const url = URL.createObjectURL(blob)
      link.setAttribute("href", url)
      link.setAttribute("download", `upload_logs_${new Date().toISOString().split("T")[0]}.csv`)
      link.style.visibility = "hidden"
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-2 text-gray-600">Loading analytics...</span>
      </div>
    )
  }

  if (error) {
    return <div className="p-8 text-center text-red-500">{error}</div>
  }

  if (!data) return null

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as AnalyticsTab)}>
        <div className="flex flex-col gap-3">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="search">Detailed Search Logs</TabsTrigger>
            <TabsTrigger value="uploads">Detailed Upload Logs</TabsTrigger>
          </TabsList>

          {(activeTab === "search" || activeTab === "uploads") && (
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="grid gap-1">
                      <Label htmlFor="month" className="text-xs">Month</Label>
                      <Input
                        id="month"
                        type="month"
                        className="h-8 w-[160px]"
                        value={month}
                        onChange={(e) => setMonth(e.target.value)}
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="grid gap-1">
                        <Label htmlFor="start-date" className="text-xs">From</Label>
                        <Input
                          id="start-date"
                          type="date"
                          className="h-8 w-[140px]"
                          value={startDate}
                          onChange={(e) => setStartDate(e.target.value)}
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor="end-date" className="text-xs">To</Label>
                        <Input
                          id="end-date"
                          type="date"
                          className="h-8 w-[140px]"
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={applyFilters} disabled={logsLoading}>
                      {logsLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Filter className="h-4 w-4 mr-2" />}
                      Apply
                    </Button>
                    <Button variant="outline" size="sm" onClick={resetRange} disabled={logsLoading}>
                      Reset
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={downloadActiveCsv}
                      disabled={logsLoading || (activeTab === "search" ? searchLogs.length === 0 : uploadLogs.length === 0)}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      CSV
                    </Button>
                  </div>
                </div>

                {(startDate || endDate) && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Range overrides month
                  </div>
                )}

                {filterError && (
                  <div className="mt-2 text-xs text-red-600">
                    {filterError}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <TabsContent value="summary" className="mt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Uploads</CardTitle>
                <Upload className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data.upload_count}</div>
                <p className="text-xs text-muted-foreground">Resumes uploaded by you</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Searches</CardTitle>
                <Search className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data.search_count}</div>
                <p className="text-xs text-muted-foreground">Searches performed by you</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5" />
                  Recent Searches
                </CardTitle>
                <CardDescription>Your last 5 searches</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {data.recent_searches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No recent searches</p>
                  ) : (
                    data.recent_searches.map((search, i) => (
                      <div key={i} className="flex justify-between items-center border-b pb-2 last:border-0">
                        <div>
                          <p className="font-medium text-sm">{search.search_query || "All candidates"}</p>
                          <p className="text-xs text-muted-foreground">{new Date(search.created_at).toLocaleDateString()}</p>
                        </div>
                        <div className="text-sm text-muted-foreground">{search.results_count} results</div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Upload className="h-5 w-5" />
                  Recent Uploads
                </CardTitle>
                <CardDescription>Your last 5 uploads</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {data.recent_uploads.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No recent uploads</p>
                  ) : (
                    data.recent_uploads.map((upload, i) => (
                      <div key={i} className="flex justify-between items-center border-b pb-2 last:border-0">
                        <div>
                          <p className="font-medium text-sm">{upload.name}</p>
                          <p className="text-xs text-muted-foreground">{new Date(upload.created_at).toLocaleDateString()}</p>
                        </div>
                        <div className="text-sm">
                          <span
                            className={`px-2 py-1 rounded-full text-xs ${
                              upload.status === "hired"
                                ? "bg-green-100 text-green-800"
                                : upload.status === "rejected"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-blue-100 text-blue-800"
                            }`}
                          >
                            {upload.status}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="search" className="mt-6">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Search className="h-5 w-5" />
                  Detailed Search Logs
                </CardTitle>
                <CardDescription>View and download your search history</CardDescription>
              </div>
              <div className="text-xs text-muted-foreground">
                Rows: {logsLoading ? "…" : searchLogs.length}
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date & Time</TableHead>
                      <TableHead>Search Query</TableHead>
                      <TableHead>Results</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logsLoading ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center py-8">
                          <div className="flex justify-center">
                            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : searchLogs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                          No search logs found for the selected period
                        </TableCell>
                      </TableRow>
                    ) : (
                      searchLogs.map((log) => (
                        <TableRow key={log.id}>
                          <TableCell className="font-medium">{new Date(log.created_at).toLocaleString()}</TableCell>
                          <TableCell>{log.search_query}</TableCell>
                          <TableCell>{log.results_count}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="uploads" className="mt-6">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Upload className="h-5 w-5" />
                  Detailed Upload Logs
                </CardTitle>
                <CardDescription>View and download your resume upload history</CardDescription>
              </div>
              <div className="text-xs text-muted-foreground">
                Rows: {logsLoading ? "…" : uploadLogs.length}
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date & Time</TableHead>
                      <TableHead>File</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>Errors</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logsLoading ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-8">
                          <div className="flex justify-center">
                            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : uploadLogs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                          No upload logs found for the selected period
                        </TableCell>
                      </TableRow>
                    ) : (
                      uploadLogs.map((log) => (
                        <TableRow key={log.id}>
                          <TableCell className="font-medium">{new Date(log.created_at).toLocaleString()}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <FileText className="h-4 w-4 text-muted-foreground" />
                              <span className="truncate max-w-[260px]">{log.file_name || ""}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span
                              className={`px-2 py-1 rounded-full text-xs ${
                                String(log.status) === "failed"
                                  ? "bg-red-100 text-red-800"
                                  : String(log.status) === "completed"
                                    ? "bg-green-100 text-green-800"
                                    : "bg-blue-100 text-blue-800"
                              }`}
                            >
                              {String(log.status || "")}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm">{String(log.result_type || "")}</span>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm">{log.error_message ? "Yes" : "No"}</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setSelectedUploadLog(log)
                                setUploadDetailOpen(true)
                              }}
                            >
                              <Eye className="h-4 w-4 mr-2" />
                              View
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={uploadDetailOpen} onOpenChange={setUploadDetailOpen}>
        <DialogContent className="sm:max-w-[1120px]">
          <DialogHeader>
            <DialogTitle>Upload Details</DialogTitle>
          </DialogHeader>
          {!selectedUploadLog ? (
            <div className="text-sm text-muted-foreground">No log selected</div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3 rounded-md border">
                    <div className="text-xs text-muted-foreground">Created At</div>
                    <div className="text-sm font-medium">{new Date(selectedUploadLog.created_at).toLocaleString()}</div>
                  </div>
                  <div className="p-3 rounded-md border">
                    <div className="text-xs text-muted-foreground">Result</div>
                    <div className="text-sm font-medium">{String(selectedUploadLog.result_type || "")}</div>
                  </div>
                  <div className="p-3 rounded-md border sm:col-span-2">
                    <div className="text-xs text-muted-foreground">File</div>
                    <div className="text-sm font-medium break-words">{String(selectedUploadLog.resume_file_name || selectedUploadLog.file_name || "")}</div>
                  </div>
                  <div className="p-3 rounded-md border">
                    <div className="text-xs text-muted-foreground">Candidate ID</div>
                    <div className="text-sm font-medium break-words">{String(selectedUploadLog.candidate_id || "")}</div>
                  </div>
                  <div className="p-3 rounded-md border">
                    <div className="text-xs text-muted-foreground">Parsing Method</div>
                    <div className="text-sm font-medium">{String(selectedUploadLog.parsing_method || "")}</div>
                  </div>
                  <div className="p-3 rounded-md border sm:col-span-2">
                    <div className="text-xs text-muted-foreground">Message</div>
                    <div className="text-sm font-medium break-words">{String(selectedUploadLog.message || "")}</div>
                  </div>
                </div>

                {(selectedUploadLog.error_message || selectedUploadLog.error_code) && (
                  <div className="p-3 rounded-md border border-red-200 bg-red-50">
                    <div className="text-sm font-medium text-red-800">Error</div>
                    <div className="text-sm text-red-700 mt-1 break-words">
                      {String(selectedUploadLog.error_code || "")}
                      {selectedUploadLog.error_code && selectedUploadLog.error_message ? ": " : ""}
                      {String(selectedUploadLog.error_message || "")}
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-md border overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
                  <div className="text-sm font-medium">Resume Preview</div>
                  <div className="flex items-center gap-2">
                    {selectedUploadLog.resume_url && (
                      <Button asChild variant="outline" size="sm">
                        <a href={String(selectedUploadLog.resume_url)} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-4 w-4 mr-2" />
                          Open
                        </a>
                      </Button>
                    )}
                  </div>
                </div>

                {!selectedUploadLog.resume_url ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Resume preview is not available for this upload.
                  </div>
                ) : String(selectedUploadLog.resume_file_type || "").includes("pdf") ||
                  String(selectedUploadLog.resume_file_name || "").toLowerCase().endsWith(".pdf") ? (
                  <iframe
                    title="Resume Preview"
                    src={String(selectedUploadLog.resume_url)}
                    className="w-full h-[70vh]"
                  />
                ) : (
                  <div className="p-4 text-sm">
                    <div className="text-muted-foreground">Preview is best supported for PDF files.</div>
                    <div className="mt-3">
                      <Button asChild variant="outline" size="sm">
                        <a href={String(selectedUploadLog.resume_url)} target="_blank" rel="noreferrer">
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </a>
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
