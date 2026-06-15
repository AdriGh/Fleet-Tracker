import { useEffect, useMemo, useState } from 'react'
import Modal from './Modal'
import {
  deleteTemplate, listRecipients, listTemplates, saveTemplate,
  sendBroadcast, type MsgTemplate, type Recipient,
} from '../api'

type Chan = 'email' | 'sms'

// Mensajes a conductores con plantillas reutilizables: crear/editar/borrar
// plantillas y mandar un broadcast (email/SMS) a los conductores elegidos.
export default function BroadcastModal({ onClose }: { onClose: () => void }) {
  const [templates, setTemplates] = useState<MsgTemplate[]>([])
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [id, setId] = useState('')            // '' = plantilla nueva
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [channels, setChannels] = useState<Set<Chan>>(new Set(['email']))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function pick(t: MsgTemplate) {
    setId(t.id); setName(t.name); setSubject(t.subject); setBody(t.body)
  }
  function blank() { setId(''); setName(''); setSubject(''); setBody('') }

  useEffect(() => {
    (async () => {
      try {
        const [t, r] = await Promise.all([listTemplates(), listRecipients()])
        setTemplates(t)
        setRecipients(r)
        if (t[0]) pick(t[0])
      } catch (e) { setErr(e instanceof Error ? e.message : 'Error') }
    })()
  }, [])

  async function onSaveTpl() {
    if (!name.trim()) { setErr('Ponele un nombre a la plantilla'); return }
    setBusy(true); setErr(null)
    try {
      const saved = await saveTemplate({ id, name, subject, body })
      setId(saved.id)
      setTemplates(await listTemplates())
      setDone('Plantilla guardada')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Error') }
    finally { setBusy(false) }
  }

  async function onDeleteTpl() {
    if (!id) return
    setBusy(true); setErr(null)
    try {
      await deleteTemplate(id)
      setTemplates(await listTemplates())
      blank()
      setDone('Plantilla borrada')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Error') }
    finally { setBusy(false) }
  }

  const needEmail = channels.has('email')
  const needSms = channels.has('sms')
  const eligible = useMemo(() => recipients.filter(
    (r) => (needEmail && r.has_email) || (needSms && r.has_phone)),
    [recipients, needEmail, needSms])

  function toggleDriver(n: string) {
    setSelected((s) => {
      const x = new Set(s)
      if (x.has(n)) x.delete(n); else x.add(n)
      return x
    })
  }
  function toggleAll() {
    setSelected((s) => s.size === eligible.length
      ? new Set() : new Set(eligible.map((r) => r.name)))
  }
  function toggleChan(c: Chan) {
    setChannels((s) => {
      const x = new Set(s)
      if (x.has(c)) x.delete(c); else x.add(c)
      return x
    })
  }

  async function onSend() {
    const drivers = [...selected]
    if (drivers.length === 0) { setErr('Elegí al menos un conductor'); return }
    if (channels.size === 0) { setErr('Elegí al menos un canal'); return }
    if (!body.trim()) { setErr('El mensaje está vacío'); return }
    setSending(true); setErr(null); setDone(null)
    try {
      const r = await sendBroadcast(
        { drivers, channels: [...channels], subject, body })
      const dry = r.email_dry_run || r.sms_dry_run
      setDone(`Enviado a ${r.sent}/${drivers.length}`
        + (dry ? ' · modo SIMULADO (configurá email/SMS en Settings para '
          + 'enviar de verdad)' : ''))
    } catch (e) { setErr(e instanceof Error ? e.message : 'No se pudo enviar') }
    finally { setSending(false) }
  }

  return (
    <Modal title="Mensaje a conductores · Plantillas"
      onClose={onClose} width={920}>
      {err && <div className="banner error"><span>{err}</span></div>}
      {done && <div className="banner success"><span>{done}</span></div>}

      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
        {/* Izquierda: plantilla + editor */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <label>
            <span>Plantilla</span>
            <select className="cell-input" value={id}
              onChange={(e) => {
                const t = templates.find((x) => x.id === e.target.value)
                if (t) pick(t); else blank()
              }}>
              <option value="">— Nueva plantilla —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Nombre</span>
            <input className="cell-input" value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre de la plantilla" />
          </label>
          <label>
            <span>Asunto (email)</span>
            <input className="cell-input" value={subject}
              onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label>
            <span>Mensaje <small style={{ color: 'var(--muted,#889)' }}>
              · variables: {'{first_name}'} {'{name}'}</small></span>
            <textarea className="cell-input" rows={9} value={body}
              onChange={(e) => setBody(e.target.value)}
              style={{ resize: 'vertical', fontFamily: 'inherit' }} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={blank}>Nueva</button>
            <button className="btn btn-ghost" onClick={onSaveTpl}
              disabled={busy}>Guardar plantilla</button>
            {id && <button className="btn btn-ghost" onClick={onDeleteTpl}
              disabled={busy}>Borrar</button>}
          </div>
        </div>

        {/* Derecha: canales + destinatarios + enviar */}
        <div style={{ width: 320, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Canales</span>
          <div style={{ display: 'flex', gap: 8, margin: '4px 0 12px' }}>
            {(['email', 'sms'] as Chan[]).map((c) => (
              <button key={c}
                className="btn btn-ghost"
                onClick={() => toggleChan(c)}
                style={channels.has(c)
                  ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                  : {}}>
                {c.toUpperCase()}
              </button>
            ))}
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              Conductores ({selected.size}/{eligible.length})
            </span>
            <button className="btn btn-ghost btn-xs" onClick={toggleAll}>
              {selected.size === eligible.length && eligible.length > 0
                ? 'Ninguno' : 'Todos'}
            </button>
          </div>
          <div style={{
            maxHeight: 290, overflow: 'auto',
            border: '1px solid var(--border, #e3e7ee)', borderRadius: 8,
            marginTop: 6, padding: 4,
          }}>
            {eligible.length === 0 && (
              <div style={{ padding: 10, fontSize: 12,
                color: 'var(--muted, #667)' }}>
                Sin conductores con {needEmail && needSms ? 'email/teléfono'
                  : needEmail ? 'email' : 'teléfono'} cargado. Cargá los
                contactos en la sección Drivers.
              </div>
            )}
            {eligible.map((r) => (
              <label key={r.name} style={{
                display: 'flex', gap: 8, alignItems: 'center',
                padding: '4px 6px', fontSize: 13,
              }}>
                <input type="checkbox" checked={selected.has(r.name)}
                  onChange={() => toggleDriver(r.name)} />
                <span style={{ flex: 1 }}>{r.name}</span>
                <small style={{ color: 'var(--muted, #889)' }}>
                  {r.has_email ? '✉ ' : ''}{r.has_phone ? '☎' : ''}
                </small>
              </label>
            ))}
          </div>
          <button className="btn btn-primary"
            style={{ width: '100%', marginTop: 10 }}
            onClick={onSend} disabled={sending || selected.size === 0}>
            {sending ? 'Enviando…' : `Enviar a ${selected.size}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
