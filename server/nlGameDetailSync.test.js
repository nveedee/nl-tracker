// ---------------------------------------------------------------------------
// Tests für server/nlGameDetailSync.js gegen einen echten, gespeicherten
// abgeschlossenen NL-Spieldatensatz (server/data/fixtures/nl-game-detail-
// sample.json, per curl von der öffentlichen API geladen - HC Lugano 6:3
// Genève-Servette HC, 15.9.2026, gameId 20271105000006). Kein Live-Request
// im Test (deterministisch, offline, gleiches Prinzip wie
// src/playoffSim.test.js mit server/data/seed.json).
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseAndMergeGameDetail } from './nlGameDetailSync.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(__dirname, 'data', 'fixtures', 'nl-game-detail-sample.json')
const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

// Baut eine minimale, aber vollständig zum Fixture passende Test-DB (Teams +
// Spieler mit `externalId` aus lineupHome/lineupAway, Spiel mit passender
// `externalId`) - dieselbe Struktur wie server/data/db.json, nur auf die
// zwei am Fixture beteiligten Teams reduziert.
function buildTestDb() {
  const homeTeam = { id: 'team_lug', name: 'HC Lugano', short: 'LUG', color: '#111827', externalId: String(raw.overview.homeTeamId) }
  const awayTeam = { id: 'team_gse', name: 'Genève-Servette HC', short: 'GSHC', color: '#8b1a1a', externalId: String(raw.overview.awayTeamId) }
  const posMap = { goalkeeper: 'G', defender: 'D', forwarder: 'F' }
  const players = []
  for (const [groups, teamId] of [[raw.lineupHome, homeTeam.id], [raw.lineupAway, awayTeam.id]]) {
    for (const group of groups) {
      for (const pl of group.players) {
        players.push({
          id: `player_${pl.playerId}`,
          name: `${pl.firstName} ${pl.lastName}`,
          position: posMap[pl.position] || 'F',
          teamId,
          externalId: String(pl.playerId),
        })
      }
    }
  }
  const game = {
    id: 'game_test_lug_gse',
    date: String(raw.overview.date).slice(0, 10),
    homeTeamId: homeTeam.id,
    awayTeamId: awayTeam.id,
    status: 'final',
    homeGoals: raw.overview.homeTeamResult,
    awayGoals: raw.overview.awayTeamResult,
    decision: raw.overview.isShootout ? 'SO' : raw.overview.isOvertime ? 'OT' : 'REG',
    playerStats: [],
    externalId: String(raw.overview.gameId),
  }
  return { db: { teams: [homeTeam, awayTeam], players, games: [game] }, game }
}

test('parseAndMergeGameDetail: Player Stats werden für beide Teams befüllt', () => {
  const { db, game } = buildTestDb()
  const summary = parseAndMergeGameDetail(db, game, raw, () => {})
  assert.ok(game.playerStats.length > 10, `erwartet >10 Spieler-Zeilen, erhalten ${game.playerStats.length}`)
  assert.equal(summary.unmatched, 0, 'alle Fixture-Spieler sollten über externalId matchen (Test-DB wurde aus demselben Fixture gebaut)')
})

test('parseAndMergeGameDetail: rohe Shot-Daten vorhanden (Punkt 5)', () => {
  const { db, game } = buildTestDb()
  parseAndMergeGameDetail(db, game, raw, () => {})
  assert.ok(game.nlShots.home.length > 0 && game.nlShots.away.length > 0)
  const shot = game.nlShots.home[0]
  for (const key of ['playerId', 'period', 'time', 'gameSecond', 'situation', 'type', 'x', 'y', 'xg', 'xgSum', 'videoTime', 'unix']) {
    assert.ok(key in shot, `Shot-Objekt sollte Feld "${key}" tragen`)
  }
  assert.ok(['GOAL', 'SOG', 'MISS', 'BLOCK'].includes(shot.type))
  assert.ok(['EQ', 'PP', 'PK'].includes(shot.situation))
})

test('parseAndMergeGameDetail: xG vorhanden (pro Spieler UND pro Schuss)', () => {
  const { db, game } = buildTestDb()
  parseAndMergeGameDetail(db, game, raw, () => {})
  const allShots = [...game.nlShots.home, ...game.nlShots.away]
  assert.ok(allShots.some((s) => s.xg != null && s.xg > 0), 'mindestens ein Schuss sollte einen xG-Wert > 0 haben')
  assert.ok(game.playerStats.some((s) => s.xg != null), 'mindestens ein Spieler sollte ein aggregiertes xG haben')
})

test('parseAndMergeGameDetail: Faceoffs vorhanden', () => {
  const { db, game } = buildTestDb()
  parseAndMergeGameDetail(db, game, raw, () => {})
  const withFaceoffs = game.playerStats.filter((s) => s.faceoffsTotal != null && s.faceoffsTotal > 0)
  assert.ok(withFaceoffs.length > 0)
  for (const s of withFaceoffs) {
    assert.equal(s.faceoffsWon + s.faceoffsLost, s.faceoffsTotal)
    assert.ok(s.faceoffPercentage == null || (s.faceoffPercentage >= 0 && s.faceoffPercentage <= 100))
  }
})

test('parseAndMergeGameDetail: TOI (gesamt + EQ/PP/PK) vorhanden', () => {
  const { db, game } = buildTestDb()
  parseAndMergeGameDetail(db, game, raw, () => {})
  const skater = game.playerStats.find((s) => s.toiPpSec != null && s.toiPpSec > 0)
  assert.ok(skater, 'mindestens ein Spieler sollte Powerplay-TOI > 0 haben')
  assert.ok(game.playerStats.some((s) => s.toiPkSec != null))
  assert.ok(game.playerStats.some((s) => s.toiEqSec != null))
})

test('parseAndMergeGameDetail: Goalie-Daten vorhanden', () => {
  const { db, game } = buildTestDb()
  parseAndMergeGameDetail(db, game, raw, () => {})
  const goalies = db.players.filter((p) => p.position === 'G').map((p) => p.id)
  const goalieStats = game.playerStats.filter((s) => goalies.includes(s.playerId) && s.shotsAgainst != null)
  assert.ok(goalieStats.length > 0)
  for (const s of goalieStats) {
    assert.ok(s.savePercentageNl == null || (s.savePercentageNl >= 0 && s.savePercentageNl <= 100))
  }
})

test('parseAndMergeGameDetail: additiver Merge - bestehende SIHF-Felder bleiben erhalten', () => {
  const { db, game } = buildTestDb()
  const somePlayerId = db.players.find((p) => p.position !== 'G').id
  // Simuliert einen bereits vom SIHF-Sync geschriebenen Eintrag - genau die
  // Felder, die server/scripts/sync-sihf.cjs für Feldspieler setzt.
  game.playerStats.push({ playerId: somePlayerId, goals: 2, assists: 1, plusMinus: -1, pim: 4, sog: 7, toiSec: 999 })

  parseAndMergeGameDetail(db, game, raw, () => {})

  const merged = game.playerStats.find((s) => s.playerId === somePlayerId)
  assert.equal(merged.goals, 2, 'SIHF goals darf nicht überschrieben werden')
  assert.equal(merged.assists, 1, 'SIHF assists darf nicht überschrieben werden')
  assert.equal(merged.plusMinus, -1, 'SIHF plusMinus darf nicht überschrieben werden')
  assert.equal(merged.pim, 4, 'SIHF pim darf nicht überschrieben werden')
  assert.equal(merged.sog, 7, 'SIHF sog darf nicht überschrieben werden')
  assert.equal(merged.toiSec, 999, 'SIHF toiSec darf nicht überschrieben werden')
  // Neue Felder sollten trotzdem ergänzt worden sein (additiv)
  assert.ok('faceoffsTotal' in merged || 'toiPpSec' in merged)
})

test('parseAndMergeGameDetail: Game-Winning-Goal wird genau einmal vergeben (nicht bei Shootout)', () => {
  const { db, game } = buildTestDb()
  parseAndMergeGameDetail(db, game, raw, () => {})
  const gwgCount = game.playerStats.filter((s) => s.gameWinningGoals === 1).length
  if (raw.overview.isShootout) {
    assert.equal(gwgCount, 0)
  } else {
    assert.equal(gwgCount, 1, 'bei einem Spiel mit klarem Sieger (kein Unentschieden) muss genau ein GWG vergeben werden')
  }
})

test('parseAndMergeGameDetail: wirft bei Team-Mismatch statt falsch zu mergen', () => {
  const { db, game } = buildTestDb()
  game.homeTeamId = 'team_dav' // absichtlich falsch
  assert.throws(() => parseAndMergeGameDetail(db, game, raw, () => {}))
})

test('parseAndMergeGameDetail: Aufruf ist idempotent (zweimaliges Mergen verdoppelt keine Summen-Felder)', () => {
  const { db, game } = buildTestDb()
  parseAndMergeGameDetail(db, game, raw, () => {})
  const xgAfterFirst = game.playerStats.find((s) => s.xg != null)?.xg
  const ppgAfterFirst = game.playerStats.find((s) => s.powerplayGoals)?.powerplayGoals
  parseAndMergeGameDetail(db, game, raw, () => {})
  const xgAfterSecond = game.playerStats.find((s) => s.xg != null)?.xg
  const ppgAfterSecond = game.playerStats.find((s) => s.powerplayGoals)?.powerplayGoals
  assert.equal(xgAfterSecond, xgAfterFirst, 'xg wird bei erneutem Merge neu gesetzt (nicht aufaddiert)')
  assert.equal(ppgAfterSecond, ppgAfterFirst, 'powerplayGoals wird bei erneutem Merge nicht verdoppelt')
})

test('parseAndMergeGameDetail: keine NaN/Infinity in den ergänzten Feldern', () => {
  const { db, game } = buildTestDb()
  parseAndMergeGameDetail(db, game, raw, () => {})
  for (const s of game.playerStats) {
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} auf Spieler ${s.playerId} ist ${v}`)
    }
  }
  for (const shot of [...game.nlShots.home, ...game.nlShots.away]) {
    for (const [k, v] of Object.entries(shot)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `Shot-Feld ${k} ist ${v}`)
    }
  }
})
