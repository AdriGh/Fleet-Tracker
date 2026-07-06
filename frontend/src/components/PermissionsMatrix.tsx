// Matriz de permisos (Increment 5 del handoff): expone en la UI, READ-ONLY,
// exactamente los scopes RBAC que el backend enforce. Filas = capacidades
// (scopes), columnas = roles. Como la lectura nunca exige scope, cada rol
// tiene al menos "View"; tener el scope es "Edit". Admin = Edit en todo
// (lockeado). Editar roles a medida llegará con un store de RBAC por-org.
import { useQuery } from '@tanstack/react-query'
import { getPermissionsMatrix } from '../api'
import Skeleton from './Skeleton'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', dispatcher: 'Dispatcher', safety: 'Safety',
  mechanic: 'Mechanic', viewer: 'Viewer',
}

export default function PermissionsMatrix() {
  const q = useQuery({
    queryKey: ['permissions-matrix'], queryFn: getPermissionsMatrix,
  })

  if (q.isPending) return <Skeleton h={240} />
  const data = q.data
  if (!data) {
    return <div className="empty mini"><p>Could not load permissions.</p></div>
  }

  return (
    <div className="perm-wrap">
      <p className="perm-note">
        Your roles and what each one can do — a live reflection of what the
        backend enforces. Read-only for now: everyone can <strong>view</strong>;
        a role needs the capability to <strong>edit</strong>. Admin always has
        full access. Custom roles are coming.
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
                  const v = data.matrix[r]?.[sc.id] ?? 'view'
                  return (
                    <td key={r} className="perm-cell">
                      <span className={`perm-seg ${v}`}>
                        <span className={v === 'view' ? 'on' : ''}>View</span>
                        <span className={v === 'edit' ? 'on' : ''}>Edit</span>
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
