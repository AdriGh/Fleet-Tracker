// Modelo de navegación v2.22 (estilo SquareRigger): grupos WORK / RESOURCES /
// INSIGHTS / ADMIN + catálogo del menú "+" Add New. Los ids de sección son
// ESTABLES (setup_status.py y guides.ts los referencian): acá solo cambian
// labels y agrupación. Iconos: trazo 1.8 redondeado, viewBox 24, como el
// resto de la app.
import type { ReactElement, ReactNode } from 'react'
import type { CreateKind } from './shell'

const svg = (children: ReactNode, sw = 1.8): ReactElement => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    focusable="false">
    {children}
  </svg>
)

// ----- Iconos de sección -----------------------------------------------------
export const ICONS: Record<string, ReactElement> = {
  dashboard: svg(<>
    <path d="M3.5 10.6 12 3.8l8.5 6.8" />
    <path d="M5.5 9.1V19a1.5 1.5 0 0 0 1.5 1.5h3.3v-5.6h3.4v5.6H17a1.5 1.5 0 0 0 1.5-1.5V9.1" />
  </>),
  'service-requests': svg(<>
    <path d="M3.5 13.5 6 5.6A1.6 1.6 0 0 1 7.5 4.5h9a1.6 1.6 0 0 1 1.5 1.1l2.5 7.9" />
    <path d="M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5H16l-1.5 2.5h-5L8 13.5z" />
    <path d="M9.5 8.5h5M10.5 11h3" />
  </>),
  workorders: svg(<>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </>),
  purchasing: svg(<>
    <circle cx="9" cy="20" r="1.4" />
    <circle cx="18" cy="20" r="1.4" />
    <path d="M2.5 3H4.8l2 11.4a1.5 1.5 0 0 0 1.5 1.2h8.2a1.5 1.5 0 0 0 1.5-1.2L20.5 7H5.2" />
  </>),
  pm: svg(
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.5-.5-2.3z" />,
  ),
  // Cronómetro: PM del reefer por HORAS de motor.
  'reefer-pm': svg(<>
    <circle cx="12" cy="13.5" r="7.2" />
    <path d="M12 13.5V10M12 13.5l2.6 1.6M9.8 2.8h4.4M12 2.8v3.5M18.6 6.4l1.3-1.3" />
  </>),
  dot: svg(<>
    <path d="M9 4h6M9 4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2M9 4v2h6V4" />
    <path d="m9.5 13 1.8 1.8 3.2-3.6" />
  </>),
  dvir: svg(<>
    <path d="M9 4h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2V5a1 1 0 0 1 1-1z" />
    <path d="m9 13 2 2 4-4" />
  </>),
  defectos: svg(<>
    <path d="M10.3 3.5 1.8 18a1.5 1.5 0 0 0 1.3 2.2h17.8A1.5 1.5 0 0 0 22.2 18L13.7 3.5a1.5 1.5 0 0 0-2.6 0z" />
    <path d="M12 9v4M12 17h.01" />
  </>),
  customers: svg(<>
    <circle cx="12" cy="8.2" r="3.7" />
    <path d="M4.6 20.2c.9-3.8 3.8-5.9 7.4-5.9s6.5 2.1 7.4 5.9" />
  </>),
  employees: svg(<>
    <rect x="4.5" y="3.5" width="15" height="17" rx="2.2" />
    <circle cx="12" cy="10.2" r="2.6" />
    <path d="M8.2 16.8c.7-1.8 2.1-2.7 3.8-2.7s3.1.9 3.8 2.7M10 3.5v1.8h4V3.5" />
  </>),
  flota: svg(<>
    <path d="M2 6h11v9H2zM13 9h4l3 3v3h-7z" />
    <circle cx="6.5" cy="17.5" r="1.8" />
    <circle cx="17.5" cy="17.5" r="1.8" />
  </>),
  locations: svg(<>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.4" />
  </>),
  parts: svg(<>
    <path d="M21 8 12 3 3 8v8l9 5 9-5V8z" />
    <path d="m3 8 9 5 9-5M12 13v8" />
  </>),
  vendors: svg(<>
    <path d="M4.5 10.6V20h15v-9.4" />
    <path d="M3 9.2 4.7 4h14.6L21 9.2a2.6 2.6 0 0 1-4.5 1.6 2.6 2.6 0 0 1-4.5 0 2.6 2.6 0 0 1-4.5 0A2.6 2.6 0 0 1 3 9.2z" />
    <path d="M9.7 20v-4.6h4.6V20" />
  </>),
  drivers: svg(<>
    <circle cx="12" cy="12" r="8.6" />
    <circle cx="12" cy="12" r="2.2" />
    <path d="M12 14.2v6.3M9.9 11.4 3.6 10M14.1 11.4l6.3-1.4" />
  </>),
  reports: svg(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />),
  overview: svg(<>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="5" rx="1.5" />
    <rect x="13" y="10" width="8" height="11" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
  </>),
  map: svg(<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" />),
  coldchain: svg(<>
    <path d="M10 13.5V5a2 2 0 0 1 4 0v8.5a4.5 4.5 0 1 1-4 0z" />
    <path d="M12 9v7" />
    <circle cx="12" cy="17.5" r="1.6" />
  </>),
  settings: svg(<>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </>),
}

// ----- Iconos de grupo (riel colapsado) y de UI del shell -------------------
export const UI_ICONS = {
  resources: svg(<>
    <path d="M3 20.5V9.2l9-5.2 9 5.2v11.3" />
    <path d="M7 20.5v-7.5h10v7.5M7 16.8h10" />
  </>),
  insights: svg(<>
    <path d="M9.2 18h5.6M10.2 21h3.6" />
    <path d="M12 3a6 6 0 0 0-3.7 10.7c.7.6 1.1 1.4 1.1 2.3h5.2c0-.9.4-1.7 1.1-2.3A6 6 0 0 0 12 3z" />
  </>),
  admin: svg(<>
    <path d="M12 3 4.5 6v5.6c0 4.4 3.1 8.1 7.5 9.4 4.4-1.3 7.5-5 7.5-9.4V6z" />
    <path d="m9.2 12 2 2 3.6-3.8" />
  </>),
  work: svg(<>
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18" />
  </>),
  plus: svg(<path d="M12 5v14M5 12h14" />, 2.1),
  search: svg(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.3-4.3" /></>, 2),
  bolt: svg(<path d="M13.2 2.8 4.8 13.4h6.4l-1 7.8 8.4-10.6h-6.4z" />, 1.9),
  chevronDown: svg(<path d="m6 9 6 6 6-6" />, 2),
  chevronLeft: svg(<path d="m14.5 6-6 6 6 6" />, 2),
  chevronsLeft: svg(<path d="m11.5 7-5 5 5 5M18 7l-5 5 5 5" />, 2),
  chevronRight: svg(<path d="m9.5 6 6 6-6 6" />, 2),
  arrowRight: svg(<path d="M5 12h14M13 6l6 6-6 6" />, 2),
  sun: svg(<>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
  </>),
  moon: svg(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />),
  system: svg(<>
    <rect x="3" y="4" width="18" height="12.5" rx="2" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </>),
  signOut: svg(<>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </>),
  menu: svg(<path d="M3 6h18M3 12h18M3 18h18" />, 2),
  more: svg(<>
    <circle cx="6" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" />
    <circle cx="18" cy="12" r="1.2" />
  </>, 2),
  close: svg(<path d="M6 6l12 12M18 6L6 18" />, 2),
  clock: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  wrench: svg(
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.5-.5-2.3z" />,
  ),
  check: svg(<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>),
  alert: svg(<>
    <path d="M10.3 3.9 2.4 17.6A1.9 1.9 0 0 0 4 20.5h16a1.9 1.9 0 0 0 1.6-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0z" />
    <path d="M12 9.5v4M12 17h.01" />
  </>),
  gauge: svg(<>
    <path d="M4.6 17.5a8.5 8.5 0 1 1 14.8 0" />
    <path d="m12 13.5 3.6-4.1" />
    <circle cx="12" cy="13.5" r="1.3" />
  </>),
  calendar: svg(<>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
  </>),
  book: svg(<>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z" />
    <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-2.5" />
  </>),
  refresh: svg(
    <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />,
    2,
  ),
}

// ----- Iconos del menú Add New ----------------------------------------------
const CREATE_ICONS: Record<CreateKind, ReactElement> = {
  service_request: ICONS['service-requests'],
  work_order: ICONS.workorders,
  outside_work: svg(<>
    <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5" />
    <path d="M13 3v5h5v3.5M9 13h4M9 17h2" />
    <path d="M15.5 18h6M19 15.5l2.5 2.5-2.5 2.5" />
  </>),
  purchase_order: svg(<>
    <path d="M6 3h12v18l-3-1.8-3 1.8-3-1.8L6 21z" />
    <path d="M9 8h6M9 11.5h6M9 15h3.5" />
  </>),
  parts_request: svg(<>
    <path d="M20 8.2V8l-8-4.5L4 8v8l8 4.5" />
    <path d="m4 8 8 4.5L20 8M12 12.5v8" />
    <path d="M18.5 14.5v6M15.5 17.5h6" />
  </>),
  customer: ICONS.customers,
  employee: ICONS.employees,
  equipment: ICONS.flota,
  location: ICONS.locations,
  part: ICONS.parts,
  vendor: ICONS.vendors,
}

// ----- Grupos del sidebar ----------------------------------------------------
export type NavGroupKey = 'work' | 'resources' | 'insights' | 'admin'

export interface NavItemDef {
  id: string
  label: string
  // Palabras extra para el command palette ("Go to …").
  keywords?: string
  // Scope requerido (perms.can); sin scope = visible para todos.
  scope?: string
}

export interface NavGroupDef {
  key: NavGroupKey
  label: string
  icon: ReactElement
  // Riel colapsado: 'items' = un icono por ítem (WORK); 'flyout' = UN icono
  // de grupo que abre un menú lateral (RESOURCES / INSIGHTS / ADMIN).
  rail: 'items' | 'flyout'
  items: NavItemDef[]
}

export const NAV_GROUPS: NavGroupDef[] = [
  {
    key: 'work', label: 'Work', icon: UI_ICONS.work, rail: 'items',
    items: [
      { id: 'dashboard', label: 'Home', keywords: 'dashboard welcome' },
      { id: 'service-requests', label: 'Service Requests',
        keywords: 'backlog requests sr' },
      { id: 'workorders', label: 'Work Orders', keywords: 'wo repairs shop' },
      { id: 'purchasing', label: 'Purchasing',
        keywords: 'purchase orders po parts requests cores warranty' },
      { id: 'pm', label: 'PM Tracker', keywords: 'preventive maintenance miles' },
      { id: 'reefer-pm', label: 'Reefer PM',
        keywords: 'engine hours reefer maintenance' },
      { id: 'dot', label: 'DOT Inspections', keywords: 'annual inspection' },
      { id: 'dvir', label: 'DVIR', keywords: 'inspection reports' },
      { id: 'defectos', label: 'Defects', keywords: 'defect backlog' },
    ],
  },
  {
    key: 'resources', label: 'Resources', icon: UI_ICONS.resources,
    rail: 'flyout',
    items: [
      { id: 'customers', label: 'Customers',
        keywords: 'owner operators billing' },
      { id: 'employees', label: 'Employees',
        keywords: 'technicians mechanics staff' },
      { id: 'flota', label: 'Equipment', keywords: 'fleet units trucks trailers' },
      { id: 'locations', label: 'Locations', keywords: 'terminals shops yards' },
      { id: 'parts', label: 'Parts', keywords: 'inventory catalog stock' },
      { id: 'vendors', label: 'Vendors', keywords: 'suppliers shops' },
      { id: 'drivers', label: 'Drivers', keywords: 'roster driver compliance' },
    ],
  },
  {
    key: 'insights', label: 'Insights', icon: UI_ICONS.insights,
    rail: 'flyout',
    items: [
      { id: 'reports', label: 'Reports', keywords: 'analytics builder export' },
      { id: 'overview', label: 'Fleet overview',
        keywords: 'compliance trends alerts dashboard' },
      { id: 'map', label: 'Live Map', keywords: 'gps tracking' },
      { id: 'coldchain', label: 'Cold Chain', keywords: 'reefer temperature' },
    ],
  },
  {
    key: 'admin', label: 'Admin', icon: UI_ICONS.admin, rail: 'flyout',
    items: [
      { id: 'settings', label: 'Settings',
        keywords: 'company users integrations alerts' },
    ],
  },
]

export const NAV_ITEMS: NavItemDef[] = NAV_GROUPS.flatMap((g) => g.items)

export function sectionLabel(id: string): string {
  return NAV_ITEMS.find((i) => i.id === id)?.label ?? id
}

export function groupOf(id: string): NavGroupKey | undefined {
  return NAV_GROUPS.find((g) => g.items.some((i) => i.id === id))?.key
}

// ----- Menú "+" Add New ------------------------------------------------------
export interface CreateItemDef {
  kind: CreateKind
  label: string
  icon: ReactElement
  scope?: string
  // Separador: 'work' (registros de trabajo) | 'resource' (maestros).
  block: 'work' | 'resource'
  keywords?: string
}

const CREATE_BASE: Omit<CreateItemDef, 'icon'>[] = [
  { kind: 'service_request', label: 'Service Request', block: 'work',
    scope: 'maint.edit', keywords: 'sr request' },
  { kind: 'work_order', label: 'Work Order', block: 'work',
    scope: 'maint.edit', keywords: 'wo inside repair' },
  { kind: 'outside_work', label: 'Outside Work', block: 'work',
    scope: 'maint.edit', keywords: 'outside vendor shop wo' },
  { kind: 'purchase_order', label: 'Purchase Order', block: 'work',
    scope: 'maint.edit', keywords: 'po buy' },
  { kind: 'parts_request', label: 'Parts Request', block: 'work',
    scope: 'maint.edit', keywords: 'part request shortage' },
  { kind: 'customer', label: 'Customer', block: 'resource',
    scope: 'maint.edit', keywords: 'owner operator' },
  { kind: 'employee', label: 'Employee', block: 'resource',
    scope: 'maint.edit', keywords: 'technician mechanic' },
  // POST /api/units/manual cae en el prefijo /api/units/ -> maint.edit.
  { kind: 'equipment', label: 'Equipment', block: 'resource',
    scope: 'maint.edit', keywords: 'unit truck trailer' },
  { kind: 'location', label: 'Location', block: 'resource',
    scope: 'settings.manage', keywords: 'terminal shop yard' },
  { kind: 'part', label: 'Part', block: 'resource', scope: 'maint.edit',
    keywords: 'inventory catalog' },
  { kind: 'vendor', label: 'Vendor', block: 'resource', scope: 'maint.edit',
    keywords: 'supplier shop' },
]

export const CREATE_ITEMS: CreateItemDef[] = CREATE_BASE.map(
  (c) => ({ ...c, icon: CREATE_ICONS[c.kind] }))
