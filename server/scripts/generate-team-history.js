// ---------------------------------------------------------------------------
// Einmalig auszuführendes Generierungs-Skript für die Team-Analytics-Ebene
// (TeamDetail.jsx, Abschnitt "Historischer Teamvergleich").
//
// Berechnet pro aktuell in der NL vertretenem Team und pro historischer
// Archiv-Saison (2017/18-2025/26): Spiele, Punkte, Tore, Gegentore, Rang
// (via der UNVERÄNDERTEN, produktiven computeStandings()-Funktion) sowie das
// Saisonend-ELO (via der UNVERÄNDERTEN, produktiven computeElo()-Funktion,
// exakt dieselbe volle Chronologie wie in generate-preseason-elo.js - hier
// zusätzlich der Zwischenstand nach JEDER Saison entnommen statt nur der
// allerletzte).
//
// Keine neue Formel, keine neuen Gewichtungen - reine Wiederverwendung von
// src/elo.js und src/stats.js. Verändert KEINE historischen Quelldaten, nur
// ein rein abgeleiteter, statischer Export für den Client
// (public/team-history.json).
//
// "Rang" = Tabellenplatz am Ende der jeweiligen Saison. WICHTIG (identischer
// Vorbehalt wie beim Player-History-Export): regulär Saison und Playoffs sind
// im Archiv nicht zuverlässig unterscheidbar - Saison-Totale (und damit auch
// der Rang) können Playoff-Spiele enthalten. Keine separate Playoff-Tabelle.
//
// Aufruf: node server/scripts/generate-team-history.js
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { computeElo } from '../../src/elo.js'
import { computeStandings } from '../../src/stats.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'historical')
const OUT_PATH = path.join(__dirname, '..', '..', 'public', 'team-history.json')

const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]

// Identische Tabelle wie generate-preseason-elo.js/generate-historical-h2h.js
// (bewusst dupliziert, damit dieses Skript unabhängig lauffähig bleibt).
const SIHF_TO_TEAM_ID = {
  103144: 'team_ajo', 101152: 'team_apk', 102126: 'team_scb', 102128: 'team_bie',
  101151: 'team_dav', 103138: 'team_fri', 103140: 'team_gse', 101149: 'team_klo',
  102127: 'team_scl', 103141: 'team_lau', 101150: 'team_lug', 101060: 'team_rap',
  101144: 'team_zug', 101139: 'team_zsc',
}

function main() {
  const games = []
  let skippedUnmapped = 0
  for (const f of SEASON_FILES) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8'))
    for (const g of raw.games) {
      const homeTeamId = SIHF_TO_TEAM_ID[g.homeTeam.sihfId]
      const awayTeamId = SIHF_TO_TEAM_ID[g.awayTeam.sihfId]
      if (!homeTeamId || !awayTeamId) { skippedUnmapped++; continue }
      games.push({
        id: `${f}_${games.length}`, date: g.date, season: g.season, status: 'final',
        homeTeamId, awayTeamId, homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision,
      })
    }
  }
  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const teams = Object.values(SIHF_TO_TEAM_ID).map((id) => ({ id }))
  const gameIdToSeason = new Map(games.map((g) => [g.id, g.season]))

  // ELO über die komplette Chronologie - unveränderte computeElo(), keine
  // settings-Overrides (identisch zu generate-preseason-elo.js).
  const { history } = computeElo(teams, games, {})

  // Saisonend-ELO = letzter history-Eintrag, dessen Spiel in diese Saison fällt.
  const eloEndBySeason = {}
  for (const t of teams) {
    eloEndBySeason[t.id] = {}
    for (const entry of history[t.id]) {
      if (!entry.gameId) continue
      const season = gameIdToSeason.get(entry.gameId)
      if (season) eloEndBySeason[t.id][season] = entry.rating
    }
  }

  const seasons = [...new Set(games.map((g) => g.season))].sort()
  const out = {
    generatedAt: new Date().toISOString(),
    seasonsIncluded: seasons,
    note: 'Saison-Totale (inkl. Rang) können Playoff-Spiele enthalten - regulär Saison/Playoffs sind im Archiv nicht zuverlässig unterscheidbar, siehe Bericht. Kein Wert erfunden.',
    teams: {},
  }
  for (const t of teams) out.teams[t.id] = { seasons: [] }

  for (const season of seasons) {
    const seasonGames = games.filter((g) => g.season === season)
    const standings = computeStandings(teams, seasonGames) // unveränderte Funktion, bereits nach Rang sortiert
    standings.forEach((row, i) => {
      out.teams[row.team.id].seasons.push({
        season, gp: row.gp, pts: row.pts, gf: row.gf, ga: row.ga, rank: i + 1,
        eloEnd: eloEndBySeason[row.team.id]?.[season] != null ? Math.round(eloEndBySeason[row.team.id][season] * 10) / 10 : null,
      })
    })
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))
  console.log(`Geschrieben: ${OUT_PATH}`)
  console.log(`Spiele verarbeitet: ${games.length} (übersprungen, nicht mehr in der NL: ${skippedUnmapped})`)
  console.log(`Teams: ${teams.length}, Saisons: ${seasons.length}`)
}

main()
