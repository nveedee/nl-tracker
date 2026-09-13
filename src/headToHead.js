// ---------------------------------------------------------------------------
// Hilfsfunktionen für die Head-to-Head-Seite (src/pages/HeadToHead.jsx).
// Reine Datenauswertung - keine Prognosemodelle, keine erfundenen Werte.
// Verwendet ausschliesslich tatsächlich vorhandene Spiele (aktuelle Saison
// aus data.games + optional historische Duelle aus public/historical-h2h.json,
// generiert von server/scripts/generate-historical-h2h.js).
// ---------------------------------------------------------------------------

import { useState, useEffect } from 'react'
import { isFinalGame } from './stats.js'

// Historische Duelle sind ein statischer, aus den unveränderten historischen
// SIHF-Daten generierter Export (server/scripts/generate-historical-h2h.js),
// lazy per fetch geladen (nicht in den Haupt-Bundle gepackt). Von mehreren
// Seiten (HeadToHead, MatchupDetail) gemeinsam genutzt, statt erneut zu
// importieren/laden.
export function useHistoricalH2H() {
  const [historical, setHistorical] = useState(null) // null = lädt noch
  useEffect(() => {
    let cancelled = false
    fetch('/historical-h2h.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((json) => { if (!cancelled) setHistorical(json) })
      .catch(() => { if (!cancelled) setHistorical([]) })
    return () => { cancelled = true }
  }, [])
  return historical
}

function isPair(g, id1, id2) {
  return (g.homeTeamId === id1 && g.awayTeamId === id2) || (g.homeTeamId === id2 && g.awayTeamId === id1)
}

// Alle direkten Duelle zwischen zwei Teams: aktuelle Saison (bereits
// gespielte Partien) + historische Duelle (falls vorhanden), chronologisch
// sortiert. Jedes Spiel wird mit `isCurrentSeason` markiert.
export function mergeMatchups(team1Id, team2Id, currentGames, historicalGames) {
  const current = (currentGames || [])
    .filter(isFinalGame)
    .filter((g) => isPair(g, team1Id, team2Id))
    .map((g) => ({
      date: g.date,
      season: null,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      homeGoals: g.homeGoals,
      awayGoals: g.awayGoals,
      decision: g.decision,
      isCurrentSeason: true,
    }))
  const historical = (historicalGames || [])
    .filter((g) => isPair(g, team1Id, team2Id))
    .map((g) => ({ ...g, isCurrentSeason: false }))

  return [...historical, ...current].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

// Bilanz aus Sicht von `teamId` über eine beliebige Spieleliste (teamId muss
// in jedem Spiel Heim- oder Auswärtsteam sein). OT und SO werden getrennt
// ausgewiesen.
export function summarizeRecord(teamId, games) {
  let w = 0, otw = 0, sow = 0, l = 0, otl = 0, sol = 0, gf = 0, ga = 0
  for (const g of games) {
    const isHome = g.homeTeamId === teamId
    const myGoals = isHome ? g.homeGoals : g.awayGoals
    const oppGoals = isHome ? g.awayGoals : g.homeGoals
    gf += myGoals
    ga += oppGoals
    const won = myGoals > oppGoals
    if (g.decision === 'SO') { won ? sow++ : sol++ }
    else if (g.decision === 'OT') { won ? otw++ : otl++ }
    else { won ? w++ : l++ }
  }
  const gp = games.length
  const pts = w * 3 + (otw + sow) * 2 + (otl + sol) * 1
  return {
    gp, w, otw, sow, l, otl, sol, gf, ga, pts,
    wins: w + otw + sow,
    losses: l + otl + sol,
    winRate: gp > 0 ? (w + otw + sow) / gp : null,
    avgGf: gp > 0 ? gf / gp : null,
    avgGa: gp > 0 ? ga / gp : null,
    avgDiff: gp > 0 ? (gf - ga) / gp : null,
  }
}

// Heim/Auswärts-Split: Bilanz von team1 NUR aus Spielen, in denen team1
// Heimteam war, und von team2 NUR aus Spielen, in denen team2 Heimteam war.
export function summarizeHomeAway(team1Id, team2Id, games) {
  const team1AtHome = games.filter((g) => g.homeTeamId === team1Id)
  const team2AtHome = games.filter((g) => g.homeTeamId === team2Id)
  return {
    team1AtHome: summarizeRecord(team1Id, team1AtHome),
    team2AtHome: summarizeRecord(team2Id, team2AtHome),
  }
}

// Letzte N Spiele EINES Teams (unabhängig vom Gegner), aus aktuellen +
// historischen Daten kombiniert. `recent[0]` ist das jüngste Spiel.
export function computeRecentFormDetailed(teamId, currentGames, historicalGames, n = 5) {
  const current = (currentGames || [])
    .filter(isFinalGame)
    .filter((g) => g.homeTeamId === teamId || g.awayTeamId === teamId)
    .map((g) => ({
      date: g.date, homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId,
      homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision,
    }))
  const historical = (historicalGames || [])
    .filter((g) => g.homeTeamId === teamId || g.awayTeamId === teamId)

  const all = [...historical, ...current].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const recent = all.slice(-n).reverse()
  const summary = summarizeRecord(teamId, recent)

  const letters = recent.map((g) => {
    const isHome = g.homeTeamId === teamId
    const won = (isHome ? g.homeGoals : g.awayGoals) > (isHome ? g.awayGoals : g.homeGoals)
    if (g.decision === 'SO') return won ? 'SOS' : 'SON'
    if (g.decision === 'OT') return won ? 'OTS' : 'OTN'
    return won ? 'S' : 'N'
  })

  return { ...summary, letters, games: recent, totalGamesAvailable: all.length }
}

// Zugelassene Schüsse/Spiel aus Torhüter-Einträgen in playerStats - rein
// deskriptiver Rohwert (keine Adjustierung/Prognose), gleiche Grundlage wie
// in src/powerRankings.js / src/playoffSim.js, hier dupliziert um diese
// Dateien nicht anfassen zu müssen. Liefert `null`, wenn keine Daten vorhanden
// sind (aktuell z.B. eine Saison ohne erfasste Torhüter-Statistiken).
export function computeShotsAllowedPerGame(teamId, games, players) {
  const goalieIds = new Set(
    (players || []).filter((p) => p.teamId === teamId && p.position === 'G').map((p) => p.id)
  )
  if (goalieIds.size === 0) return null

  let gp = 0
  let shotsAgainst = 0
  for (const g of (games || []).filter(isFinalGame)) {
    if (g.homeTeamId !== teamId && g.awayTeamId !== teamId) continue
    let gameShotsAgainst = 0
    for (const s of g.playerStats || []) {
      if (goalieIds.has(s.playerId)) {
        gameShotsAgainst += (Number(s.saves) || 0) + (Number(s.goalsAgainst) || 0)
      }
    }
    if (gameShotsAgainst > 0) {
      gp++
      shotsAgainst += gameShotsAgainst
    }
  }
  return gp > 0 ? shotsAgainst / gp : null
}
