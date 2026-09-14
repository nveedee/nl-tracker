import { useState } from 'react'
import { TeamBadge, SectionHeader, Expander } from './ui.jsx'
import PositionMatrix from './PositionMatrix.jsx'
import BracketCards from './BracketCards.jsx'
import { toComparisonSnapshot } from '../baselineStore.js'
import { simulatePlayoffOdds, OVERRIDE_RESULTS } from '../playoffSim.js'

const RESULT_LABELS = {
  HOME_REG: 'H reg.',
  HOME_OT: 'H n.V.',
  AWAY_OT: 'A n.V.',
  AWAY_REG: 'A reg.',
}

const DEFAULT_LIMIT = 12

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })
}

// Lässt einzelne offene Spiele als FIX vorgeben (Klick auf eine der 4
// Ausgang-Optionen, erneuter Klick löscht die Vorgabe wieder) und simuliert
// den Rest per Monte-Carlo (src/playoffSim.js::simulateSeasonProjections mit
// `overrides`). Delta in Bracket-Karten/Positions-Matrix immer ggü. der
// AKTUELLEN unbedingten Projektion (`baseResults`), nicht der Tages-Baseline.
export default function WhatIfSimulator({ teams, games, settings, players, initialRatings, baseResults, forecasts, runs }) {
  const [overrides, setOverrides] = useState({})
  const [whatIfResults, setWhatIfResults] = useState(null)
  const [simulating, setSimulating] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const overrideCount = Object.keys(overrides).length
  const visibleForecasts = expanded ? forecasts : forecasts.slice(0, DEFAULT_LIMIT)

  const setOverride = (gameId, code) => {
    setOverrides((prev) => {
      const next = { ...prev }
      if (next[gameId] === code) delete next[gameId]
      else next[gameId] = code
      return next
    })
  }

  const handleSimulate = () => {
    if (overrideCount === 0) return
    setSimulating(true)
    setTimeout(() => {
      try {
        // Derselbe Seed wie die aktuelle unbedingte Projektion ("common
        // random numbers") - die Differenz misst dann ausschliesslich den
        // Effekt der vorgegebenen Spiele, nicht zusätzliches Simulationsrauschen.
        const sim = simulatePlayoffOdds(teams, games, settings, { runs, seed: baseResults.seed, players, initialRatings, overrides })
        setWhatIfResults(sim)
      } catch (err) {
        console.error('What-if-Simulation error:', err)
      } finally {
        setSimulating(false)
      }
    }, 0)
  }

  const handleReset = () => {
    setOverrides({})
    setWhatIfResults(null)
  }

  const compare = whatIfResults ? toComparisonSnapshot(baseResults, 'aktuelle Projektion') : null

  return (
    <div className="card mb">
      <div className="card-pad" style={{ paddingBottom: 10 }}>
        <SectionHeader
          title="What-if-Simulator"
          caption="Ergebnisse einzelner Spiele fix vorgeben, Rest bleibt Monte-Carlo."
          action={<span className="muted" style={{ fontSize: 11.5 }}>{overrideCount} vorgegeben</span>}
        />
        <div className="row gap-sm" style={{ marginTop: 10 }}>
          <button className="btn primary sm" onClick={handleSimulate} disabled={overrideCount === 0 || simulating} style={{ flex: 1, minHeight: 40 }}>
            {simulating ? 'Simuliert…' : 'Simulieren'}
          </button>
          <button className="btn ghost sm" onClick={handleReset} disabled={overrideCount === 0 && !whatIfResults} style={{ minHeight: 40 }}>Reset</button>
        </div>
      </div>

      <div className="match-list">
        {visibleForecasts.map((f) => (
          <div key={f.gameId} className="match-item" style={{ cursor: 'default' }}>
            <div className="match-meta"><span>{fmtDate(f.date)}</span></div>
            <div className="match-teams" style={{ marginBottom: 8 }}>
              <TeamBadge team={f.homeTeam} short /> <span className="muted">–</span> <TeamBadge team={f.awayTeam} short />
            </div>
            <div className="pill-tabs full">
              {OVERRIDE_RESULTS.map((code) => (
                <button key={code} className={overrides[f.gameId] === code ? 'active' : ''} onClick={() => setOverride(f.gameId, code)}>
                  {RESULT_LABELS[code]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <Expander total={forecasts.length} initialCount={DEFAULT_LIMIT} expanded={expanded} onExpand={() => setExpanded(true)} moreLabel={`Alle ${forecasts.length} offenen Spiele anzeigen`} />

      {whatIfResults && (
        <div className="card-pad" style={{ paddingTop: 4 }}>
          <div className="chip" style={{ marginBottom: 12 }}>
            What-if-Ergebnis · {whatIfResults.runs.toLocaleString('de-CH')} Läufe · Δ ggü. aktueller Projektion
          </div>
          <BracketCards rows={whatIfResults.rows} compare={compare} />
          <PositionMatrix rows={whatIfResults.rows} runs={whatIfResults.runs} compare={compare} />
        </div>
      )}
    </div>
  )
}
