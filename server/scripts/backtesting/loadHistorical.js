// ---------------------------------------------------------------------------
// Lädt und normalisiert die historischen Archiv-Saisons
// (server/data/historical/*.json) zu einem flachen, chronologisch
// sortierten Spiele-Array für den Walk-Forward-Backtest.
//
// Read-only: rührt die Rohdaten unter server/data/historical/ nicht an.
//
// Team-Identität: die rohe SIHF-ID (Zahl) wird direkt als Team-Key verwendet
// - KEIN Mapping auf unsere produktiven team_xxx-IDs nötig, da der Backtest
// vollständig unabhängig vom aktuellen Kader/db.json arbeitet (die Namen für
// die Anzeige kommen direkt aus den Spieldaten selbst, siehe buildTeamNames()).
//
// SOG-Allowed (siehe src/playoffSim.js::computeSogAllowedStats, dort NUR aus
// games[].playerStats[]-Einträgen der Torhüter summiert): die historischen
// Archivdaten liefern dieselbe Grösse direkt pro Spiel/Team vor-aggregiert
// unter game.goalies.{home,away}[].shotsAgainst - hier 1:1 pro Team
// aufsummiert (saves+goalsAgainst je Torhüter-Eintrag), exakt dieselbe
// Definition wie produktiv, nur bereits vom SIHF-Export vorgerechnet.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'historical')

export const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]

// Corona-Saisons: identische Definition wie server/scripts/backtest-elo.js
// und server/scripts/backtest-preseason-h2h.js (verkürzte/deformierte
// Spielpläne, 2019/20 vorzeitig abgebrochen, 2020/21 mit Sonderformat) -
// konsistent aus den bestehenden Analysen übernommen, nicht neu erfunden.
export const CORONA_SEASONS = new Set(['2019/20', '2020/21'])

function num(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

// Summe shotsAgainst über alle Torhüter-Einträge eines Teams in einem Spiel
// (mehrere Einträge bei Torhüterwechsel) - identische Definition wie
// src/playoffSim.js::computeSogAllowedStats (saves+goalsAgainst je Eintrag).
function sumShotsAgainst(goalieEntries) {
  if (!Array.isArray(goalieEntries)) return 0
  return goalieEntries.reduce((s, g) => s + num(g.saves) + num(g.goalsAgainst), 0)
}

// Lädt alle 9 Archiv-Saisons, gibt ein flaches, chronologisch sortiertes
// Array zurück. Jedes Element trägt eine STABILE, eindeutige `id` (für die
// ELO-History-Verknüpfung, siehe predictors.js) sowie alle Felder, die vor
// Spielbeginn bekannt waren (keine zukünftigen/Endergebnis-Infos ausser den
// für die Auswertung nötigen homeGoals/awayGoals/decision selbst, die im
// Backtest-Loop erst NACH der Prognose gelesen werden dürfen).
export function loadHistoricalGames() {
  const games = []
  const teamNames = new Map() // sihfId -> { name, acronym }
  let skippedNoDecision = 0

  for (const f of SEASON_FILES) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8'))
    for (const g of raw.games) {
      if (g.homeGoals == null || g.awayGoals == null || !g.decision) { skippedNoDecision++; continue }

      teamNames.set(g.homeTeam.sihfId, { name: g.homeTeam.name, acronym: g.homeTeam.acronym })
      teamNames.set(g.awayTeam.sihfId, { name: g.awayTeam.name, acronym: g.awayTeam.acronym })

      games.push({
        id: `${f}_${games.length}`,
        season: g.season,
        seasonEndYear: g.seasonEndYear,
        corona: CORONA_SEASONS.has(g.season),
        date: g.date,
        dt: g.startDateTime || g.date,
        gameId: g.gameId,
        homeTeamId: g.homeTeam.sihfId,
        awayTeamId: g.awayTeam.sihfId,
        homeGoals: g.homeGoals,
        awayGoals: g.awayGoals,
        decision: g.decision, // REG | OT | SO
        // shotsAgainst je Torhüter-Eintrag DES Teams selbst = Schüsse, die
        // GEGEN dieses Team abgegeben wurden -> "SOG allowed" dieses Teams.
        sogAllowedHome: sumShotsAgainst(g.goalies && g.goalies.home),
        sogAllowedAway: sumShotsAgainst(g.goalies && g.goalies.away),
      })
    }
  }

  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  games.forEach((g, i) => { g.__idx = i })

  return { games, teamNames, skippedNoDecision }
}

export function teamLabel(teamNames, sihfId) {
  const t = teamNames.get(sihfId)
  return t ? t.acronym || t.name : String(sihfId)
}

export function seasonList(games) {
  return [...new Set(games.map((g) => g.season))].sort()
}
