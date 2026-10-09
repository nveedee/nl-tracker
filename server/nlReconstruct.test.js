// ---------------------------------------------------------------------------
// Prüft, dass der NL-Sync aus einem FRISCHEN seed.json-Stand die Saison inkl.
// abgeschlossener Spiele rekonstruiert: syncGames() markiert Spiele, die die
// NL-API als "finished" meldet, als final (Resultat + externalId), und lässt
// offene Spiele scheduled. Reine Funktion, Fixture-Daten, KEIN Netzwerk, KEIN
// echter Sync. seed.json wird nur GELESEN (in-memory-Kopie), nie verändert.
//
// Aufruf: node --test server/nlReconstruct.test.js
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncGames } from './sync.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'seed.json'), 'utf-8'))

test('syncGames: aus seed.json werden von der API gemeldete Finals korrekt rekonstruiert, offene bleiben scheduled', () => {
  // In-memory-Kopie des Seeds (seed.json wird NICHT verändert).
  const db = structuredClone(SEED)
  assert.ok(db.games.length >= 2, 'Seed hat zu wenige Spiele für den Test')
  // Seed-Spiele sind scheduled und ohne externalId - genau der Zustand nach
  // einem frischen Start aus seed.json.
  assert.ok(db.games.every((g) => !g.externalId), 'Seed sollte keine externalId haben')

  const g0 = db.games[0] // soll final werden
  const g1 = db.games[1] // soll scheduled bleiben

  // Minimale, aber realistische teamMap (apiTeamId -> lokale Team-ID) für die
  // in den beiden Spielen vorkommenden Teams.
  const teamMap = {}
  const apiId = {}
  for (const tid of [g0.homeTeamId, g0.awayTeamId, g1.homeTeamId, g1.awayTeamId]) {
    const a = 'api_' + tid
    teamMap[a] = tid
    apiId[tid] = a
  }

  const apiGames = [
    { gameId: 'EXT-G0', date: g0.date, homeTeamId: apiId[g0.homeTeamId], awayTeamId: apiId[g0.awayTeamId], status: 'finished', homeTeamResult: 4, awayTeamResult: 1, isOvertime: false, isShootout: false },
    { gameId: 'EXT-G1', date: g1.date, homeTeamId: apiId[g1.homeTeamId], awayTeamId: apiId[g1.awayTeamId], status: 'scheduled' },
  ]

  const summary = syncGames(db, apiGames, teamMap, () => {})

  // API-Sicht: genau 1 final, 1 scheduled; beide bestehenden Spiele per
  // Datum/Teams verknüpft (kein Neuanlegen).
  assert.equal(summary.gamesFinal, 1)
  assert.equal(summary.gamesScheduled, 1)
  assert.equal(summary.gamesMatchedByDate, 2)
  assert.equal(summary.gamesCreated, 0)

  const after0 = db.games.find((x) => x.id === g0.id)
  assert.equal(after0.status, 'final', 'abgeschlossenes Spiel wurde nicht final')
  assert.equal(after0.homeGoals, 4)
  assert.equal(after0.awayGoals, 1)
  assert.equal(after0.decision, 'REG')
  assert.equal(after0.externalId, 'EXT-G0')

  const after1 = db.games.find((x) => x.id === g1.id)
  assert.equal(after1.status, 'scheduled', 'offenes Spiel sollte scheduled bleiben')
  assert.equal(after1.homeGoals, null)
  assert.equal(after1.externalId, 'EXT-G1')
})

test('syncGames: OT/SO-Entscheidung wird korrekt übernommen', () => {
  const db = structuredClone(SEED)
  const g = db.games[0]
  const teamMap = { ['api_' + g.homeTeamId]: g.homeTeamId, ['api_' + g.awayTeamId]: g.awayTeamId }
  const apiGames = [{ gameId: 'EXT-OT', date: g.date, homeTeamId: 'api_' + g.homeTeamId, awayTeamId: 'api_' + g.awayTeamId, status: 'finished', homeTeamResult: 2, awayTeamResult: 3, isOvertime: false, isShootout: true }]
  syncGames(db, apiGames, teamMap, () => {})
  const after = db.games.find((x) => x.id === g.id)
  assert.equal(after.status, 'final')
  assert.equal(after.decision, 'SO')
})
