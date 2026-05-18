import { useRef, useState, type DragEvent } from 'react'

interface Props {
  label: string
  hint: string
  file: File | null
  onChange: (file: File | null) => void
  accept?: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function FileDrop({ label, hint, file, onChange, accept }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDrag(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onChange(dropped)
  }

  return (
    <div
      className={`dropzone ${drag ? 'drag' : ''} ${file ? 'filled' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept ?? '.csv'}
        hidden
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      {file ? (
        <>
          <svg
            className="dz-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="m9 15 2 2 4-4" />
          </svg>
          <span className="dz-file">{file.name}</span>
          <span className="dz-hint">{formatSize(file.size)}</span>
          <button
            type="button"
            className="dz-clear"
            onClick={(e) => {
              e.stopPropagation()
              onChange(null)
              if (inputRef.current) inputRef.current.value = ''
            }}
          >
            Quitar
          </button>
        </>
      ) : (
        <>
          <svg
            className="dz-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M17 8l-5-5-5 5" />
            <path d="M12 3v12" />
          </svg>
          <span className="dz-label">{label}</span>
          <span className="dz-hint">{hint}</span>
        </>
      )}
    </div>
  )
}
