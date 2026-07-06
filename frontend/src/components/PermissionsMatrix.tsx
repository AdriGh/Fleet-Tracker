// Matriz de permisos EDITABLE (Increment 5b, RBAC editable). Expone y ahora
// permite editar los scopes RBAC por rol de la org (admin-only). Filas =
// capacidades (scopes), columnas = roles. Como la lectura nunca exige scope,
// cada rol tiene al menos "View"; conceder el scope es "Edit". Admin = Edit
// en todo (lockeado). El backend fusiona esto sobre los defaults; sin cambios
// la org sigue con los defaults hardcodeados.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getPermissionsMatrix, savePermissionsMatrix } from '../api'
import { notifyOk, notifyErr } from '../toast'
import { Button } from './ds'
import Skeleton from './Skeleton'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', dispatcher: 'Dispatcher', safety: 'Safety',
  mechanic: 'Mechanic', viewer: 'Viewer',
}

type Cell = 'view' | 'edit'
type Grid = Record<string, Record<string, Cell>>

export default function PermissionsMatrix() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['permissions-matrix'], queryFn: getPermissionsMatrix,
  })
  const data = q.data

  // Copia editable de la matriz (se re-sincroniza cuando llega/cambia el fetch).
  const [grid, setGrid] = useState<Grid>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (data) setGrid(JSON.parse(JSON.stringify(data.matrix)) as Grid)
  }, [data])

  const dirty = useMemo(() => {
    if (!data) return false
    return JSON.stringify(grid) !== JSON.stringify(data.matrix)
  }, [grid, data])

  if (q.isPending) return <Skeleton h={260} />
  if (!data) {
    return <div className="empty mini"><p>Could not load permissions.</p></div>
  }

  function toggle(role: string, scope: string) {
    if (role === 'admin') return   // admin lockeado
    setGrid((g) => ({
      ...g,
      [role]: { ...g[role], [scope]: g[role][scope] === 'edit' ? 'view' : 'edit' },
    }))
  }

  function reset() {
    if (data) setGrid(JSON.parse(JSON.stringify(data.matrix)) as Grid)
  }

  async function save() {
    if (!data) return
    // grants = por rol (menos admin), los scopes en 'edit'.
    const grants: Record<string, string[]> = {}
    for (const role of data.roles) {
      if (role === 'admin') continue
      grants[role] = data.scopes
        .filter((sc) => grid[role]?.[sc.id] === 'edit')
        .map((sc) => sc.id)
    }
    setSaving(true)
    try {
      await savePermissionsMatrix(grants)
      notifyOk('Permissions saved', 'The access matrix is updated')
      qc.invalidateQueries({ queryKey: ['permissions-matrix'] })
      // El rol propio del admin no cambia, pero refrescamos el estado de auth
      // por si algún scope del usuario actual se vio afectado.
      qc.invalidateQueries({ queryKey: ['auth-status'] })
    } catch (e) {
      notifyErr("Couldn't save permissions", e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="perm-wrap">
      <p className="perm-note">
        What each role can do. Everyone can <strong>view</strong>; grant a
        capability to let a role <strong>edit</strong>. Click a cell to toggle.
        Admin always has full access. Changes apply to your whole organization.
      </p>
      <div className="table-wrap">
        <table className="perm-table">
          <thead>
            <tr>
              <th className="perm-cap">Capability</th>
              {data.roles.map((r) => (
                <th key={r} className="perm-role">
                  {ROLE_LABEL[r] ?? r}
                  {r === 'admin' && (
                    <svg className="perm-lock" viewBox="0 0 24 24" width="12"
                      height="12" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round"
                      strokeLinejoin="round" aria-label="always full access">
                      <rect x="4" y="11" width="16" height="10" rx="2" />
                      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                    </svg>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.scopes.map((sc) => (
              <tr key={sc.id}>
                <td className="perm-cap">
                  <strong>{sc.label}</strong>
                  <span className="perm-scope mono">{sc.id}</span>
                </td>
                {data.roles.map((r) => {
                  const v = grid[r]?.[sc.id] ?? 'view'
                  const locked = r === 'admin'
                  return (
                    <td key={r} className="perm-cell">
                      <button type="button"
                        className={`perm-seg ${v}${locked ? ' is-locked' : ''}`}
                        disabled={locked}
                        onClick={() => toggle(r, sc.id)}
                        title={locked ? 'Admin always has full access'
                          : 'Click to toggle View / Edit'}>
                        <span className={v === 'view' ? 'on' : ''}>View</span>
                        <span className={v === 'edit' ? 'on' : ''}>Edit</span>
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="perm-actions">
        {dirty && (
          <button className="btn btn-ghost btn-sm" onClick={reset}
            disabled={saving}>Reset changes</button>
        )}
        <span className="head-spacer" />
        <Button variant="primary" size="sm" onClick={save}
          disabled={!dirty || saving} loading={saving}>
          Save permissions
        </Button>
      </div>
    </div>
  )
}
