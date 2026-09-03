"use client"

import { DbMatchesTab } from "./job-db-matches-tab"
import { JuiceboxProfilesTab } from "./juicebox-profiles-tab"

interface SourcingTabProps {
  jobId: string
  jobTitle: string
  view: "db_matches" | "juicebox"
  onViewChange: (view: "db_matches" | "juicebox") => void
  onViewProfile: (candidate: any) => void
  onCandidateAdded: () => void
}

const VIEWS = [
  { id: "db_matches", label: "Database Matches" },
  { id: "juicebox", label: "LinkedIn" },
] as const

export function SourcingTab({ jobId, jobTitle, view, onViewChange, onViewProfile, onCandidateAdded }: SourcingTabProps) {
  return (
    <div className="space-y-4">
      <div className="inline-flex items-center gap-1 p-1 bg-zinc-100 rounded-xl border border-zinc-200/80">
        {VIEWS.map((v) => {
          const active = view === v.id
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={active}
              className={`px-4 py-2 rounded-lg text-[11px] font-black tracking-widest uppercase transition-all whitespace-nowrap ${
                active
                  ? "bg-white text-zinc-900 shadow-[0_4px_12px_rgba(0,0,0,0.06)] ring-1 ring-zinc-200/50"
                  : "text-zinc-500 hover:text-zinc-900 hover:bg-white/50"
              }`}
              onClick={() => onViewChange(v.id)}
            >
              {v.label}
            </button>
          )
        })}
      </div>

      {view === "juicebox" ? (
        <JuiceboxProfilesTab jobId={jobId} jobTitle={jobTitle} />
      ) : (
        <DbMatchesTab jobId={jobId} onViewProfile={onViewProfile} onCandidateAdded={onCandidateAdded} />
      )}
    </div>
  )
}
