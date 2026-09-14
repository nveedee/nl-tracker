// ---------------------------------------------------------------------------
// Zentrale, app-weite Ablage des ZULETZT gelaufenen Season-Projections-
// Simulationsergebnisses (src/playoffSim.js) - die eine gemeinsame
// Datenquelle für das Playoff Probability Wheel auf Dashboard.jsx UND die
// Detailansicht PlayoffOdds.jsx. Getrennt von src/baselineStore.js: die
// Baseline ist die FIXIERTE Tages-Referenz für Delta-Anzeigen, dieser Store
// hier ist der LIVE-Stand der aktuellen Session, der sich nach jedem
// Simulationslauf sofort ändert - ganz ohne Page Reload, da React Context.
//
// Initialwert: die letzte Baseline (falls vorhanden), damit auch ohne
// eigenen Simulationslauf in dieser Session sofort etwas angezeigt wird.
// Sobald PlayoffOdds.jsx eine neue Simulation abschliesst, überschreibt
// setLiveResults() diesen State - Dashboard.jsx (falls gemountet oder beim
// nächsten Rendern) zeigt dann unmittelbar die frischen Werte.
// ---------------------------------------------------------------------------

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { getLastBaseline } from './baselineStore.js'

const SimResultsContext = createContext(null)

// Reduziert eine simulateSeasonProjections()-Zeile (`row.team.id`) ODER eine
// Baseline-Zeile (`row.teamId`, s. baselineStore.js) auf dieselbe schlanke
// Form - Konsumenten (PlayoffWheel etc.) müssen die Quelle nicht kennen.
function toProbsRow(row) {
  return {
    teamId: row.team ? row.team.id : row.teamId,
    pPlayoffs: row.pPlayoffs,
    pSemifinal: row.pSemifinal,
    pFinal: row.pFinal,
  }
}

function fromBaseline(baseline) {
  if (!baseline) return null
  return { updatedAt: baseline.createdAt, source: 'baseline', rows: baseline.rows.map(toProbsRow) }
}

export function SimResultsProvider({ children }) {
  const [state, setState] = useState(() => fromBaseline(getLastBaseline()))

  const setLiveResults = useCallback((simResult) => {
    if (!simResult?.rows) return
    setState({ updatedAt: new Date().toISOString(), source: 'live', rows: simResult.rows.map(toProbsRow) })
  }, [])

  const value = useMemo(() => ({
    rows: state?.rows || null,
    updatedAt: state?.updatedAt || null,
    source: state?.source || null,
    setLiveResults,
  }), [state, setLiveResults])

  return <SimResultsContext.Provider value={value}>{children}</SimResultsContext.Provider>
}

export function useSimResults() {
  const ctx = useContext(SimResultsContext)
  if (!ctx) throw new Error('useSimResults muss innerhalb von SimResultsProvider genutzt werden')
  return ctx
}

export function getProbsRow(rows, teamId) {
  return (rows || []).find((r) => r.teamId === teamId) || null
}
