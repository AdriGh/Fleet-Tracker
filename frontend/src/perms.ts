// Permisos por rol en el frontend (fase H4). Los scopes los manda el backend
// en /api/auth/status; acá se exponen vía contexto para ocultar/deshabilitar
// acciones. El ENFORCEMENT real vive en el backend (middleware por scope) —
// esto es solo UX. `can()` es permisivo con admin por las dudas.
import { createContext, useContext } from 'react'

export interface Perms {
  role: string
  scopes: string[]
  can: (scope: string) => boolean
}

export const PermsContext = createContext<Perms>({
  role: '',
  scopes: [],
  can: () => false,
})

export const usePerms = () => useContext(PermsContext)
