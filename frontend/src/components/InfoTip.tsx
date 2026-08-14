// Tooltip "?" (v2.13, elemento 04): explica una métrica en una frase, donde
// la métrica vive. Hover o foco de teclado; CSS puro (index.css .info-tip).
// Para KPIs nuevos (CPM, preventive share) donde el nombre solo no alcanza.
export default function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} role="note" aria-label={text}>
      ?
      <span className="info-tip-pop" role="tooltip">{text}</span>
    </span>
  )
}
