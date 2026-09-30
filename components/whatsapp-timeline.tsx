"use client"

import { useState } from "react"
import {
  MessageCircle,
  Send,
  User,
  ChevronDown,
  ChevronUp,
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

interface WhatsAppTimelineProps {
  participant: {
    id: string
    status: string
    whatsapp_history: WhatsAppMessage[] | null
    whatsapp_outbound_template: string | null
    whatsapp_sent_at: string | null
    whatsapp_delivery_status: string | null
    whatsapp_response: string | null
    whatsapp_reply_text: string | null
    info_request_sent_at: string | null
    info_received_at: string | null
    call_attempts: number
    retry_count: number
    bolna_status: string | null
    bolna_execution_id?: string | null
    last_attempt_at: string | null
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

const STATUS_COLORS: Record<string, string> = {
  sent: "text-blue-500",
  delivered: "text-green-500",
  read: "text-green-600",
  failed: "text-red-500",
  pending: "text-zinc-400",
}

export function WhatsAppTimeline({ participant, candidateName }: WhatsAppTimelineProps) {
  const [isOpen, setIsOpen] = useState(false)
  
  const history = participant.whatsapp_history || []
  
  // Build timeline events
  const events: Array<{
    time: string
    type: "sent" | "received" | "call" | "info"
    template?: string
    status?: string
    content: string
    color: string
  }> = []
  
  // Add WhatsApp messages from history
  history.forEach((msg) => {
    events.push({
      time: msg.sentAt,
      type: "sent",
      template: msg.template,
      status: msg.status,
      content: TEMPLATE_LABELS[msg.template] || msg.template,
      color: STATUS_COLORS[msg.status] || "text-blue-500",
    })
  })
  
  // Add reply if any
  if (participant.whatsapp_response || participant.whatsapp_reply_text) {
    events.push({
      time: participant.whatsapp_sent_at || new Date().toISOString(),
      type: "received",
      content: participant.whatsapp_reply_text || participant.whatsapp_response || "Replied",
      color: "text-green-500",
    })
  }
  
  // Add info collection events
  if (participant.info_request_sent_at) {
    events.push({
      time: participant.info_request_sent_at,
      type: "info",
      content: "Info request sent",
      color: "text-amber-500",
    })
  }
  if (participant.info_received_at) {
    events.push({
      time: participant.info_received_at,
      type: "received",
      content: "Info received from candidate",
      color: "text-green-500",
    })
  }
  
  // Add call events — only once the provider has confirmed a call exists.
  const truth = getCallTruth(participant)
  if (participant.bolna_execution_id) {
    events.push({
      time: participant.last_attempt_at || new Date().toISOString(),
      type: "call",
      content: truth.detail,
      color: truth.state === "completed" ? "text-green-500" : truth.toneClasses,
    })
  }
  
  // Sort by time
  events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
  
  if (events.length === 0) return null
  
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-zinc-500 hover:text-zinc-700 p-1"
        >
          <MessageCircle className="h-3.5 w-3.5 mr-1" />
          {history.length > 0 ? `${history.length} messages` : "View flow"}
          {isOpen ? <ChevronUp className="h-3 w-3 ml-1" /> : <ChevronDown className="h-3 w-3 ml-1" />}
        </Button>
      </CollapsibleTrigger>
      
      <CollapsibleContent>
        <Card className="mt-2 border-zinc-200 bg-zinc-50/50">
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-semibold text-zinc-600 flex items-center gap-2">
              <MessageCircle className="h-3.5 w-3.5" />
              WhatsApp Flow — {candidateName}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="relative">
              {/* Vertical line */}
              <div className="absolute left-3 top-0 bottom-0 w-0.5 bg-zinc-200" />
              
              <div className="space-y-3">
                {events.map((event, index) => {
                  const isOutbound = event.type === "sent" || event.type === "info"
                  
                  return (
                    <div key={index} className="relative flex items-start gap-3 pl-6">
                      {/* Dot */}
                      <div className={`absolute left-1.5 top-1 w-3 h-3 rounded-full border-2 border-white ${
                        event.type === "received" ? "bg-green-500" :
                        event.type === "call" ? "bg-orange-500" :
                        "bg-blue-500"
                      }`} />
                      
                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-zinc-700">{event.content}</span>
                          {event.status && event.status !== "sent" && (
                            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${STATUS_COLORS[event.status]}`}>
                              {event.status}
                            </Badge>
                          )}
                        </div>
                        <p className="text-[10px] text-zinc-400 mt-0.5">
                          {new Date(event.time).toLocaleString("en-IN", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                      
                      {/* Direction indicator */}
                      <div className={`shrink-0 ${isOutbound ? "text-blue-500" : "text-green-500"}`}>
                        {isOutbound ? (
                          <Send className="h-3.5 w-3.5" />
                        ) : (
                          <User className="h-3.5 w-3.5" />
                        )}
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
