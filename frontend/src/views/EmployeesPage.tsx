// Resources → Employees (v2.22 [F]): el roster de técnicos como recurso,
// maestro-detalle estilo SquareRigger. Perfil con rol, contacto
// (enmascarado sin pii.view), tarifa, fecha de ingreso, WOs asignadas y
// horas/costo de labor de los últimos 30 días.
// Props de contrato: { intent?: {technician: id} }.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deactivateTechnician, getTechnician, listTechnicians, patchTechnician,
  type Technician,
} from '../api'
import { notifyErr, notifyOk } from '../toast'
import { usePerms } from '../perms'
import type { NavIntent } from '../shell'
import { ICONS } from '../navModel'
import { Button } from '../components/ds'
import Skeleton from '../components/Skeleton'
import EmployeeModal from '../components/EmployeeModal'
import {
  RxAvatar, RxBack, RxBlock, RxDl, RxEmpty, RxKpi, RxRow, RxSeg, 
} from '../components/ResourceLayout'
import { listKeyHandler } from '../listKeys'
import { isMasked, money } from '../customers'
import { WoDrawer } from './WoDetail'
import { dateOf, STATUS_META } from './woShared'

type ActiveFilter = 'active' | 'inactive' | 'all'

export default function EmployeesPage({ intent }: { intent?: NavIntent }) {
  const { can } = usePerms()
  const editable = can('maint.edit')
  const [q, setQ] = useState('')
  const [active, setActive] = useState<ActiveFilter>('active')
  const [selId, setSelId] = useState<number | null>(
    () => (typeof intent?.technician === 'number' ? intent.technician : null))
  const [showDetail, setShowDetail] = useState(() => intent?.technician != null)
  const [creating, setCreating] = useState(false)

  const techQ = useQuery({
    queryKey: ['technicians', 'all'], queryFn: () => listTechnicians(true),
  })
  const all = useMemo(() => techQ.data ?? [], [techQ.data])
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return all
      .filter((t) => active === 'all' || (active === 'active') === t.active)
      .filter((t) => !s || t.name.toLowerCase().includes(s)
        || (t.role ?? '').toLowerCase().includes(s))
      .sort((a, b) => Number(b.active) - Number(a.active)
        || a.name.localeCompare(b.name))
  }, [all, q, active])

  const profileId = selId ?? rows[0]?.id ?? null
  const selIndex = rows.findIndex((r) => r.id === profileId)
  const onListKey = listKeyHandler(rows, selIndex, (t) => setSelId(t.id))
  const fromList = all.find((t) => t.id === profileId) ?? null

  return (
    <div className="page page-wide rx-page">
      {techQ.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Employees</h1>
          <p className="page-sub">
            Technicians and shop staff: who works inside orders, their rates
            and recent labor.
          </p>
        </div>
        {editable && (
          <div className="head-actions">
            <Button variant="primary" onClick={() => setCreating(true)}>
              New employee
            </Button>
          </div>
        )}
      </div>

      <div className={`rx-layout ${showDetail ? 'show-detail' : ''}`}>
        <aside className="rx-list" aria-label="Employees">
          <div className="rx-list-tools">
            <input className="cell-input rx-search" type="search"
              placeholder="Search name or role…" value={q}
              aria-label="Search employees"
              onChange={(e) => setQ(e.target.value)} />
            <RxSeg<ActiveFilter> label="Status" value={active}
              onChange={setActive}
              options={[
                { id: 'active', label: 'Active' },
                { id: 'inactive', label: 'Inactive' },
                { id: 'all', label: 'All' },
              ]} />
          </div>
          <div className="rx-list-head">
            <span>{rows.length} employee{rows.length === 1 ? '' : 's'}</span>
          </div>
          <div className="rx-list-body" role="listbox" aria-label="Employee list"
            onKeyDown={onListKey}>
            {techQ.isPending ? (
              Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} h={52} r={10} />
              ))
            ) : techQ.isError ? (
              <RxEmpty title="Couldn't load employees">
                <button type="button" className="link-btn"
                  onClick={() => { void techQ.refetch() }}>Retry</button>
              </RxEmpty>
            ) : rows.length === 0 ? (
              <RxEmpty title={all.length ? 'No employees match' : 'No employees yet'}>
                <p>{all.length ? 'Try another filter.'
                  : 'Add the technicians you assign to work orders.'}</p>
              </RxEmpty>
            ) : rows.map((t) => (
              <RxRow key={t.id} selected={t.id === profileId}
                onSelect={() => { setSelId(t.id); setShowDetail(true) }}
                avatar={<RxAvatar name={t.name} />}
                title={t.name}
                sub={<>
                  {t.role || 'Technician'}
                  {t.hire_date ? <span className="rx-sep">Since {t.hire_date.slice(0, 4)}</span> : null}
                </>}
                side={t.active ? null
                  : <span className="rx-pill is-muted">Inactive</span>} />
            ))}
          </div>
        </aside>

        <section className="rx-detail" aria-label="Employee profile">
          {profileId != null ? (
            <EmployeeProfile key={profileId} id={profileId} fallback={fromList}
              editable={editable} onBack={() => setShowDetail(false)} />
          ) : (
            <RxEmpty icon={ICONS.employees} title="Pick an employee">
              <p>Their assigned work orders and recent labor show here.</p>
            </RxEmpty>
          )}
        </section>
      </div>

      {creating && (
        <EmployeeModal onClose={() => setCreating(false)}
          onSaved={(t) => {
            setCreating(false)
            setSelId(t.id)
            setShowDetail(true)
          }} />
      )}
    </div>
  )
}

function EmployeeProfile({ id, fallback, editable, onBack }: {
  id: number
  fallback: Technician | null
  editable: boolean
  onBack: () => void
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [openWo, setOpenWo] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const profQ = useQuery({
    queryKey: ['technician', id],
    queryFn: () => getTechnician(id),
    retry: false,
  })
  // Sin perfil (backend viejo / error) se muestra lo que trae el roster.
  const t = profQ.data?.technician ?? fallback
  const wos = profQ.data?.work_orders ?? []
  const openWos = wos.filter((w) => w.status !== 'invoiced')

  function refresh() {
    qc.invalidateQueries({ queryKey: ['technicians'] })
    qc.invalidateQueries({ queryKey: ['technician', id] })
  }

  async function toggleActive() {
    if (!t) return
    if (t.active && !window.confirm(
      `Deactivate ${t.name}? They leave the technician picker; existing work orders keep the name.`)) return
    setBusy(true)
    try {
      if (t.active) await deactivateTechnician(t.id)
      else await patchTechnician(t.id, { active: true })
      refresh()
      notifyOk(t.active ? `${t.name} deactivated` : `${t.name} reactivated`)
    } catch (e) {
      notifyErr("Couldn't update the employee", e)
    } finally {
      setBusy(false)
    }
  }

  if (profQ.isPending && !t) {
    return (
      <div className="rx-pskel">
        <Skeleton w="45%" h={24} />
        <div className="rx-kpis">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={72} r={12} />)}
        </div>
        <Skeleton h={160} r={12} />
      </div>
    )
  }
  if (!t) {
    return (
      <RxEmpty title="Employee not found">
        <RxBack label="Employees" onClick={onBack} />
      </RxEmpty>
    )
  }
  const contact = (v?: string) => (v ? (isMasked(v)
    ? <span className="rx-masked" title="Hidden — needs permission to view personal data">{v}</span>
    : v) : '')

  return (
    <>
      <header className="rx-phead">
        <RxBack label="Employees" onClick={onBack} />
        <RxAvatar name={t.name} size="lg" />
        <div className="rx-phead-main">
          <span className="rx-eyebrow">Employee</span>
          <h2 className="rx-ptitle">{t.name}</h2>
          <div className="rx-pchips">
            <span className="rx-pill">{t.role || 'Technician'}</span>
            <span className={`rx-pill ${t.active ? 'is-ok' : 'is-muted'}`}>
              {t.active ? 'Active' : 'Inactive'}
            </span>
            {t.hire_date && (
              <span className="rx-psub">
                Hired {t.hire_date}
              </span>
            )}
          </div>
        </div>
        {editable && (
          <div className="rx-phead-actions">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" loading={busy}
              className={t.active ? 'up-danger' : ''} onClick={toggleActive}>
              {t.active ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        )}
      </header>

      <div className="rx-pbody">
        <div className="rx-stack">
          <div className="rx-kpis">
            <RxKpi label="Labor hours · 30d"
              value={profQ.data ? (Math.round(profQ.data.labor_hours_30d * 10) / 10)
                .toLocaleString('en-US') : '—'}
              sub="on their work orders" />
            <RxKpi label="Labor cost · 30d"
              value={profQ.data ? money(profQ.data.labor_cost_30d) : '—'} />
            <RxKpi label="Hourly rate"
              value={t.hourly_rate != null ? money(t.hourly_rate) : '—'}
              sub={t.hourly_rate != null ? 'per hour' : 'not set'} />
            <RxKpi label="Open work orders" value={openWos.length}
              tone={openWos.length > 6 ? 'warn' : undefined}
              sub={`${wos.length} recent`} />
          </div>

          <RxBlock title="Info">
            <RxDl rows={[
              ['Role', t.role || 'Technician'],
              ['Phone', contact(t.phone)],
              ['Email', contact(t.email)],
              ['Hire date', t.hire_date],
              ['App login', t.user_id ? 'Linked to a user account' : 'No login'],
              ['Notes', t.notes],
            ]} />
          </RxBlock>

          <RxBlock title={`Assigned work orders · ${wos.length}`}>
            {profQ.isError ? (
              <p className="rx-none">Work order history isn't available right now.</p>
            ) : wos.length === 0 ? (
              <p className="rx-none">No work orders assigned to {t.name} yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="defects-table rx-table">
                  <thead>
                    <tr>
                      <th scope="col">WO</th>
                      <th scope="col">Unit · work</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wos.map((w) => (
                      <tr key={w.id} className="rx-click"
                        onClick={() => setOpenWo(w.id)}>
                        <td className="mono">
                          <button type="button" className="link-btn"
                            onClick={(e) => { e.stopPropagation(); setOpenWo(w.id) }}>
                            #{w.display_no || w.id}
                          </button>
                        </td>
                        <td className="rx-cell-2">
                          <strong>{w.unit}</strong>
                          <span title={w.title}>{w.title}</span>
                        </td>
                        <td className="rx-cell-2">
                          <span className={`wo-status ${STATUS_META[w.status]?.cls ?? ''}`}>
                            {STATUS_META[w.status]?.label ?? w.status}
                          </span>
                          <span className="muted">{dateOf(w.created_at)}</span>
                        </td>
                        <td className="num mono">
                          {w.total != null ? money(w.total) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </RxBlock>
        </div>
      </div>

      {editing && (
        <EmployeeModal technician={t} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); refresh() }} />
      )}
      <WoDrawer woId={openWo} onClose={() => setOpenWo(null)} />
    </>
  )
}
