// ---------------------------------------------------------------------------
// Tests für die Live-Anbindung: server/scripts/sync-sihf.cjs::parseLiveSnapshot
// (reine Parsing-Funktion, synthetische SIHF-Fixtures - kein Netzwerk nötig)
// sowie server/liveSync.js::pollLiveGames (In-Flight-Lock, API-Ausfall/Retry,
// Cache-Verhalten bei Spielende) über sihfSync.fetchSihfGame-Fakes.
//
// Aufruf: node --test server/liveSync.test.js
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'

import sihfSync from './scripts/sync-sihf.cjs'
import { pollLiveGames, getLiveState, _resetForTests } from './liveSync.js'

const { parseLiveSnapshot, SIHF_TO_TEAM_ID } = sihfSync
const HOME_SIHF_ID = 103144 // team_ajo
const AWAY_SIHF_ID = 101152 // team_apk

function baseRaw({ percent = 0, name = 'Geplant', canceled = false } = {}) {
  return {
    status: { percent, name, canceled },
    details: {
      homeTeam: { id: HOME_SIHF_ID, name: 'HC Ajoie' },
      awayTeam: { id: AWAY_SIHF_ID, name: 'SC Rapperswil-Jona Lakers' },
    },
    result: { homeTeam: '', awayTeam: '', scores: [], sogs: [] },
    summary: { periods: [] },
    stats: [],
  }
}

test('parseLiveSnapshot: 0:0 vor Spielbeginn -> status scheduled', () => {
  const snap = parseLiveSnapshot(baseRaw())
  assert.equal(snap.status, 'scheduled')
  assert.equal(snap.homeGoals, 0)
  assert.equal(snap.awayGoals, 0)
  assert.equal(snap.phase, 'REG')
})

test('parseLiveSnapshot: 0:0 laufendes Spiel -> status live', () => {
  const raw = baseRaw({ percent: 5, name: '1. Drittel' })
  const snap = parseLiveSnapshot(raw)
  assert.equal(snap.status, 'live')
  assert.equal(snap.statusLabel, '1. Drittel')
  assert.equal(snap.homeGoals, 0)
  assert.equal(snap.awayGoals, 0)
})

test('parseLiveSnapshot: einzelnes Goal-Event wird gezählt und dem richtigen Team zugeordnet', () => {
  const raw = baseRaw({ percent: 20, name: '1. Drittel' })
  raw.result.homeTeam = '1'
  raw.result.awayTeam = '0'
  raw.summary.periods = [{ name: '1. Drittel', goals: [{ time: '05:12', teamId: HOME_SIHF_ID, text: 'Fritsche' }], fouls: [] }]
  const snap = parseLiveSnapshot(raw)
  assert.equal(snap.homeGoals, 1)
  assert.equal(snap.awayGoals, 0)
  assert.equal(snap.goals.length, 1)
  assert.equal(snap.goals[0].teamId, SIHF_TO_TEAM_ID[HOME_SIHF_ID])
  assert.equal(snap.goals[0].time, '05:12')
})

test('parseLiveSnapshot: mehrere Goals über mehrere Perioden bleiben chronologisch und vollständig', () => {
  const raw = baseRaw({ percent: 55, name: '2. Drittel' })
  raw.result.homeTeam = '2'
  raw.result.awayTeam = '1'
  raw.result.scores = [
    { name: '1. Drittel', indicator: '1', homeTeam: '1', awayTeam: '1' },
    { name: '2. Drittel', indicator: '2', homeTeam: '1', awayTeam: '0' },
  ]
  raw.summary.periods = [
    { name: '1. Drittel', goals: [{ time: '05:12', teamId: HOME_SIHF_ID, text: 'A' }, { time: '18:40', teamId: AWAY_SIHF_ID, text: 'B' }], fouls: [] },
    { name: '2. Drittel', goals: [{ time: '25:03', teamId: HOME_SIHF_ID, text: 'C' }], fouls: [] },
  ]
  const snap = parseLiveSnapshot(raw)
  assert.equal(snap.homeGoals, 2)
  assert.equal(snap.awayGoals, 1)
  assert.equal(snap.goals.length, 3)
  assert.equal(snap.periods.length, 2) // Periodenwechsel: zweite Periode jetzt in result.scores sichtbar
})

test('parseLiveSnapshot: Penalty wird mit Zeit/Team/Minuten geparst', () => {
  const raw = baseRaw({ percent: 30, name: '1. Drittel' })
  raw.summary.periods = [{ name: '1. Drittel', goals: [], fouls: [{ time: '10:00', minutes: 2, teamId: AWAY_SIHF_ID, text: 'Halten' }] }]
  const snap = parseLiveSnapshot(raw)
  assert.equal(snap.penalties.length, 1)
  assert.equal(snap.penalties[0].teamId, SIHF_TO_TEAM_ID[AWAY_SIHF_ID])
  assert.equal(snap.penalties[0].minutes, 2)
})

test('parseLiveSnapshot: Spielende -> status final', () => {
  const raw = baseRaw({ percent: 100, name: 'Ende' })
  raw.result.homeTeam = '3'
  raw.result.awayTeam = '2'
  raw.result.scores = [
    { name: '1. Drittel', homeTeam: '1', awayTeam: '1' },
    { name: '2. Drittel', homeTeam: '1', awayTeam: '0' },
    { name: '3. Drittel', homeTeam: '1', awayTeam: '1' },
  ]
  const snap = parseLiveSnapshot(raw)
  assert.equal(snap.status, 'final')
  assert.equal(snap.homeGoals, 3)
  assert.equal(snap.awayGoals, 2)
})

test('parseLiveSnapshot: Overtime (4. Periodeneintrag) -> phase OT', () => {
  const raw = baseRaw({ percent: 90, name: 'Overtime' })
  raw.result.scores = [
    { name: '1. Drittel', homeTeam: '1', awayTeam: '1' },
    { name: '2. Drittel', homeTeam: '0', awayTeam: '0' },
    { name: '3. Drittel', homeTeam: '1', awayTeam: '1' },
    { name: 'OT', homeTeam: '0', awayTeam: '0' },
  ]
  const snap = parseLiveSnapshot(raw)
  assert.equal(snap.phase, 'OT')
})

test('parseLiveSnapshot: Shootout-Einträge -> phase SO (unabhängig von der Periodenzahl)', () => {
  const raw = baseRaw({ percent: 95, name: 'Penaltyschiessen' })
  raw.summary.shootout = { shoots: [{ teamId: HOME_SIHF_ID, scored: true }] }
  const snap = parseLiveSnapshot(raw)
  assert.equal(snap.phase, 'SO')
})

test('parseLiveSnapshot: abgesagtes Spiel -> status scheduled, nicht live', () => {
  const raw = baseRaw({ percent: 0, name: 'Abgesagt', canceled: true })
  const snap = parseLiveSnapshot(raw)
  assert.equal(snap.status, 'scheduled')
})

// ---------------------------------------------------------------------------
// pollLiveGames: In-Flight-Lock, API-Ausfall, Cache-Räumung bei Spielende.
// ---------------------------------------------------------------------------

function makeGame(overrides = {}) {
  return { id: 'game_test_1', sihfGameId: '20271105000001', status: 'scheduled', date: '2026-09-16', time: '19:45', ...overrides }
}

test('pollLiveGames: aktualisiert den Cache mit einem gültigen Live-Snapshot', async (t) => {
  _resetForTests()
  const originalFetch = sihfSync.fetchSihfGame
  const raw = baseRaw({ percent: 10, name: '1. Drittel' })
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: raw })
  t.after(() => { sihfSync.fetchSihfGame = originalFetch })

  const game = makeGame()
  const now = new Date(`${game.date}T20:00:00`) // 15 Min nach Anpfiff -> Kandidat
  await pollLiveGames({ games: [game] }, { now })
  const state = getLiveState(game.id)
  assert.ok(state)
  assert.equal(state.status, 'live')
})

test('pollLiveGames: keine parallelen Requests für dasselbe Spiel (In-Flight-Lock)', async (t) => {
  _resetForTests()
  const originalFetch = sihfSync.fetchSihfGame
  let calls = 0
  let resolveFirst
  const firstCallGate = new Promise((r) => { resolveFirst = r })
  sihfSync.fetchSihfGame = async () => {
    calls++
    await firstCallGate
    return { status: 200, json: baseRaw({ percent: 15, name: '1. Drittel' }) }
  }
  t.after(() => { sihfSync.fetchSihfGame = originalFetch })

  const game = makeGame()
  const now = new Date(`${game.date}T20:00:00`)
  const p1 = pollLiveGames({ games: [game] }, { now })
  const p2 = pollLiveGames({ games: [game] }, { now }) // startet, während p1 noch im In-Flight-Lock hängt
  resolveFirst()
  await Promise.all([p1, p2])
  assert.equal(calls, 1, 'zweiter gleichzeitiger Poll-Aufruf für dasselbe Spiel darf keinen zweiten Request auslösen')
})

test('pollLiveGames: API-Ausfall behält den zuletzt bekannten Live-Stand (kein Cache-Reset)', async (t) => {
  _resetForTests()
  const originalFetch = sihfSync.fetchSihfGame
  const game = makeGame()
  const now = new Date(`${game.date}T20:00:00`)

  sihfSync.fetchSihfGame = async () => ({ status: 200, json: baseRaw({ percent: 20, name: '1. Drittel' }) })
  await pollLiveGames({ games: [game] }, { now })
  assert.ok(getLiveState(game.id))

  sihfSync.fetchSihfGame = async () => { throw new Error('SIHF nicht erreichbar') }
  await pollLiveGames({ games: [game] }, { now })
  assert.ok(getLiveState(game.id), 'ein fehlgeschlagener Poll darf den bisherigen Live-Stand nicht löschen')

  t.after(() => { sihfSync.fetchSihfGame = originalFetch })
})

test('pollLiveGames: Spielende räumt den Live-Cache (Endergebnis übernimmt der reguläre SIHF-Sync)', async (t) => {
  _resetForTests()
  const originalFetch = sihfSync.fetchSihfGame
  const game = makeGame()
  const now = new Date(`${game.date}T20:00:00`)

  sihfSync.fetchSihfGame = async () => ({ status: 200, json: baseRaw({ percent: 50, name: '2. Drittel' }) })
  await pollLiveGames({ games: [game] }, { now })
  assert.ok(getLiveState(game.id))

  sihfSync.fetchSihfGame = async () => ({ status: 200, json: baseRaw({ percent: 100, name: 'Ende' }) })
  await pollLiveGames({ games: [game] }, { now })
  assert.equal(getLiveState(game.id), null)

  t.after(() => { sihfSync.fetchSihfGame = originalFetch })
})

test('pollLiveGames: Spiele ausserhalb des Live-Fensters (noch nicht begonnen) werden nicht angefragt', async () => {
  _resetForTests()
  const originalFetch = sihfSync.fetchSihfGame
  let calls = 0
  sihfSync.fetchSihfGame = async () => { calls++; return { status: 200, json: baseRaw() } }
  const game = makeGame({ time: '23:00' })
  const now = new Date(`${game.date}T19:00:00`) // vor Anpfiff
  await pollLiveGames({ games: [game] }, { now })
  assert.equal(calls, 0)
  sihfSync.fetchSihfGame = originalFetch
})
