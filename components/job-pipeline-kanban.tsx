"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  useDroppable,
} from "@dnd-kit/core"
import { Columns3, List, RefreshCw, Search, X } from "lucide-react"
import { PipelineCard, type PipelineCardData } from "./job-pipeline-card"
import { PIPELINE_COLUMNS, type PipelineStageId } from "./job-pipeline-stages"

/**
 * The job pipeline, as a kanban board.
 *
 * WHY A KANBAN
 *
 * The pipeline was a single vertical list of very tall cards with a row of
 * stage chips above it that FILTERED the list. To answer "how many people
 * are at each stage" you had to click through seven chips one at a time. To
 * answer "who is stuck" you had to read every card. Neither is a pipeline.
 *
 * A kanban shows the SHAPE of the pipeline at a glance: which stage is
 * backed up, which stage is empty, where candidates are piling up.
 *
 * DESIGN RULES
 *
 *  - One card = one candidate. Six lines maximum.
 *  - ONE status pill per card, saying the most urgent thing about them.
 *  - Drag a card to move stages. The drop goes through the same
 *    confirmation path as the old stage dropdown, so a drag into Rejected
 *    still asks for a reason.
 *  - Click a card to open the detail modal. Nothing else on the card is
 *    a button — a card with nine buttons is a wall, not a card.
 */

export type PipelineViewMode = "board" | "list"

export interface PipelineKanbanProps {
  cards: PipelineCardData[]
  viewMode: PipelineViewMode
  onViewModeChange: (mode: PipelineViewMode) => void
  onOpen: (applicationId: string) => void
  onToggleSelect: (applicationId: string) => void
  /** Fired when a card is dropped on a different stage. */
  onMoveStage: (applicationId: string, toStage: PipelineStageId) => void
  selectedIds: Set<string>
  onRefresh: () => void
  refreshing?: boolean
  /** Counts for the column headers — all candidates in that stage. */
  columnTotals?: Record<string, number>
  /** Shown when there is nothing to show. */
  emptyState?: React.ReactNode
  /**
   * A stage to scroll to and highlight.
   *
   * The job list's metric badges deep-link to `?stage=ai_screen`. On the
   * board there is no single stage to show, so instead of dropping the
   * intent on the floor we scroll to that column and ring it — the
   * recruiter lands on exactly the slice the badge promised.
   */
  focusStage?: string | null
}

function Column({
  stage,
  cards,
  selectedIds,
  onOpen,
  onToggleSelect,
  focused,
}: {
  stage: (typeof PIPELINE_COLUMNS)[number]
  cards: PipelineCardData[]
  selectedIds: Set<string>
  onOpen: (id: string) => void
  onToggleSelect: (id: string) => void
  focused: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id })
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!focused) return
    scrollRef.current?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" })
  }, [focused])

  return (
    <div ref={scrollRef} className="flex w-[280px] shrink-0 flex-col">
      {/* Header: name + count. The hint is a tooltip, not permanent text —
          the board has to stay scannable, not a wall of explanation. */}
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${stage.dot}`} />
        <span className="truncate text-xs font-semibold text-zinc-700 dark:text-zinc-200">{stage.label}</span>
        <span className="rounded bg-zinc-100 px-1.5 py-px text-[10px] font-bold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {cards.length}
        </span>
        {focused && (
          <span className="rounded bg-blue-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            focused
          </span>
        )}
      </div>

      <div
        ref={setNodeRef}
        className={`flex min-h-[120px] flex-1 flex-col gap-2 rounded-xl border-2 border-dashed p-2 transition-colors ${
          isOver
            ? "border-blue-400 bg-blue-50/60 dark:bg-blue-950/20"
            : "border-transparent bg-zinc-50/70 dark:bg-zinc-900/40"
        }`}
      >
        {cards.map((card) => (
          <PipelineCard
            key={card.applicationId}
            data={{ ...card, selected: selectedIds.has(card.applicationId) }}
            onOpen={onOpen}
            onToggleSelect={onToggleSelect}
          />
        ))}
        {cards.length === 0 && (
          <div className="flex flex-1 items-center justify-center py-6 text-center text-[11px] text-zinc-400 dark:text-zinc-600">
            Empty
          </div>
        )}
      </div>
    </div>
  )
}

export function PipelineKanban({
  cards,
  viewMode,
  onViewModeChange,
  onOpen,
  onToggleSelect,
  onMoveStage,
  selectedIds,
  onRefresh,
  refreshing,
  emptyState,
  focusStage,
}: PipelineKanbanProps) {
  const [activeId, setActiveId] = useState<string | null>(null)

  // Only focus a column that actually exists on the board.
  const focusedStage =
    focusStage && PIPELINE_COLUMNS.some((c) => c.id === focusStage) ? focusStage : null

  // A small activation distance so a click on a card does not start a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )

  const byStage = useMemo(() => {
    const out: Record<string, PipelineCardData[]> = {}
    for (const col of PIPELINE_COLUMNS) out[col.id] = []
    for (const card of cards) {
      // A card whose stage is not a known column (a legacy value) still has
      // to be visible — Applied is where it belongs for review.
      const stage = out[card.stage] ? card.stage : "applied"
      out[stage].push(card)
    }
    return out
  }, [cards])

  const activeCard = useMemo(
    () => cards.find((c) => c.applicationId === activeId) || null,
    [cards, activeId],
  )

  const handleDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id))
  }

  const handleDragOver = (e: DragOverEvent) => {
    // We do not move the card on drag-over — the board shows where it WILL
    // land. Moving optimistically made the card jump columns mid-drag and
    // it was impossible to drop on the column you wanted.
    const over = e.over?.id
    if (over) {
      const stage = PIPELINE_COLUMNS.find((c) => c.id === over)
      if (stage) document.body.style.cursor = "copy"
    }
  }

  const handleDragEnd = (e: DragEndEvent) => {
    document.body.style.cursor = ""
    const id = String(e.active.id)
    setActiveId(null)
    const over = e.over?.id
    if (!over) return

    const target = PIPELINE_COLUMNS.find((c) => c.id === over)
    if (!target) return

    const card = cards.find((c) => c.applicationId === id)
    if (!card) return
    if (card.stage === target.id) return

    onMoveStage(id, target.id)
  }

  if (cards.length === 0 && emptyState) {
    return <>{emptyState}</>
  }

  return (
    <div>
      {/* View switch + refresh. Two controls, in one place. */}
      <div className="mb-3 flex items-center gap-2">
        <div className="flex items-center rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900">
          <button
            type="button"
            onClick={() => onViewModeChange("board")}
            aria-pressed={viewMode === "board"}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              viewMode === "board"
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            <Columns3 className="h-3.5 w-3.5" />
            Board
          </button>
          <button
            type="button"
            onClick={() => onViewModeChange("list")}
            aria-pressed={viewMode === "list"}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              viewMode === "list"
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            <List className="h-3.5 w-3.5" />
            List
          </button>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh candidates and call status"
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {viewMode === "board" ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            document.body.style.cursor = ""
            setActiveId(null)
          }}
        >
          <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-4">
            {PIPELINE_COLUMNS.map((col) => (
              <Column
                key={col.id}
                stage={col}
                cards={byStage[col.id] || []}
                selectedIds={selectedIds}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
                focused={focusedStage === col.id}
              />
            ))}
          </div>

          {/* The card that follows the cursor. */}
          <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
            {activeCard ? (
              <div className="w-[256px] rotate-2 cursor-grabbing rounded-xl border border-blue-400 bg-white p-2.5 shadow-2xl dark:bg-zinc-900">
                <div className="flex items-center gap-1.5">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900 text-[10px] font-bold text-white dark:bg-zinc-700">
                    {(activeCard.name || "?").trim().slice(0, 2).toUpperCase()}
                  </span>
                  <span className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
                    {activeCard.name}
                  </span>
                </div>
                <p className="mt-1 truncate pl-[30px] text-[11px] text-zinc-500 dark:text-zinc-400">
                  {activeCard.role}
                </p>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}
    </div>
  )
}
