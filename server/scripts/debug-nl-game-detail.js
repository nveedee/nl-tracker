#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Debug-Ausgabe für EIN abgeschlossenes Spiel (Auftrag Punkt 14) - nutzt
// standardmässig das committete Fixture (server/data/fixtures/nl-game-
// detail-sample.json, siehe server/nlGameDetailSync.test.js), damit dieses
// Skript offline und ohne DB-Abhängigkeit läuft. Optional: ein echter,
// bereits synchronisierter lokaler Spiel-Datensatz aus server/data/db.json
// per --game <lokale-game-id>.
//
// Aufruf:
//   node server/scripts/debug-nl-game-detail.js                 (Fixture)
//   node server/scripts/debug-nl-game-detail.js --game <id>       (aus db.json)
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseAndMergeGameDetail } from '../nlGameDetailSync.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function fmtSec(v) {
  if (v == null) return '–'
  const t = Math.round(v)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
function fmtPct(v) { return v == null ? '–' : `${v.toFixed(1)}%` }
function fmt2(v) { return v == null ? '–' : v.toFixed(2) }

function printReport(db, game) {
  const home = db.teams.find((t) => t.id === game.homeTeamId)
  const away = db.teams.find((t) => t.id === game.awayTeamId)
  console.log('='.repeat(70))
  console.log(`GAME: ${home.name} ${game.homeGoals} : ${game.awayGoals} ${away.name}`)
  console.log('='.repeat(70))

  const rows = [...game.playerStats]
    .map((s) => ({ ...s, player: db.players.find((p) => p.id === s.playerId) }))
    .filter((r) => r.player)
    .sort((a, b) => (b.points || 0) - (a.points || 0))

  console.log('\nPLAYER STATS:')
  console.log('Name'.padEnd(24), 'G'.padStart(3), 'A'.padStart(3), 'P'.padStart(3), 'SOG'.padStart(4), 'TOI'.padStart(6), 'FO%'.padStart(7), 'BKS'.padStart(4), 'xG'.padStart(6))
  for (const r of rows.slice(0, 10)) {
    console.log(
      r.player.name.padEnd(24),
      String(r.goals ?? '–').padStart(3),
      String(r.assists ?? '–').padStart(3),
      String(r.points ?? '–').padStart(3),
      String(r.sog ?? '–').padStart(4),
      fmtSec(r.toiSec).padStart(6),
      fmtPct(r.faceoffPercentage).padStart(7),
      String(r.blockedShots ?? '–').padStart(4),
      fmt2(r.xg).padStart(6),
    )
  }
  console.log(`  … (${rows.length} Spieler insgesamt)`)

  const allShots = [...(game.nlShots?.home || []), ...(game.nlShots?.away || [])]
  const byType = (t) => allShots.filter((s) => s.type === t).length
  const totalXg = allShots.reduce((a, s) => a + (s.xg || 0), 0)
  console.log('\nSHOTS:')
  console.log(`  Anzahl: ${allShots.length}`)
  console.log(`  Goals: ${byType('GOAL')} · SOG: ${byType('SOG')} · Miss: ${byType('MISS')} · Block: ${byType('BLOCK')}`)
  console.log(`  Total xG: ${totalXg.toFixed(3)}`)

  const gwg = rows.find((r) => r.gameWinningGoals === 1)
  console.log(`\nGame Winning Goal: ${gwg ? gwg.player.name : 'n/a'}`)
  const ppScorers = rows.filter((r) => r.powerplayGoals > 0).map((r) => `${r.player.name} (${r.powerplayGoals})`)
  console.log(`Powerplay-Tore: ${ppScorers.length ? ppScorers.join(', ') : 'keine'}`)
  console.log()
}

async function main() {
  const args = process.argv.slice(2)
  const gameIdx = args.indexOf('--game')

  if (gameIdx === -1) {
    const fixturePath = path.join(__dirname, '..', 'data', 'fixtures', 'nl-game-detail-sample.json')
    const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'))
    // Minimal-DB analog server/nlGameDetailSync.test.js::buildTestDb()
    const homeTeam = { id: 'team_lug', name: raw.overview.homeTeamName, short: 'LUG', externalId: String(raw.overview.homeTeamId) }
    const awayTeam = { id: 'team_gse', name: raw.overview.awayTeamName, short: 'GSHC', externalId: String(raw.overview.awayTeamId) }
    const posMap = { goalkeeper: 'G', defender: 'D', forwarder: 'F' }
    const players = []
    for (const [groups, teamId] of [[raw.lineupHome, homeTeam.id], [raw.lineupAway, awayTeam.id]]) {
      for (const group of groups) {
        for (const pl of group.players) {
          players.push({ id: `player_${pl.playerId}`, name: `${pl.firstName} ${pl.lastName}`, position: posMap[pl.position] || 'F', teamId, externalId: String(pl.playerId) })
        }
      }
    }
    const db = { teams: [homeTeam, awayTeam], players, games: [] }
    const game = {
      id: 'game_debug_fixture', date: String(raw.overview.date).slice(0, 10),
      homeTeamId: homeTeam.id, awayTeamId: awayTeam.id, status: 'final',
      homeGoals: raw.overview.homeTeamResult, awayGoals: raw.overview.awayTeamResult,
      decision: raw.overview.isShootout ? 'SO' : raw.overview.isOvertime ? 'OT' : 'REG',
      playerStats: [], externalId: String(raw.overview.gameId),
    }
    console.log('(Quelle: server/data/fixtures/nl-game-detail-sample.json - offline, kein Netzwerkzugriff)\n')
    parseAndMergeGameDetail(db, game, raw, (...a) => console.log(...a))
    printReport(db, game)
  } else {
    const localGameId = args[gameIdx + 1]
    const dbPath = path.join(__dirname, '..', 'data', 'db.json')
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'))
    const game = db.games.find((g) => g.id === localGameId)
    if (!game) { console.error(`Spiel "${localGameId}" nicht gefunden.`); process.exitCode = 1; return }
    if (!game.nlDetailSyncedAt) { console.error(`Spiel "${localGameId}" hat noch keine NL-Game-Detail-Daten (nlDetailSyncedAt fehlt) - erst synchronisieren.`); process.exitCode = 1; return }
    printReport(db, game)
  }
}

main()
