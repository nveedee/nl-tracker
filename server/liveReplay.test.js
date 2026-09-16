// ---------------------------------------------------------------------------
// Tests für den DEV-ONLY Live-Replay (server/liveReplay.js). Nutzt das
// tatsächliche Archiv-Fixture (HC Davos - EV Zug, 08.09.2017,
// server/data/historical/2017-18.json) - keine erfundenen Testdaten, nur
// echte, bereits archivierte SIHF-Ereignisse zu verschiedenen elapsed-
// Zeitpunkten durch dieselbe parseLiveSnapshot()-Pipeline wie im echten
// Live-Pfad.
//
// Aufruf: node --test server/liveReplay.test.js
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'

import sihfSync from './scripts/sync-sihf.cjs'
import { buildReplayLiveState, buildRealGameReplayState, buildRealGameReplayTimeline, _resetRealGameCacheForTests } from './liveReplay.js'
import { computeLiveWinProbability, REGULATION_MINUTES } from '../src/liveProbability.js'

test('Replay 0:00 - Spielbeginn, 0:0, noch nicht live', () => {
  const s = buildReplayLiveState(0)
  assert.equal(s.homeGoals, 0)
  assert.equal(s.awayGoals, 0)
  assert.equal(s.status, 'scheduled')
  assert.equal(s.replay, true)
  assert.equal(s.replaySourceGameId, '20181105000001')
})

test('Replay nach 1. Tor (16:00) - EVZ führt 0:1', () => {
  const s = buildReplayLiveState(16 * 60)
  assert.equal(s.homeGoals, 0)
  assert.equal(s.awayGoals, 1)
  assert.equal(s.status, 'live')
  assert.equal(s.goals.length, 1)
})

test('Replay Periodenwechsel - Periodenzeile erscheint erst nach Drittelende', () => {
  const before = buildReplayLiveState(19 * 60)
  const after = buildReplayLiveState(21 * 60)
  assert.equal(before.periods.length, 0, 'vor 20:00 ist die 1. Drittel-Zeile noch nicht abgeschlossen/sichtbar')
  assert.equal(after.periods.length, 1)
  assert.equal(after.periods[0].away, 1)
})

test('Replay mehrere Tore (34:00) - Stand 2:2 nach 4 Toren', () => {
  const s = buildReplayLiveState(34 * 60)
  assert.equal(s.homeGoals, 2)
  assert.equal(s.awayGoals, 2)
  assert.equal(s.goals.length, 4)
})

test('Replay Penalty (05:00) - genau die erste, bereits verhängte Strafe ist sichtbar', () => {
  const s = buildReplayLiveState(5 * 60)
  assert.equal(s.penalties.length, 1)
  assert.equal(s.penalties[0].minutes, 2)
  assert.ok(s.penalties[0].teamId)
})

test('Replay 50:00 - noch REG, kein verfrühtes Overtime/Final', () => {
  const s = buildReplayLiveState(50 * 60)
  assert.equal(s.status, 'live')
  assert.equal(s.phase, 'REG')
  assert.equal(s.homeGoals, 2)
  assert.equal(s.awayGoals, 2)
})

test('Replay Overtime (61:00) - Statuslabel zeigt Overtime, Spiel noch nicht final', () => {
  const s = buildReplayLiveState(61 * 60)
  assert.equal(s.status, 'live')
  assert.equal(s.statusLabel, 'Overtime')
  assert.equal(s.homeGoals, 2)
  assert.equal(s.awayGoals, 2)
})

test('Replay Final (inkl. Shootout) - Endstand 2:3, Phase SO, Status final', () => {
  const s = buildReplayLiveState(66 * 60)
  assert.equal(s.status, 'final')
  assert.equal(s.phase, 'SO')
  assert.equal(s.homeGoals, 2)
  assert.equal(s.awayGoals, 3)
})

test('Replay: unbekannte spätere Zeitpunkte liefern keine zusätzlichen (erfundenen) Tore', () => {
  const s = buildReplayLiveState(200 * 60) // weit nach Spielende
  assert.equal(s.homeGoals, 2)
  assert.equal(s.awayGoals, 3)
  assert.equal(s.status, 'final')
})

// ---------------------------------------------------------------------------
// buildRealGameReplayState(): historischer Replay für ein ECHTES,
// abgeschlossenes DB-Spiel (produktives Feature, siehe MatchupDetail.jsx
// "Spielverlauf anzeigen") - GENERISCH, keine Hardcodierung eines
// bestimmten Matchups (siehe Requirement "keine individuelle Hardcodierung
// für BIE-FRI"). sihfSync.fetchSihfGame() wird hier gezielt mit einem
// synthetischen, aber strukturell verifizierten Fixture überschrieben
// (identisches Muster wie liveSync.test.js) - kein echter Netzwerkzugriff
// in Tests.
// ---------------------------------------------------------------------------

const HOME_SIHF_ID = 102128 // team_bie
const AWAY_SIHF_ID = 103138 // team_fri

function makeFinalRaw() {
  return {
    status: { percent: 100, name: 'Ende', canceled: false },
    details: {
      homeTeam: { id: HOME_SIHF_ID, name: 'EHC Biel', acronym: 'BIE' },
      awayTeam: { id: AWAY_SIHF_ID, name: 'Fribourg-Gottéron', acronym: 'FRI' },
    },
    result: {
      // homeTeam/awayTeam (Gesamtscore-Strings) werden von
      // normalizeSihfRawToGameRecord() nicht gelesen - der Stand ergibt sich
      // ausschliesslich aus den goals[]-Events unten (hier: 3:2), siehe
      // buildRawPayloadAt()-Kommentar in liveReplay.js.
      scores: [
        { name: '1. Drittel', indicator: '1', homeTeam: '2', awayTeam: '0' },
        { name: '2. Drittel', indicator: '2', homeTeam: '1', awayTeam: '1' },
        { name: '3. Drittel', indicator: '3', homeTeam: '1', awayTeam: '1' },
      ],
      sogs: [
        { name: '1. Drittel', indicator: '1', homeTeam: '11', awayTeam: '8' },
        { name: '2. Drittel', indicator: '2', homeTeam: '9', awayTeam: '10' },
        { name: '3. Drittel', indicator: '3', homeTeam: '8', awayTeam: '9' },
      ],
    },
    summary: {
      periods: [
        {
          name: '1. Drittel',
          goals: [
            { time: '05:10', teamId: HOME_SIHF_ID, text: 'Spieler A' },
            { time: '17:42', teamId: HOME_SIHF_ID, text: 'Spieler B' },
          ],
          fouls: [{ time: '10:00', minutes: 2, teamId: AWAY_SIHF_ID, text: 'Halten' }],
        },
        {
          name: '2. Drittel',
          goals: [
            { time: '25:00', teamId: AWAY_SIHF_ID, text: 'Spieler C' },
            { time: '38:15', teamId: HOME_SIHF_ID, text: 'Spieler D' },
          ],
          fouls: [],
        },
        {
          name: '3. Drittel',
          goals: [{ time: '55:30', teamId: AWAY_SIHF_ID, text: 'Spieler E' }],
          fouls: [{ time: '58:00', minutes: 2, teamId: HOME_SIHF_ID, text: 'Haken' }],
        },
      ],
      shootout: { shoots: [] },
    },
    stats: [],
  }
}

function makeLocalGame(overrides = {}) {
  return { id: 'game_2026-09-15_bie_fri', sihfGameId: '20271105000002', status: 'final', decision: 'REG', date: '2026-09-15', ...overrides }
}

test('buildRealGameReplayState: mehrere Tore werden über die Zeit korrekt aufsummiert', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: makeFinalRaw() })
  t.after(() => { sihfSync.fetchSihfGame = original })

  const game = makeLocalGame()
  const at0 = await buildRealGameReplayState(game, 0)
  assert.equal(at0.homeGoals, 0)
  assert.equal(at0.awayGoals, 0)

  const afterFirstGoal = await buildRealGameReplayState(game, 5 * 60 + 30) // 05:30, nach dem Tor bei 05:10
  assert.equal(afterFirstGoal.homeGoals, 1)
  assert.equal(afterFirstGoal.awayGoals, 0)

  const afterFourGoals = await buildRealGameReplayState(game, 38 * 60 + 30) // nach 38:15
  assert.equal(afterFourGoals.homeGoals, 3)
  assert.equal(afterFourGoals.awayGoals, 1)
})

test('buildRealGameReplayState: SIHF-Zeitstempel sind absolute Spielzeit (22:50-Stil), keine Perioden-relative Umrechnung', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: makeFinalRaw() })
  t.after(() => { sihfSync.fetchSihfGame = original })

  const game = makeLocalGame()
  // Tor bei "25:00" (2. Drittel) - absolute Sekunde 1500, NICHT 5*60=300
  // (das wäre die falsche "relativ zum Drittelstart"-Interpretation).
  const before = await buildRealGameReplayState(game, 1500 - 1)
  const after = await buildRealGameReplayState(game, 1500)
  assert.equal(before.awayGoals, 0)
  assert.equal(after.awayGoals, 1)
  assert.equal(after.replayElapsedSeconds, 1500)
})

test('buildRealGameReplayState: Wahrscheinlichkeit (liveProbability.js) ändert sich nach einem Tor', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: makeFinalRaw() })
  t.after(() => { sihfSync.fetchSihfGame = original })

  const game = makeLocalGame()
  const pregame = { expHomeFull: 3.05, expAwayFull: 2.53, pHomePreGame: 0.55 }
  const before = await buildRealGameReplayState(game, 4 * 60)
  const after = await buildRealGameReplayState(game, 6 * 60)
  const probBefore = computeLiveWinProbability({ ...pregame, homeGoals: before.homeGoals, awayGoals: before.awayGoals, elapsedMinutes: 4, phase: before.phase })
  const probAfter = computeLiveWinProbability({ ...pregame, homeGoals: after.homeGoals, awayGoals: after.awayGoals, elapsedMinutes: 6, phase: after.phase })
  assert.notEqual(probBefore.homeFinal, probAfter.homeFinal, 'ein Tor muss die (über liveProbability.js berechnete) Wahrscheinlichkeit verändern')
  assert.ok(probAfter.homeFinal > probBefore.homeFinal, 'Heimtor muss die Heimsieg-Wahrscheinlichkeit erhöhen')
})

test('buildRealGameReplayState: Penalty wird korrekt geparst', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: makeFinalRaw() })
  t.after(() => { sihfSync.fetchSihfGame = original })

  const s = await buildRealGameReplayState(makeLocalGame(), 12 * 60)
  assert.equal(s.penalties.length, 1)
  assert.equal(s.penalties[0].minutes, 2)
})

test('buildRealGameReplayState: endet beim echten Endstand (3:2, aus den 5 Goal-Events), Status final', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: makeFinalRaw() })
  t.after(() => { sihfSync.fetchSihfGame = original })

  const s = await buildRealGameReplayState(makeLocalGame(), 3600)
  assert.equal(s.status, 'final')
  assert.equal(s.homeGoals, 3)
  assert.equal(s.awayGoals, 2)
})

test('buildRealGameReplayState: OT-Spiel - zusätzliche Periodenzeile wird korrekt behandelt', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  // Eigenständiges Fixture (3:4 n.V., angelehnt an RAP-KLO vom 15.09.2026):
  // 3 REG-Tore Heim, 3 REG-Tore Auswärts, 1 Auswärtstor in der Overtime.
  const raw = {
    status: { percent: 100, name: 'Ende', canceled: false },
    details: {
      homeTeam: { id: HOME_SIHF_ID, name: 'EHC Biel', acronym: 'BIE' },
      awayTeam: { id: AWAY_SIHF_ID, name: 'Fribourg-Gottéron', acronym: 'FRI' },
    },
    result: {
      scores: [
        { name: '1. Drittel', indicator: '1', homeTeam: '1', awayTeam: '1' },
        { name: '2. Drittel', indicator: '2', homeTeam: '1', awayTeam: '1' },
        { name: '3. Drittel', indicator: '3', homeTeam: '1', awayTeam: '1' },
        { name: 'Overtime', indicator: 'OT1', homeTeam: '0', awayTeam: '1' },
      ],
      sogs: [],
    },
    summary: {
      periods: [
        { name: '1. Drittel', goals: [{ time: '03:00', teamId: HOME_SIHF_ID, text: 'A' }, { time: '15:00', teamId: AWAY_SIHF_ID, text: 'B' }], fouls: [] },
        { name: '2. Drittel', goals: [{ time: '28:00', teamId: HOME_SIHF_ID, text: 'C' }, { time: '35:00', teamId: AWAY_SIHF_ID, text: 'D' }], fouls: [] },
        { name: '3. Drittel', goals: [{ time: '50:00', teamId: HOME_SIHF_ID, text: 'E' }, { time: '58:00', teamId: AWAY_SIHF_ID, text: 'F' }], fouls: [] },
        { name: 'Overtime', goals: [{ time: '62:30', teamId: AWAY_SIHF_ID, text: 'G' }], fouls: [] },
      ],
      shootout: { shoots: [] },
    },
    stats: [],
  }
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: raw })
  t.after(() => { sihfSync.fetchSihfGame = original })

  const game = makeLocalGame({ id: 'game_2026-09-15_rap_klo', decision: 'OT' })
  const endOfReg = await buildRealGameReplayState(game, 60 * 60)
  assert.equal(endOfReg.homeGoals, 3)
  assert.equal(endOfReg.awayGoals, 3)
  assert.equal(endOfReg.status, 'live', 'nach 60:00 noch nicht final - Overtime-Tor ist noch nicht gefallen')

  const final = await buildRealGameReplayState(game, 63 * 60)
  assert.equal(final.status, 'final')
  assert.equal(final.homeGoals, 3)
  assert.equal(final.awayGoals, 4)
  assert.equal(final.phase, 'OT')
})

test('buildRealGameReplayState: nicht-abgeschlossenes/zukünftiges Spiel liefert keinen Replay', async () => {
  await assert.rejects(
    () => buildRealGameReplayState(makeLocalGame({ status: 'scheduled' }), 0),
    /nicht abgeschlossen/,
  )
})

test('buildRealGameReplayState: Spiel ohne sihfGameId liefert keinen Replay (keine erfundenen Daten)', async () => {
  await assert.rejects(
    () => buildRealGameReplayState(makeLocalGame({ sihfGameId: null }), 0),
    /keine sihfGameId/,
  )
})

// ---------------------------------------------------------------------------
// buildRealGameReplayTimeline(): DIE VOLLSTÄNDIGE Kurve (nicht nur der am
// Regler ausgewählte Einzelpunkt) - Requirement "ICH WILL DIE KOMPLETTE
// HISTORISCHE LIVE-PROBABILITY-LINIE".
// ---------------------------------------------------------------------------

test('buildRealGameReplayTimeline: liefert eine dichte, aufsteigend sortierte Zeitreihe von 0 bis Spielende', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: makeFinalRaw() })
  t.after(() => { sihfSync.fetchSihfGame = original })

  const timeline = await buildRealGameReplayTimeline(makeLocalGame(), { stepSeconds: 30 })
  assert.equal(timeline.replayDurationSeconds, 3600) // reines REG-Spiel, keine OT
  assert.ok(timeline.points.length > 60, 'dichtes Raster (30s-Schritte über 60 Minuten) + Tor-Zeitpunkte')
  assert.equal(timeline.points[0].elapsedSeconds, 0)
  assert.equal(timeline.points[timeline.points.length - 1].elapsedSeconds, 3600)
  for (let i = 1; i < timeline.points.length; i++) {
    assert.ok(timeline.points[i].elapsedSeconds > timeline.points[i - 1].elapsedSeconds, 'streng aufsteigend, keine Duplikate')
  }
  // Jedes echte Tor (05:10, 17:42, 25:00, 38:15, 55:30) muss als exakter
  // Sprungpunkt (Sekunde davor + Sekunde selbst) im Raster enthalten sein.
  const seconds = new Set(timeline.points.map((s) => s.elapsedSeconds))
  for (const goalSec of [310, 1062, 1500, 2295, 3330]) {
    assert.ok(seconds.has(goalSec - 1) && seconds.has(goalSec), `Torzeitpunkt ${goalSec}s fehlt im Raster`)
  }
  // finalState liefert die vollständigen Ereignisdaten (Tore/Strafen), EINMAL,
  // nicht pro Punkt dupliziert.
  assert.equal(timeline.finalState.status, 'final')
  assert.equal(timeline.finalState.goals.length, 5)
})

test('buildRealGameReplayTimeline: jeder Punkt ist über liveProbability.js in eine unterschiedliche Wahrscheinlichkeit übersetzbar, wenn sich der Spielstand ändert', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: makeFinalRaw() })
  t.after(() => { sihfSync.fetchSihfGame = original })

  const timeline = await buildRealGameReplayTimeline(makeLocalGame(), { stepSeconds: 60 })
  const pregame = { expHomeFull: 3.05, expAwayFull: 2.53, pHomePreGame: 0.55 }
  const before = timeline.points.find((s) => s.elapsedSeconds === 309)
  const after = timeline.points.find((s) => s.elapsedSeconds === 310)
  const probBefore = computeLiveWinProbability({ ...pregame, homeGoals: before.homeGoals, awayGoals: before.awayGoals, elapsedMinutes: 309 / 60, phase: before.phase })
  const probAfter = computeLiveWinProbability({ ...pregame, homeGoals: after.homeGoals, awayGoals: after.awayGoals, elapsedMinutes: 310 / 60, phase: after.phase })
  assert.notEqual(probBefore.homeFinal, probAfter.homeFinal)
})

test('buildRealGameReplayTimeline: Default-Auflösung ist 1s, ohne dass sich die Werte an echten Torzeitpunkten dadurch ändern', async (t) => {
  _resetRealGameCacheForTests()
  const original = sihfSync.fetchSihfGame
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: makeFinalRaw() })
  t.after(() => { sihfSync.fetchSihfGame = original })

  const fine = await buildRealGameReplayTimeline(makeLocalGame(), {}) // Default = 1s
  assert.ok(fine.points.length > 3500, `1s-Auflösung über 60 Minuten sollte >3500 Punkte ergeben, war ${fine.points.length}`)

  _resetRealGameCacheForTests()
  sihfSync.fetchSihfGame = async () => ({ status: 200, json: makeFinalRaw() })
  const coarse = await buildRealGameReplayTimeline(makeLocalGame(), { stepSeconds: 30 })

  // Score an jedem echten Torzeitpunkt (310, 1062, 1500, 2295, 3330) muss bei
  // 1s- und 30s-Raster identisch sein - die Auflösung darf den EINGABEWERT
  // an liveProbability.js nicht verändern, nur wie viele Zwischenpunkte
  // gerendert werden.
  for (const goalSec of [310, 1062, 1500, 2295, 3330]) {
    const finePt = fine.points.find((p) => p.elapsedSeconds === goalSec)
    const coarsePt = coarse.points.find((p) => p.elapsedSeconds === goalSec)
    assert.equal(finePt.homeGoals, coarsePt.homeGoals, `homeGoals bei ${goalSec}s muss auflösungsunabhängig gleich sein`)
    assert.equal(finePt.awayGoals, coarsePt.awayGoals, `awayGoals bei ${goalSec}s muss auflösungsunabhängig gleich sein`)
  }
})
