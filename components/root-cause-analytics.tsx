"use client"

import { useMemo } from "react"
import { 
  BarChart3, 
  PhoneOff, 
  MessageCircle, 
  Clock, 
  AlertTriangle,
  CheckCircle,
  TrendingDown,
  Phone,
  Send,
  Users,
  Lightbulb
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getCallTruth } from "@/lib/call-truth"
import { Badge } from "@/components/ui/badge"

interface Participant {
  id: string
  status: string
  whatsapp_delivery_status: string | null
  whatsapp_response: string | null
  whatsapp_reply_text: string | null
  bolna_status: string | null
  bolna_execution_id?: string | null
  call_attempts: number
  retry_count: number
  next_retry_at: string | null
  info_request_sent_at: string | null
  info_received_at: string | null
  whatsapp_sent_at: string | null
  last_attempt_at: string | null
  created_at: string
}

interface RootCauseAnalyticsProps {
  participants: Participant[]
}

interface AnalyticsSummary {
  total: number
  byGroup: Record<string, number>
  responseRate: number
  infoCollectionRate: number
  callSuccessRate: number
  avgAttemptsBeforeSuccess: number
  commonFailures: Array<{ reason: string; count: number; percentage: number }>
  /** Calls the provider confirmed as completed (picked up + finished). */
  callsCompleted: number
  recommendation: string
}

export function RootCauseAnalytics({ participants }: RootCauseAnalyticsProps) {
  const analytics = useMemo<AnalyticsSummary>(() => {
    const total = participants.length
    
    if (total === 0) {
      return {
        total: 0,
        byGroup: {},
        responseRate: 0,
        infoCollectionRate: 0,
        callSuccessRate: 0,
        avgAttemptsBeforeSuccess: 0,
        commonFailures: [],
        callsCompleted: 0,
        recommendation: "No candidates in pipeline yet.",
      }
    }
    
    // Count by group
    const byGroup: Record<string, number> = {}
    let responded = 0
    let infoRequested = 0
    let infoReceived = 0
    let callsCompleted = 0
    let totalAttempts = 0
    let successfulCalls = 0
    
    const failureReasons: Record<string, number> = {}
    
    participants.forEach((p) => {
      // Same derivation the cards use, so the analytics never disagree with
      // what a recruiter sees on the pipeline.
      const truth = getCallTruth(p)
      const group = truth.bucket

      byGroup[group] = (byGroup[group] || 0) + 1

      // Count a call as placed only when the provider gave us an execution id —
      // incremented counters alone proved nothing about a real dial.
      if (p.bolna_execution_id) {
        totalAttempts += p.call_attempts || 1
      }

      if (truth.state === "completed") {
        callsCompleted++
        successfulCalls++
      }

      if (p.whatsapp_response || p.whatsapp_reply_text) responded++
      if (p.status === "info_received" || p.info_received_at) infoReceived++
      if (p.status === "info_requested" || p.info_request_sent_at) infoRequested++

      // Attribute the failure to the real cause, distinguishing "the candidate
      // didn't answer" from "the call never got out".
      if (group === "failed") {
        failureReasons[truth.state] = (failureReasons[truth.state] || 0) + 1
      }
    })
    
    // Calculate rates
    const responseRate = total > 0 ? (responded / total) * 100 : 0
    const infoCollectionRate = infoRequested > 0 ? (infoReceived / infoRequested) * 100 : 0
    const callSuccessRate = totalAttempts > 0 ? (successfulCalls / totalAttempts) * 100 : 0
    const avgAttemptsBeforeSuccess = successfulCalls > 0 ? totalAttempts / successfulCalls : 0
    
    // Common failures
    const commonFailures = Object.entries(failureReasons)
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
    
    // Generate recommendation
    let recommendation = ""
    const failedCount = byGroup.failed || 0
    const waitingCount = byGroup.waiting || 0
    const noAnswerCount = failureReasons["no_answer"] || 0
    
    if (failedCount > total * 0.3) {
      recommendation = `${Math.round((failedCount / total) * 100)}% failure rate. Consider varying call times or adding more WhatsApp follow-ups.`
    } else if (noAnswerCount > 2) {
      recommendation = `${noAnswerCount} no-answer cases. Try calling during different hours (10 AM - 12 PM or 4 PM - 6 PM works best).`
    } else if (waitingCount > total * 0.5) {
      recommendation = `${waitingCount} candidates waiting. Consider sending a reminder nudge after 4 hours.`
    } else if (responseRate < 30) {
      recommendation = `Low response rate (${Math.round(responseRate)}%). Review WhatsApp template messaging.`
    } else {
      recommendation = "Pipeline is healthy. Keep monitoring response rates."
    }
    
    return {
      total,
      byGroup,
      responseRate,
      infoCollectionRate,
      callSuccessRate,
      avgAttemptsBeforeSuccess,
      commonFailures,
      callsCompleted,
      recommendation,
    }
  }, [participants])
  
  if (analytics.total === 0) return null
  
  // Keys are call-truth states, so a failure is always attributed to a cause we
  // can actually prove (the candidate didn't pick up vs the call never got out).
  const failureReasonLabels: Record<string, string> = {
    no_answer: "Rang out, no answer",
    busy: "Line busy",
    voicemail: "Went to voicemail",
    partial: "Hung up mid-call",
    our_side_failed: "Failed on our side",
    rejected: "Rejected by provider",
    not_placed: "No call was ever placed",
  }
  
  return (
    <Card className="border-zinc-200">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-zinc-500" />
          Pipeline Analytics
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Response Rate */}
          <div className="p-3 bg-green-50 rounded-lg border border-green-100">
            <div className="flex items-center gap-2 mb-1">
              <MessageCircle className="h-3.5 w-3.5 text-green-600" />
              <span className="text-[10px] font-semibold text-green-700 uppercase">Response Rate</span>
            </div>
            <p className="text-2xl font-bold text-green-800">{analytics.responseRate.toFixed(1)}%</p>
            <p className="text-[10px] text-green-600 mt-0.5">
              {analytics.byGroup.engaged || 0} engaged
            </p>
          </div>
          
          {/* Call Success Rate */}
          <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
            <div className="flex items-center gap-2 mb-1">
              <Phone className="h-3.5 w-3.5 text-blue-600" />
              <span className="text-[10px] font-semibold text-blue-700 uppercase">Call Success</span>
            </div>
            <p className="text-2xl font-bold text-blue-800">{analytics.callSuccessRate.toFixed(1)}%</p>
            <p className="text-[10px] text-blue-600 mt-0.5">
              {analytics.callsCompleted} completed of the calls the provider actually placed
            </p>
          </div>
          
          {/* Waiting */}
          <div className="p-3 bg-amber-50 rounded-lg border border-amber-100">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-3.5 w-3.5 text-amber-600" />
              <span className="text-[10px] font-semibold text-amber-700 uppercase">Waiting</span>
            </div>
            <p className="text-2xl font-bold text-amber-800">{analytics.byGroup.waiting || 0}</p>
            <p className="text-[10px] text-amber-600 mt-0.5">
              for response
            </p>
          </div>
          
          {/* Failed */}
          <div className="p-3 bg-red-50 rounded-lg border border-red-100">
            <div className="flex items-center gap-2 mb-1">
              <PhoneOff className="h-3.5 w-3.5 text-red-600" />
              <span className="text-[10px] font-semibold text-red-700 uppercase">Failed</span>
            </div>
            <p className="text-2xl font-bold text-red-800">{analytics.byGroup.failed || 0}</p>
            <p className="text-[10px] text-red-600 mt-0.5">
              needs follow-up
            </p>
          </div>
        </div>
        
        {/* Common Failure Reasons */}
        {analytics.commonFailures.length > 0 && (
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-zinc-600 mb-2 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              Why Candidates Aren't Connecting
            </h4>
            <div className="space-y-2">
              {analytics.commonFailures.map((failure) => (
                <div key={failure.reason} className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-zinc-700">
                        {failureReasonLabels[failure.reason] || failure.reason}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        {failure.count} ({failure.percentage.toFixed(0)}%)
                      </span>
                    </div>
                    <div className="w-full bg-zinc-100 rounded-full h-1.5">
                      <div
                        className="bg-red-400 h-1.5 rounded-full"
                        style={{ width: `${failure.percentage}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        {/* Recommendation */}
        <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
          <div className="flex items-start gap-2">
            <Lightbulb className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold text-blue-700 mb-0.5">Recommendation</p>
              <p className="text-xs text-blue-600">{analytics.recommendation}</p>
            </div>
          </div>
        </div>
        
        {/* Status Breakdown */}
        <div className="mt-4 pt-3 border-t border-zinc-100">
          <h4 className="text-xs font-semibold text-zinc-600 mb-2">Status Breakdown</h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(analytics.byGroup)
              .sort(([, a], [, b]) => b - a)
              .map(([group, count]) => (
                <Badge
                  key={group}
                  variant="outline"
                  className={`text-[10px] px-2 py-0.5 ${
                    group === "done" ? "bg-green-50 text-green-700 border-green-200" :
                    group === "engaged" ? "bg-green-50 text-green-600 border-green-200" :
                    group === "waiting" ? "bg-amber-50 text-amber-700 border-amber-200" :
                    group === "calling" ? "bg-blue-50 text-blue-700 border-blue-200" :
                    group === "failed" ? "bg-red-50 text-red-700 border-red-200" :
                    "bg-zinc-50 text-zinc-600 border-zinc-200"
                  }`}
                >
                  <span className="capitalize">{group}</span>
                  <span className="ml-1 font-bold">{count}</span>
                </Badge>
              ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
