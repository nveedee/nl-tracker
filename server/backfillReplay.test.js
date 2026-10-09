// ---------------------------------------------------------------------------
// Tests für server/scripts/backfill-replay-timelines.cjs
//
// Isoliert in einem Temp-PERSIST_DIR, kein echter Netzwerkzugriff
// (sihfSync.fetchSihfGame wird überschrieben). Keine Produktionsdaten.
// Aufruf: node --test server/backfillReplay.test.js
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-backfill-'))
process.env.PERSIST_DIR = TMP
const DB = path.join(TMP, 'db.json')

const sihf = require('./scripts/sync-sihf.cjs')
const { runBackfill, findCandidates } = require('./scripts/backfill-replay-timelines.cjs')
const ORIG_FETCH = sihf.fetchSihfGame

const HOME = 102128
const AWAY = 103138

function rawReg() {
  return {
    status: { percent: 100, name: 'Ende', canceled: false },
    details: { homeTeam: { id: HOME, name: 'EHC Biel', acronym: 'BIE' }, awayTeam: { id: AWAY, name: 'Fribourg', acronym: 'FRI' } },
    result: {
      scores: [
        { name: '1. Drittel', indicator: '1', homeTeam: '2', awayTeam: '0' },
        { name: '2. Drittel', indicator: '2', homeTeam: '0', awayTeam: '1' },
        { name: '3. Drittel', indicator: '3', homeTeam: '1', awayTeam: '0' },
      ],
      sogs: [{ name: '1', indicator: '1', homeTeam: '10', awayTeam: '8' }],
    },
    summary: {
      periods: [
        { name: '1. Drittel', goals: [{ time: '05:10', teamId: HOME, text: 'A' }], fouls: [] },
        { name: '2. Drittel', goals: [{ time: '25:00', teamId: AWAY, text: 'B' }], fouls: [] },
        { name: '3. Drittel', goals: [{ time: '50:00', teamId: HOME, text: 'C' }], fouls: [] },
      ],
      shootout: { shoots: [] },
    },
    stats: [],
  }
}
function rawIncomplete() { const r = rawReg(); r.summary.periods = []; return r } // -> parseReplayTimeline unvollständig

function finalGame(id, overrides = {}) {
  return { id, date: '2026-09-15', status: 'final', decision: 'REG', homeTeamId: 'team_bie', awayTeamId: 'team_fri', homeGoals: 3, awayGoals: 1, externalId: 'EXT-' + id, sihfGameId: 'sihf-' + id, playerStats: [{ playerId: 'p', points: 1 }], ...overrides }
}
function writeDb(games, extra = {}) { fs.writeFileSync(DB, JSON.stringify({ settings: {}, teams: [{ id: 'team_bie' }], players: [], predictions: [{ gameId: 'x' }], games, ...extra })) }
function readDb() { return JSON.parse(fs.readFileSync(DB, 'utf-8')) }
function completeTimeline() { return sihf.parseReplayTimeline(rawReg()) }

test.afterEach(() => { sihf.fetchSihfGame = ORIG_FETCH })
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* egal */ } })

test('findCandidates: nur final + sihfGameId + unvollständige Timeline', () => {
  writeDb([
    finalGame('0001'),                                             // Kandidat (keine Timeline)
    finalGame('0002', { replayTimeline: completeTimeline() }),     // vollständig -> kein Kandidat
    finalGame('0003', { sihfGameId: null }),                       // keine sihfGameId -> kein Kandidat
    finalGame('0004', { status: 'scheduled' }),                    // nicht final -> kein Kandidat
    finalGame('0005', { replayTimeline: { bogus: true } }),        // ungültig/unvollständig -> Kandidat
  ])
  const ids = findCandidates(readDb()).map((g) => g.id).sort()
  assert.deepEqual(ids, ['0001', '0005'])
})

test('Dry-Run: verändert keine Daten und ruft SIHF nicht ab', async () => {
  writeDb([finalGame('0001'), finalGame('0002', { replayTimeline: completeTimeline() })])
  const before = fs.readFileSync(DB, 'utf-8')
  sihf.fetchSihfGame = async () => { throw new Error('Dry-Run darf nicht fetchen') }

  const r = await runBackfill({ write: false, log: () => {}, pauseMs: 0 })
  assert.equal(r.dryRun, true)
  assert.equal(r.candidates, 1) // nur game0001
  assert.equal(r.saved, 0)
  assert.equal(fs.readFileSync(DB, 'utf-8'), before, 'Dry-Run hat die DB verändert')
})

test('--write: ergänzt fehlende Timeline aus SIHF, lässt andere Felder unverändert', async () => {
  writeDb([finalGame('0001')])
  const before = readDb().games[0]
  sihf.fetchSihfGame = async () => ({ status: 200, json: rawReg() })

  const r = await runBackfill({ write: true, log: () => {}, pauseMs: 0 })
  assert.equal(r.saved, 1)
  const after = readDb().games[0]
  assert.ok(sihf.isReplayTimelineComplete(after.replayTimeline, 'REG'), 'Timeline nicht vollständig gespeichert')
  // Alle anderen Felder unverändert:
  for (const k of ['id', 'date', 'status', 'decision', 'homeGoals', 'awayGoals', 'externalId', 'sihfGameId']) {
    assert.deepEqual(after[k], before[k], `Feld ${k} wurde verändert`)
  }
  assert.deepEqual(after.playerStats, before.playerStats)
})

test('--write: unvollständige SIHF-Daten überschreiben nichts (kein Save)', async () => {
  writeDb([finalGame('0001')])
  const before = fs.readFileSync(DB, 'utf-8')
  sihf.fetchSihfGame = async () => ({ status: 200, json: rawIncomplete() })

  const r = await runBackfill({ write: true, log: () => {}, pauseMs: 0 })
  assert.equal(r.saved, 0)
  assert.equal(r.skipped, 1)
  assert.equal(fs.readFileSync(DB, 'utf-8'), before, 'DB trotz unvollständiger Daten verändert')
})

test('--write: Fehler bei einem Spiel blockiert die übrigen nicht', async () => {
  writeDb([finalGame('0001'), finalGame('0002')])
  sihf.fetchSihfGame = async (sihfGameId) => {
    if (sihfGameId === 'sihf-0001') throw new Error('network down')
    return { status: 200, json: rawReg() }
  }
  const r = await runBackfill({ write: true, log: () => {}, pauseMs: 0 })
  assert.equal(r.failed, 1)
  assert.equal(r.saved, 1)
  const games = readDb().games
  assert.ok(!sihf.isReplayTimelineComplete(games.find((g) => g.id === '0001').replayTimeline, 'REG'))
  assert.ok(sihf.isReplayTimelineComplete(games.find((g) => g.id === '0002').replayTimeline, 'REG'))
})

test('--write ist idempotent: zweiter Lauf findet keine Kandidaten mehr', async () => {
  writeDb([finalGame('0001')])
  sihf.fetchSihfGame = async () => ({ status: 200, json: rawReg() })

  const r1 = await runBackfill({ write: true, log: () => {}, pauseMs: 0 })
  assert.equal(r1.saved, 1)
  const afterFirst = fs.readFileSync(DB, 'utf-8')

  const r2 = await runBackfill({ write: true, log: () => {}, pauseMs: 0 })
  assert.equal(r2.candidates, 0)
  assert.equal(r2.saved, 0)
  assert.equal(fs.readFileSync(DB, 'utf-8'), afterFirst, 'zweiter Lauf hat die DB verändert')
})

test('bereits vollständige Timeline wird nie angefasst (kein Kandidat)', async () => {
  writeDb([finalGame('0002', { replayTimeline: completeTimeline() })])
  const before = fs.readFileSync(DB, 'utf-8')
  sihf.fetchSihfGame = async () => { throw new Error('sollte nicht aufgerufen werden') }
  const r = await runBackfill({ write: true, log: () => {}, pauseMs: 0 })
  assert.equal(r.candidates, 0)
  assert.equal(fs.readFileSync(DB, 'utf-8'), before)
})
