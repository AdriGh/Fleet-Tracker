import {
  lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  useSyncExternalStore,
} from 'react'
import { Toaster } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  authStatus, getHealth, listAlertEvents, listPartsRequests,
  listServiceRequests, logout,
  type AuthUser, type OrgBranding,
} from './api'
import { PermsContext, type Perms } from './perms'
import { notifyWarn } from './toast'
import {
  ShellContext, type CreateKind, type CreateOpts, type NavIntent,
  type ShellApi, type ThemePref,
} from './shell'
import { UI_ICONS, sectionLabel } from './navModel'
import { useEscLayer } from './layers'
import OnboardingWizard from './views/OnboardingWizard'
import Logo from './components/Logo'
import Sidebar from './components/Sidebar'
import AddNewMenu from './components/AddNewMenu'
import CommandPalette from './components/CommandPalette'
import CreateHost, { type CreateRequest } from './components/CreateHost'
import Home from './views/Home'
import FleetOverviewPage from './views/FleetOverviewPage'
import DvirPage from './views/DvirPage'
import DefectsPage from './views/DefectsPage'
import FleetPage from './views/FleetPage'
import MaintBoardPage from './views/MaintBoardPage'
import UnitProfilePage from './views/UnitProfilePage'
import DriverDrawer from './components/DriverDrawer'
import ReeferPage from './views/ReeferPage'
import WorkOrdersPage from './views/WorkOrdersPage'
import ServiceRequestsPage from './views/ServiceRequestsPage'
import PartsPage from './views/PartsPage'
import PurchasingPage from './views/PurchasingPage'
import SettingsPage from './views/SettingsPage'
import CustomersPage from './views/CustomersPage'
import EmployeesPage from './views/EmployeesPage'
import LocationsPage from './views/LocationsPage'
import VendorsPage from './views/VendorsPage'
import DriversPage from './views/DriversPage'
import LoginPage from './views/LoginPage'

// El mapa carga maplibre-gl (~250 kB gz): solo se descarga al abrirlo.
const MapPage = lazy(() => import('./views/MapPage'))
// Reports v2.22 (biblioteca, builder, gráficos, asistente): chunk propio.
const ReportsPage = lazy(() => import('./views/ReportsPage'))

// ----- Tema: light / dark / system ------------------------------------------
// La preferencia vive en localStorage['dvir-theme']; 'system' sigue a
// prefers-color-scheme en vivo (useSyncExternalStore, sin efectos).
function initialThemePref(): ThemePref {
  try {
    const saved = localStorage.getItem('dvir-theme')
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch { /* storage bloqueado */ }
  return 'system'
}
const DARK_MQ = '(prefers-color-scheme: dark)'
function subscribeDark(cb: () => void) {
  const mq = window.matchMedia(DARK_MQ)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const systemDark = () => window.matchMedia(DARK_MQ).matches

// Deep link ?wo= al cargar: arranca en Work Orders (la página lo abre).
function initialSection(): string {
  try {
    return new URLSearchParams(window.location.search).has('wo')
      ? 'workorders' : 'dashboard'
  } catch {
    return 'dashboard'
  }
}

// Un drawer vaul (Radix modal) atrapa foco y puntero: el palette no se abre
// encima (quedaría inerte); primero se cierra el drawer.
const vaulOpen = () =>
  !!document.querySelector('[data-vaul-drawer][data-state="open"]')

type NavState = { section: string; intent?: NavIntent; seq: number }

export default function App() {
  const qc = useQueryClient()
  const [version, setVersion] = useState<string | null>(null)
  const [themePref, setThemePref] = useState<ThemePref>(initialThemePref)
  const prefersDark = useSyncExternalStore(subscribeDark, systemDark, () => false)
  const theme: 'light' | 'dark' =
    themePref === 'system' ? (prefersDark ? 'dark' : 'light') : themePref

  // Navegación (sin router): sección + intent opcional. `seq` re-monta la
  // página cuando llega un intent nuevo (cada página lo lee al montar).
  const [nav, setNav] = useState<NavState>(
    () => ({ section: initialSection(), seq: 0 }))
  const section = nav.section
  // H3: perfil completo de unidad (se superpone a la sección actual).
  const [profileUnit, setProfileUnit] = useState<string | null>(null)
  // Conductor abierto en el drawer (palette / Drivers).
  const [driverName, setDriverName] = useState<string | null>(null)
  // Drawer móvil (<760px): el sidebar se esconde tras una barra superior con
  // hamburguesa; navegar o tocar el scrim lo cierra.
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 760,
  )
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [createReq, setCreateReq] = useState<CreateRequest | null>(null)
  const [topAddOpen, setTopAddOpen] = useState(false)
  const topAddRef = useRef<HTMLButtonElement | null>(null)

  // Navegar SIEMPRE cierra el perfil de unidad abierto (si no, el perfil se
  // superpone y el clic en el sidebar "no hace nada") y el drawer móvil.
  // Intents que resuelve el shell: {unit} en Equipment abre el perfil;
  // {driver} abre el drawer del conductor; {create} abre el alta.
  const navigate = useCallback((id: string, intent?: NavIntent) => {
    setDrawerOpen(false)
    setProfileUnit(id === 'flota' && intent?.unit ? String(intent.unit) : null)
    if (intent?.driver) setDriverName(String(intent.driver))
    if (intent?.create) setCreateReq({ kind: intent.create })
    setNav((n) => ({
      section: id,
      intent,
      seq: intent ? n.seq + 1 : n.seq,
    }))
  }, [])

  const openCreate = useCallback((kind: CreateKind, opts?: CreateOpts) => {
    setDrawerOpen(false)
    setCreateReq({ kind, opts })
  }, [])
  const openSearch = useCallback(() => {
    if (vaulOpen()) return
    setDrawerOpen(false)
    setPaletteOpen(true)
  }, [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])

  const shell: ShellApi = useMemo(() => ({
    section, navigate, openCreate, openSearch,
  }), [section, navigate, openCreate, openSearch])

  // Sesión real (fase G7): cookie HttpOnly; /api/auth/status decide entre
  // wizard, login o app.
  const [sessionUser, setSessionUser] = useState<AuthUser | null>(null)
  const statusQuery = useQuery({
    queryKey: ['auth-status'],
    queryFn: authStatus,
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const branding: OrgBranding | undefined = statusQuery.data?.branding

  useEffect(() => {
    if (statusQuery.data?.authenticated && statusQuery.data.user) {
      setSessionUser(statusQuery.data.user)
    }
  }, [statusQuery.data])

  // Un 401 de cualquier llamada -> volver al login.
  useEffect(() => {
    const onUnauthorized = () => {
      setSessionUser(null)
      qc.removeQueries()
      statusQuery.refetch()
    }
    window.addEventListener('ft-unauthorized', onUnauthorized)
    return () =>
      window.removeEventListener('ft-unauthorized', onUnauthorized)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Branding aplicado en vivo: título + acento (color-mix deriva tonos).
  useEffect(() => {
    if (!branding) return
    document.title = branding.app_name || 'Rigsmith'
    const root = document.documentElement
    const props = ['--accent', '--brand', '--accent-2', '--accent-strong',
                   '--accent-soft']
    if (branding.accent) {
      const a = branding.accent
      root.style.setProperty('--accent', a)
      root.style.setProperty('--brand', a)
      root.style.setProperty('--accent-2',
        `color-mix(in srgb, ${a} 78%, white)`)
      root.style.setProperty('--accent-strong',
        `color-mix(in srgb, ${a} 78%, black)`)
      root.style.setProperty('--accent-soft',
        `color-mix(in srgb, ${a} 12%, transparent)`)
    } else {
      props.forEach((p) => root.style.removeProperty(p))
    }
  }, [branding])

  const authed = sessionUser !== null
  // H4: scopes del rol (del backend) para ocultar/deshabilitar acciones.
  const scopes = statusQuery.data?.scopes ?? []
  const perms: Perms = useMemo(() => ({
    role: sessionUser?.role ?? '',
    scopes,
    can: (s: string) => sessionUser?.role === 'admin' || scopes.includes(s),
  }), [sessionUser?.role, scopes])
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try { return localStorage.getItem('ft-sidebar-collapsed') === '1' } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('ft-sidebar-collapsed', navCollapsed ? '1' : '0')
    } catch { /* storage bloqueado */ }
  }, [navCollapsed])

  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth <= 760
      setIsMobile(mobile)
      if (!mobile) setDrawerOpen(false) // al agrandar, cerrar el drawer
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Drawer móvil: es una CAPA de la pila (layers.ts) — Escape lo cierra solo
  // si está arriba; con el menú "+" o el de cuenta abiertos dentro del
  // drawer, el primer Esc cierra el menú y el drawer sigue abierto. Se
  // bloquea el scroll del body mientras está abierto para que el gesto quede
  // contenido en el panel.
  useEscLayer(drawerOpen, () => setDrawerOpen(false))
  useEffect(() => {
    if (!drawerOpen) return
    document.body.classList.add('drawer-lock')
    return () => document.body.classList.remove('drawer-lock')
  }, [drawerOpen])

  // Ctrl/⌘+K abre (o cierra) el command palette desde cualquier pantalla.
  useEffect(() => {
    if (!authed) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      if (vaulOpen()) return
      setDrawerOpen(false)
      setPaletteOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [authed])

  // Alertas de flota (G3): poll ligero y toast SOLO para eventos nuevos
  // (el primer fetch fija la línea base sin avisar).
  const alertsQuery = useQuery({
    queryKey: ['alert-events-unacked'],
    queryFn: () => listAlertEvents(10, true),
    refetchInterval: 60_000,
    enabled: authed,
  })
  // Badge de Purchasing: nº de requests de partes pendientes de ordenar.
  const requestsQuery = useQuery({
    queryKey: ['parts-requests', 'pending'],
    queryFn: () => listPartsRequests('pending'),
    enabled: authed,
    staleTime: 60_000,
  })
  // Badge de Service Requests: nº de requests abiertos. Misma key que la
  // pestaña Open de la página (caché compartida); refresco cada 5 min.
  const serviceRequestsQuery = useQuery({
    queryKey: ['service-requests', 'open', '', ''],
    queryFn: () => listServiceRequests({ status: 'open' }),
    enabled: authed,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })
  const navBadges: Record<string, number> = {
    purchasing: requestsQuery.data?.stats?.pending ?? 0,
    'service-requests': serviceRequestsQuery.data?.counts?.open ?? 0,
  }
  const lastAlertId = useRef<number | null>(null)
  useEffect(() => {
    const events = alertsQuery.data
    if (!events) return
    const maxId = events.reduce((m, e) => Math.max(m, e.id), 0)
    if (lastAlertId.current === null) {
      lastAlertId.current = maxId
      return
    }
    const fresh = events.filter((e) => e.id > (lastAlertId.current ?? 0))
    fresh.slice(0, 3).forEach((e) => {
      notifyWarn(`${e.rule_label}: ${e.unit}`, e.message)
    })
    if (fresh.length > 3) {
      notifyWarn(`${fresh.length - 3} more fleet alerts`,
        'See Fleet overview for the full list')
    }
    if (maxId > (lastAlertId.current ?? 0)) lastAlertId.current = maxId
  }, [alertsQuery.data])

  useEffect(() => {
    getHealth()
      .then((h) => setVersion(h.version))
      .catch(() => setVersion(null))
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    try { localStorage.setItem('dvir-theme', themePref) } catch {
      /* storage bloqueado */
    }
  }, [themePref])

  const signOut = useCallback(() => {
    logout()
    setSessionUser(null)
    setPaletteOpen(false)
    setCreateReq(null)
    qc.removeQueries()
    statusQuery.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc])

  // Splash mínimo mientras se resuelve el estado de auth.
  if (statusQuery.isPending) {
    return (
      <div className="auth-splash" aria-busy="true">
        <Logo />
      </div>
    )
  }

  // Primer arranque: aún no existe el admin.
  if (statusQuery.data?.setup_needed) {
    return (
      <OnboardingWizard
        onDone={() => {
          qc.invalidateQueries({ queryKey: ['auth-status'] })
          statusQuery.refetch()
        }}
      />
    )
  }

  if (!authed) {
    return (
      <LoginPage
        appName={branding?.app_name || 'Rigsmith'}
        tagline={branding?.tagline || 'Your fleet, forged right.'}
        onLogin={(user) => { setSessionUser(user); statusQuery.refetch() }}
      />
    )
  }

  const appName = branding?.app_name || 'Rigsmith'
  const intent = nav.intent
  // Key de la página: cambia solo cuando la navegación trae un intent.
  const pageKey = `${section}:${intent ? nav.seq : 0}`

  return (
    <PermsContext.Provider value={perms}>
    <ShellContext.Provider value={shell}>
    <div className={`app ${drawerOpen ? 'drawer-open' : ''}`}>
      <Toaster
        theme={theme}
        position="top-right"
        richColors
        closeButton
        toastOptions={{ style: { fontFamily: 'inherit' } }}
      />

      {/* Barra superior móvil (<760px): hamburguesa + marca + "+" y Search.
          En desktop queda oculta por CSS. */}
      <header className="topbar">
        <button
          className="icon-btn topbar-burger"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
        >
          {UI_ICONS.menu}
        </button>
        <span className="topbar-brand">
          <Logo />
          <strong>{appName}</strong>
        </span>
        <span className="topbar-actions">
          <button className="icon-btn topbar-act" onClick={openSearch}
            aria-label="Search">
            {UI_ICONS.search}
          </button>
          <button ref={topAddRef} className="icon-btn topbar-act is-add"
            onClick={() => setTopAddOpen((o) => !o)}
            aria-label="Add new" aria-haspopup="menu"
            aria-expanded={topAddOpen}>
            {UI_ICONS.plus}
          </button>
        </span>
      </header>
      {topAddOpen && (
        <AddNewMenu anchor={topAddRef} placement="bottom-end"
          onClose={() => setTopAddOpen(false)} onPick={openCreate} />
      )}

      {/* Scrim: cierra el drawer al tocar fuera. */}
      <div
        className="drawer-scrim"
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      <Sidebar
        section={profileUnit ? 'flota' : section}
        onNavigate={navigate}
        collapsed={navCollapsed}
        onToggleCollapsed={() => setNavCollapsed((c) => !c)}
        isMobile={isMobile}
        badges={navBadges}
        user={sessionUser}
        appName={appName}
        tagline={branding?.tagline || 'Your fleet, forged right.'}
        version={version}
        themePref={themePref}
        onThemePref={setThemePref}
        onSignOut={signOut}
        onOpenSearch={openSearch}
        onCreate={openCreate}
      />

      <div className="main-area">
        <main className="container" aria-label={sectionLabel(section)}>
          {profileUnit && (
            <UnitProfilePage unit={profileUnit}
              onClose={() => setProfileUnit(null)} />
          )}
          {!profileUnit && (
            <SectionView
              key={pageKey}
              section={section}
              intent={intent}
              theme={theme}
              onTheme={setThemePref}
              isAdmin={sessionUser?.role === 'admin'}
              userName={sessionUser?.name ?? ''}
              onNavigate={navigate}
              onOpenUnit={setProfileUnit}
            />
          )}
        </main>
      </div>

      {/* Drawer del conductor: palette / Drivers, sobre cualquier pantalla. */}
      <DriverDrawer name={driverName} onClose={() => setDriverName(null)} />

      {paletteOpen && (
        <CommandPalette
          onClose={closePalette}
          onNavigate={navigate}
          onCreate={openCreate}
          themePref={themePref}
          onThemePref={setThemePref}
          onSignOut={signOut}
          sidebarCollapsed={navCollapsed}
          onToggleSidebar={isMobile ? undefined
            : () => setNavCollapsed((c) => !c)}
        />
      )}

      <CreateHost request={createReq} onClose={() => setCreateReq(null)}
        onNavigate={navigate} />
    </div>
    </ShellContext.Provider>
    </PermsContext.Provider>
  )
}

// Página de cada sección. Separada para poder re-montarla por `key` cuando
// la navegación trae un intent.
function SectionView({
  section, intent, theme, onTheme, isAdmin, userName, onNavigate, onOpenUnit,
}: {
  section: string
  intent?: NavIntent
  theme: 'light' | 'dark'
  onTheme: (t: ThemePref) => void
  isAdmin: boolean
  userName: string
  onNavigate: (section: string, intent?: NavIntent) => void
  onOpenUnit: (unit: string) => void
}) {
  switch (section) {
    case 'dashboard': return <Home userName={userName} />
    case 'overview': return <FleetOverviewPage onNavigate={onNavigate} />
    case 'map':
      return (
        <Suspense fallback={<div className="loadbar" aria-hidden="true" />}>
          <MapPage theme={theme} />
        </Suspense>
      )
    case 'dvir': return <DvirPage />
    case 'defectos': return <DefectsPage />
    case 'flota': return <FleetPage onOpenUnit={onOpenUnit} />
    case 'pm': return <MaintBoardPage kind="pm" />
    // Reefer PM por horas de motor (v2.22 [B]): MaintBoardPage generalizado.
    case 'reefer-pm': return <MaintBoardPage kind="reefer" />
    case 'dot': return <MaintBoardPage kind="dot" />
    case 'coldchain': return <ReeferPage />
    case 'service-requests': return <ServiceRequestsPage intent={intent} />
    case 'workorders': return <WorkOrdersPage intent={intent} />
    case 'parts': return <PartsPage intent={intent} />
    case 'purchasing': return <PurchasingPage intent={intent} />
    case 'reports':
      return (
        <Suspense fallback={<div className="loadbar" aria-hidden="true" />}>
          <ReportsPage intent={intent} />
        </Suspense>
      )
    case 'customers': return <CustomersPage intent={intent} />
    case 'employees': return <EmployeesPage intent={intent} />
    case 'locations': return <LocationsPage intent={intent} />
    case 'vendors': return <VendorsPage intent={intent} />
    case 'drivers': return <DriversPage intent={intent} />
    case 'settings':
      return <SettingsPage theme={theme} onTheme={onTheme} isAdmin={isAdmin} />
    default: return <Home userName={userName} />
  }
}
