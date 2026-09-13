import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import { api } from './api.js'
import { computeStandings, computePlayerStats } from './stats.js'
import { computeElo, ELO_CONFIG } from './elo.js'
import { usePreseasonElo, computePreseasonRatings } from './preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from './marketValuePrior.js'

const DataContext = createContext(null)

export function DataProvider({ children }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const preseasonSeasonEnd = usePreseasonElo()

  const refresh = useCallback(async () => {
    try {
      const d = await api.getData()
      setData(d)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Abgeleitete Werte – neu berechnet, sobald sich die Daten ändern.
  const derived = useMemo(() => {
    if (!data) return null
    const standings = computeStandings(data.teams, data.games)
    const playerStats = computePlayerStats(data.players, data.games)

    // ELO-Start-Prior: Marktwert-Prior (src/marketValuePrior.js), wenn
    // aktiviert und Daten vorhanden, sonst der bestehende, aus dem
    // historischen Archiv abgeleitete Pre-Season-ELO (src/preseasonElo.js,
    // unverändert) - identisches Verhalten wie vor dieser Erweiterung, wenn
    // der Marktwert-Prior deaktiviert ist oder (noch) keine Marktwerte
    // vorliegen. `eloPriorSource` dient nur der UI-Kennzeichnung.
    const eloStart = data.settings?.eloStart ?? ELO_CONFIG.eloStart
    const useMarketValue = data.settings?.marketValuePriorEnabled !== false
    const marketPrior = useMarketValue
      ? computeMarketValuePrior(data.teams, data.players, eloStart, data.settings?.priorSpread ?? DEFAULT_PRIOR_SPREAD)
      : null
    const preseasonRatings = computePreseasonRatings(preseasonSeasonEnd, eloStart)
    const initialRatings = marketPrior || preseasonRatings
    const eloPriorSource = marketPrior ? 'marketValue' : preseasonRatings ? 'historicalArchive' : 'flat'

    const elo = computeElo(data.teams, data.games, data.settings, initialRatings)
    return { standings, playerStats, elo, eloPriorSource }
  }, [data, preseasonSeasonEnd])

  const value = {
    data,
    loading,
    error,
    refresh,
    derived,
    api,
    // Lookup-Helfer
    teamById: (id) => data?.teams.find((t) => t.id === id),
    playerById: (id) => data?.players.find((p) => p.id === id),
  }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData muss innerhalb von DataProvider genutzt werden')
  return ctx
}
