// Resources → Drivers (v2.22 [F]): el roster de conductores como sección
// propia (antes solo vivía dentro de Settings, que lo sigue incrustando).
// El intent {driver} lo resuelve App abriendo el DriverDrawer; acá no hay
// nada más que leer del intent.
import type { NavIntent } from '../shell'
import RosterPage from './RosterPage'

export default function DriversPage({ intent }: { intent?: NavIntent }) {
  void intent
  return <RosterPage title="Drivers" />
}
