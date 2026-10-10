// Perfil de unidad (fase H3, estilo Fullbay): Components & PMs,
// Active Services, Service History y Attachments. Se abre desde Fleet.
import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addMaintRecord, decodeVin, deleteUnitDoc, deleteWorkOrder, downloadUnitDoc,
  fetchUnitPhotoUrl, getReefer, getUnitCampaigns, getOdometerLog,
  getUnitEngineHours, getUnitPartsUsed, listFleet, listUnitsWithPhoto,
  listOpenDefects, logOdometer, logUnitEngineHours,
  listUnitDocs, listWorkOrders, toggleUnitCampaign, uploadUnitDocs,
  uploadUnitPhoto,
  type PartUsed, type UnitCampaign, type WorkOrder,
  type WoStatus,
} from '../api'
import { notifyOk, notifyErr } from '../toast'
import Modal from '../components/Modal'
import { useShell } from '../shell'
import { useUnitOwners } from '../customers'
import { analyzeUnit } from '../defectGroups'
import type { Kind } from '../truckZones'
import TruckDiagram from '../components/TruckDiagram'
import { PIPELINE, STATUS_META, WoDrawer } from './WorkOrdersPage'

type Tab = 'campaigns' | 'active' | 'history' | 'parts' | 'docs'

const TABS: { key: Tab; label: string }[] = [
  { key: 'campaigns', label: 'Components & PMs' },
  { key: 'active', label: 'Active Services' },
  { key: 'history', label: 'Service History' },
  { key: 'parts', label: 'Parts used' },
  { key: 'docs', label: 'Attachments' },
]

const CAMP_STATUS: Record<string, { label: string; cls: string }> = {
  on_track: { label: 'On track', cls: 's-on_track' },
  upcoming: { label: 'Upcoming', cls: 's-upcoming' },
  overdue: { label: 'Overdue', cls: 's-overdue' },
  never: { label: 'Never performed', cls: 's-never' },
  no_meter: { label: 'No meter reading', cls: 's-never' },
  tracked: { label: 'Tracked', cls: 's-on_track' },
}

// Buckets visuales para el panel de salud de la unidad (misma identidad de
// color --st-* que PM/DOT). El orden es de más a menos urgente.
const STATUS_BUCKETS: { cls: string; label: string; token: string }[] = [
  { cls: 's-overdue', label: 'Overdue', token: '--st-overdue' },
  { cls: 's-upcoming', label: 'Upcoming', token: '--st-upcoming' },
  { cls: 's-on_track', label: 'On track', token: '--st-on-track' },
  { cls: 's-never', label: 'Never', token: '--st-never' },
]
// Valor "a vencer" de una campaña en SU unidad. v2.22: las campañas por
// horas (PM del reefer) usan horas mientras haya horómetro y venzan primero;
// si no, la fecha de respaldo (días). Nunca millas.
function campDue(c: UnitCampaign): { v: number; unit: string } | null {
  if (c.due === 'hours') {
    if (c.to_due != null && c.due_by !== 'days') {
      return { v: c.to_due, unit: 'hrs' }
    }
    if (c.to_due_days != null) return { v: c.to_due_days, unit: 'days' }
    return c.to_due != null ? { v: c.to_due, unit: 'hrs' } : null
  }
  if (c.to_due == null) return null
  return { v: c.to_due, unit: c.due === 'miles' ? 'mi' : c.due === 'days' ? 'days' : '' }
}
const fmtHrs = (n: number | null | undefined) =>
  n == null ? '' : Math.round(n).toLocaleString('en-US')

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtMi = (n: number | null | undefined) =>
  n == null ? '' : n.toLocaleString('en-US')
const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '')

function fmtSize(b: number): string {
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(b / 1024))} KB`
}

function todayISO(): string {
  const t = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

export default function UnitProfilePage({ unit, onClose }: {
  unit: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('campaigns')
  const [openWo, setOpenWo] = useState<number | null>(null)

  const fleetQ = useQuery({ queryKey: ['fleet'], queryFn: listFleet })
  const info = useMemo(
    () => (fleetQ.data ?? []).find((u) => u.unit === unit),
    [fleetQ.data, unit])

  const campQ = useQuery({
    queryKey: ['unit-campaigns', unit],
    // make+model completo: pm_label matchea "international" del MAKE — con
    // solo el model ("LT") los International caían al PM genérico en vez
    // del ISX (v2.18; el board fleet-wide ya usaba el string completo).
    queryFn: () => getUnitCampaigns(
      unit, [info?.make, info?.model].filter(Boolean).join(' ')),
  })
  const wosQ = useQuery({
    queryKey: ['unit-wos', unit],
    queryFn: () => listWorkOrders('', unit),
  })
  const docsQ = useQuery({
    queryKey: ['unit-docs', unit],
    queryFn: () => listUnitDocs(unit),
  })
  const partsQ = useQuery({
    queryKey: ['unit-parts-used', unit],
    queryFn: () => getUnitPartsUsed(unit),
    enabled: tab === 'parts',
  })
  // Odómetro registrado de esta unidad (manual + backfill de WOs/PM). Es el
  // atajo para el CPM sin integración ELD: si el taller carga el odómetro acá,
  // el cost-per-mile ya funciona. Se muestra como fallback si no hay dato live.
  const odoQ = useQuery({
    queryKey: ['unit-odometer', unit],
    queryFn: () => getOdometerLog(unit),
  })
  // Form inline de "Log reading".
  const [odoOpen, setOdoOpen] = useState(false)
  const [odoMiles, setOdoMiles] = useState('')
  const [odoDate, setOdoDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [odoBusy, setOdoBusy] = useState(false)
  async function saveOdo() {
    const mi = Math.round(Number(odoMiles))
    if (!Number.isFinite(mi) || mi <= 0) {
      notifyErr('Enter a valid mileage', new Error('mileage must be a positive number'))
      return
    }
    setOdoBusy(true)
    try {
      await logOdometer(unit, mi, odoDate)
      notifyOk(`Odometer logged — ${mi.toLocaleString('en-US')} mi`)
      setOdoOpen(false)
      setOdoMiles('')
      qc.invalidateQueries({ queryKey: ['unit-odometer', unit] })
      qc.invalidateQueries({ queryKey: ['cpm-report'] })  // el CPM usa esta lectura
    } catch (e) {
      notifyErr("Couldn't log the reading", e)
    } finally {
      setOdoBusy(false)
    }
  }

  // v2.22 horómetro (engine hours) del reefer: medidor PROPIO de la unidad
  // (tabla meter_reading), nunca el odómetro. Alimenta el Reefer PM.
  const hrsQ = useQuery({
    queryKey: ['unit-engine-hours', unit],
    queryFn: () => getUnitEngineHours(unit),
    retry: false,
  })
  const [hrsOpen, setHrsOpen] = useState(false)
  const [hrsVal, setHrsVal] = useState('')
  const [hrsDate, setHrsDate] = useState(todayISO)
  const [hrsBusy, setHrsBusy] = useState(false)
  async function saveHrs() {
    const v = Number(hrsVal)
    if (!hrsVal.trim() || !Number.isFinite(v) || v < 0) {
      notifyErr('Enter valid engine hours',
        new Error('engine hours must be zero or more'))
      return
    }
    setHrsBusy(true)
    try {
      try {
        await logUnitEngineHours(unit, { value: v, date: hrsDate })
      } catch (e) {
        // Lectura inverosímil (más baja que la anterior / > 24 h por día):
        // el backend pide confirmación explícita (horómetro reseteado).
        if (!window.confirm(
          `${e instanceof Error ? e.message : String(e)}\n\n`
          + 'Save it anyway? Use this when the hour meter was reset or the controller was replaced.')) {
          return
        }
        await logUnitEngineHours(unit, { value: v, date: hrsDate, force: true })
      }
      notifyOk(`Engine hours logged — ${fmtHrs(v)} hrs`)
      setHrsOpen(false)
      setHrsVal('')
      qc.invalidateQueries({ queryKey: ['unit-engine-hours', unit] })
      qc.invalidateQueries({ queryKey: ['unit-campaigns', unit] })
      qc.invalidateQueries({ queryKey: ['maint'] })
      qc.invalidateQueries({ queryKey: ['service-requests'] })
    } catch (e) {
      notifyErr("Couldn't log engine hours", e)
    } finally {
      setHrsBusy(false)
    }
  }

  // Foto de identidad (v2.13, elemento 05): banda héroe bajo el header.
  // El índice (compartido con Fleet) gatea el fetch: sin foto no hay GET 404
  // en consola. Misma queryKey que <UnitPhoto/> para compartir el blob.
  const photoIdxQ = useQuery({
    queryKey: ['unit-photos-index'], queryFn: listUnitsWithPhoto,
  })
  const hasPhoto = (photoIdxQ.data ?? []).includes(unit)
  const photoQ = useQuery({
    queryKey: ['unit-photo', unit],
    queryFn: () => fetchUnitPhotoUrl(unit),
    staleTime: Infinity,
    retry: false,
    enabled: hasPhoto,
  })
  const photoInput = useRef<HTMLInputElement>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  async function onPhotoPicked(file: File | undefined) {
    if (!file) return
    setPhotoBusy(true)
    try {
      await uploadUnitPhoto(unit, file)
      notifyOk('Photo saved', `Unit ${unit}`)
      qc.invalidateQueries({ queryKey: ['unit-photo', unit] })
      qc.invalidateQueries({ queryKey: ['unit-photos-index'] })
    } catch (e) {
      notifyErr("Couldn't save the photo", e)
    } finally {
      setPhotoBusy(false)
      if (photoInput.current) photoInput.current.value = ''
    }
  }

  // Defectos ABIERTOS de esta unidad: alimentan el diagrama por zonas (rojo =
  // con defecto). Misma fuente que DefectsPage, filtrada por unidad.
  const defectsQ = useQuery({
    queryKey: ['unit-open-defects', unit],
    queryFn: listOpenDefects,
  })
  // Reefer en vivo (solo se usa el mini de cadena de frío si esta unidad
  // aparece en el feed del reefer). No bloquea el resto del perfil.
  const reeferQ = useQuery({ queryKey: ['reefer'], queryFn: getReefer })
  // Motor: no es un campo persistido del asset; se decodifica del VIN bajo
  // demanda (vPIC / Smart Fill). Solo se muestra si el VIN existe y resuelve.
  const vinQ = useQuery({
    queryKey: ['vin-decode', info?.vin],
    queryFn: () => decodeVin(info!.vin),
    enabled: !!info?.vin,
    staleTime: 24 * 3600_000,
  })

  // Tipo físico de la unidad para el diagrama (camión vs tráiler).
  const kind: Kind = (info?.kind ?? info?.unit_type) === 'trailer'
    ? 'trailer' : 'truck'
  // Zonas con defecto, derivadas de los defectos abiertos REALES de la unidad.
  const { zones, defectGroups } = useMemo(() => {
    const recs = (defectsQ.data ?? []).filter((d) => d.unit === unit)
    const { groups, zones } = analyzeUnit(recs, kind)
    return { zones, defectGroups: groups }
  }, [defectsQ.data, unit, kind])
  // Reefer de esta unidad (match por número de unidad), si el feed lo trae.
  const reefer = useMemo(
    () => (reeferQ.data?.units ?? []).find((u) => u.unit === unit),
    [reeferQ.data, unit])
  const engine = vinQ.data?.ok ? vinQ.data.engine : undefined

  const wos = wosQ.data?.workorders ?? []
  const active = wos.filter((w) => w.status !== 'invoiced')
  const history = wos.filter((w) => w.status === 'invoiced')
  const cost12 = history
    .filter((w) => Date.parse(w.invoiced_at ?? w.updated_at) >
      Date.now() - 365 * 86400_000)
    .reduce((s, w) => s + w.total, 0)
  const pmCamp = campQ.data?.campaigns.find((c) => c.key === 'pm')

  // ----- Panel "Maintenance status" (bajo las tarjetas resumen) -----
  const camps = campQ.data?.campaigns ?? []
  const campCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const k of camps) {
      const cls = CAMP_STATUS[k.status]?.cls ?? 's-never'
      c[cls] = (c[cls] ?? 0) + 1
    }
    return c
  }, [campQ.data])
  // Acción más urgente: el componente vencido por más margen; si ninguno,
  // el más próximo a vencer. (v2.22: cada uno en su unidad — mi/días/hrs.)
  const urgent = useMemo(() => {
    const byDue = (a: UnitCampaign, b: UnitCampaign) =>
      (campDue(a)?.v ?? 0) - (campDue(b)?.v ?? 0)
    const od = camps.filter((c) =>
      CAMP_STATUS[c.status]?.cls === 's-overdue' && campDue(c)).sort(byDue)
    if (od[0]) return { camp: od[0], overdue: true }
    const soon = camps.filter((c) =>
      CAMP_STATUS[c.status]?.cls === 's-upcoming' && campDue(c)).sort(byDue)
    if (soon[0]) return { camp: soon[0], overdue: false }
    return null
  }, [campQ.data])
  const urgentDue = urgent ? campDue(urgent.camp) : null

  // v2.22: la tarjeta del horómetro aparece en unidades reefer (campaña por
  // horas activa, feed del reefer) o si ya tienen lecturas de horas.
  const reeferCamp = camps.find((c) => c.due === 'hours')
  const curHours = campQ.data?.current_hours ?? hrsQ.data?.latest?.value ?? null
  const curHoursSrc = campQ.data?.current_hours != null
    ? campQ.data?.current_hours_source : hrsQ.data?.latest?.source
  const curHoursDate = campQ.data?.current_hours != null
    ? campQ.data?.current_hours_date : hrsQ.data?.latest?.date
  const showHours = !!reeferCamp || curHours != null
    || (hrsQ.data?.readings.length ?? 0) > 0 || !!reefer

  // v2.22 [C]: dueño (cliente owner-operator) de la unidad.
  const { navigate } = useShell()
  const owners = useUnitOwners()
  const owner = owners.ownerOf(unit)

  function refreshAll() {
    qc.invalidateQueries({ queryKey: ['unit-campaigns', unit] })
    qc.invalidateQueries({ queryKey: ['maint'] })
    qc.invalidateQueries({ queryKey: ['pm'] })
    // Un PM/DOT registrado cambia lo que vence: el backend ya olvidó el TTL
    // del sync, así que el refetch trae el backlog al día.
    qc.invalidateQueries({ queryKey: ['service-requests'] })
  }

  return (
    <div className="page page-wide unit-profile">
      <div className="page-head">
        <div className="up-headline">
          <button className="btn btn-ghost up-back" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" width="16" height="16">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Fleet
          </button>
          <div>
            <h1>Unit {unit}</h1>
            <p className="page-sub">
              {info
                ? [info.model || info.kind, info.vin && `VIN ${info.vin}`,
                   info.plate && `Plate ${info.plate}`, info.company]
                    .filter(Boolean).join(' · ')
                : 'Loading unit…'}
            </p>
          </div>
        </div>
        <div className="head-actions">
          <input ref={photoInput} type="file" accept="image/*" hidden
            onChange={(e) => onPhotoPicked(e.target.files?.[0])} />
          <button className="btn btn-ghost" disabled={photoBusy}
            onClick={() => photoInput.current?.click()}>
            {photoBusy ? 'Saving…'
              : photoQ.data ? 'Change photo' : 'Add photo'}
          </button>
        </div>
      </div>

      {/* Banda héroe (v2.13): la foto identifica a la unidad de un vistazo.
          Sin foto no hay banda — el botón de arriba invita, no se finge. */}
      {photoQ.data && (
        <div className="up-hero">
          <img src={photoQ.data} alt={`Unit ${unit}`} />
          <div className="up-hero-veil" aria-hidden="true" />
        </div>
      )}

      {/* Tarjetas resumen (estilo Fullbay, con datos útiles) */}
      <div className="up-cards">
        <div className="up-card up-card-blue">
          <strong>{money(cost12)}</strong>
          <span>Maintenance cost · last 12 months</span>
        </div>
        <div className="up-card up-card-green">
          <strong>{active.length}</strong>
          <span>Active service orders</span>
        </div>
        <div className="up-card up-card-sky up-card-odo">
          <button type="button" className="up-odo-log"
            title="Log an odometer reading"
            onClick={() => setOdoOpen((v) => !v)}>+ Log</button>
          <strong>
            {campQ.data?.current_miles != null
              ? `${fmtMi(campQ.data.current_miles)} mi`
              : odoQ.data?.latest
                ? `${fmtMi(odoQ.data.latest.miles)} mi`
                : '—'}
          </strong>
          <span>
            Odometer
            {campQ.data?.current_miles != null && campQ.data?.current_source
              ? ` · ${campQ.data.current_source}`
              : odoQ.data?.latest
                ? ` · logged ${odoQ.data.latest.date}`
                : ''}
            {pmCamp?.to_due != null
              ? ` · PM in ${fmtMi(Math.abs(pmCamp.to_due))} mi`
                .replace('in -', 'overdue by ')
              : ''}
          </span>
        </div>
        {/* v2.22: horómetro del reefer, al lado del odómetro (dos medidores
            independientes, como en el equipo real). */}
        {showHours && (
          <div className="up-card up-card-violet up-card-odo">
            <button type="button" className="up-odo-log"
              title="Log an engine-hours reading"
              aria-expanded={hrsOpen}
              onClick={() => setHrsOpen((v) => !v)}>+ Log</button>
            <strong>{curHours != null ? `${fmtHrs(curHours)} hrs` : '—'}</strong>
            <span>
              Engine hours
              {curHours != null && curHoursSrc ? ` · ${curHoursSrc}` : ''}
              {curHours != null && curHoursDate ? ` · ${curHoursDate}` : ''}
              {reeferCamp && campDue(reeferCamp)
                ? (() => {
                    const d = campDue(reeferCamp)!
                    return d.v < 0
                      ? ` · PM overdue by ${fmtMi(Math.abs(Math.round(d.v)))} ${d.unit}`
                      : ` · PM in ${fmtMi(Math.round(d.v))} ${d.unit}`
                  })()
                : ''}
            </span>
          </div>
        )}
      </div>

      {hrsOpen && (
        <div className="up-odo-form">
          <label>Engine hours
            <input type="number" min={0} step="0.1" value={hrsVal} autoFocus
              placeholder={curHours != null ? String(Math.round(curHours))
                : 'Hour meter reading'}
              onChange={(e) => setHrsVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveHrs() }} />
          </label>
          <label>Date
            <input type="date" value={hrsDate}
              max={todayISO()}
              onChange={(e) => setHrsDate(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-xs" disabled={hrsBusy}
            onClick={saveHrs}>{hrsBusy ? 'Saving…' : 'Save reading'}</button>
          <button className="btn btn-ghost btn-xs"
            onClick={() => setHrsOpen(false)}>Cancel</button>
          <span className="up-odo-hint">
            Reefer PM is tracked on this hour meter, never on the odometer.
            Readings from Lynx, Thermo King or Traccar land here automatically.
          </span>
        </div>
      )}

      {/* Log de odómetro: el atajo del CPM sin ELD. Dos lecturas en el tiempo
          = cost-per-mile de esta unidad. */}
      {odoOpen && (
        <div className="up-odo-form">
          <label>Miles
            <input type="number" min={0} value={odoMiles} autoFocus
              placeholder="Current odometer"
              onChange={(e) => setOdoMiles(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveOdo() }} />
          </label>
          <label>Date
            <input type="date" value={odoDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setOdoDate(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-xs" disabled={odoBusy}
            onClick={saveOdo}>{odoBusy ? 'Saving…' : 'Save reading'}</button>
          <button className="btn btn-ghost btn-xs"
            onClick={() => setOdoOpen(false)}>Cancel</button>
          <span className="up-odo-hint">
            Two readings over time turn on cost-per-mile for this unit — no ELD
            needed.
          </span>
        </div>
      )}

      {camps.length > 0 && (
        <div className="up-status">
          <div className="up-status-main">
            <span className="up-status-eyebrow">Maintenance status</span>
            <div className="up-status-bar" role="img"
              aria-label="Component status distribution">
              {STATUS_BUCKETS.map((b) => campCounts[b.cls] ? (
                <span key={b.cls} className="up-status-seg"
                  style={{
                    width: `${(campCounts[b.cls] / camps.length) * 100}%`,
                    background: `var(${b.token})`,
                  }}
                  title={`${b.label}: ${campCounts[b.cls]}`} />
              ) : null)}
            </div>
            <div className="up-status-legend">
              {STATUS_BUCKETS.map((b) => campCounts[b.cls] ? (
                <span key={b.cls} className="up-status-chip">
                  <i style={{ background: `var(${b.token})` }} />
                  <b>{campCounts[b.cls]}</b> {b.label}
                </span>
              ) : null)}
            </div>
          </div>
          {urgent ? (
            <span className={`up-status-hl ${urgent.overdue
              ? 'is-overdue' : 'is-upcoming'}`}>
              {urgent.overdue
                ? `${urgent.camp.label} · overdue by ${fmtMi(
                    Math.abs(Math.round(urgentDue?.v ?? 0)))} ${urgentDue?.unit ?? ''}`
                : `Next: ${urgent.camp.label} · ${fmtMi(
                    Math.round(urgentDue?.v ?? 0))} ${urgentDue?.unit ?? ''}`}
            </span>
          ) : (
            <span className="up-status-hl is-ok">All components on track</span>
          )}
        </div>
      )}

      {/* Banda de resumen (estilo mockup aprobado): diagrama por zonas +
          datos rápidos reales. Rellena el espacio vacío sobre los tabs sin
          duplicar nada de los tabs (PM/servicios/adjuntos siguen abajo). */}
      <div className="up-overview">
        <div className="up-ov-left">
          <section className="card up-diagram-card">
            <div className="card-head">
              <h2>Unit map — defect zones</h2>
              <span className="sub">
                {kind === 'trailer' ? 'Trailer' : 'Truck'} · {unit}
              </span>
            </div>
            <div className="card-body up-diagram-body">
              <TruckDiagram zones={zones} kind={kind} />
              <p className="up-diagram-cap">
                Schematic of <b>this unit</b> ({unit})
                {info?.model ? <> · <b>{info.model}</b></> : null}
                {' '}— red zones have an open defect, green are clear.
              </p>
              {defectGroups.length > 0 ? (
                <div className="up-zone-note">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.8" strokeLinecap="round"
                    strokeLinejoin="round">
                    <path d="m10.3 3.3-7 12A1.5 1.5 0 0 0 4.6 18h14.8a1.5 1.5 0 0 0 1.3-2.7l-7-12a1.5 1.5 0 0 0-2.6 0Z" />
                    <path d="M12 9v4M12 16h.01" />
                  </svg>
                  <span className="up-zone-t">
                    <b>{defectGroups.length} open defect
                      {defectGroups.length > 1 ? 's' : ''}</b>
                    {' '}— highest: {defectGroups[0].category}
                    {defectGroups[0].body ? ` · ${defectGroups[0].body}` : ''}
                  </span>
                </div>
              ) : (
                <p className="up-diagram-clear">No open defects on this unit.</p>
              )}
            </div>
          </section>

          {/* Mini de cadena de frío: SOLO si el feed del reefer trae esta
              unidad (datos reales). Si no, se omite por completo. */}
          {reefer && (
            <section className="card up-reefer-card">
              <div className="card-head">
                <h2>Cold chain</h2>
                <span className="sub">
                  {reefer.source ? `${reefer.source} · ` : ''}
                  {reefer.demo ? 'demo' : 'live'}
                </span>
              </div>
              <div className="up-reefer-body">
                <div className="up-reefer-top">
                  <div className="up-reefer-temp num">
                    {reefer.return_f != null
                      ? <>{reefer.return_f.toFixed(1)}<small>°F</small></>
                      : '—'}
                  </div>
                  <div className="up-reefer-set">
                    <div className="k">Setpoint</div>
                    <div className="v num">
                      {reefer.setpoint_f != null
                        ? `${reefer.setpoint_f.toFixed(1)} °F` : '—'}
                    </div>
                  </div>
                </div>
                <div className="up-reefer-meta">
                  {reefer.run_mode && (
                    <span className="mode">
                      <span className="pdot" />{reefer.run_mode}
                      {reefer.state ? ` · ${reefer.state}` : ''}
                    </span>
                  )}
                  {reefer.fuel_pct != null && (
                    <>
                      <span className="dot-sep">·</span>
                      <span>Fuel {reefer.fuel_pct}%</span>
                    </>
                  )}
                  {reefer.door && (
                    <>
                      <span className="dot-sep">·</span>
                      <span>Door {reefer.door}</span>
                    </>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>

        <section className="card up-facts-card">
          <div className="card-head"><h2>Quick facts</h2></div>
          <div className="up-spec-list">
            {(info?.year || info?.make || info?.model) && (
              <div className="up-spec-row">
                <span className="k">Make / model</span>
                <span className="v">
                  {[info?.year, info?.make, info?.model]
                    .filter(Boolean).join(' ')}
                </span>
              </div>
            )}
            {engine && (
              <div className="up-spec-row">
                <span className="k">Engine</span>
                <span className="v">{engine}</span>
              </div>
            )}
            {info?.vin && (
              <div className="up-spec-row">
                <span className="k">VIN</span>
                <span className="v mono">{info.vin}</span>
              </div>
            )}
            {info?.plate && (
              <div className="up-spec-row">
                <span className="k">Plate</span>
                <span className="v mono">{info.plate}</span>
              </div>
            )}
            {info?.company && (
              <div className="up-spec-row">
                <span className="k">Company</span>
                <span className="v">{info.company}</span>
              </div>
            )}
            <div className="up-spec-row">
              <span className="k">Current odometer</span>
              <span className="v mono">
                {campQ.data?.current_miles != null
                  ? `${fmtMi(campQ.data.current_miles)} mi`
                  : '—'}
                {campQ.data?.current_source && (
                  <em className="up-spec-src">{campQ.data.current_source}</em>
                )}
              </span>
            </div>
            {showHours && (
              <div className="up-spec-row">
                <span className="k">Engine hours</span>
                <span className="v mono">
                  {curHours != null ? `${fmtHrs(curHours)} hrs` : '—'}
                  {curHours != null && curHoursSrc && (
                    <em className="up-spec-src">{curHoursSrc}</em>
                  )}
                </span>
              </div>
            )}
            {/* v2.22 [C]: dueño de la unidad (owner-operator facturado). */}
            {owner && (
              <div className="up-spec-row">
                <span className="k">Owner</span>
                <span className="v">
                  <button type="button" className="link-btn"
                    onClick={() => navigate('customers', { customer: owner.id })}>
                    {owner.name}
                  </button>
                </span>
              </div>
            )}
            <div className="up-spec-row">
              <span className="k">Open defects</span>
              <span className={`v ${(info?.open_defects ?? 0) > 0
                ? 'is-bad' : 'is-ok'}`}>
                {info?.open_defects ?? 0}
              </span>
            </div>
            <div className="up-spec-row">
              <span className="k">Last DVIR</span>
              <span className="v">{dateOf(info?.last_dvir ?? null) || '—'}</span>
            </div>
          </div>
        </section>
      </div>

      <div className="up-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab"
            aria-selected={tab === t.key}
            className={`up-tab ${tab === t.key ? 'on' : ''}`}
            onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'active' && active.length > 0 && (
              <i className="up-tab-n">{active.length}</i>
            )}
            {t.key === 'docs' && (docsQ.data?.docs.length ?? 0) > 0 && (
              <i className="up-tab-n">{docsQ.data?.docs.length}</i>
            )}
          </button>
        ))}
      </div>

      {tab === 'campaigns' && (
        <CampaignsTab unit={unit} data={campQ.data}
          loading={campQ.isPending} onChanged={refreshAll} />
      )}
      {tab === 'active' && (
        <ServicesTab
          title="Active service orders"
          empty="There are no active service orders for this unit."
          wos={active} grouped onOpen={setOpenWo} />
      )}
      {tab === 'history' && (
        <ServicesTab
          title="Invoiced service orders"
          empty="No invoiced service orders yet."
          wos={history} onOpen={setOpenWo}
          onDelete={async (w) => {
            if (!window.confirm(
              `Delete work order #${w.id}? This cannot be undone.`)) return
            try {
              await deleteWorkOrder(w.id)
              qc.invalidateQueries({ queryKey: ['unit-wos', unit] })
              qc.invalidateQueries({ queryKey: ['workorders'] })
              qc.invalidateQueries({ queryKey: ['workorder'] })
              // Los service requests ligados a la WO borrada vuelven a open
              // en el backend: badge del nav y backlog al día.
              qc.invalidateQueries({ queryKey: ['service-requests'] })
              notifyOk(`Work order #${w.id} deleted`)
            } catch (e) {
              notifyErr("Couldn't delete", e)
            }
          }} />
      )}
      {tab === 'parts' && (
        <PartsUsedTab data={partsQ.data} loading={partsQ.isPending}
          onOpenWo={setOpenWo} />
      )}
      {tab === 'docs' && (
        <DocsTab unit={unit} data={docsQ.data}
          onChanged={() =>
            qc.invalidateQueries({ queryKey: ['unit-docs', unit] })} />
      )}

      <WoDrawer woId={openWo}
        onClose={() => {
          setOpenWo(null)
          qc.invalidateQueries({ queryKey: ['unit-wos', unit] })
        }} />
    </div>
  )
}

// ----- Parts used ----------------------------------------------------------
function PartsUsedTab({ data, loading, onOpenWo }: {
  data: import('../api').PartsUsedResult | undefined
  loading: boolean
  onOpenWo: (id: number) => void
}) {
  const money = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

  if (loading || !data) {
    return <div className="card"><div className="card-body empty mini">
      <p>Loading parts…</p></div></div>
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Parts used on this unit</h2>
        {data.total_lines > 0 && (
          <span className="sub">
            {data.distinct_parts} part{data.distinct_parts === 1 ? '' : 's'}
            {' · '}{money(data.total_spend)} spent
          </span>
        )}
      </div>
      <div className="card-body">
        {data.total_lines === 0 ? (
          <div className="empty mini">
            <p>No parts have been used on this unit's work orders yet.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="defects-table wo-table">
              <thead>
                <tr>
                  <th>Part #</th>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit</th>
                  <th className="num">Total</th>
                  <th>WO</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p: PartUsed, i: number) => (
                  <tr key={i} onClick={() => onOpenWo(p.wo_id)}>
                    <td className="mono">
                      {p.part_number || <span className="muted">—</span>}
                    </td>
                    <td className="wo-title">{p.description}</td>
                    <td className="num">{p.qty}</td>
                    <td className="num mono">{money(p.unit_cost)}</td>
                    <td className="num mono">{money(p.total)}</td>
                    <td><span className="mono">#{p.wo_no}</span></td>
                    <td className="muted">{p.date || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

// ----- Components & PMs ----------------------------------------------------
function CampaignsTab({ unit, data, loading, onChanged }: {
  unit: string
  data: import('../api').UnitCampaignsResult | undefined
  loading: boolean
  onChanged: () => void
}) {
  const [recordFor, setRecordFor] = useState<UnitCampaign | null>(null)
  // Animación "PM DONE" (handoff del diseñador, v2.17): al REGISTRAR un PM
  // (tras el éxito del modal, no al click), una onda verde inunda el panel
  // desde el botón, muestra PM DONE y se desvanece revelando el estado nuevo
  // — el flood ENMASCARA el re-render de los datos (coreografía intencional).
  const [flooding, setFlooding] = useState<string | null>(null)
  // Ancla del disco = centro del botón "Record done" relativo a la tarjeta,
  // capturada al abrir el modal (fallback del mock: top 42 / right 100).
  // `size` se calcula por tarjeta (2.2× su diagonal, regla del handoff): los
  // 1600px fijos del mock alcanzaban para su card de ~640px, no para el
  // panel real de escritorio (~1700px) — la onda no llegaba a cubrirlo.
  const [floodAnchor, setFloodAnchor] = useState(
    { top: 42, right: 100, size: 1600 })

  if (loading || !data) {
    return <div className="card"><div className="card-body empty mini">
      <p>Loading campaigns…</p></div></div>
  }

  return (
    <>
      <div className="up-campaigns">
        {data.campaigns.map((c) => {
          const sm = CAMP_STATUS[c.status] ?? CAMP_STATUS.never
          return (
            <div className="card up-campaign" key={c.key}>
              {flooding === c.key && (
                <>
                  <span className="pm-flood"
                    style={{
                      top: floodAnchor.top,
                      right: floodAnchor.right,
                      width: floodAnchor.size,
                      height: floodAnchor.size,
                    }}
                    onAnimationEnd={() => setFlooding(null)}
                    aria-hidden="true" />
                  <span className="pm-flood-msg" aria-hidden="true">
                    PM DONE
                  </span>
                </>
              )}
              <div className="up-camp-head">
                <strong className={flooding === c.key ? 'pm-flood-title' : ''}>
                  {c.label}
                </strong>
                <span className={`mnt-status-pill ${sm.cls}`}>
                  {sm.label}
                </span>
                {!c.default && (
                  <button className="mnt-icon" title="Remove campaign"
                    onClick={async () => {
                      await toggleUnitCampaign(unit, c.key, false)
                      onChanged()
                    }}>
                    <svg viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="1.8"
                      strokeLinecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="up-camp-grid">
                <span>
                  <em>Last done</em>
                  {c.last_date
                    ? `${c.last_date}${c.due === 'hours'
                        ? (c.last_hours != null
                          ? ` · ${fmtHrs(c.last_hours)} hrs` : '')
                        : c.last_miles != null
                          ? ` · ${fmtMi(c.last_miles)} mi` : ''}`
                    : 'Never'}
                </span>
                <span>
                  <em>Next due</em>
                  {c.due === 'miles' && c.next_due_miles != null
                    ? `${fmtMi(c.next_due_miles)} mi`
                    : c.due === 'days' && c.next_due_date
                      ? c.next_due_date
                      : c.due === 'hours'
                        ? ([c.next_due_hours != null
                          ? `${fmtHrs(c.next_due_hours)} hrs` : '',
                          c.next_due_date
                            ? `${c.next_due_hours != null ? 'or ' : ''}${c.next_due_date}`
                            : ''].filter(Boolean).join(' · ') || '—')
                        : c.due === 'none' ? 'On condition' : '—'}
                </span>
                <span>
                  {c.due === 'hours' ? (
                    <HoursToDue c={c} />
                  ) : (
                    <>
                      <em>{c.due === 'miles' ? 'Miles to due'
                        : c.due === 'days' ? 'Days to due' : 'Interval'}</em>
                      {c.to_due != null
                        ? `${c.to_due < 0 ? '-' : ''}${fmtMi(Math.abs(c.to_due))}`
                        : '—'}
                    </>
                  )}
                </span>
                <button className="btn btn-ghost btn-xs"
                  onClick={(e) => {
                    // Centro del botón relativo a la tarjeta: de acá nace el
                    // disco del flood si el registro tiene éxito.
                    const btn = e.currentTarget.getBoundingClientRect()
                    const card = e.currentTarget
                      .closest('.up-campaign')?.getBoundingClientRect()
                    if (card) {
                      setFloodAnchor({
                        top: btn.top + btn.height / 2 - card.top,
                        right: card.right - (btn.left + btn.width / 2),
                        size: Math.ceil(
                          2.2 * Math.hypot(card.width, card.height)),
                      })
                    }
                    setRecordFor(c)
                  }}>
                  Record done
                </button>
              </div>
              {c.records.length > 0 && (
                <div className="up-camp-recs">
                  {c.records.map((r) => (
                    <span key={r.id}>
                      {r.date}
                      {r.hours != null ? ` · ${fmtHrs(r.hours)} hrs` : ''}
                      {r.mileage != null ? ` · ${fmtMi(r.mileage)} mi` : ''}
                      {r.notes ? ` · ${r.notes}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {data.available.length > 0 && (
        <div className="up-add-campaign">
          <span>Add a maintenance campaign:</span>
          {data.available.map((a) => (
            <button key={a.key} className="btn btn-ghost btn-xs"
              onClick={async () => {
                await toggleUnitCampaign(unit, a.key, true)
                onChanged()
                notifyOk('Campaign added', a.label)
              }}>
              + {a.label}
            </button>
          ))}
        </div>
      )}

      {recordFor && (
        <RecordModal unit={unit} campaign={recordFor}
          currentMiles={data.current_miles}
          currentHours={data.current_hours ?? null}
          onClose={() => setRecordFor(null)}
          onSaved={() => {
            const key = recordFor.key
            setRecordFor(null)
            // Reduced motion: sin animación, solo el swap de estado (spec).
            // El guard evita re-disparo si ya hay un flood en curso.
            if (flooding == null && !window.matchMedia(
              '(prefers-reduced-motion: reduce)').matches) {
              setFlooding(key)
            }
            onChanged()
          }} />
      )}
    </>
  )
}

// "Hours to due" de una campaña por horas, con la fecha de respaldo abajo
// (vence lo que llegue primero). Sin horómetro: solo días.
function HoursToDue({ c }: { c: UnitCampaign }) {
  const byHours = c.to_due != null && c.due_by !== 'days'
  return (
    <>
      <em>{byHours ? 'Hours to due' : 'Days to due'}</em>
      {byHours
        ? `${(c.to_due as number) < 0 ? '-' : ''}${fmtHrs(Math.abs(c.to_due as number))}`
        : c.to_due_days != null
          ? `${c.to_due_days < 0 ? '-' : ''}${fmtMi(Math.abs(c.to_due_days))}`
          : '—'}
      {byHours && c.to_due_days != null && (
        <small className="up-camp-alt">
          or {c.to_due_days < 0
            ? `${fmtMi(Math.abs(c.to_due_days))} days over`
            : `${fmtMi(c.to_due_days)} days`} by date
        </small>
      )}
      {c.meter_missing && (
        <small className="up-camp-alt">No engine-hours reading · by date</small>
      )}
    </>
  )
}

function RecordModal({
  unit, campaign, currentMiles, currentHours, onClose, onSaved,
}: {
  unit: string
  campaign: UnitCampaign
  currentMiles: number | null
  currentHours: number | null
  onClose: () => void
  onSaved: () => void
}) {
  // v2.22: las campañas por horas (PM del reefer) registran HORAS de motor;
  // el resto, millas. Nunca se mezclan.
  const byHours = campaign.due === 'hours'
  const [date, setDate] = useState(todayISO())
  const [miles, setMiles] = useState(
    !byHours && currentMiles != null ? String(currentMiles) : '')
  const [hours, setHours] = useState(
    byHours && currentHours != null ? String(currentHours) : '')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (busy) return
    setBusy(true)
    try {
      await addMaintRecord(byHours
        ? { kind: campaign.key, unit, date,
            hours: hours ? Number(hours) : null, notes }
        : { kind: campaign.key, unit, date,
            mileage: miles ? Number(miles) : null, notes })
      notifyOk(`${campaign.label} recorded`, unit)
      onSaved()
    } catch (e) {
      notifyErr("Couldn't save", e)
      setBusy(false)
    }
  }

  return (
    <Modal title={`Record · ${campaign.label}`} onClose={onClose} width={420}>
      <form className="mnt-form"
        onSubmit={(e) => { e.preventDefault(); void save() }}>
        <label><span>Date</span>
          <input type="date" className="cell-input" value={date} autoFocus
            onChange={(e) => setDate(e.target.value)} />
        </label>
        {byHours ? (
          <label><span>Engine hours</span>
            <input type="number" className="cell-input" value={hours}
              min={0} step="0.1"
              placeholder="hour meter at the service"
              onChange={(e) => setHours(e.target.value)} />
          </label>
        ) : (
          <label><span>Mileage</span>
            <input type="number" className="cell-input" value={miles}
              placeholder="optional"
              onChange={(e) => setMiles(e.target.value)} />
          </label>
        )}
        <label><span>Notes</span>
          <input className="cell-input" value={notes} placeholder="optional"
            onChange={(e) => setNotes(e.target.value)} />
        </label>
        {byHours && (
          <p className="field-hint">
            The hours are also saved as an engine-hours reading for {unit}.
          </p>
        )}
        <div className="mnt-form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ----- Active Services / Service History ------------------------------------
function ServicesTab({ title, empty, wos, grouped, onOpen, onDelete }: {
  title: string
  empty: string
  wos: WorkOrder[]
  grouped?: boolean
  onOpen: (id: number) => void
  onDelete?: (w: WorkOrder) => void
}) {
  const sections: { status: WoStatus; rows: WorkOrder[] }[] = grouped
    ? PIPELINE.filter((s) => s !== 'invoiced')
        .map((s) => ({ status: s, rows: wos.filter((w) => w.status === s) }))
    : [{ status: 'invoiced', rows: wos }]

  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2>
        <span className="sub">{wos.length} total</span></div>
      <div className="card-body">
        {wos.length === 0 && (
          <div className="empty mini"><p>{empty}</p></div>
        )}
        {wos.length > 0 && sections.map(({ status, rows }) => (
          (grouped || rows.length > 0) && (
            <div key={status} className="up-svc-group">
              {grouped && (
                <div className="up-svc-head">
                  <span className={`wo-status ${STATUS_META[status].cls}`}>
                    {STATUS_META[status].label}
                  </span>
                  <i>{rows.length}</i>
                </div>
              )}
              {rows.length === 0 ? (
                <p className="up-svc-empty">
                  No service orders in this status.
                </p>
              ) : (
                <table className="up-svc-table">
                  <tbody>
                    {rows.map((w) => (
                      <tr key={w.id} onClick={() => onOpen(w.id)}>
                        <td className="mono">#{w.id}</td>
                        <td className="up-svc-title">
                          {w.title}
                          {w.is_pm && <span className="wo-pm-tag">PM</span>}
                          {w.waiting_parts && (
                            <span className="wo-wait-tag">parts</span>
                          )}
                        </td>
                        <td>{w.mechanic || '—'}</td>
                        <td className="muted">
                          {dateOf(w.invoiced_at) || dateOf(w.service_date)
                            || dateOf(w.created_at)}
                        </td>
                        <td className="num mono">
                          {w.total ? money(w.total) : '—'}
                        </td>
                        <td className="up-svc-actions">
                          <button className="btn btn-ghost btn-xs"
                            onClick={(e) => {
                              e.stopPropagation(); onOpen(w.id)
                            }}>
                            Edit
                          </button>
                          {onDelete && (
                            <button className="btn btn-ghost btn-xs up-danger"
                              onClick={(e) => {
                                e.stopPropagation(); onDelete(w)
                              }}>
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        ))}
      </div>
    </section>
  )
}

// ----- Attachments -----------------------------------------------------------
function DocsTab({ unit, data, onChanged }: {
  unit: string
  data: { docs: import('../api').UnitDoc[]
          kinds: { key: string; label: string }[] } | undefined
  onChanged: () => void
}) {
  const [kind, setKind] = useState('other')
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || busy) return
    setBusy(true)
    try {
      const r = await uploadUnitDocs(unit, kind, Array.from(files))
      onChanged()
      if (r.saved.length) {
        notifyOk(`${r.saved.length} document${r.saved.length === 1 ? '' : 's'} uploaded`)
      }
      for (const err of r.errors) notifyErr('Skipped', err)
    } catch (e) {
      notifyErr("Couldn't upload", e)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <section className="card">
      <div className="card-head"><h2>Unit documents</h2>
        <span className="sub">
          PM copies, DOT inspections, CAB cards, registrations
        </span>
      </div>
      <div className="card-body">
        <div className="up-doc-bar">
          <label className="ud-field up-doc-kind">
            <span>Document type</span>
            <select className="cell-input" value={kind}
              onChange={(e) => setKind(e.target.value)}>
              {(data?.kinds ?? []).map((k) => (
                <option key={k.key} value={k.key}>{k.label}</option>
              ))}
            </select>
          </label>
          <div
            className={`wo-scan up-doc-drop ${dragOver ? 'is-over' : ''} ${busy ? 'is-busy' : ''}`}
            role="button" tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') fileRef.current?.click()
            }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false)
              upload(e.dataTransfer.files)
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round"
              className="wo-scan-ico">
              <path d="M12 16V4m0 0L7 9m5-5 5 5" />
              <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            <span className="wo-scan-text">
              <strong>{busy ? 'Uploading…' : 'Upload documents'}</strong>
              <span>PDF or photos. Several files at once work.</span>
            </span>
            <input ref={fileRef} type="file" hidden multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*"
              onChange={(e) => upload(e.target.files)} />
          </div>
        </div>

        {(data?.docs ?? []).length === 0 ? (
          <div className="empty mini">
            <p>No documents yet. Upload the PM copy, DOT inspection,
              CAB card or registration.</p>
          </div>
        ) : (
          <table className="up-svc-table up-docs-table">
            <tbody>
              {(data?.docs ?? []).map((d) => (
                <tr key={d.id}>
                  <td>
                    <span className="up-doc-kind-tag">{d.kind_label}</span>
                  </td>
                  <td className="up-svc-title">{d.filename}</td>
                  <td className="muted">{fmtSize(d.size)}</td>
                  <td className="muted">{dateOf(d.uploaded_at)}</td>
                  <td className="up-svc-actions">
                    <button className="btn btn-ghost btn-xs"
                      onClick={() => downloadUnitDoc(d.id, d.filename)
                        .catch((e) => notifyErr("Couldn't download", e))}>
                      Download
                    </button>
                    <button className="btn btn-ghost btn-xs up-danger"
                      onClick={async () => {
                        if (!window.confirm(
                          `Delete ${d.filename}?`)) return
                        try {
                          await deleteUnitDoc(d.id)
                          onChanged()
                        } catch (e) {
                          notifyErr("Couldn't delete", e)
                        }
                      }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
