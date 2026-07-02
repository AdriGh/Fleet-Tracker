import React, { createContext, useContext } from 'react'

/**
 * StatCluster (Rigsmith DS jul-2026): el panel de instrumentos. Funde gauges
 * StatCard en UNA sola placa always-dark con divisores hairline — nunca más
 * tiles sueltos en grilla. Los divisores salen de gap:1px sobre fondo #232327
 * (equivalente visual al borderRight del handoff, pero soporta wrap
 * responsive y wrappers intermedios como <button>). El contexto avisa a los
 * gauges que suelten su chrome standalone.
 * Los hex literales son del instrumento (theme-invariant por diseño).
 */
const ClusterCtx = createContext(false)
export const useInCluster = () => useContext(ClusterCtx)

type StatClusterProps = {
  /** Override de grid-template-columns (ej. "1fr 1.25fr 1fr"): fija el
      cluster a grid con ese template. Sin esto, es flex-wrap responsive
      (las celdas que wrappean ESTIRAN la fila — nunca queda placa vacía). */
  columns?: string
  children?: React.ReactNode
} & React.HTMLAttributes<HTMLDivElement>

export function StatCluster({
  columns,
  children,
  className = '',
  style = {},
  ...rest
}: StatClusterProps) {
  const kids = React.Children.toArray(children).filter(Boolean)
  const layout: React.CSSProperties = columns
    ? { display: 'grid', gridTemplateColumns: columns }
    : { display: 'flex', flexWrap: 'wrap' }
  return (
    <div
      className={`ft-stat-cluster ${className}`.trim()}
      style={{
        ...layout,
        gap: 1,
        background: '#232327',
        border: '1px solid #27272b',
        borderRadius: 14,
        overflow: 'hidden',
        ...style,
      }}
      {...rest}
    >
      <ClusterCtx.Provider value={true}>
        {kids.map((child, i) => (
          <div
            key={React.isValidElement(child) && child.key != null ? child.key : i}
            className="ft-stat-cell"
            style={{
              background: '#131316',
              minWidth: 0,
              display: 'grid',
              ...(columns ? null : { flex: '1 1 170px' }),
            }}
          >
            {child}
          </div>
        ))}
      </ClusterCtx.Provider>
    </div>
  )
}
