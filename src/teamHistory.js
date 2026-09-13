// ---------------------------------------------------------------------------
// Historische Mehrsaison-Teamdaten (Team Analytics: TeamDetail.jsx).
// Reine Datenauswertung - kein Prognosemodell, keine erfundenen Werte,
// nichts hiervon fliesst in ELO/Power Ranking/Season Projections ein.
//
// Datenquelle: public/team-history.json - statischer, einmalig per
// server/scripts/generate-team-history.js generierter Export (siehe dort:
// Rang/ELO/Punkte/Tore/Gegentore pro Team und historischer Archiv-Saison,
// aus den unveränderten computeStandings()/computeElo()-Funktionen -
// Saison-Totale können Playoff-Spiele enthalten, da regulär Saison/Playoffs
// im Archiv nicht zuverlässig unterscheidbar sind). Lazy per fetch geladen.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'

let cache = null
export function useTeamHistory() {
  const [data, setData] = useState(cache)
  useEffect(() => {
    if (cache) { setData(cache); return }
    let cancelled = false
    fetch('/team-history.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { cache = json; if (!cancelled) setData(json) })
      .catch(() => { if (!cancelled) setData(null) })
    return () => { cancelled = true }
  }, [])
  return data // null = lädt noch (oder nicht verfügbar)
}

// Historie EINES Teams (chronologisch), oder [] falls nicht verfügbar.
export function getTeamSeasons(teamHistoryData, teamId) {
  return teamHistoryData?.teams?.[teamId]?.seasons || []
}

// Abgeleitete Pro-Spiel-Werte für eine Team-Saison - null statt NaN bei gp=0.
export function teamSeasonRates(s) {
  if (!s || s.gp <= 0) return { ptsPerGame: null, gfpg: null, gapg: null }
  return { ptsPerGame: s.pts / s.gp, gfpg: s.gf / s.gp, gapg: s.ga / s.gp }
}

// Letzte N Saisons mit gp>0 (chronologisch), für den historischen
// Teamvergleich (Abschnitt 10) und die Kurzreferenz in Offense/Defense
// (Abschnitt 3).
export function lastNSeasons(teamHistoryData, teamId, n = 3) {
  return getTeamSeasons(teamHistoryData, teamId).filter((s) => s.gp > 0).slice(-n)
}
