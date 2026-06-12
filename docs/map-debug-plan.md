# Live Map — postmortem del bug (resuelto jun-11)

Síntoma reportado: mapa azul/borroso, vista clavada en "Groenlandia",
zoom/pan sin efecto, baja calidad de unidades y tiles.

## Causa raíz (verificada con reproducción headless)

`.map-shell` es un grid con altura fija, pero **sin `grid-template-rows`**:
la fila implícita crecía hasta el contenido más alto, la lista de ~100
unidades del panel (10,540 px medidos). `.map-canvas { height: 100% }`
resuelve contra la FILA, no contra el shell, así que el contenedor del
mapa medía 764 × 10,540 px dentro de un shell recortado por
`overflow: hidden`:

- WebGL clampea el canvas a 4096 px y CSS lo estira a 10,540 px
  → **borroso / mala calidad** (canvas real: 296 × 4096).
- El centro de cámara (EE.UU.) quedaba ~5,200 px por debajo del área
  visible; lo que se veía arriba era el norte del mundo → **Groenlandia**.
- Los gestos de zoom/pan operaban sobre un viewport de 10,540 px
  → parecían no hacer nada.

Falsas pistas descartadas con evidencia: la red estaba limpia
(OpenFreeMap 200 en style/tiles/glyphs/sprites), WebGL era hardware
(NVIDIA D3D11) y el bundle servido era el actual (`no-cache` en
index.html ya estaba bien).

## Fix (index.css)

```css
.map-shell { grid-template-rows: minmax(0, 1fr); }
.map-panel { min-height: 0; }
.map-list  { min-height: 0; }   /* flex item debe poder encoger */
.map-canvas{ min-height: 0; }
```

Verificado con Playwright + Chrome instalado (headless): canvas
764 × 683 a escala 1:1, EE.UU. centrado, clusters y labels vectoriales
nítidos, sin errores de consola. El media query móvil ya acota el panel
(`max-height: 340px`) y fija el canvas (420 px), no le afecta el bug.

Harness de verificación: `~/map-test/run.js` y `~/map-test/sidebar.js`
(Playwright sobre el Chrome instalado, token local de prueba).

## Lección

Cuando un grid/flex contiene un canvas WebGL, la cadena completa de
alturas debe estar acotada (`grid-template-rows: minmax(0,1fr)` +
`min-height: 0` en cada nivel). Un canvas que hereda altura de contenido
crea un loop de layout que se manifiesta lejos del CSS culpable.

## Cómo implementan mapas estas herramientas (investigación jun-11)

- **Panda ELD**: Mapbox GL JS (atribución visible en sus screenshots).
  Estilo claro, clusters nativos, panel lateral con datos por unidad.
- **Samsara**: Google Maps JS API (atribución en screenshots) con capa
  propia de markers/clustering; pagan el costo por carga de mapa.
- **Motive / Geotab / Verizon**: mezcla de Google Maps y Mapbox según
  producto; ninguno renderiza tiles propios.
- **Nuestra elección** (MapLibre GL + OpenFreeMap) es la variante
  open-source de la arquitectura de Panda: mismo motor de render
  (MapLibre es fork de Mapbox GL 1.x), tiles vectoriales gratis sin API
  key y sin ToS que prohíba overlays propios (los POIs ODbL sí pueden
  pintarse, a diferencia de Google Places).
- Plan B de tiles si OpenFreeMap degradara: demotiles MapLibre,
  VersaTiles, o Protomaps self-host (.pmtiles de EE.UU. servido por
  FastAPI, cero dependencia externa).
