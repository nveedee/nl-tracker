// ---------------------------------------------------------------------------
// Regressionstests für den Startup-Race zwischen SIHF-Discover und NL-Sync
// (Incident: Discover schrieb am Ende seine minutenalte Voll-Kopie zurück und
// überschrieb zwischenzeitliche NL-Sync-Writes - Resultate/externalId/Finals).
//
// runDiscover() macht jetzt einen sicheren MERGE: es liest unmittelbar vor dem
// Schreiben die aktuelle db NEU ein und übernimmt NUR die neu gefundenen
// sihfGameId. Diese Tests simulieren einen gleichzeitigen NL-Sync-Write WÄHREND
// des Discover-Laufs (über das überschreibbare module.exports.fetchSihfGame)
// und prüfen, dass die NL-Daten erhalten bleiben und die IDs ergänzt werden.
//
// Vollständig isoliert in einem Temp-PERSIST_DIR - KEINE Produktionsdaten.
// Aufruf: node --test server/discoverMerge.test.js
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// PERSIST_DIR VOR dem Require setzen (DB_PATH ist eine Modul-Konstante).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-discover-'))
process.env.PERSIST_DIR = TMP
const DB = path.join(TMP, 'db.json')

const sihf = require('./scripts/sync-sihf.cjs')
const ORIG_FETCH = sihf.fetchSihfGame
// localTeamId -> sihfTeamId (Umkehr von SIHF_TO_TEAM_ID) für die Fake-Rohdaten.
const REV = Object.fromEntries(Object.entries(sihf.SIHF_TO_TEAM_ID).map(([sihfId, local]) => [local, Number(sihfId)]))

function writeDb(obj) { fs.writeFileSync(DB, JSON.stringify(obj)) }
function readDb() { return JSON.parse(fs.readFileSync(DB, 'utf-8')) }
function baseGame(id, date, home, away, extra = {}) {
  return { id, date, time: '19:45', homeTeamId: home, awayTeamId: away, status: 'scheduled', homeGoals: null, awayGoals: null, ...extra }
}
function rawFor(date, home, away) {
  return {
    status: { percent: 100, name: 'Ende' },
    startDateTime: `${date}T19:45:00`,
    details: { homeTeam: { id: REV[home] }, awayTeam: { id: REV[away] } },
    result: { homeTeam: '', awayTeam: '', scores: [], sogs: [] },
    summary: { periods: [] },
    stats: [],
  }
}

test.afterEach(() => { sihf.fetchSihfGame = ORIG_FETCH })
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* egal */ } })

test('Discover-Merge: gleichzeitiger NL-Sync-Write (Resultate/externalId/Finals/playerStats/predictions) bleibt erhalten, sihfGameId wird ergänzt', async () => {
  writeDb({ settings: {}, teams: [], players: [], predictions: [], games: [baseGame('g1', '2026-09-20', 'team_ajo', 'team_apk')] })
  const matchId = '20271105000001'
  sihf.fetchSihfGame = async (gameId) => {
    if (gameId === matchId) {
      // Simuliert: WÄHREND Discover läuft, schreibt der NL-Sync neue Daten.
      const db = readDb()
      Object.assign(db.games.find((g) => g.id === 'g1'), {
        status: 'final', homeGoals: 3, awayGoals: 2, decision: 'REG',
        externalId: 'EXT-1', sihfPeriods: [{ name: '1', home: 1, away: 0 }],
        playerStats: [{ playerId: 'p1', points: 2 }],
      })
      db.predictions = [{ gameId: 'g1', homeWinProbability: 0.5 }]
      writeDb(db)
      return { status: 200, json: rawFor('2026-09-20', 'team_ajo', 'team_apk') }
    }
    return { status: 404, json: null }
  }

  const r = await sihf.runDiscover({ write: true, log: () => {}, maxSeq: 20, seasonEndYear: 2027 })
  assert.equal(r.matched, 1)
  assert.equal(r.applied, 1)

  const g1 = readDb().games.find((g) => g.id === 'g1')
  assert.equal(g1.sihfGameId, matchId, 'sihfGameId wurde nicht ergänzt')
  // NL-Sync-Daten MÜSSEN erhalten geblieben sein (kein Clobber):
  assert.equal(g1.status, 'final')
  assert.equal(g1.homeGoals, 3)
  assert.equal(g1.awayGoals, 2)
  assert.equal(g1.decision, 'REG')
  assert.equal(g1.externalId, 'EXT-1')
  assert.ok(Array.isArray(g1.sihfPeriods) && g1.sihfPeriods.length === 1, 'sihfPeriods verloren')
  assert.ok(Array.isArray(g1.playerStats) && g1.playerStats.length === 1, 'playerStats verloren')
  assert.equal(readDb().predictions.length, 1, 'predictions verloren')
})

test('Discover-Merge: inzwischen anderweitig gesetzte sihfGameId wird NICHT überschrieben', async () => {
  writeDb({ settings: {}, teams: [], players: [], predictions: [], games: [baseGame('g1', '2026-09-21', 'team_scb', 'team_bie')] })
  const matchId = '20271105000001'
  sihf.fetchSihfGame = async (gameId) => {
    if (gameId === matchId) {
      const db = readDb()
      db.games.find((g) => g.id === 'g1').sihfGameId = 'OTHER-ID' // zwischenzeitlich anders gesetzt
      writeDb(db)
      return { status: 200, json: rawFor('2026-09-21', 'team_scb', 'team_bie') }
    }
    return { status: 404, json: null }
  }

  const r = await sihf.runDiscover({ write: true, log: () => {}, maxSeq: 20, seasonEndYear: 2027 })
  assert.equal(r.matched, 1)
  assert.equal(r.applied, 0, 'hätte die bestehende ID nicht überschreiben dürfen')
  assert.equal(readDb().games.find((g) => g.id === 'g1').sihfGameId, 'OTHER-ID')
})

test('Fehlgeschlagener Discover (fetch wirft) schreibt nicht und zerstört keine aktuellen Daten', async () => {
  const snapshot = {
    settings: { x: 1 }, teams: [{ id: 't' }], players: [], predictions: [{ gameId: 'g1' }],
    games: [baseGame('g1', '2026-09-22', 'team_fri', 'team_gse', { status: 'final', homeGoals: 5, awayGoals: 1, externalId: 'E', playerStats: [{ playerId: 'p' }] })],
  }
  writeDb(snapshot)
  sihf.fetchSihfGame = async () => { throw new Error('network down') }

  const r = await sihf.runDiscover({ write: true, log: () => {}, maxSeq: 20, seasonEndYear: 2027 })
  assert.equal(r.matched, 0)
  assert.equal(r.applied, 0)
  assert.deepEqual(readDb(), snapshot, 'db wurde trotz fehlgeschlagenem Discover verändert')
})

test('Discover ohne offene Spiele (alle sihfGameId gesetzt) kehrt früh zurück, kein Write', async () => {
  const snapshot = {
    settings: {}, teams: [], players: [], predictions: [],
    games: [baseGame('g1', '2026-09-23', 'team_lug', 'team_zsc', { sihfGameId: '20271105000099', status: 'final', homeGoals: 2, awayGoals: 1 })],
  }
  writeDb(snapshot)
  let called = false
  sihf.fetchSihfGame = async () => { called = true; return { status: 404, json: null } }

  const r = await sihf.runDiscover({ write: true, log: () => {}, maxSeq: 20, seasonEndYear: 2027 })
  assert.equal(r.matched, 0)
  assert.equal(called, false, 'fetch hätte gar nicht aufgerufen werden dürfen')
  assert.deepEqual(readDb(), snapshot)
})
