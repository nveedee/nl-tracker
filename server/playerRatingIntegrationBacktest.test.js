// ---------------------------------------------------------------------------
// Data-Leakage-Tests für den Integration-Backtest (Auftrag Punkt 8) -
// bestätigt explizit: Anhängen zukünftiger Spiele darf ein bereits
// berechnetes Ergebnis an einem historischen Cutoff nicht verändern - weder
// ELO, noch Lineup Strength, noch die daraus geblendete Vorhersage.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runIntegrationWalkForward, blendPredictions, ratingWinProbability,
  calibrationTable, WEIGHT_GRID,
} from './scripts/backtest-player-rating-integration.js'

// Kleine synthetische Test-Ligen erreichen nie SKATER_MIN_N=20/GOALIE_MIN_N=6
// (die produktive Baseline-Mindeststichprobe) - hier bewusst herabgesetzt,
// NUR für diese Tests (die Konstanten im Kern-/Integrationsmodul selbst
// bleiben unverändert), damit die z-Scores überhaupt einen Wert liefern.
const TEST_OPTS = { minN: 1, goalieMinN: 1 }

function makeGame(overrides) {
  return {
    gameId: 'g', date: '2024-10-01', season: '2024/25', corona: false,
    homeTeamId: 1, awayTeamId: 2, homeGoals: 3, awayGoals: 1, decision: 'REG',
    skaters: [], goalies: [],
    ...overrides,
  }
}

function skaterRow(playerId, teamId, isHome, gi, overrides = {}) {
  return {
    playerId, teamId, isHome, position: 'F',
    goals: gi % 3 === 0 ? 1 : 0, assists: gi % 2 === 0 ? 1 : 0, points: (gi % 3 === 0 ? 1 : 0) + (gi % 2 === 0 ? 1 : 0),
    plusMinus: 1, sog: 3, blockedShots: 1, toiSec: 900, ppToiSec: 60, pkToiSec: 30, faceoffsWon: 5, faceoffsLost: 3,
    ...overrides,
  }
}

function goalieRow(playerId, teamId, isHome, overrides = {}) {
  return { playerId, teamId, isHome, goalsAgainst: 2, saves: 28, shotsAgainst: 30, toiSec: 3600, ...overrides }
}

// Team 1 (Heim) deutlich stärker als Team 2 (Auswärts) - mehr Tore/Assists/
// SOG - damit Rating-Differenzen ungleich 0 entstehen (sonst wäre jeder Test
// über "verschiebt die Vorhersage" trivial erfüllt, weil nichts zu
// verschieben ist).
function buildSeries(nGames, dateOffsetStart = 1) {
  const games = []
  for (let i = 0; i < nGames; i++) {
    const day = dateOffsetStart + i
    games.push(makeGame({
      gameId: `g${i}`, date: `2024-10-${String(day).padStart(2, '0')}`,
      homeGoals: 3 + (i % 2), awayGoals: 1,
      skaters: [
        skaterRow(101, 1, true, i, { goals: 2, assists: 1, points: 3, sog: 6, plusMinus: 3 }),
        skaterRow(102, 1, true, i, { position: 'D', goals: 1, assists: 1, points: 2, plusMinus: 3 }),
        skaterRow(201, 2, false, i, { goals: 0, assists: 0, points: 0, sog: 1, plusMinus: -3 }),
        skaterRow(202, 2, false, i, { position: 'D', goals: 0, assists: 0, points: 0, plusMinus: -3 }),
      ],
      goalies: [goalieRow(901, 1, true, { goalsAgainst: 1, saves: 30, shotsAgainst: 31 }), goalieRow(902, 2, false, { goalsAgainst: 4, saves: 20, shotsAgainst: 24 })],
    }))
  }
  return games
}

test('runIntegrationWalkForward: Spiele NACH einem Cutoff verändern die davor berechneten Zeilen (ELO + alle Lineup-Varianten) nicht', () => {
  const games = buildSeries(12)
  const rowsBefore = runIntegrationWalkForward(games.slice(0, 8), TEST_OPTS)

  const gamesWithFuture = [
    ...games,
    // extreme "Zukunfts"-Spiele weit hinten anhängen
    ...buildSeries(5, 100).map((g) => ({ ...g, homeGoals: 9, awayGoals: 0 })),
  ]
  const rowsAfter = runIntegrationWalkForward(gamesWithFuture, TEST_OPTS).slice(0, 8)

  assert.deepEqual(rowsBefore, rowsAfter)
})

test('runIntegrationWalkForward: Torhüter-"wahrscheinlicher Starter"-Proxy nutzt nur VERGANGENE Einsätze, nie das aktuelle oder spätere Spiel', () => {
  const games = buildSeries(6)
  // Torhüter 901 spielt in games[0..4], ein neuer Torhüter 903 taucht NUR im
  // letzten (6.) Spiel auf. Der Proxy für Spiel 6 darf NICHT wissen, dass 903
  // dort tatsächlich spielt (das wäre erst DURCH dieses Spiel bekannt).
  games[5].goalies = [goalieRow(903, 1, true), goalieRow(902, 2, false)]
  const rows = runIntegrationWalkForward(games, TEST_OPTS)
  // Bis einschliesslich Spiel 6 war der einzige BEKANNTE Heim-Torhüter 901 -
  // die pregameGoalie-Variante darf sich für Spiel 6 daher NICHT
  // unterscheiden von einem Szenario, in dem Spiel 6 stattdessen ganz normal
  // mit 901 gespielt worden wäre (der Proxy kennt 903 noch nicht).
  const gamesAlt = buildSeries(6)
  const rowsAlt = runIntegrationWalkForward(gamesAlt, TEST_OPTS)
  assert.deepEqual(rows[5].diffs.pregameGoalie, rowsAlt[5].diffs.pregameGoalie)
})

test('blendPredictions: eloWeight=1.0 ignoriert das Rating vollständig (identisch zu reinem ELO)', () => {
  const games = buildSeries(10)
  const rows = runIntegrationWalkForward(games, TEST_OPTS)
  const preds = blendPredictions(rows, 1.0, 'actualGoalie')
  for (let i = 0; i < preds.length; i++) assert.equal(preds[i].p, rows[i].pElo)
})

test('blendPredictions: niedrigeres eloWeight verschiebt die Vorhersage in Richtung des Rating-Signals (nicht identisch zu ELO allein, wenn ein Rating-Diff vorhanden ist)', () => {
  const games = buildSeries(15)
  const rows = runIntegrationWalkForward(games, TEST_OPTS)
  const withDiff = rows.filter((r) => r.diffs.actualGoalie != null && r.diffs.actualGoalie !== 0)
  assert.ok(withDiff.length > 0, 'Testvoraussetzung: mindestens ein Spiel mit einem Rating-Unterschied != 0')
  const preds100 = blendPredictions(withDiff, 1.0, 'actualGoalie')
  const preds75 = blendPredictions(withDiff, 0.75, 'actualGoalie')
  let anyDifferent = false
  for (let i = 0; i < preds100.length; i++) if (Math.abs(preds100[i].p - preds75[i].p) > 1e-9) anyDifferent = true
  assert.ok(anyDifferent)
})

test('ratingWinProbability: liefert ~0.5 bei Differenz 0, liegt für jede endliche Differenz in (0,1), ist monoton', () => {
  assert.ok(Math.abs(ratingWinProbability(0) - 0.5) < 1e-4) // normalCdf ist eine Näherung (Abramowitz-Stegun), nicht exakt 0.5
  assert.equal(ratingWinProbability(null), null)
  const p1 = ratingWinProbability(1), p2 = ratingWinProbability(2)
  assert.ok(p1 > 0.5 && p1 < 1)
  assert.ok(p2 > p1)
  const pNeg = ratingWinProbability(-1)
  assert.ok(pNeg < 0.5)
})

test('calibrationTable: Bins summieren sich zur Gesamtanzahl, keine NaN', () => {
  const preds = [
    { p: 0.2, y: 0 }, { p: 0.35, y: 1 }, { p: 0.45, y: 0 }, { p: 0.55, y: 1 }, { p: 0.8, y: 1 },
  ]
  const table = calibrationTable(preds)
  const total = table.reduce((s, b) => s + b.n, 0)
  assert.equal(total, preds.length)
  for (const b of table) {
    if (b.n > 0) { assert.ok(Number.isFinite(b.predictedMean)); assert.ok(Number.isFinite(b.actualRate)) }
  }
})

test('WEIGHT_GRID: genau die 6 im Auftrag geforderten Gewichtungen (100/0 bis 75/25 in 5%-Schritten)', () => {
  assert.equal(WEIGHT_GRID.length, 6)
  assert.deepEqual(WEIGHT_GRID.map((w) => w.eloWeight), [1.00, 0.95, 0.90, 0.85, 0.80, 0.75])
})

test('Keine NaN/Infinity in Predictions über eine grössere, gemischte Serie', () => {
  const games = buildSeries(40)
  const rows = runIntegrationWalkForward(games, TEST_OPTS)
  for (const w of WEIGHT_GRID) {
    for (const key of ['actualGoalie', 'pregameGoalie', 'noGoalie', 'heavierGoalieActual']) {
      const preds = blendPredictions(rows, w.eloWeight, key)
      for (const p of preds) {
        assert.ok(Number.isFinite(p.p), `p ist nicht endlich: ${p.p}`)
        assert.ok(p.p >= 0 && p.p <= 1, `p ausserhalb [0,1]: ${p.p}`)
      }
    }
  }
})
