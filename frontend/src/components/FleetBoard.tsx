// Tablero de asignación de flota (drag & drop, reutilizable).
//
// Columnas = entidades (terminales o equipos) + una columna "pool" con la
// flota sin asignar. Se arrastra una unidad de una columna a otra para
// reasignarla; en pantallas chicas (o por teclado/accesibilidad) cada
// tarjeta tiene un <select> para moverla sin arrastrar. Al guardar se
// reporta la ubicación por columna y el padre persiste vía su `assign`.
import { useMemo, useState } from 'react'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import type { FleetUnit } from '../api'

export const POOL = '__pool__'

export interface BoardColumn {
  key: string
  label: string
}

interface CardProps {
  u: FleetUnit
  colKey: string
  columns: BoardColumn[]
  poolLabel: string
  autoHint?: string
  onMove: (unit: string, col: string) => void
}

function UnitCard({ u, colKey, columns, poolLabel, autoHint, onMove }: CardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: u.unit,
  })
  return (
    <div ref={setNodeRef}
      className={`fb-card${isDragging ? ' dragging' : ''}`}
      {...attributes} {...listeners}>
      <span className="fb-card-main">
        <span className="fb-card-unit">{u.unit}</span>
        <span className="fb-card-kind">{u.unit_type}</span>
      </span>
      {autoHint && colKey === POOL && (
        <span className="fb-card-auto">{autoHint}</span>
      )}
      {/* Fallback accesible / móvil: mover sin arrastrar. */}
      <select className="fb-move" value={colKey} aria-label={`Move ${u.unit}`}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => onMove(u.unit, e.target.value)}>
        <option value={POOL}>{poolLabel}</option>
        {columns.map((c) => (
          <option key={c.key} value={c.key}>{c.label}</option>
        ))}
      </select>
    </div>
  )
}

function Column({ id, label, count, focus, children }: {
  id: string
  label: string
  count: number
  focus?: boolean
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef}
      className={`fb-col${isOver ? ' over' : ''}${focus ? ' focus' : ''}`}>
      <header className="fb-col-head">
        <span className="fb-col-label">{label}</span>
        <span className="fb-col-count">{count}</span>
      </header>
      <div className="fb-col-body">{children}</div>
    </div>
  )
}

export default function FleetBoard({
  kind, columns, units, initialOf, autoHintOf, busy, focusKey, onCommit,
}: {
  kind: 'terminal' | 'team'
  columns: BoardColumn[]
  units: FleetUnit[]
  /** Columna explícita inicial de una unidad, o '' → pool. */
  initialOf: (unit: string) => string
  /** Terminales: etiqueta muda de la resolución automática (pool). */
  autoHintOf?: (u: FleetUnit) => string | undefined
  busy: boolean
  /** Columna a resaltar (la que disparó el board), opcional. */
  focusKey?: string | null
  onCommit: (placement: Record<string, string[]>) => void
}) {
  const poolLabel = kind === 'terminal' ? 'Auto / unpinned' : 'Unassigned'
  const [place, setPlace] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const u of units) m[u.unit] = initialOf(u.unit) || POOL
    return m
  })
  const [q, setQ] = useState('')
  const [dragUnit, setDragUnit] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor,
      { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  )

  const byCol = useMemo(() => {
    const g: Record<string, FleetUnit[]> = { [POOL]: [] }
    for (const c of columns) g[c.key] = []
    for (const u of units) {
      const col = place[u.unit] ?? POOL
      ;(g[col] ?? g[POOL]).push(u)
    }
    return g
  }, [units, place, columns])

  const dragCard = dragUnit ? units.find((u) => u.unit === dragUnit) : null

  function move(unit: string, col: string) {
    setPlace((p) => (p[unit] === col ? p : { ...p, [unit]: col }))
  }
  function onDragStart(e: DragStartEvent) {
    setDragUnit(String(e.active.id))
  }
  function onDragEnd(e: DragEndEvent) {
    setDragUnit(null)
    const over = e.over?.id
    if (over != null) move(String(e.active.id), String(over))
  }

  function commit() {
    const placement: Record<string, string[]> = {}
    for (const c of columns) placement[c.key] = []
    for (const [unit, col] of Object.entries(place)) {
      if (col !== POOL && placement[col]) placement[col].push(unit)
    }
    onCommit(placement)
  }

  const s = q.trim().toLowerCase()
  const poolUnits = s
    ? byCol[POOL].filter((u) => u.unit.toLowerCase().includes(s)
        || u.company.toLowerCase().includes(s))
    : byCol[POOL]
  const assignedCount = units.length - byCol[POOL].length

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart}
      onDragEnd={onDragEnd}>
      <div className="fleet-board">
        <div className="fb-toolbar">
          <input className="cell-input" placeholder="Search the pool…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="fb-summary">
            {assignedCount} assigned · {byCol[POOL].length} in pool
          </span>
          <button className="btn btn-primary btn-expand" disabled={busy}
            onClick={commit}>
            {busy ? 'Saving…' : 'Save board'}
          </button>
        </div>

        <div className="fb-cols">
          <Column id={POOL} label={poolLabel} count={byCol[POOL].length}>
            {poolUnits.map((u) => (
              <UnitCard key={u.id} u={u} colKey={POOL} columns={columns}
                poolLabel={poolLabel} autoHint={autoHintOf?.(u)}
                onMove={move} />
            ))}
            {poolUnits.length === 0 && (
              <p className="fb-empty">
                {s ? 'No matches.' : 'Pool is empty.'}
              </p>
            )}
          </Column>

          {columns.map((c) => (
            <Column key={c.key} id={c.key} label={c.label}
              count={byCol[c.key].length} focus={focusKey === c.key}>
              {byCol[c.key].map((u) => (
                <UnitCard key={u.id} u={u} colKey={c.key} columns={columns}
                  poolLabel={poolLabel} onMove={move} />
              ))}
              {byCol[c.key].length === 0 && (
                <p className="fb-empty">Drag units here.</p>
              )}
            </Column>
          ))}
        </div>

        <p className="fb-help">
          Drag a unit between columns to reassign it — or use the menu on
          each card. {kind === 'terminal'
            ? 'Pool units fall back to prefix and company rules.'
            : 'Pool units belong to no team.'}
        </p>
      </div>

      <DragOverlay>
        {dragCard && (
          <div className="fb-card dragging fb-card-overlay">
            <span className="fb-card-main">
              <span className="fb-card-unit">{dragCard.unit}</span>
              <span className="fb-card-kind">{dragCard.unit_type}</span>
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
