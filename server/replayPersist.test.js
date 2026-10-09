// ---------------------------------------------------------------------------
// Tests für Option A: persistierte Replay-Timeline + Bevorzugung gespeicherter
// Daten in server/liveReplay.js (kein SIHF-Abruf, wenn gespeichert), inkl.
// Fallback, Nicht-Überschreiben vollständiger Daten und OT/SO.
//
// Isoliert, kein echter Netzwerkzugriff: sihfSync.fetchSihfGame wird gezielt
// überschrieben (gleiches Muster wie liveSync/liveReplay-Tests).
// Aufruf: node --test server/replayPersist.test.js
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import sihfSync from './scripts/sync-sihf.cjs'
import { buildRealGameReplayTimeline, buildRealGameReplayState, _resetRealGameCacheForTests } from './liveReplay.js'

const require = createRequire(import.meta.url)
const sihf = require('./scripts/sync-sihf.cjs')
const { parseReplayTimeline, isReplayTimelineComplete, saveReplayTimelineIfBetter } = sihf

const HOME = 102128 // team_bie
const AWAY = 103138 // team_fri

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
      sogs: [
        { name: '1', indicator: '1', homeTeam: '10', awayTeam: '8' },
        { name: '2', indicator: '2', homeTeam: '9', awayTeam: '11' },
        { name: '3', indicator: '3', homeTeam: '12', awayTeam: '7' },
      ],
    },
    summary: {
      periods: [
        { name: '1. Drittel', goals: [{ time: '05:10', teamId: HOME, text: 'A' }, { time: '17:42', teamId: HOME, text: 'B' }], fouls: [{ time: '10:00', minutes: 2, teamId: AWAY, text: 'Halten' }] },
        { name: '2. Drittel', goals: [{ time: '25:00', teamId: AWAY, text: 'C' }], fouls: [] },
        { name: '3. Drittel', goals: [{ time: '50:00', teamId: HOME, text: 'D' }], fouls: [] },
      ],
      shootout: { shoots: [] },
    },
    stats: [],
  }
}

function rawSo() {
  const r = rawReg()
  // Regulation 2:2, dann OT-Periode (0:0) und Shootout-Entscheid.
  r.result.scores = [
    { name: '1. Drittel', indicator: '1', homeTeam: '1', awayTeam: '1' },
    { name: '2. Drittel', indicator: '2', homeTeam: '1', awayTeam: '0' },
    { name: '3. Drittel', indicator: '3', homeTeam: '0', awayTeam: '1' },
    { name: 'Overtime', indicator: '4', homeTeam: '0', awayTeam: '0' },
  ]
  r.summary.periods = [
    { name: '1. Drittel', goals: [{ time: '05:00', teamId: HOME, text: 'A' }, { time: '12:00', teamId: AWAY, text: 'B' }], fouls: [] },
    { name: '2. Drittel', goals: [{ time: '25:00', teamId: HOME, text: 'C' }], fouls: [] },
    { name: '3. Drittel', goals: [{ time: '50:00', teamId: AWAY, text: 'D' }], fouls: [] },
    { name: 'Overtime', goals: [], fouls: [] },
  ]
  r.summary.shootout = { shoots: [{ player: 'X', scored: true }, { player: 'Y', scored: false }] }
  return r
}

function localGame(overrides = {}) {
  return { id: 'game_2026-09-15_bie_fri', sihfGameId: '20271105000002', status: 'final', decision: 'REG', date: '2026-09-15', homeTeamId: 'team_bie', awayTeamId: 'team_fri', ...overrides }
}

// --- parseReplayTimeline / isReplayTimelineComplete -------------------------
test('parseReplayTimeline: extrahiert Perioden/Shots/Events/Teams aus dem SIHF-Raw (REG)', () => {
  const tl = parseReplayTimeline(rawReg())
  assert.equal(tl.homeTeam.sihfId, HOME)
  assert.equal(tl.awayTeam.sihfId, AWAY)
  assert.equal(tl.periods.length, 3)
  assert.equal(tl.events.length, 3)
  assert.equal(tl.events[0].goals.length, 2)
  assert.equal(tl.events[0].fouls.length, 1)
  assert.ok(isReplayTimelineComplete(tl, 'REG'))
})

test('isReplayTimelineComplete: SO verlangt Shootout-Einträge', () => {
  assert.ok(isReplayTimelineComplete(parseReplayTimeline(rawSo()), 'SO'))
  const noShoot = parseReplayTimeline(rawReg()) // shootout null
  assert.equal(isReplayTimelineComplete(noShoot, 'SO'), false)
  assert.equal(isReplayTimelineComplete(null, 'REG'), false)
  assert.equal(isReplayTimelineComplete({ homeTeam: { sihfId: 1 }, awayTeam: { sihfId: 2 }, periods: [], events: [] }, 'REG'), false)
})

// --- saveReplayTimelineIfBetter (nicht-klobbernd) ---------------------------
test('saveReplayTimelineIfBetter: speichert, wenn noch keine vorhanden', () => {
  const g = localGame()
  assert.equal(saveReplayTimelineIfBetter(g, rawReg(), 'REG'), true)
  assert.ok(isReplayTimelineComplete(g.replayTimeline, 'REG'))
})

test('saveReplayTimelineIfBetter: unvollständiger späterer Sync ersetzt vollständige NICHT', () => {
  const g = localGame()
  saveReplayTimelineIfBetter(g, rawReg(), 'REG')
  const before = g.replayTimeline
  // Späterer Raw ohne summary.periods -> parseReplayTimeline unvollständig.
  const incomplete = rawReg(); incomplete.summary.periods = []
  assert.equal(saveReplayTimelineIfBetter(g, incomplete, 'REG'), false)
  assert.equal(g.replayTimeline, before, 'vollständige Timeline wurde überschrieben')
})

test('saveReplayTimelineIfBetter: bereits vollständige wird nicht unnötig überschrieben', () => {
  const g = localGame()
  saveReplayTimelineIfBetter(g, rawReg(), 'REG')
  const before = g.replayTimeline
  assert.equal(saveReplayTimelineIfBetter(g, rawReg(), 'REG'), false)
  assert.equal(g.replayTimeline, before)
})

test('saveReplayTimelineIfBetter: unvollständiger Raw wird gar nicht gespeichert', () => {
  const g = localGame()
  const incomplete = rawReg(); incomplete.summary.periods = []
  assert.equal(saveReplayTimelineIfBetter(g, incomplete, 'REG'), false)
  assert.equal(g.replayTimeline, undefined)
})

// --- liveReplay: gespeicherte Daten bevorzugt (KEIN SIHF-Abruf) -------------
test('buildRealGameReplayTimeline: nutzt gespeicherte Timeline ohne SIHF-Abruf', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => { throw new Error('FETCH SOLLTE NICHT AUFGERUFEN WERDEN') }
  t.after(() => { sihfSync.fetchSihfGame = original })

  const g = localGame({ replayTimeline: parseReplayTimeline(rawReg()) })
  const r = await buildRealGameReplayTimeline(g, { log: () => {}, stepSeconds: 60 })
  assert.ok(Array.isArray(r.points) && r.points.length > 0)
  assert.ok(r.finalState)
  assert.equal(r.finalState.homeGoals, 3)
  assert.equal(r.finalState.awayGoals, 1)
})

test('buildRealGameReplayState: gespeicherte Timeline, Score summiert korrekt ohne Fetch', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => { throw new Error('kein Fetch erlaubt') }
  t.after(() => { sihfSync.fetchSihfGame = original })

  const g = localGame({ replayTimeline: parseReplayTimeline(rawReg()) })
  const at0 = await buildRealGameReplayState(g, 0)
  assert.equal(at0.homeGoals, 0)
  const afterFirst = await buildRealGameReplayState(g, 5 * 60 + 30) // nach 05:10
  assert.equal(afterFirst.homeGoals, 1)
})

// --- liveReplay: Fallback auf SIHF, wenn nichts (oder Ungültiges) gespeichert
test('buildRealGameReplayTimeline: Fallback auf SIHF, wenn keine Timeline gespeichert', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  let fetched = false
  sihfSync.fetchSihfGame = async () => { fetched = true; return { status: 200, json: rawReg() } }
  t.after(() => { sihfSync.fetchSihfGame = original })

  const g = localGame() // keine replayTimeline
  const r = await buildRealGameReplayTimeline(g, { log: () => {}, stepSeconds: 60 })
  assert.equal(fetched, true, 'SIHF-Fallback wurde nicht genutzt')
  assert.ok(r.points.length > 0)
})

test('buildRealGameReplayTimeline: ungültige gespeicherte Timeline -> Fallback auf SIHF', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  let fetched = false
  sihfSync.fetchSihfGame = async () => { fetched = true; return { status: 200, json: rawReg() } }
  t.after(() => { sihfSync.fetchSihfGame = original })

  const g = localGame({ replayTimeline: { bogus: true } })
  const r = await buildRealGameReplayTimeline(g, { log: () => {}, stepSeconds: 60 })
  assert.equal(fetched, true)
  assert.ok(r.points.length > 0)
})

test('buildRealGameReplayTimeline: ungültige Timeline UND keine sihfGameId -> klarer Fehler', async () => {
  const g = localGame({ replayTimeline: { bogus: true }, sihfGameId: null })
  await assert.rejects(() => buildRealGameReplayTimeline(g, { log: () => {}, stepSeconds: 60 }), /keine sihfGameId/)
})

// --- OT/SO aus gespeicherten Daten ------------------------------------------
test('buildRealGameReplayTimeline: OT/SO-Spiel aus gespeicherter Timeline (Phase SO am Ende)', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => { throw new Error('kein Fetch erlaubt') }
  t.after(() => { sihfSync.fetchSihfGame = original })

  const g = localGame({ decision: 'SO', replayTimeline: parseReplayTimeline(rawSo()) })
  const r = await buildRealGameReplayTimeline(g, { log: () => {}, stepSeconds: 60 })
  assert.ok(r.points.length > 0)
  assert.equal(r.finalState.phase, 'SO')
})
