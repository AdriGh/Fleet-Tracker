import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type IconName =
  | 'edit' | 'exclude' | 'include' | 'archive' | 'save' | 'cancel'

const PATHS: Record<IconName, ReactNode> = {
  edit: <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  exclude: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6 18.4 18.4" />
    </>
  ),
  include: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </>
  ),
  save: <path d="m5 12 4 4L19 6" />,
  cancel: <path d="M6 6 18 18M18 6 6 18" />,
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  name: IconName
  title: string
  danger?: boolean
}

/** Botón de acción compacto, solo ícono (con tooltip accesible). */
export default function IconButton(
  { name, title, danger, className, ...rest }: Props,
) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`icon-act${danger ? ' danger' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
        stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
        strokeLinejoin="round">
        {PATHS[name]}
      </svg>
    </button>
  )
}
