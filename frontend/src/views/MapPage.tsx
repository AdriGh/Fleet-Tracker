import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Map, {
  Layer,
  NavigationControl,
  Popup,
  Source,
  type MapLayerMouseEvent,
  type MapRef,
} from 'react-map-gl/maplibre'
import type { FeatureCollection, Point } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  getTrack, listPois,
  type Poi, type PoiKind, type TrackVehicle,
} from '../api'
import { notifyOk, notifyErr } from '../toast'

type Props = { theme: 'light' | 'dark' }

// Estilos OpenFreeMap (gratis, sin API key, comercial OK).
const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/liberty'
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark'

const REFRESH_MS = 20_000

// Duty status de Samsara -> badge corto + tono (estilo Panda DR/ON/SB/OFF).
const DUTY: Record<string, { code: string; cls: string; label: string }> = {
  driving: { code: 'DR', cls: 'duty-dr', label: 'Driving' },
  onDuty: { code: 'ON', cls: 'duty-on', label: 'On duty' },
  sleeperBed: { code: 'SB', cls: 'duty-sb', label: 'Sleeper berth' },
  offDuty: { code: 'OFF', cls: 'duty-off', label: 'Off duty' },
  yardMove: { code: 'YM', cls: 'duty-ym', label: 'Yard move' },
  personalConveyance: { code: 'PC', cls: 'duty-pc', label: 'Personal conveyance' },
}

const STROKE = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

// Capas de servicios (G2): color y etiqueta por categoría.
const POI_META: Record<PoiKind, { label: string; color: string }> = {
  repair: { label: 'Repair', color: '#d97706' },
  dealer_truck: { label: 'Truck dealers', color: '#3b82f6' },
  dealer_trailer: { label: 'Trailer & reefer', color: '#8b5cf6' },
  scale: { label: 'Scales', color: '#14b8a6' },
}
const POI_KINDS = Object.keys(POI_META) as PoiKind[]

function haversineMi(aLat: number, aLng: number,
                     bLat: number, bLng: number): number {
  const R = 3958.8
  const dLat = (bLat - aLat) * Math.PI / 180
  const dLng = (bLng - aLng) * Math.PI / 180
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${Math.floor(s % 60)}s`
}

function fmtAgo(iso: string, nowMs: number): string {
  if (!iso) return ''
  const diff = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000))
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function coordsOf(v: TrackVehicle): string {
  return `${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}`
}

export default function MapPage({ theme }: Props) {
  const mapRef = useRef<MapRef | null>(null)
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [q, setQ] = useState('')
  const [onlyMoving, setOnlyMoving] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  // Tick para refrescar los "Xs ago" sin esperar al refetch.
  const [nowMs, setNowMs] = useState(() => Date.now())

  const trackQuery = useQuery({
    queryKey: ['track'],
    queryFn: getTrack,
    refetchInterval: REFRESH_MS,
  })
  const data = trackQuery.data

  // POIs (talleres/dealers/básculas) — dataset propio, cambia poco.
  const poisQuery = useQuery({
    queryKey: ['pois'],
    queryFn: listPois,
    staleTime: 30 * 60_000,
  })
  const [poiKinds, setPoiKinds] = useState<Set<PoiKind>>(() => new Set())
  const [dotOnly, setDotOnly] = useState(false)
  const [selectedPoi, setSelectedPoi] = useState<Poi | null>(null)

  function togglePoiKind(k: PoiKind) {
    setPoiKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const activePois = useMemo(() => {
    const all = poisQuery.data?.pois ?? []
    if (poiKinds.size === 0) return []
    return all.filter((p) =>
      poiKinds.has(p.kind) &&
      (!dotOnly || p.kind !== 'scale' || p.subtype === 'enforcement'))
  }, [poisQuery.data, poiKinds, dotOnly])

  const poiGeojson = useMemo((): FeatureCollection<Point> => ({
    type: 'FeatureCollection',
    features: activePois.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { id: p.id, kind: p.kind },
    })),
  }), [activePois])

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 10_000)
    return () => window.clearInterval(id)
  }, [])

  const vehicles = useMemo(() => data?.vehicles ?? [], [data])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return vehicles.filter((v) =>
      (!onlyMoving || v.speed_mph > 1) &&
      (!s ||
        v.unit.toLowerCase().includes(s) ||
        v.driver.toLowerCase().includes(s)))
  }, [vehicles, q, onlyMoving])

  const selectedVehicle = useMemo(
    () => vehicles.find((v) => v.id === selected) ?? null,
    [vehicles, selected],
  )

  // Servicios más cercanos a la unidad seleccionada (sobre dataset propio).
  const nearby = useMemo(() => {
    if (!selectedVehicle) return []
    const all = poisQuery.data?.pois ?? []
    return all
      .map((p) => ({
        poi: p,
        mi: haversineMi(selectedVehicle.lat, selectedVehicle.lng,
                        p.lat, p.lng),
      }))
      .sort((a, b) => a.mi - b.mi)
      .slice(0, 5)
  }, [selectedVehicle, poisQuery.data])

  const geojson = useMemo((): FeatureCollection<Point> => ({
    type: 'FeatureCollection',
    features: filtered.map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
      properties: {
        id: v.id,
        unit: v.unit,
        moving: v.speed_mph > 1 ? 1 : 0,
      },
    })),
  }), [filtered])

  function select(v: TrackVehicle, fly = true) {
    setSelected(v.id)
    if (fly) {
      const map = mapRef.current
      map?.flyTo({
        center: [v.lng, v.lat],
        zoom: Math.max(map.getZoom(), 9),
        duration: 900,
      })
    }
  }

  // Al seleccionar desde el mapa, llevar la fila a la vista.
  useEffect(() => {
    if (!selected) return
    rowRefs.current[selected]?.scrollIntoView({
      block: 'nearest', behavior: 'smooth',
    })
  }, [selected])

  function onMapClick(e: MapLayerMouseEvent) {
    const f = e.features?.[0]
    if (!f) return
    if (f.layer.id === 'unit-clusters') {
      const map = mapRef.current
      map?.flyTo({
        center: (f.geometry as Point).coordinates as [number, number],
        zoom: map.getZoom() + 2,
        duration: 600,
      })
      return
    }
    const id = f.properties?.id as string | undefined
    if (f.layer.id === 'poi-dots') {
      const p = activePois.find((x) => x.id === id)
      if (p) {
        setSelectedPoi(p)
        setSelected(null)
      }
      return
    }
    const v = vehicles.find((x) => x.id === id)
    if (v) {
      setSelectedPoi(null)
      select(v, false)
    }
  }

  async function copyCoords(v: TrackVehicle) {
    try {
      await navigator.clipboard.writeText(coordsOf(v))
      notifyOk('Coordenadas copiadas', coordsOf(v))
    } catch (e) {
      notifyErr('No se pudo copiar', e)
    }
  }

  const summary = data?.summary

  // ----- Empty state: faltan scopes en el token -----
  if (data && !data.available) {
    return (
      <div className="page page-wide">
        <div className="page-head">
          <div>
            <h1>Live Map</h1>
            <p className="page-sub">Real-time fleet positions from Samsara.</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body map-setup">
            <span className="map-setup-ico">
              <svg viewBox="0 0 24 24" {...STROKE}>
                <rect x="4" y="10" width="16" height="10" rx="2.5" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2.5" />
              </svg>
            </span>
            <h2>Connect the GPS feed</h2>
            <p>
              The Samsara token works, but it needs extra scopes to read
              live positions. Edit the API token in the Samsara dashboard
              and enable:
            </p>
            <div className="map-setup-scopes">
              {(data.missing_scopes.length
                ? data.missing_scopes
                : ['Read Vehicle Statistics',
                   'Read ELD Compliance Settings (US)']).map((s) => (
                <code key={s}>{s}</code>
              ))}
            </div>
            {data.error && <p className="map-setup-err">{data.error}</p>}
            <button className="btn btn-primary"
              onClick={() => trackQuery.refetch()}>
              Check again
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page page-wide map-page">
      {trackQuery.isFetching && <div className="loadbar" aria-hidden="true" />}
      <div className="page-head">
        <div>
          <h1>Live Map</h1>
          <p className="page-sub">
            Real-time positions, speed and duty status from Samsara.
          </p>
        </div>
        {summary && (
          <div className="head-actions map-statusbar">
            <span className="map-stat" title="Active drivers">
              <svg viewBox="0 0 24 24" {...STROKE}>
                <circle cx="12" cy="8" r="3.4" />
                <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
              </svg>
              {summary.drivers}
            </span>
            <span className="map-stat" title="Units moving / on map">
              <svg viewBox="0 0 24 24" {...STROKE}>
                <path d="M2 6h11v9H2zM13 9h4l3 3v3h-7z" />
                <circle cx="6.5" cy="17.5" r="1.8" />
                <circle cx="17.5" cy="17.5" r="1.8" />
              </svg>
              {summary.moving}/{summary.vehicles}
            </span>
            <span className="map-duty-group">
              <span className="map-duty duty-dr">DR · {summary.driving}</span>
              <span className="map-duty duty-on">ON · {summary.onDuty}</span>
              <span className="map-duty duty-sb">SB · {summary.sleeperBed}</span>
              <span className="map-duty duty-off">OFF · {summary.offDuty}</span>
            </span>
          </div>
        )}
      </div>

      {trackQuery.error && (
        <div className="banner error">
          <span>{String(trackQuery.error)}</span>
        </div>
      )}

      <div className={`map-shell ${panelOpen ? '' : 'panel-closed'}`}>
        {/* ----- Panel de unidades (estilo Panda) ----- */}
        <aside className="map-panel">
          <div className="map-panel-tools">
            <input
              className="cell-input"
              placeholder="Search unit or driver…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button
              className={`tab-btn ${onlyMoving ? 'active' : ''}`}
              onClick={() => setOnlyMoving((m) => !m)}
            >
              Moving
            </button>
          </div>

          <div className="map-list">
            {trackQuery.isPending ? (
              <div className="map-list-empty">Loading fleet…</div>
            ) : filtered.length === 0 ? (
              <div className="map-list-empty">
                No units match. Clear the search or the Moving filter.
              </div>
            ) : (
              filtered.map((v) => {
                const duty = DUTY[v.duty]
                const moving = v.speed_mph > 1
                return (
                  <div
                    key={v.id}
                    ref={(el) => { rowRefs.current[v.id] = el }}
                    className={`map-row ${selected === v.id ? 'on' : ''}`}
                    onClick={() => select(v)}
                  >
                    <div className="map-row-top">
                      <span className={`map-row-arrow ${moving ? 'is-moving' : ''}`}
                        style={moving && v.heading != null
                          ? { transform: `rotate(${v.heading}deg)` }
                          : undefined}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 3 19 20l-7-4-7 4z" />
                        </svg>
                      </span>
                      <strong className="map-row-unit">{v.unit}</strong>
                      <span className="map-row-ago">
                        {fmtAgo(v.gps_time, nowMs)}
                      </span>
                      <span className={`map-speed ${moving ? 'is-moving' : ''}`}>
                        {Math.round(v.speed_mph)} mph
                      </span>
                    </div>

                    <div className="map-row-loc">
                      <svg viewBox="0 0 24 24" {...STROKE}>
                        <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
                        <circle cx="12" cy="10" r="2.6" />
                      </svg>
                      <span className="map-row-loc-text" title={v.location}>
                        {v.location || coordsOf(v)}
                      </span>
                      <button
                        className="map-mini-btn"
                        title={`Copiar coordenadas: ${coordsOf(v)}`}
                        onClick={(e) => { e.stopPropagation(); copyCoords(v) }}
                      >
                        <svg viewBox="0 0 24 24" {...STROKE}>
                          <rect x="9" y="9" width="11" height="11" rx="2" />
                          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                        </svg>
                      </button>
                      <a
                        className="map-mini-btn"
                        title="Abrir en Google Maps"
                        href={`https://www.google.com/maps?q=${v.lat},${v.lng}`}
                        target="_blank" rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <svg viewBox="0 0 24 24" {...STROKE}>
                          <path d="M14 4h6v6M20 4 10 14" />
                          <path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" />
                        </svg>
                      </a>
                    </div>

                    {(v.driver || duty) && (
                      <div className="map-row-driver">
                        <svg viewBox="0 0 24 24" {...STROKE}>
                          <circle cx="12" cy="8" r="3.4" />
                          <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
                        </svg>
                        <span className="map-row-driver-name">
                          {v.driver || 'Unassigned'}
                        </span>
                        {duty && (
                          <span className={`map-duty ${duty.cls}`}
                            title={duty.label}>
                            {duty.code}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="map-row-meta">
                      <span className={`map-eng eng-${(v.engine || 'na').toLowerCase()}`}>
                        <span className="nf-dot" />
                        {moving && v.moving_for_s != null
                          ? `Moving for ${fmtDuration(v.moving_for_s)}`
                          : v.engine
                            ? `Engine ${v.engine}`
                            : 'No engine data'}
                      </span>
                      {v.fuel_pct != null && (
                        <span title="Fuel level">
                          <svg viewBox="0 0 24 24" {...STROKE}>
                            <path d="M5 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 21h14" />
                            <path d="M15 9h2.5a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0v-7l-2.5-2.5" />
                          </svg>
                          {v.fuel_pct}%
                        </span>
                      )}
                      {v.def_pct != null && (
                        <span title="DEF level">
                          <svg viewBox="0 0 24 24" {...STROKE}>
                            <path d="M12 3s6 6.3 6 11a6 6 0 0 1-12 0c0-4.7 6-11 6-11z" />
                          </svg>
                          {v.def_pct}%
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {selectedVehicle && nearby.length > 0 && (
            <div className="map-nearby">
              <div className="map-nearby-head">
                <strong>Nearby services</strong>
                <span>for {selectedVehicle.unit}</span>
              </div>
              {nearby.map(({ poi, mi }) => (
                <div className="map-nearby-row" key={poi.id}>
                  <span className="map-poi-dot"
                    style={{ background: POI_META[poi.kind].color }} />
                  <span className="map-nearby-name" title={poi.name}>
                    {poi.name}
                    <em>
                      {POI_META[poi.kind].label}
                      {poi.subtype === 'enforcement' ? ' · DOT' : ''}
                    </em>
                  </span>
                  <span className="map-nearby-mi">{mi.toFixed(0)} mi</span>
                  <a
                    className="map-mini-btn"
                    title="Abrir en Google Maps"
                    href={`https://www.google.com/maps?q=${poi.lat},${poi.lng}`}
                    target="_blank" rel="noreferrer"
                  >
                    <svg viewBox="0 0 24 24" {...STROKE}>
                      <path d="M14 4h6v6M20 4 10 14" />
                      <path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" />
                    </svg>
                  </a>
                </div>
              ))}
              <a
                className="map-nearby-google"
                href={`https://www.google.com/maps/search/truck+repair/@${selectedVehicle.lat},${selectedVehicle.lng},11z`}
                target="_blank" rel="noreferrer"
              >
                Search more on Google Maps →
              </a>
            </div>
          )}

          <div className="map-panel-foot">
            {filtered.length} of {vehicles.length} units
            {activePois.length > 0 && ` · ${activePois.length} POIs`}
          </div>
        </aside>

        <button
          className="map-panel-toggle"
          onClick={() => setPanelOpen((o) => !o)}
          title={panelOpen ? 'Hide list' : 'Show list'}
          aria-label={panelOpen ? 'Hide unit list' : 'Show unit list'}
        >
          <svg viewBox="0 0 24 24" {...STROKE}
            style={{ transform: panelOpen ? 'none' : 'rotate(180deg)' }}>
            <path d="m14 6-6 6 6 6" />
          </svg>
        </button>

        {/* ----- Mapa ----- */}
        <div className="map-canvas">
          {/* Chips de capas de servicios (dataset propio, ODbL) */}
          <div className="map-layerbar">
            {POI_KINDS.map((k) => (
              <button
                key={k}
                className={`map-layer-chip ${poiKinds.has(k) ? 'on' : ''}`}
                onClick={() => togglePoiKind(k)}
                aria-pressed={poiKinds.has(k)}
              >
                <span className="map-poi-dot"
                  style={{ background: POI_META[k].color }} />
                {POI_META[k].label}
              </button>
            ))}
            {poiKinds.has('scale') && (
              <button
                className={`map-layer-chip sub ${dotOnly ? 'on' : ''}`}
                onClick={() => setDotOnly((d) => !d)}
                aria-pressed={dotOnly}
                title="Solo básculas de enforcement (DOT)"
              >
                DOT only
              </button>
            )}
          </div>

          <Map
            ref={mapRef}
            initialViewState={{ longitude: -88.5, latitude: 36.5, zoom: 4.2 }}
            mapStyle={theme === 'dark' ? STYLE_DARK : STYLE_LIGHT}
            interactiveLayerIds={['unit-clusters', 'unit-dots', 'poi-dots']}
            onClick={onMapClick}
            attributionControl={{
              compact: true,
              customAttribution:
                'POI data © OpenStreetMap contributors · Illinois DOT',
            }}
          >
            <NavigationControl position="top-right" showCompass={false} />

            <Source
              id="units"
              type="geojson"
              data={geojson}
              cluster
              clusterMaxZoom={11}
              clusterRadius={46}
            >
              <Layer
                id="unit-clusters"
                type="circle"
                filter={['has', 'point_count']}
                paint={{
                  'circle-color': theme === 'dark' ? '#27272b' : '#3f3f46',
                  'circle-radius': [
                    'step', ['get', 'point_count'], 15, 10, 19, 30, 24,
                  ],
                  'circle-stroke-width': 2,
                  'circle-stroke-color':
                    theme === 'dark' ? '#a1a1aa' : '#ffffff',
                }}
              />
              <Layer
                id="unit-cluster-count"
                type="symbol"
                filter={['has', 'point_count']}
                layout={{
                  'text-field': ['get', 'point_count_abbreviated'],
                  'text-font': ['Noto Sans Bold'],
                  'text-size': 12,
                }}
                paint={{ 'text-color': '#ffffff' }}
              />
              <Layer
                id="unit-dots"
                type="circle"
                filter={['!', ['has', 'point_count']]}
                paint={{
                  'circle-color': [
                    'case', ['==', ['get', 'moving'], 1],
                    '#e11900', '#3f3f46',
                  ],
                  'circle-radius': [
                    'case',
                    ['==', ['get', 'id'], selected ?? ''], 9, 6.5,
                  ],
                  'circle-stroke-width': 2,
                  'circle-stroke-color': '#ffffff',
                }}
              />
              <Layer
                id="unit-labels"
                type="symbol"
                filter={['!', ['has', 'point_count']]}
                layout={{
                  'text-field': ['get', 'unit'],
                  'text-font': ['Noto Sans Bold'],
                  'text-size': 11,
                  'text-offset': [0, 1.3],
                  'text-anchor': 'top',
                  'text-optional': true,
                }}
                paint={{
                  'text-color': theme === 'dark' ? '#f4f4f5' : '#18181b',
                  'text-halo-color':
                    theme === 'dark' ? '#0a0a0b' : '#ffffff',
                  'text-halo-width': 1.4,
                }}
              />
            </Source>

            {activePois.length > 0 && (
              <Source id="pois" type="geojson" data={poiGeojson}>
                <Layer
                  id="poi-dots"
                  type="circle"
                  paint={{
                    'circle-color': [
                      'match', ['get', 'kind'],
                      'repair', POI_META.repair.color,
                      'dealer_truck', POI_META.dealer_truck.color,
                      'dealer_trailer', POI_META.dealer_trailer.color,
                      'scale', POI_META.scale.color,
                      '#71717a',
                    ],
                    'circle-radius': [
                      'interpolate', ['linear'], ['zoom'],
                      4, 2.4, 8, 4.2, 12, 6,
                    ],
                    'circle-opacity': 0.85,
                    'circle-stroke-width': 1,
                    'circle-stroke-color':
                      theme === 'dark' ? '#0a0a0b' : '#ffffff',
                  }}
                />
              </Source>
            )}

            {selectedPoi && (
              <Popup
                longitude={selectedPoi.lng}
                latitude={selectedPoi.lat}
                anchor="bottom"
                offset={10}
                closeButton={false}
                onClose={() => setSelectedPoi(null)}
                className="map-popup"
              >
                <div className="map-popup-body">
                  <div className="map-popup-head">
                    <strong>{selectedPoi.name}</strong>
                    <span className="map-poi-tag"
                      style={{ color: POI_META[selectedPoi.kind].color }}>
                      {POI_META[selectedPoi.kind].label}
                      {selectedPoi.subtype === 'enforcement' ? ' · DOT' : ''}
                    </span>
                  </div>
                  {selectedPoi.address && (
                    <span className="map-popup-line muted">
                      {selectedPoi.address}
                    </span>
                  )}
                  {selectedPoi.phone && (
                    <span className="map-popup-line mono">
                      {selectedPoi.phone}
                    </span>
                  )}
                  <div className="map-popup-actions">
                    <button className="btn btn-ghost btn-xs"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            `${selectedPoi.lat.toFixed(5)}, ${selectedPoi.lng.toFixed(5)}`)
                          notifyOk('Coordenadas copiadas')
                        } catch (e) {
                          notifyErr('No se pudo copiar', e)
                        }
                      }}>
                      Copy coords
                    </button>
                    <a className="btn btn-ghost btn-xs"
                      href={`https://www.google.com/maps?q=${selectedPoi.lat},${selectedPoi.lng}`}
                      target="_blank" rel="noreferrer">
                      Google Maps
                    </a>
                  </div>
                </div>
              </Popup>
            )}

            {selectedVehicle && (
              <Popup
                longitude={selectedVehicle.lng}
                latitude={selectedVehicle.lat}
                anchor="bottom"
                offset={14}
                closeButton={false}
                onClose={() => setSelected(null)}
                className="map-popup"
              >
                <div className="map-popup-body">
                  <div className="map-popup-head">
                    <strong>{selectedVehicle.unit}</strong>
                    <span className={`map-speed ${selectedVehicle.speed_mph > 1 ? 'is-moving' : ''}`}>
                      {Math.round(selectedVehicle.speed_mph)} mph
                    </span>
                  </div>
                  {selectedVehicle.driver && (
                    <span className="map-popup-line">
                      {selectedVehicle.driver}
                    </span>
                  )}
                  <span className="map-popup-line muted">
                    {selectedVehicle.location || coordsOf(selectedVehicle)}
                  </span>
                  <div className="map-popup-actions">
                    <button className="btn btn-ghost btn-xs"
                      onClick={() => copyCoords(selectedVehicle)}>
                      Copy coords
                    </button>
                    <a className="btn btn-ghost btn-xs"
                      href={`https://www.google.com/maps?q=${selectedVehicle.lat},${selectedVehicle.lng}`}
                      target="_blank" rel="noreferrer">
                      Google Maps
                    </a>
                  </div>
                </div>
              </Popup>
            )}
          </Map>
        </div>
      </div>
    </div>
  )
}
