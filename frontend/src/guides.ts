// Guías in-app (v2.13, elemento 04 del board — PERMANENTE por pedido del
// founder: el usuario siempre puede abrir todos los tutoriales desde el
// Dashboard). Contenido escrito contra los flujos REALES de la app: si un
// flujo cambia, la guía se actualiza en el mismo PR (esto es producto, no
// un README). Sin videos: cuando existan grabaciones reales se agregan acá
// con `video?: string` — no se fingen thumbnails de videos que no existen.

export interface Guide {
  id: string
  title: string
  minutes: number       // lectura estimada, honesta
  section: string       // id de NAV_SECTIONS: el botón "Open" navega ahí
  sectionLabel: string
  steps: string[]
  tip?: string
}

export const GUIDES: Guide[] = [
  {
    id: 'eld-day',
    title: 'Import your ELD day into DVIR',
    minutes: 2,
    section: 'dvir',
    sectionLabel: 'DVIR',
    steps: [
      'Open DVIR and press "Generate from ELD".',
      'Pick the date and the company — the preview shows DVIR count, distance and pre-trips before you commit.',
      'Press "Import to Recent DVIRs". The day is saved per company and feeds the DVIR page and reports.',
    ],
    tip: 'No ELD yet? Demo mode generates a full synthetic day so you can try the flow end to end.',
  },
  // v2.23: reemplaza a 'defect-wo' (la página Defects se fue). Los defectos
  // DVIR abiertos son una de las 5 fuentes del backlog de Service Requests;
  // esta guía es también la explicación in-app de qué es un service request.
  {
    id: 'service-requests',
    title: 'Work the Service Requests backlog',
    minutes: 3,
    section: 'service-requests',
    sectionLabel: 'Service Requests',
    steps: [
      'A service request is one thing a unit needs before it becomes a work order. Service Requests groups them by unit, most urgent first.',
      'They come from five sources: open DVIR defects reported by drivers, PMs coming due by miles, annual DOT inspections, reefer PMs by engine hours, and requests your team adds with "New request". The source chips (Defects, PM, DOT, Reefer PM, Requests) filter the list.',
      'Pick a unit, select its requests and press "Create work order". Choose Inside work with a technician, or Outside work with the vendor shop doing it. The work type can’t be changed once the work order exists.',
      'Already have an open work order for that unit? Use "Add to…" on a request to put it there instead.',
      'Not needed? "Deny" it (a reason is optional). Not now? "Snooze" it until a date and it comes back to Open on its own.',
      'Requests clear themselves when their source goes away: the defect is resolved in the ELD, or the PM, DOT or reefer service is recorded (invoicing the work order records it). Completing the work order closes the requests on it.',
    ],
    tip: 'The backlog refreshes about every 5 minutes while the app is open. Press "Check for due" to look again right now.',
  },
  {
    id: 'cpm',
    title: 'Get your cost per mile (CPM)',
    minutes: 4,
    section: 'reports',
    sectionLabel: 'Reports',
    steps: [
      'CPM = invoiced maintenance dollars ÷ miles driven, per unit and fleet-wide.',
      'Costs come from invoiced work orders — no extra work needed.',
      'Miles come from the ELD, or without one: open a unit in Fleet and press "+ Log" on the odometer card. Two readings apart in time are enough.',
      'Open Insights → Reports → Cost per mile. Units without miles in the window are listed apart, never silently dropped.',
    ],
    tip: 'Log the odometer every time a truck visits the shop and CPM stays fresh for free.',
  },
  {
    id: 'pm',
    title: 'Set up PM schedules',
    minutes: 3,
    section: 'pm',
    sectionLabel: 'PM Tracker',
    steps: [
      'Open PM Tracker and record the last PM of each unit (date + mileage).',
      'The tracker computes the next due from the interval; overdue units go red and appear in "PMs due & overdue" on Home.',
      'Each completed service gets recorded with mileage — that history also backfills the odometer series for CPM.',
    ],
  },
  {
    id: 'coldchain',
    title: 'Watch your reefers (Cold Chain)',
    minutes: 2,
    section: 'coldchain',
    sectionLabel: 'Cold Chain',
    steps: [
      'Cold Chain lists every reefer with setpoint vs box temperature and its 24 h curve.',
      'A sustained excursion raises an alert — and can auto-open a work order on the unit.',
      'In demo mode one trailer runs a scripted excursion so you can see the whole loop.',
    ],
  },
  {
    id: 'warranty',
    title: 'Track part warranties',
    minutes: 3,
    section: 'workorders',
    sectionLabel: 'Work Orders',
    steps: [
      'Give your parts a warranty period (months) in Parts.',
      'When a new WO replaces a part that a previous WO installed within warranty, the scan flags it.',
      'File the claim with the vendor instead of paying for the same part twice.',
    ],
  },
  {
    id: 'drivers',
    title: 'Driver roster & compliance',
    minutes: 3,
    section: 'drivers',
    sectionLabel: 'Drivers',
    steps: [
      'Resources → Drivers (also in Settings → Driver roster & privacy): complete each profile (CDL, medical card, MVR, clearinghouse).',
      'Find any driver with Search (Ctrl K) — profile, expirations and DVIR history in one drawer.',
      'The fleet-wide compliance report (expired / expiring / missing dates) lives in Reports.',
    ],
  },
  {
    id: 'photos',
    title: 'Add unit photos',
    minutes: 1,
    section: 'flota',
    sectionLabel: 'Fleet',
    steps: [
      'Open a unit from Fleet and press "Add photo" — one photo per unit.',
      'The photo becomes the unit\'s hero in its profile and its card in the Fleet card view.',
      'Uploading again replaces the old photo.',
    ],
    tip: 'A quick phone shot in the yard is enough — the point is recognizing the truck at a glance.',
  },
]
