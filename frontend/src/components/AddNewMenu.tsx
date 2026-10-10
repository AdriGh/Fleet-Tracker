// Menú "+" Add New (v2.22, estructura de SquareRigger): registros de trabajo
// arriba, maestros (Resources) abajo, con separador. Cada ítem respeta el
// scope del rol (perms.can) — un viewer ve una nota en vez de opciones.
import type { RefObject } from 'react'
import { CREATE_ITEMS } from '../navModel'
import { usePerms } from '../perms'
import type { CreateKind } from '../shell'
import { MenuList, Popover, type Placement } from './ShellPopover'

export default function AddNewMenu({ anchor, placement, onClose, onPick }: {
  anchor: RefObject<HTMLElement | null>
  placement: Placement
  onClose: () => void
  onPick: (kind: CreateKind) => void
}) {
  const { can } = usePerms()
  const items = CREATE_ITEMS.filter((i) => !i.scope || can(i.scope))
  const work = items.filter((i) => i.block === 'work')
  const res = items.filter((i) => i.block === 'resource')
  const pick = (k: CreateKind) => { onClose(); onPick(k) }

  return (
    <Popover anchor={anchor} placement={placement} onClose={onClose}
      className="rs-menu rs-add-menu">
      <div className="rs-menu-head" aria-hidden="true">Add new…</div>
      {items.length === 0 ? (
        <p className="rs-menu-note">
          Your role can view records but not create them.
        </p>
      ) : (
        <MenuList label="Add new" onClose={onClose}>
          {work.map((i) => (
            <button key={i.kind} type="button" role="menuitem"
              className="rs-menu-item" onClick={() => pick(i.kind)}>
              <span className="rs-mi-ico">{i.icon}</span>
              <span className="rs-mi-label">{i.label}</span>
            </button>
          ))}
          {work.length > 0 && res.length > 0 && (
            <div role="separator" className="rs-menu-sep" />
          )}
          {res.map((i) => (
            <button key={i.kind} type="button" role="menuitem"
              className="rs-menu-item" onClick={() => pick(i.kind)}>
              <span className="rs-mi-ico">{i.icon}</span>
              <span className="rs-mi-label">{i.label}</span>
            </button>
          ))}
        </MenuList>
      )}
    </Popover>
  )
}
