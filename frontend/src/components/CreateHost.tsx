// CreateHost (v2.22): pinta el modal de alta que pidió el shell
// (openCreate(kind) desde el menú "+", el command palette o cualquier vista
// vía useShell()). Al crear: invalida las queries del registro y navega a su
// sección con un intent que lo abre ({wo}, {po}, {customer}, …).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listParts, listVendors } from '../api'
import type {
  CreateKind, CreateOpts, CreatedRecord, NavIntent,
} from '../shell'
import { CreateWoModal } from '../views/WorkOrdersPage'
import { RequestModal } from '../views/ServiceRequestsPage'
import { CreatePoModal } from '../views/PurchaseOrdersPage'
import { PartModal, VendorModal } from '../views/PartsPage'
import AddUnitModal from './AddUnitModal'
import PartsRequestModal from './PartsRequestModal'
import CustomerModal from './CustomerModal'
import EmployeeModal from './EmployeeModal'
import LocationModal from './LocationModal'

export interface CreateRequest {
  kind: CreateKind
  opts?: CreateOpts
}

export default function CreateHost({ request, onClose, onNavigate }: {
  request: CreateRequest | null
  onClose: () => void
  onNavigate: (section: string, intent?: NavIntent) => void
}) {
  if (!request) return null
  return (
    <CreateHostInner key={`${request.kind}`} request={request}
      onClose={onClose} onNavigate={onNavigate} />
  )
}

function CreateHostInner({ request, onClose, onNavigate }: {
  request: CreateRequest
  onClose: () => void
  onNavigate: (section: string, intent?: NavIntent) => void
}) {
  const qc = useQueryClient()
  const { kind, opts } = request
  // Catálogos que piden PartModal (vendors + categorías); solo se cargan
  // para ese alta.
  const needsCatalog = kind === 'part'
  const vendorsQ = useQuery({
    queryKey: ['vendors'], queryFn: listVendors, enabled: needsCatalog,
  })
  const partsQ = useQuery({
    queryKey: ['parts'], queryFn: listParts, enabled: needsCatalog,
  })

  function done(rec: CreatedRecord, section: string, intent?: NavIntent,
                keys: string[][] = []) {
    for (const k of keys) qc.invalidateQueries({ queryKey: k })
    onClose()
    opts?.onCreated?.(rec)
    if (opts?.navigate !== false) onNavigate(section, intent)
  }

  switch (kind) {
    case 'service_request':
      return (
        <RequestModal unitDefault={opts?.unit ?? ''} extraUnits={[]}
          onClose={onClose}
          onSaved={(saved) => done(
            { kind, id: saved.id, label: saved.title }, 'service-requests',
            { unit: saved.unit, sr: saved.id },
            [['service-requests'], ['home-summary']])} />
      )
    case 'work_order':
    case 'outside_work':
      return (
        <CreateWoModal
          initialType={kind === 'outside_work' ? 'outside' : 'inside'}
          onClose={onClose}
          onCreated={(id) => done({ kind, id }, 'workorders', { wo: id },
            [['workorders'], ['workorder'], ['home-summary']])} />
      )
    case 'purchase_order':
      return (
        <CreatePoModal onClose={onClose}
          onCreated={(id) => done({ kind, id }, 'purchasing',
            { po: id, tab: 'pos' }, [['purchase-orders'], ['parts-requests']])} />
      )
    case 'parts_request':
      return (
        <PartsRequestModal onClose={onClose}
          onCreated={(r) => done({ kind, id: r.id }, 'purchasing',
            { tab: 'requests' }, [['parts-requests']])} />
      )
    case 'customer':
      return (
        <CustomerModal onClose={onClose}
          onSaved={(c) => done({ kind, id: c.id, label: c.name }, 'customers',
            { customer: c.id }, [['customers']])} />
      )
    case 'employee':
      return (
        <EmployeeModal onClose={onClose}
          onSaved={(t) => done({ kind, id: t.id, label: t.name }, 'employees',
            { technician: t.id }, [['technicians']])} />
      )
    case 'equipment':
      // "Who is the customer?" puede crear/ligar un owner-operator en el
      // backend (customers.link_unit_text): refrescar también los caches de
      // clientes (['customers'] cubre ['customers','owners'] por prefijo),
      // si no el próximo "+ Work Order" de la unidad diría "Bill to: Self".
      return (
        <AddUnitModal onClose={onClose}
          onSaved={(unit) => done({ kind, id: unit, label: unit }, 'flota',
            { unit }, [['fleet'], ['customers'], ['customer']])} />
      )
    case 'location':
      return (
        <LocationModal onClose={onClose}
          onSaved={(key) => done({ kind, id: key }, 'locations',
            key ? { location: key } : undefined, [['terminals']])} />
      )
    case 'part':
      if (!vendorsQ.data || !partsQ.data) return null
      return (
        <PartModal part={null} vendors={vendorsQ.data}
          categories={partsQ.data.categories ?? []}
          onClose={onClose}
          onSaved={(p) => done({ kind, id: p.id, label: p.part_number },
            'parts', { part: p.id }, [['parts']])} />
      )
    case 'vendor':
      return (
        <VendorModal vendor={null} onClose={onClose}
          onSaved={(v) => done({ kind, id: v.id, label: v.name }, 'vendors',
            { vendor: v.id }, [['vendors']])} />
      )
    default:
      return null
  }
}
