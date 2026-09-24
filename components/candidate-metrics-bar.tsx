"use client"

import { useMemo } from "react"
import { 
  Send, 
  Check, 
  CheckCheck, 
  Phone, 
  PhoneOff, 
  Clock, 
  MessageCircle, 
  RefreshCw,
  AlertCircle,
  User
} from "lucide-react"
import { Badge } from "@/components/ui/badge"

interface ParticipantData {
  whatsapp_sent_at: string | null
  whatsapp_delivery_status: string | null
  whatsapp_response: string | null
  whatsapp_reply_text: string | null
  info_data?: Record<string, unknown> | null
  call_attempts: number
  retry_count: number
  next_retry_at: string | null
  last_attempt_at: string | null
  info_request_sent_at: string | null
  info_received_at: string | null
  bolna_status: string | null
  created_at: string
}

interface CandidateMetricsBarProps {
  participant: ParticipantData | null
  callStatus: string
}

function formatTimeSince(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  
  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${diffDays}d ago`
}

function formatTimeUntil(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  
  if (diffMins <= 0) return "now"
  if (diffMins < 60) return `in ${diffMins}m`
  if (diffHours < 24) return `in ${diffHours}h`
  return `in ${Math.floor(diffHours / 24)}d`
}

export function CandidateMetricsBar({ participant, callStatus }: CandidateMetricsBarProps) {
  const metrics = useMemo(() => {
    if (!participant) return null
    
    const sentAt = participant.whatsapp_sent_at || participant.info_request_sent_at
    const delivery = participant.whatsapp_delivery_status
    const hasReply = !!(participant.whatsapp_response || participant.whatsapp_reply_text)
    const callAttempts = participant.call_attempts || 0
    const retryCount = participant.retry_count || 0
    const nextRetry = participant.next_retry_at
    const lastAttempt = participant.last_attempt_at
    const bolnaStatus = participant.bolna_status
    
    return {
      sentAt,
      delivery,
      hasReply,
      callAttempts,
      retryCount,
      nextRetry,
      lastAttempt,
      bolnaStatus,
    }
  }, [participant])
  
  if (!metrics) return null
  
  // Build metrics items based on callStatus
  const items: Array<{
    icon: any
    label: string
    value: string
    color: string
  }> = []
  
  // Last contact time
  if (metrics.sentAt) {
    items.push({
      icon: Send,
      label: "Sent",
      value: formatTimeSince(metrics.sentAt),
      color: "text-zinc-500",
    })
  }
  
  // Delivery status
  if (metrics.delivery) {
    const deliveryIcon = metrics.delivery === "read" ? CheckCheck : 
                        metrics.delivery === "delivered" ? Check : Send
    const deliveryColor = metrics.delivery === "read" ? "text-green-500" :
                         metrics.delivery === "delivered" ? "text-blue-500" :
                         metrics.delivery === "failed" ? "text-red-500" : "text-zinc-400"
    items.push({
      icon: deliveryIcon,
      label: "",
      value: metrics.delivery,
      color: deliveryColor,
    })
  }
  
  // Reply status
  if (metrics.hasReply) {
    items.push({
      icon: MessageCircle,
      label: "Replied",
      value: participant?.whatsapp_reply_text || "Yes",
      color: "text-green-600",
    })
  }

  // Structured fields collected & parsed by AI
  const infoData = participant?.info_data
  const infoFieldCount = infoData ? Object.values(infoData).filter(v => v !== null && v !== undefined && v !== "").length : 0
  if (infoFieldCount > 0) {
    items.push({
      icon: CheckCheck,
      label: "",
      value: `${infoFieldCount} field${infoFieldCount !== 1 ? "s" : ""} collected`,
      color: "text-teal-600",
    })
  }

  // Call attempts
  if (metrics.callAttempts > 0) {
    items.push({
      icon: metrics.bolnaStatus === "completed" ? Phone : PhoneOff,
      label: "Calls",
      value: `${metrics.callAttempts} attempt${metrics.callAttempts !== 1 ? "s" : ""}`,
      color: metrics.bolnaStatus === "completed" ? "text-green-500" : "text-orange-500",
    })
  }
  
  // Next retry
  if (metrics.nextRetry && callStatus === "calling") {
    items.push({
      icon: RefreshCw,
      label: "Next retry",
      value: formatTimeUntil(metrics.nextRetry),
      color: "text-blue-500",
    })
  }
  
  if (items.length === 0) return null
  
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 mt-1.5">
      {items.map((item, index) => {
        const Icon = item.icon
        return (
          <span key={index} className={`inline-flex items-center gap-1 ${item.color}`}>
            <Icon className="h-3 w-3 shrink-0" />
            {item.label && <span className="text-zinc-400">{item.label}:</span>}
            <span className="font-medium">{item.value}</span>
          </span>
        )
      })}
    </div>
  )
}
