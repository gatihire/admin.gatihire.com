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
import { Archive, ChevronDown, ChevronUp, UserX } from "lucide-react"
import { PipelineCard, type PipelineCardData } from "./job-pipeline-card"
import { PIPELINE_COLUMNS, type PipelineStageId } from "./job-pipeline-stages"

/**
 * How many cards a column shows before it collapses into a "show more".
 *
 * The largest job has 326 applicants. Rendering 326 cards in one column
 * makes the column infinitely tall and pushes every other stage off the
 * screen — the board becomes unusable exactly where it is needed most.
 */
const COLUMN_PAGE_SIZE = 25

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
  /** Every card, unfiltered — used for the column counts. */
  allCards?: PipelineCardData[]
  onOpen: (applicationId: string) => void
  onToggleSelect: (applicationId: string) => void
  /** Fired when a card is dropped on a different stage. */
  onMoveStage: (applicationId: string, toStage: PipelineStageId | "rejected") => void
  selectedIds: Set<string>
  /** Counts for the column headers — all candidates in that stage. */
  columnTotals?: Record<string, number>
  /** Shown when there is nothing to show. */
  emptyState?: React.ReactNode
  /**
   * Rejected candidates.
   *
   * Rejected is not a column — it is where candidates leave. But they are
   * not invisible either: a recruiter sometimes needs to check that
   * somebody was rejected for the right reason, and 1,111 of them must not
   * be dumped into the Applied column. They live in a collapsed history
   * strip at the bottom of the board.
   */
  rejectedCards?: PipelineCardData[]
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
  total,
  selectedIds,
  onOpen,
  onToggleSelect,
  focused,
}: {
  stage: (typeof PIPELINE_COLUMNS)[number]
  cards: PipelineCardData[]
  /** How many candidates are in this stage, BEFORE any filter. */
  total: number
  selectedIds: Set<string>
  onOpen: (id: string) => void
  onToggleSelect: (id: string) => void
  focused: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id })
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!focused) return
    scrollRef.current?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" })
  }, [focused])

  // The column scrolls internally so one long column cannot push the other
  // seven off the screen.
  const visible = expanded ? cards : cards.slice(0, COLUMN_PAGE_SIZE)
  const hidden = cards.length - visible.length

  return (
    <div ref={scrollRef} className="flex h-[calc(100vh-16rem)] min-h-[420px] w-[280px] shrink-0 flex-col">
      {/* Header: name + count. The hint is a tooltip, not permanent text —
          the board has to stay scannable, not a wall of explanation. */}
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${stage.dot}`} />
        <span className="truncate text-xs font-semibold text-zinc-700 dark:text-zinc-200">{stage.label}</span>
        {/*
          The count is the size of the STAGE, not the number of cards
          currently visible. It used to show the filtered count, so with a
          search box open the board said "3, 1, 0" — and the whole point of
          a kanban is answering "which stage is backed up".
        */}
        <span
          className="rounded bg-zinc-100 px-1.5 py-px text-[10px] font-bold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          title={total === cards.length ? undefined : `${total} in this stage, ${cards.length} shown`}
        >
          {total}
        </span>
        {focused && (
          <span className="rounded bg-blue-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            focused
          </span>
        )}
      </div>

      <div
        ref={setNodeRef}
        className={`flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto rounded-xl border-2 border-dashed p-2 transition-colors ${
          isOver
            ? "border-blue-400 bg-blue-50/60 dark:bg-blue-950/20"
            : "border-transparent bg-zinc-50/70 dark:bg-zinc-900/40"
        }`}
      >
        {visible.map((card) => (
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
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-1 flex items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-white py-1.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <ChevronDown className="h-3 w-3" />
            Show {hidden} more
          </button>
        )}
        {expanded && cards.length > COLUMN_PAGE_SIZE && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mt-1 flex items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-white py-1.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <ChevronUp className="h-3 w-3" />
            Collapse
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The drop target for rejecting a candidate.
 *
 * Deliberately NOT a pipeline column: Rejected is where candidates leave.
 * It is a narrow strip below the board, so a recruiter cannot drop onto it
 * by accident, and it lights up when a card is dragged over it.
 */
function RejectZone() {
  const { setNodeRef, isOver } = useDroppable({ id: "rejected" })
  return (
    <div
      ref={setNodeRef}
      className={`mt-1 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-2.5 text-xs font-medium transition-colors ${
        isOver
          ? "border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
          : "border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-600"
      }`}
    >
      <UserX className="h-3.5 w-3.5" />
      {isOver ? "Drop here to reject" : "Drag a candidate here to reject"}
    </div>
  )
}

export function PipelineKanban({
  cards,
  allCards = cards,
  onOpen,
  onToggleSelect,
  onMoveStage,
  selectedIds,
  emptyState,
  rejectedCards = [],
  focusStage,
}: PipelineKanbanProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showRejected, setShowRejected] = useState(false)

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

  /**
   * The size of each stage, ignoring the filters.
   *
   * The parent passes the UNFILTERED cards for this, because a board whose
   * counts move when you type in a search box cannot tell you which stage
   * is backed up — which is the one question a kanban exists to answer.
   */
  const stageTotals = useMemo(() => {
    const out: Record<string, number> = {}
    for (const col of PIPELINE_COLUMNS) out[col.id] = 0
    for (const card of allCards) {
      const stage = out[card.stage] ? card.stage : "applied"
      out[stage] = (out[stage] || 0) + 1
    }
    return out
  }, [allCards])

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
      if (stage || over === "rejected") document.body.style.cursor = "copy"
    }
  }

  // The cursor is set to "copy" while dragging over a column. If the drag
  // ends outside every droppable, or the page unmounts mid-drag, that
  // cursor used to stick and the whole page kept showing a copy pointer.
  useEffect(() => {
    return () => {
      document.body.style.cursor = ""
    }
  }, [])

  const handleDragEnd = (e: DragEndEvent) => {
    document.body.style.cursor = ""
    const id = String(e.active.id)
    setActiveId(null)
    const over = e.over?.id
    if (!over) return

    // "rejected" is the dedicated drop zone, not a column.
    const isReject = over === "rejected"
    const target = PIPELINE_COLUMNS.find((c) => c.id === over)
    if (!target && !isReject) return

    const card = cards.find((c) => c.applicationId === id)
    if (!card) return
    if (!isReject && card.stage === target!.id) return

    onMoveStage(id, isReject ? "rejected" : target!.id)
  }

  if (cards.length === 0 && emptyState) {
    return <>{emptyState}</>
  }

  return (
    <div>
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
                total={stageTotals[col.id] || 0}
                selectedIds={selectedIds}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
                focused={focusedStage === col.id}
              />
            ))}
          </div>

          {/* ── Reject drop zone ───────────────────────────────────────────
              Rejected is not a column — but a recruiter must be able to
              reject by dragging, not only through a dropdown. Without this
              the code comment claiming "a drag into Rejected still asks for
              a reason" was unreachable. */}
          <RejectZone />

          {/* ── Rejected history ──────────────────────────────────────────
              Not a column: rejected candidates are out of the pipeline. But
              they are not invisible — a recruiter sometimes needs to check
              that somebody was rejected for the right reason. */}
          {rejectedCards.length > 0 && (
            <div className="mt-1 rounded-xl border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900">
              <button
                type="button"
                onClick={() => setShowRejected((v) => !v)}
                className="flex w-full items-center gap-2 text-left"
                aria-expanded={showRejected}
              >
                <Archive className="h-3.5 w-3.5 text-zinc-400" />
                <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Rejected
                </span>
                <span className="rounded bg-zinc-100 px-1.5 py-px text-[10px] font-bold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {rejectedCards.length}
                </span>
                {showRejected ? (
                  <ChevronUp className="ml-auto h-3.5 w-3.5 text-zinc-400" />
                ) : (
                  <ChevronDown className="ml-auto h-3.5 w-3.5 text-zinc-400" />
                )}
              </button>

              {showRejected && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {rejectedCards.map((card) => (
                    <PipelineCard
                      key={card.applicationId}
                      data={{ ...card, selected: selectedIds.has(card.applicationId) }}
                      onOpen={onOpen}
                      onToggleSelect={onToggleSelect}
                      // A rejected card is history. Dragging it back onto a
                      // column would silently un-reject the candidate, so
                      // it is not draggable — reopening one is a deliberate
                      // action, done from its own card.
                      draggable={false}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

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
    </div>
  )
}
