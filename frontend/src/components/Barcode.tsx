// Código de barras Code 128-B en SVG puro (sin dependencias). Cubre ASCII
// 32–126 (letras, dígitos, guiones, puntos, slash) — suficiente para números
// de parte. Colores fijos negro/blanco (los escáneres necesitan contraste,
// independiente del tema).

// Tabla estándar de patrones Code 128 (índice 0–106). Cada string son los
// anchos de módulo alternando barra/espacio, empezando por barra. El 106
// (Stop) tiene 7 módulos; el resto, 6.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213',
  '122312', '132212', '221213', '221312', '231212', '112232', '122132',
  '122231', '113222', '123122', '123221', '223211', '221132', '221231',
  '213212', '223112', '312131', '311222', '321122', '321221', '312212',
  '322112', '322211', '212123', '212321', '232121', '111323', '131123',
  '131321', '112313', '132113', '132311', '211313', '231113', '231311',
  '112133', '112331', '132131', '113123', '113321', '133121', '313121',
  '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111',
  '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114',
  '413111', '241112', '134111', '111242', '121142', '121241', '114212',
  '124112', '124211', '411212', '421112', '421211', '212141', '214121',
  '412121', '111143', '111341', '131141', '114113', '114311', '411113',
  '411311', '113141', '114131', '311141', '411131', '211412', '211214',
  '211232', '2331112',
]

const START_B = 104
const STOP = 106

// Devuelve la secuencia de códigos (start + datos + checksum + stop) para
// codificar `text` en Code 128-B.
function encode(text: string): number[] {
  const codes = [START_B]
  let sum = START_B
  let pos = 1
  for (const ch of text) {
    const v = ch.charCodeAt(0) - 32
    if (v < 0 || v > 94) continue // fuera de Code B → se omite
    codes.push(v)
    sum += v * pos
    pos += 1
  }
  codes.push(sum % 103) // checksum
  codes.push(STOP)
  return codes
}

export default function Barcode({ value, height = 56, className = '' }: {
  value: string
  height?: number
  className?: string
}) {
  const text = (value || '').trim()
  const codes = encode(text || ' ')
  const bars: { x: number; w: number }[] = []
  const quiet = 10
  let x = quiet
  for (const code of codes) {
    const widths = PATTERNS[code]
    for (let i = 0; i < widths.length; i += 1) {
      const w = Number(widths[i])
      if (i % 2 === 0) bars.push({ x, w }) // par = barra
      x += w
    }
  }
  const totalW = x + quiet
  return (
    <svg className={`barcode ${className}`.trim()}
      viewBox={`0 0 ${totalW} ${height}`} preserveAspectRatio="none"
      role="img" aria-label={`Barcode ${text}`}
      style={{ width: '100%', height, display: 'block' }}>
      <rect width={totalW} height={height} fill="#ffffff" />
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={height} fill="#000000" />
      ))}
    </svg>
  )
}
