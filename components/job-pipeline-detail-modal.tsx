"use client"

import { useMemo } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  PhoneCall, Mail, MapPin, Briefcase, Clock, Sparkles, ExternalLink,
  MessageCircle, ArrowRight, UserCheck,
} from "lucide-react"
import { PreScreenVerdict, CollectedInfoView } from "@/components/candidate-collected-info"
import { getCallTruth } from "@/lib/call-truth"
import { stageLabelSafe, nextStage, PIPELINE_COLUMNS, type PipelineStageId } from "./job-pipeline-stages"

/**
 * The pipeline detail modal.
 *
 * THE RULE
 *
 * The card shows three things: who, how good a match, what needs attention.
 * Everything else lives here — but in a fixed order that matches how a
 * recruiter actually reads a candidate:
 *
 *   1. Who + what they do      (header)
 *   2. What needs my attention (the status block — the reason they are here)
 *   3. What the AI found        (pre-screen verdict + collected info)
 *   4. How to reach them        (phone / email / WhatsApp)
 *   5. What to do next          (the action bar)
 *
 * Nothing in here is hidden behind a tab or an expander. If a recruiter has
 * to click twice to find the phone number, they will not call.
 */

export interface PipelineDetailData {
  applicationId: string
  name: string
  email: string
  phone: string
  role: string
  company: string
  location: string
  experience: string
  summary: string
  fitScore: number | null
  aiScore: number | null
  aiRecommendation: string | null
  stage: string
  appliedAgo: string
  ageLabel: string
  clientDecision: string | null
  participant: any
  /** The recruiter's own notes. */
  notes: string
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
      <span className="mt-0.5 shrink-0 text-zinc-400">{icon}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{title}</h4>
      {children}
    </section>
  )
}

export function PipelineDetailModal({
  open,
  onOpenChange,
  data,
  busy,
  onMoveStage,
  onCallNow,
  onNudge,
  onViewResults,
  onOpenFullProfile,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data: PipelineDetailData | null
  busy?: boolean
  onMoveStage?: (toStage: PipelineStageId) => void
  onCallNow?: () => void
  onNudge?: () => void
  onViewResults?: () => void
  onOpenFullProfile?: () => void
}) {
  const callTruth = useMemo(
    () => (data ? getCallTruth(data.participant) : null),
    [data],
  )
  if (!data) return null

  const next = nextStage(data.stage)
  const nextLabel = next ? PIPELINE_COLUMNS.find((c) => c.id === next)?.label : null

  const decisionTone =
    data.clientDecision === "approved"
      ? "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-900"
      : data.clientDecision === "rejected"
        ? "text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-950/40 dark:border-rose-900"
        : data.clientDecision === "pending"
          ? "text-cyan-700 bg-cyan-50 border-cyan-200 dark:text-cyan-300 dark:bg-cyan-950/40 dark:border-cyan-900"
          : "text-zinc-600 bg-zinc-100 border-zinc-200 dark:text-zinc-300 dark:bg-zinc-800 dark:border-zinc-700"

  const prescreen =
    data.participant?.screening_context?.preScreenResult ??
    data.participant?.screening_context?.prescreenResult ??
    null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="truncate">{data.name}</span>
            {data.fitScore != null && (
              <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-px text-[11px] font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                Fit {data.fitScore}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {stageLabelSafe(data.stage)}
            </span>
            {data.clientDecision && (
              <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${decisionTone}`}>
                <UserCheck className="h-3 w-3" />
                Client: {data.clientDecision}
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
              <Clock className="h-3 w-3" />
              {data.ageLabel} in this stage
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* ── 1. Who they are ─────────────────────────────────────────── */}
          <div className="grid gap-2 sm:grid-cols-2">
            <Row icon={<Briefcase className="h-3.5 w-3.5" />}>
              {data.role || "—"}
              {data.company ? ` · ${data.company}` : ""}
            </Row>
            <Row icon={<MapPin className="h-3.5 w-3.5" />}>{data.location || "—"}</Row>
            <Row icon={<Clock className="h-3.5 w-3.5" />}>{data.experience || "—"}</Row>
            <Row icon={<Mail className="h-3.5 w-3.5" />}>
              {data.email ? (
                <a href={`mailto:${data.email}`} className="hover:underline">{data.email}</a>
              ) : "—"}
            </Row>
            <Row icon={<PhoneCall className="h-3.5 w-3.5" />}>
              {data.phone ? (
                <a href={`tel:${data.phone}`} className="hover:underline">{data.phone}</a>
              ) : "—"}
            </Row>
            <Row icon={<Sparkles className="h-3.5 w-3.5" />}>
              {data.aiScore != null ? `AI score ${data.aiScore}/10` : "Not scored"}
              {data.aiRecommendation ? ` · ${data.aiRecommendation.replace(/_/g, " ")}` : ""}
            </Row>
          </div>

          {data.summary && (
            <p className="rounded-lg bg-zinc-50 p-2.5 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300">
              {data.summary}
            </p>
          )}

          {/* ── 2. What needs attention ─────────────────────────────────── */}
          {callTruth && (
            <Section title="Screening status">
              <div className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                <p className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{callTruth.label}</p>
                {callTruth.detail && (
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{callTruth.detail}</p>
                )}
              </div>
            </Section>
          )}

          {/* ── 3. What the AI found ────────────────────────────────────── */}
          {prescreen && (
            <Section title="AI pre-screen">
              <PreScreenVerdict result={prescreen} />
            </Section>
          )}

          {(data.participant?.info_data || data.participant?.info_sources) && (
            <Section title="Collected information">
              <CollectedInfoView
                infoData={data.participant?.info_data}
                infoSources={data.participant?.info_sources}
                compact
              />
            </Section>
          )}

          {data.notes && (
            <Section title="Recruiter notes">
              <p className="whitespace-pre-wrap rounded-lg border border-zinc-200 p-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                {data.notes}
              </p>
            </Section>
          )}

          {/* ── 4. What to do next ──────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            {next && onMoveStage && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onMoveStage(next)}
                className="bg-indigo-600 font-semibold text-white hover:bg-indigo-700"
              >
                Move to {nextLabel}
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            )}
            {onViewResults && (
              <Button size="sm" variant="outline" disabled={busy} onClick={onViewResults}>
                View results
              </Button>
            )}
            {onCallNow && (
              <Button size="sm" variant="outline" disabled={busy} onClick={onCallNow}>
                <PhoneCall className="mr-1.5 h-3.5 w-3.5" />
                Call now
              </Button>
            )}
            {onNudge && (
              <Button size="sm" variant="outline" disabled={busy} onClick={onNudge}>
                <MessageCircle className="mr-1.5 h-3.5 w-3.5" />
                WhatsApp
              </Button>
            )}
            {onOpenFullProfile && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onOpenFullProfile} className="ml-auto">
                Full profile
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
