// Helper centralizado de notificaciones (Sonner). Mantiene un estilo
// consistente en toda la app. El <Toaster /> se monta en App.tsx.
import { toast } from 'sonner'

export { toast }

/** Éxito (verde). */
export const notifyOk = (message: string, description?: string) =>
  toast.success(message, { description })

/** Error (rojo). Si se pasa el error, muestra su mensaje como detalle. */
export const notifyErr = (message: string, err?: unknown) =>
  toast.error(message, {
    description: err instanceof Error ? err.message : undefined,
  })

/** Promesa: muestra "cargando" y resuelve a éxito/error automáticamente. */
export const notifyPromise = <T>(
  promise: Promise<T>,
  msgs: { loading: string; success: string; error: string },
) => toast.promise(promise, msgs)
