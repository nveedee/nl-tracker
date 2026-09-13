import { useState, useRef, useEffect, useMemo } from 'react'
import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'
import { toast } from '../components/ui.jsx'
import { computeMarketValuePrior, computeTeamMarketValueSums, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'
import { DEFAULT_BACK_TO_BACK_PENALTY } from '../restDays.js'
import { fmtChf } from '../stats.js'

function fmtDateTime(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// Prognose-Erweiterungen (Marktwert-Prior + Ruhetage/Back-to-back) - eigene
// Karte, damit beide unabhängig voneinander umschaltbar sind (siehe
// src/marketValuePrior.js, src/restDays.js). Zeigt die resultierenden
// Start-ELOs live an (Verifikation "teure Kader über 1500, Durchschnitt exakt
// 1500"), reagiert auf die noch ungespeicherten Eingaben für sofortiges Feedback.
function PredictionSettingsCard() {
  const { data, api, refresh } = useData()
  const s = data.settings
  const [marketValuePriorEnabled, setMarketValuePriorEnabled] = useState(s.marketValuePriorEnabled ?? true)
  const [priorSpread, setPriorSpread] = useState(s.priorSpread ?? DEFAULT_PRIOR_SPREAD)
  const [restDaysEnabled, setRestDaysEnabled] = useState(s.restDaysEnabled ?? true)
  const [backToBackPenalty, setBackToBackPenalty] = useState(
    s.backToBackPenalty != null ? s.backToBackPenalty * 100 : DEFAULT_BACK_TO_BACK_PENALTY * 100
  )
  const eloStart = Number(s.eloStart) || 1500

  const preview = useMemo(() => {
    const sums = computeTeamMarketValueSums(data.teams, data.players)
    const prior = marketValuePriorEnabled
      ? computeMarketValuePrior(data.teams, data.players, eloStart, Number(priorSpread) || 0)
      : null
    return data.teams
      .map((t) => ({ team: t, sum: sums[t.id] || 0, startElo: prior ? Math.round(prior[t.id]) : eloStart }))
      .sort((a, b) => b.startElo - a.startElo)
  }, [data.teams, data.players, marketValuePriorEnabled, priorSpread, eloStart])
  const avgStartElo = preview.length ? Math.round(preview.reduce((sum, r) => sum + r.startElo, 0) / preview.length) : eloStart
  const hasMarketData = preview.some((r) => r.sum > 0)

  const savePredictionSettings = async () => {
    try {
      await api.updateSettings({
        marketValuePriorEnabled,
        priorSpread: Number(priorSpread),
        restDaysEnabled,
        backToBackPenalty: Number(backToBackPenalty) / 100,
      })
      await refresh()
      toast('Prognose-Einstellungen gespeichert')
    } catch (e) { toast(e.message, true) }
  }

  return (
    <div className="card card-pad">
      <h2>Prognose-Erweiterungen</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Zwei transparente, unabhängig abschaltbare Zusatzfaktoren für die ELO-/Spielprognose.
      </p>

      <div className="mb">
        <label className="row gap-sm" style={{ fontWeight: 600, cursor: 'pointer' }}>
          <input type="checkbox" checked={marketValuePriorEnabled} onChange={(e) => setMarketValuePriorEnabled(e.target.checked)} />
          Marktwert-Prior verwenden
        </label>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginLeft: 24 }}>
          Start-ELO jedes Teams wird aus der Summe seiner Kader-Marktwerte (NL-API) abgeleitet, statt
          alle Teams pauschal bei {eloStart} zu starten. Ligaweit so zentriert, dass der Durchschnitt
          exakt {eloStart} bleibt. Wirkt NUR auf den Startwert – jedes Resultat aktualisiert das ELO
          danach ganz normal weiter. Deaktiviert (oder ohne Marktwerte): Rückfall auf den bisherigen
          Pre-Season-ELO bzw. den flachen Startwert.
        </div>
        {marketValuePriorEnabled && (
          <div className="form-row mt" style={{ marginLeft: 24, maxWidth: 260 }}>
            <div>
              <label className="field">Prior-Spread (± ELO)</label>
              <input type="number" value={priorSpread} onChange={(e) => setPriorSpread(e.target.value)} />
            </div>
          </div>
        )}
      </div>

      <div className="mb">
        <label className="row gap-sm" style={{ fontWeight: 600, cursor: 'pointer' }}>
          <input type="checkbox" checked={restDaysEnabled} onChange={(e) => setRestDaysEnabled(e.target.checked)} />
          Ruhetage/Back-to-back berücksichtigen
        </label>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginLeft: 24 }}>
          Spielt ein Team am Vortag bereits (Back-to-back) und der Gegner nicht, wird die
          Heimsieg-Wahrscheinlichkeit dieses Spiels leicht zugunsten des ausgeruhten Teams verschoben.
          Nur für die Einzelspiel-Prognose (Spielplan, Matchup-Detail), nicht Teil der Saison-Simulation.
        </div>
        {restDaysEnabled && (
          <div className="form-row mt" style={{ marginLeft: 24, maxWidth: 260 }}>
            <div>
              <label className="field">Back-to-back-Anpassung (%)</label>
              <input type="number" step="0.5" value={backToBackPenalty} onChange={(e) => setBackToBackPenalty(e.target.value)} />
            </div>
          </div>
        )}
      </div>

      <div className="mt"><button className="btn primary" onClick={savePredictionSettings}>Speichern</button></div>

      <h3 className="mt-lg">Start-ELOs (Vorschau)</h3>
      {!hasMarketData && (
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
          Noch keine Marktwerte vorhanden (NL-API-Sync noch nicht gelaufen) – alle Teams starten aktuell
          flach bei {eloStart}.
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="left">Team</th>
              <th className="num">Kader-Marktwert (Summe)</th>
              <th className="num">Start-ELO</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((r) => (
              <tr key={r.team.id}>
                <td className="left"><TeamBadge team={r.team} short /></td>
                <td className="num">{r.sum > 0 ? fmtChf(r.sum) : <span className="muted">–</span>}</td>
                <td className="num">
                  <strong className={r.startElo > eloStart ? 'good' : r.startElo < eloStart ? 'bad' : ''}>{r.startElo}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted mt" style={{ fontSize: 11.5 }}>Ø Start-ELO: {avgStartElo} (Ziel: {eloStart})</div>
    </div>
  )
}

// National-League-API-Sync (server/sync.js): eigenständig vom SIHF-Live-Sync
// (siehe SyncStatus.jsx in der Topbar) - spiegelt Spiele, Tabelle und
// Spieler-Rohdaten der öffentlichen nationalleague.ch-API.
function NlSyncCard() {
  const { api, refresh } = useData()
  const [status, setStatus] = useState(null) // { lastRunAt, lastSuccessAt, ... } | 'error' | null (lädt)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    api.getNlSyncStatus().then(setStatus).catch(() => setStatus('error'))
  }, [api])

  const runNow = async () => {
    setRunning(true)
    try {
      const res = await api.runNlSync()
      setStatus({ lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), ...res })
      await refresh()
      toast(`NL-API-Sync: ${res.gamesUpdated} Spiele, ${res.playersUpdated + res.playersCreated} Spieler, ${res.teamsUpdated} Teams aktualisiert`)
    } catch (e) {
      setStatus((prev) => ({ error: true, lastSuccessAt: prev && prev !== 'error' ? prev.lastSuccessAt : null }))
      toast(e.message || 'National-League-API momentan nicht erreichbar.', true)
    } finally {
      setRunning(false)
    }
  }

  const isError = status === 'error' || (status && status.error)
  const lastSuccess = status && status !== 'error' ? fmtDateTime(status.lastSuccessAt) : null

  return (
    <div className="card card-pad">
      <h2>National-League-API-Sync</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Spiegelt Spielplan/Resultate, Tabelle und Spieler-Rohdaten (Saison-Totale, Marktwerte) von{' '}
        <code>nationalleague.ch</code> automatisch in die Datenbank. Läuft einmal beim Serverstart und
        manuell per Button; bestätigte Endresultate werden dabei nie zurückgesetzt.
      </p>
      <div className="row gap-sm wrap" style={{ alignItems: 'center' }}>
        <button className="btn primary" onClick={runNow} disabled={running}>
          {running ? 'Synchronisiere…' : '↻ Jetzt synchronisieren'}
        </button>
        <span className={isError ? 'bad' : 'muted'} style={{ fontSize: 13 }}>
          {isError
            ? `Sync momentan nicht verfügbar${lastSuccess ? ` · letzter Erfolg: ${lastSuccess}` : ''}`
            : lastSuccess ? `Letzter Sync: ${lastSuccess}` : 'Noch nicht synchronisiert'}
        </span>
      </div>
      {status && status !== 'error' && status.gamesUpdated != null && (
        <div className="muted mt" style={{ fontSize: 12.5 }}>
          {status.gamesFinal} final · {status.gamesScheduled} geplant · {status.gamesCreated} neu angelegt
          {' · '}{status.playersUpdated} Spieler aktualisiert, {status.playersCreated} neu, {status.playersSkippedBroken} übersprungen
        </div>
      )}
    </div>
  )
}

export default function Settings() {
  const { data, api, refresh } = useData()
  const s = data.settings
  const [seasonName, setSeasonName] = useState(s.seasonName)
  const [eloStart, setEloStart] = useState(s.eloStart)
  const [eloK, setEloK] = useState(s.eloK)
  const [eloHomeAdvantage, setEloHomeAdvantage] = useState(s.eloHomeAdvantage)
  const fileRef = useRef(null)

  const saveSettings = async () => {
    try {
      await api.updateSettings({
        seasonName,
        eloStart: Number(eloStart),
        eloK: Number(eloK),
        eloHomeAdvantage: Number(eloHomeAdvantage),
      })
      await refresh()
      toast('Einstellungen gespeichert')
    } catch (e) { toast(e.message, true) }
  }

  const exportData = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `nl-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importData = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      if (!window.confirm('Aktuelle Daten durch das Backup ersetzen?')) return
      await api.importData(json)
      await refresh()
      toast('Backup importiert')
    } catch (err) { toast('Import fehlgeschlagen: ' + err.message, true) }
    finally { if (fileRef.current) fileRef.current.value = '' }
  }

  const resetGames = async () => {
    if (!window.confirm('Alle erfassten SPIELE löschen? Teams & Kader bleiben erhalten.')) return
    try { await api.reset({ keepTeams: true }); await refresh(); toast('Spiele zurückgesetzt') }
    catch (e) { toast(e.message, true) }
  }
  const resetAll = async () => {
    if (!window.confirm('ALLES auf die 14 Standard-Teams zurücksetzen? Kader, Spiele und Änderungen gehen verloren.')) return
    try { await api.reset({ keepTeams: false }); await refresh(); toast('Auf Standard zurückgesetzt') }
    catch (e) { toast(e.message, true) }
  }

  return (
    <>
      <div className="page-head"><div><h1>Einstellungen</h1><div className="sub">Saison, ELO-Parameter und Backup</div></div></div>

      <div className="grid grid-2">
        <div className="card card-pad">
          <h2>Saison & ELO</h2>
          <div className="mb"><label className="field">Saison-Name</label>
            <input value={seasonName} onChange={(e) => setSeasonName(e.target.value)} /></div>
          <div className="form-row">
            <div><label className="field">ELO Startwert</label>
              <input type="number" value={eloStart} onChange={(e) => setEloStart(e.target.value)} /></div>
            <div><label className="field">K-Faktor</label>
              <input type="number" value={eloK} onChange={(e) => setEloK(e.target.value)} /></div>
            <div><label className="field">Heimvorteil</label>
              <input type="number" value={eloHomeAdvantage} onChange={(e) => setEloHomeAdvantage(e.target.value)} /></div>
          </div>
          <div className="muted mt" style={{ fontSize: 13 }}>
            Höherer K-Faktor = ELO reagiert stärker auf einzelne Spiele. Heimvorteil wird als
            ELO-Bonus auf das Heimteam gerechnet. OT/PS-Siege zählen schwächer (0,75) als
            reguläre Siege (1,0).
          </div>
          <div className="mt"><button className="btn primary" onClick={saveSettings}>Speichern</button></div>
        </div>

        <div className="card card-pad">
          <h2>Backup & Daten</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Alle Daten liegen als Datei <code>server/data/db.json</code> im Projekt. Zusätzlich
            kannst du hier ein Backup exportieren oder einspielen.
          </p>
          <div className="row gap-sm wrap">
            <button className="btn" onClick={exportData}>⬇ Backup exportieren</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>⬆ Backup importieren</button>
            <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={importData} />
          </div>

          <h3 className="mt-lg" style={{ color: 'var(--bad)' }}>Gefahrenzone</h3>
          <div className="row gap-sm wrap">
            <button className="btn danger" onClick={resetGames}>Nur Spiele löschen</button>
            <button className="btn danger" onClick={resetAll}>Alles auf Standard</button>
          </div>
        </div>

        <NlSyncCard />
        <PredictionSettingsCard />
      </div>
    </>
  )
}
