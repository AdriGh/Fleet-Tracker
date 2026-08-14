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
      'Press "Import to Recent DVIRs". The day is saved per company and feeds the dashboard and reports.',
    ],
    tip: 'No ELD yet? Demo mode generates a full synthetic day so you can try the flow end to end.',
  },
  {
    id: 'defect-wo',
    title: 'Turn a defect into a work order',
    minutes: 3,
    section: 'defectos',
    sectionLabel: 'Defects',
    steps: [
      'Open Defects: the backlog lists every open defect by unit.',
      'Pick the defect and create a work order from it — unit and complaint come pre-filled.',
      'Assign it and track it through the pipeline in Work Orders (open → in progress → completed → invoiced).',
      'Invoicing the WO is what feeds cost reports: an unpriced WO never shows up in CPM.',
    ],
  },
  {
    id: 'cpm',
    title: 'Get your cost per mile (CPM)',
    minutes: 4,
    section: 'reports',
    sectionLabel: 'Reports & Analytics',
    steps: [
      'CPM = invoiced maintenance dollars ÷ miles driven, per unit and fleet-wide.',
      'Costs come from invoiced work orders — no extra work needed.',
      'Miles come from the ELD, or without one: open a unit in Fleet and press "+ Log" on the odometer card. Two readings apart in time are enough.',
      'Open Reports & Analytics → Cost per mile. Units without miles in the window are listed apart, never silently dropped.',
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
      'The tracker computes the next due from the interval; overdue units go red and appear in "Needs attention" on the Dashboard.',
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
    section: 'settings',
    sectionLabel: 'Settings',
    steps: [
      'Settings → Driver roster & privacy: complete each profile (CDL, medical card, MVR, clearinghouse).',
      'Find any driver from the sidebar search — profile, expirations and DVIR history in one drawer.',
      'The fleet-wide compliance report (expired / expiring / missing dates) lives in Reports & Analytics.',
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
  {
    id: 'workflows',
    title: 'Build your pre-trip workflow',
    minutes: 3,
    section: 'workflows',
    sectionLabel: 'Driver Workflows',
    steps: [
      'Open Driver Workflows: your fleet starts with a ready-made Pre-trip you can edit.',
      'Add typed steps — checklist item, photo required, reading or signature — and reorder them with the arrows.',
      'Click a step to rename it, make it required (blocks submit) or demand a photo. The phone preview updates live.',
      'Press "Set active" on the workflow your drivers should run — only one is active at a time.',
    ],
    tip: 'The Walkaround page runs whatever workflow is active — edit here, and the next inspection picks it up.',
  },
  {
    id: 'walkaround',
    title: 'Run a guided walkaround',
    minutes: 3,
    section: 'walkaround',
    sectionLabel: 'Walkaround',
    steps: [
      'Open Walkaround (best on the phone), pick the unit and type your name.',
      'One zone per screen: take the photo where required, mark OK or Defect. A defect asks for a note.',
      'The odometer step feeds cost-per-mile automatically; the signature closes the inspection.',
      'Submit: every defect enters the Defects backlog as a real record with its photos already attached.',
    ],
    tip: 'Photos are the anti "pencil-whipping": each zone documents that the inspection actually happened.',
  },
]
