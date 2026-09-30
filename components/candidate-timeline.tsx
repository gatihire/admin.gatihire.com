"use client"

import { useState } from "react"
import { 
  MessageCircle, 
  Send, 
  CheckCheck, 
  Check, 
  Clock, 
  Phone, 
  PhoneOff,
  AlertCircle,
  User,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  FileText,
  Bot
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { getCallTruth } from "@/lib/call-truth"

interface WhatsAppMessage {
  messageId: string | null
  template: string
  sentAt: string
  status: string
}

interface TimelineEvent {
  time: string
  type: "whatsapp_sent" | "whatsapp_delivered" | "whatsapp_read" | "whatsapp_reply" | "info_request" | "info_received" | "call_attempt" | "call_completed" | "call_failed" | "retry_scheduled"
  content: string
  details?: string
  status?: "success" | "pending" | "failed"
}

interface CandidateTimelineProps {
  participant: {
    id: string
    status: string
    whatsapp_history: WhatsAppMessage[] | null
    whatsapp_outbound_template: string | null
    whatsapp_sent_at: string | null
    whatsapp_delivery_status: string | null
    whatsapp_response: string | null
    whatsapp_reply_text: string | null
    whatsapp_reply_at: string | null
    info_request_sent_at: string | null
    info_received_at: string | null
    call_attempts: number
    retry_count: number
    bolna_status: string | null
    last_attempt_at: string | null
    next_retry_at: string | null
    call_started_at: string | null
    call_ended_at: string | null
    call_duration_seconds: number | null
    bolna_execution_id?: string | null
    updated_at?: string | null
    ai_score: number | null
    ai_summary: string | null
    ai_recommendation: string | null
  }
  candidateName: string
}

const TEMPLATE_LABELS: Record<string, string> = {
  talent_outreach: "Talent Outreach",
  inbound_screening_invite: "Screening Invite",
  screening_invite: "Screening Invite",
  inbound_info_request: "Info Request",
  outbound_info_request: "Info Request",
  info_received_confirm: "Info Confirmed",
  ai_call_reassurance: "Call Reassurance",
  call_nudge: "Pre-call Nudge",
  tried_calling: "Missed Call",
  missed_call_reschedule: "Reschedule Options",
  reminder_nudge: "Reminder",
  schedule_options: "Schedule Options",
  pre_call_context: "Pre-call Context",
  post_call_followup: "Post-call Followup",
}

export function CandidateTimeline({ participant, candidateName }: CandidateTimelineProps) {
  const [isOpen, setIsOpen] = useState(false)
  
  // Build timeline events from participant data
  const events: TimelineEvent[] = []
  
  // WhatsApp messages from history
  const history = participant.whatsapp_history || []
  history.forEach((msg) => {
    const isInfoRequest = msg.template?.includes("info_request")
    events.push({
      time: msg.sentAt,
      type: isInfoRequest ? "info_request" : "whatsapp_sent",
      content: TEMPLATE_LABELS[msg.template] || msg.template,
      details: msg.messageId || undefined,
      status: msg.status === "failed" ? "failed" : "pending",
    })
  })
  
  // Delivery status updates
  if (participant.whatsapp_delivery_status && participant.whatsapp_sent_at) {
    const deliveryTime = new Date(participant.whatsapp_sent_at).getTime() + 60000 // +1 min estimate
    if (participant.whatsapp_delivery_status === "delivered" || participant.whatsapp_delivery_status === "read") {
      events.push({
        time: new Date(deliveryTime).toISOString(),
        type: participant.whatsapp_delivery_status === "read" ? "whatsapp_read" : "whatsapp_delivered",
        content: participant.whatsapp_delivery_status === "read" ? "Message read by candidate" : "Message delivered to candidate",
        status: "success",
      })
    }
  }
  
  // Candidate reply
  if (participant.whatsapp_response || participant.whatsapp_reply_text) {
    events.push({
      time: participant.whatsapp_reply_at || participant.whatsapp_sent_at || new Date().toISOString(),
      type: "whatsapp_reply",
      content: `Candidate replied: "${participant.whatsapp_reply_text || participant.whatsapp_response}"`,
      status: "success",
    })
  }
  
  // Info received
  if (participant.info_received_at) {
    events.push({
      time: participant.info_received_at,
      type: "info_received",
      content: "Basic info collected from candidate",
      status: "success",
    })
  }
  
  // Call attempts — only rendered once a call was actually accepted by the
  // provider. Never claim "no answer" just because no status came back.
  if (participant.bolna_execution_id && (participant.call_attempts > 0 || participant.last_attempt_at)) {
    const attemptTime = participant.last_attempt_at || new Date().toISOString()
    const truth = getCallTruth(participant)
    const isCompleted = participant.bolna_status === "completed"
    const isSuccess = truth.state === "completed"

    events.push({
      time: attemptTime,
      type: isCompleted ? "call_completed" : "call_attempt",
      content: truth.detail,
      details: participant.ai_summary || undefined,
      status: isSuccess ? "success" : truth.tone === "danger" || truth.tone === "warning" ? "failed" : "pending",
    })

    // AI results if call completed
    if (isCompleted && participant.ai_score != null) {
      events.push({
        time: attemptTime,
        type: "call_completed",
        content: `AI Score: ${participant.ai_score}/10 — ${participant.ai_recommendation || "pending review"}`,
        status: "success",
      })
    }
  } else if (participant.call_attempts === 0) {
    // Be explicit that nothing was placed — this is the state HR could not see.
    const truth = getCallTruth(participant)
    events.push({
      time: participant.updated_at || new Date().toISOString(),
      type: "call_failed",
      content: truth.detail,
      status: truth.tone === "danger" ? "failed" : "pending",
    })
  }
  
  // Retry scheduled
  if (participant.next_retry_at && participant.bolna_status !== "completed") {
    events.push({
      time: participant.next_retry_at,
      type: "retry_scheduled",
      content: `Auto-retry scheduled`,
      details: `Next attempt at ${new Date(participant.next_retry_at).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit" })}`,
      status: "pending",
    })
  }
  
  // Sort by time
  events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
  
  if (events.length === 0) return null
  
  const getEventIcon = (event: TimelineEvent) => {
    switch (event.type) {
      case "whatsapp_sent": return Send
      case "whatsapp_delivered": return Check
      case "whatsapp_read": return CheckCheck
      case "whatsapp_reply": return MessageCircle
      case "info_request": return Send
      case "info_received": return CheckCheck
      case "call_attempt": return PhoneOff
      case "call_completed": return Phone
      case "call_failed": return PhoneOff
      case "retry_scheduled": return RefreshCw
      default: return Clock
    }
  }
  
  const getEventColor = (event: TimelineEvent) => {
    if (event.status === "success") return "text-green-500"
    if (event.status === "failed") return "text-red-500"
    if (event.status === "pending") return "text-amber-500"
    return "text-zinc-400"
  }
  
  const getDotColor = (event: TimelineEvent) => {
    if (event.status === "success") return "bg-green-500"
    if (event.status === "failed") return "bg-red-500"
    if (event.status === "pending") return "bg-amber-500"
    return "bg-zinc-300"
  }
  
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-zinc-500 hover:text-zinc-700 p-1"
        >
          <Clock className="h-3.5 w-3.5 mr-1" />
          Timeline ({events.length})
          {isOpen ? <ChevronUp className="h-3 w-3 ml-1" /> : <ChevronDown className="h-3 w-3 ml-1" />}
        </Button>
      </CollapsibleTrigger>
      
      <CollapsibleContent>
        <Card className="mt-2 border-zinc-200 bg-zinc-50/50">
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-semibold text-zinc-600 flex items-center gap-2">
              <Clock className="h-3.5 w-3.5" />
              Activity Timeline — {candidateName}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 max-h-64 overflow-y-auto">
            <div className="relative">
              {/* Vertical line */}
              <div className="absolute left-3 top-0 bottom-0 w-0.5 bg-zinc-200" />
              
              <div className="space-y-3">
                {events.map((event, index) => {
                  const Icon = getEventIcon(event)
                  const iconColor = getEventColor(event)
                  const dotColor = getDotColor(event)
                  
                  return (
                    <div key={index} className="relative flex items-start gap-3 pl-6">
                      {/* Dot */}
                      <div className={`absolute left-1.5 top-1 w-3 h-3 rounded-full border-2 border-white ${dotColor}`} />
                      
                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Icon className={`h-3.5 w-3.5 shrink-0 ${iconColor}`} />
                          <span className="text-xs font-medium text-zinc-700">{event.content}</span>
                        </div>
                        {event.details && (
                          <p className="text-[10px] text-zinc-500 mt-0.5 ml-5">{event.details}</p>
                        )}
                        <p className="text-[10px] text-zinc-400 mt-0.5 ml-5">
                          {new Date(event.time).toLocaleString("en-IN", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  )
}
