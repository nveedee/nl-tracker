import { useEffect, useState } from 'react'
import { useData } from '../DataContext.jsx'
import { api } from '../api.js'
import { toast } from './ui.jsx'

function fmtTime(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
}

// Kompakte SIHF-Sync-Anzeige (kein eigener Seiteninhalt): letzte Aktualisierung
// + manueller "Jetzt aktualisieren"-Button. Ruft denselben Sync auf, den auch
// der automatische Poll nutzt (server/scripts/sync-sihf.cjs).
export default function SyncStatus() {
  const { refresh } = useData()
  const [status, setStatus] = useState(null) // { lastRunAt, lastSuccessAt, ... } | 'error' | null (lädt)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    api.getSyncStatus().then(setStatus).catch(() => setStatus('error'))
  }, [])

  const runNow = async () => {
    setRunning(true)
    try {
      const res = await api.runSync()
      setStatus({ lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), ...res })
      if (res.updated > 0) { await refresh(); toast(`SIHF Sync: ${res.updated} Spiel${res.updated === 1 ? '' : 'e'} aktualisiert`) }
      else toast('SIHF Sync: keine Änderungen')
    } catch (e) {
      setStatus((prev) => ({ error: true, lastSuccessAt: prev && prev !== 'error' ? prev.lastSuccessAt : null }))
      toast('SIHF-Synchronisation momentan nicht verfügbar.', true)
    } finally {
      setRunning(false)
    }
  }

  const isError = status === 'error' || (status && status.error)
  const lastSuccess = status && status !== 'error' ? fmtTime(status.lastSuccessAt) : null
  const label = isError ? 'Sync: n/a' : lastSuccess ? `Sync ${lastSuccess}` : 'Sync –'
  const title = isError
    ? `SIHF-Synchronisation momentan nicht verfügbar.${lastSuccess ? ` Letzte erfolgreiche Aktualisierung: ${lastSuccess}` : ''}`
    : lastSuccess
      ? `SIHF Sync: aktuell · letzte Aktualisierung ${lastSuccess}`
      : 'SIHF Sync: noch nicht gelaufen'

  return (
    <div className="row gap-sm" style={{ fontSize: 11.5, flex: 'none' }}>
      <span className={isError ? 'bad' : 'muted'} style={{ fontWeight: 600, whiteSpace: 'nowrap' }} title={title}>
        {label}
      </span>
      <button className="btn ghost sm" onClick={runNow} disabled={running} title="Jetzt aktualisieren" style={{ padding: '5px 8px' }}>
        {running ? '…' : '↻'}
      </button>
    </div>
  )
}
