// ---------------------------------------------------------------------------
// Konsistenztests für die zentrale Pre-Game-Prediction-Quelle
// (src/pregamePrediction.js). Kernanforderung: für DASSELBE gameId müssen
// alle Seiten (Dashboard, Schedule, Season Projections/PlayoffOdds,
// TeamDetail, MatchupDetail) dieselbe zugrunde liegende Probability liefern
// - verglichen werden die vollen Float-Werte, nicht nur gerundete Prozente.
//
// Testfall orientiert sich am real aufgetretenen Bug: KLO-LUG zeigte auf
// /playoff-odds (Live-ELO-Neuberechnung) und /schedule (eingefrorener
// Snapshot) unterschiedliche Prozentwerte für dasselbe Spiel.
// ---------------------------------------------------------------------------

import test from 'node:test'
import assert from 'node:assert/strict'
import { getPregamePrediction, withPregamePredictions } from './pregamePrediction.js'
import { computeMatchForecasts } from './playoffSim.js'

const teams = [
  { id: 'team_klo', name: 'EHC Kloten', short: 'KLO' },
  { id: 'team_lug', name: 'HC Lugano', short: 'LUG' },
]
const games = [
  { id: 'game_klo_lug', homeTeamId: 'team_klo', awayTeamId: 'team_lug', date: '2026-09-18', time: '19:45', status: 'scheduled' },
]
const settings = { eloStart: 1500, eloHomeAdvantage: 65 }
const players = []

// Exaktes Format eines Prediction-Snapshots (server/scripts/predictions.js,
// db.predictions[]) - KLO liegt hier bewusst HINTER LUG (46% / 54%), damit
// der Test einen echten "Heimteam ist nicht der Favorit"-Fall abdeckt.
const predictions = [
  {
    gameId: 'game_klo_lug',
    createdAt: '2026-09-10T08:00:00.000Z',
    seed: 424242,
    date: '2026-09-18',
    homeTeamId: 'team_klo',
    awayTeamId: 'team_lug',
    homeWinProbability: 0.4623,
    awayWinProbability: 0.5377,
    expectedHomeGoals: 2.55,
    expectedAwayGoals: 2.91,
    otProbability: 0.084,
    soProbability: 0.0546,
    eloHome: 1470,
    eloAway: 1540,
    modelVersion: 'test-fixture',
  },
]

test('getPregamePrediction: Snapshot gewinnt immer gegen einen abweichenden Live-Fallback, volle Float-Praezision', () => {
  const liveFallback = {
    gameId: 'game_klo_lug', pHomeWin: 0.99, pAwayWin: 0.01, pOT: 0.5, pSO: 0.5, pDecision: 1,
    expHomeGoals: 9, expAwayGoals: 9, eloHome: 1, eloAway: 1,
  }
  const p = getPregamePrediction('game_klo_lug', predictions, liveFallback)
  assert.equal(p.source, 'snapshot')
  assert.equal(p.pHomeWin, 0.4623)
  assert.equal(p.pAwayWin, 0.5377)
  assert.equal(p.pOT, 0.084)
  assert.equal(p.pSO, 0.0546)
  assert.ok(Math.abs(p.pDecision - (0.084 + 0.0546)) < 1e-12)
  // Der stark abweichende Live-Fallback darf NICHT durchsickern.
  assert.notEqual(p.pHomeWin, liveFallback.pHomeWin)
})

test('getPregamePrediction: ohne Snapshot exakt der übergebene Live-Fallback (unverändert, keine Rundung)', () => {
  const liveFallback = {
    gameId: 'game_without_snapshot', pHomeWin: 0.61234567, pAwayWin: 0.38765433,
    pOT: 0.1, pSO: 0.05, pDecision: 0.15, expHomeGoals: 3.1, expAwayGoals: 2.4, eloHome: 1600, eloAway: 1500,
  }
  const p = getPregamePrediction('game_without_snapshot', predictions, liveFallback)
  assert.equal(p.source, 'live')
  assert.equal(p.pHomeWin, liveFallback.pHomeWin)
  assert.equal(p.pAwayWin, liveFallback.pAwayWin)
})

test('getPregamePrediction: weder Snapshot noch Live-Fallback vorhanden -> null (kein erfundener Wert)', () => {
  assert.equal(getPregamePrediction('unknown_game', predictions, null), null)
  assert.equal(getPregamePrediction('unknown_game', predictions, undefined), null)
})

test('withPregamePredictions: reichert eine Forecast-Liste identisch zu getPregamePrediction je Zeile an', () => {
  const liveForecasts = [
    {
      gameId: 'game_klo_lug', date: '2026-09-18', homeTeam: teams[0], awayTeam: teams[1],
      pHomeWin: 0.99, pAwayWin: 0.01, pDecision: 0.2, pOT: 0.1, pSO: 0.1,
      expHomeGoals: 9, expAwayGoals: 9, eloHome: 1, eloAway: 1,
    },
  ]
  const enriched = withPregamePredictions(liveForecasts, predictions)
  assert.equal(enriched[0].pHomeWin, 0.4623)
  assert.equal(enriched[0].pAwayWin, 0.5377)
  assert.equal(enriched[0].predictionSource, 'snapshot')
  // Array-Länge/Reihenfolge bleibt unverändert.
  assert.equal(enriched.length, liveForecasts.length)
})

// KERN-KONSISTENZTEST (Testfall Abschnitt 9/10 des Auftrags): computeMatchForecasts()
// (der Pfad, den Dashboard.jsx/PlayoffOdds.jsx/TeamDetail.jsx nach der
// Konsolidierung alle identisch verwenden) UND die bewusst stark
// abweichenden, seiten-eigenen Live-Fallback-Formen von Schedule.jsx und
// MatchupDetail.jsx müssen für game_klo_lug alle exakt denselben Float-Wert
// liefern, sobald ein Snapshot existiert.
test('KLO-LUG: Dashboard-/Schedule-/Season-Projection-/MatchupDetail-Pipeline liefern identische Pre-Game-Probability', () => {
  // Dashboard.jsx / PlayoffOdds.jsx ("Per-Match-Forecast") / TeamDetail.jsx
  // ("Matchups") - alle drei rufen exakt dasselbe computeMatchForecasts() +
  // withPregamePredictions() auf.
  const listForecasts = withPregamePredictions(computeMatchForecasts(teams, games, settings, players), predictions)
  const dashboardEntry = listForecasts.find((f) => f.gameId === 'game_klo_lug')
  assert.ok(dashboardEntry, 'computeMatchForecasts() sollte das offene Spiel enthalten')

  // Schedule.jsx: eigener geschlossener-Form-ELO-Live-Fallback (bewusst
  // stark abweichend simuliert) - muss trotzdem ignoriert werden.
  const scheduleLiveFallback = { gameId: 'game_klo_lug', pHomeWin: 0.9, pAwayWin: 0.1 }
  const scheduleEntry = getPregamePrediction('game_klo_lug', predictions, scheduleLiveFallback)

  // MatchupDetail.jsx: eigener 10'000-Lauf-Monte-Carlo-Live-Fallback (anderes
  // Objekt-Shape, ebenfalls bewusst stark abweichend) - muss trotzdem
  // ignoriert werden.
  const matchupLiveFallback = {
    gameId: 'game_klo_lug', pHomeWin: 0.05, pAwayWin: 0.95, pOT: 0.5, pSO: 0.5, pDecision: 1,
    expHomeGoals: 0.1, expAwayGoals: 9.9,
  }
  const matchupEntry = getPregamePrediction('game_klo_lug', predictions, matchupLiveFallback)

  // 1) Alle drei Pipelines liefern exakt den Snapshot-Wert.
  for (const entry of [dashboardEntry, scheduleEntry, matchupEntry]) {
    assert.equal(entry.pHomeWin, predictions[0].homeWinProbability)
    assert.equal(entry.pAwayWin, predictions[0].awayWinProbability)
  }

  // 2) Bit-genauer Float-Vergleich untereinander (nicht nur gerundete
  // Prozentwerte) - das eigentliche Konsistenzkriterium des Auftrags.
  assert.equal(dashboardEntry.pHomeWin, scheduleEntry.pHomeWin)
  assert.equal(scheduleEntry.pHomeWin, matchupEntry.pHomeWin)
  assert.equal(dashboardEntry.pAwayWin, scheduleEntry.pAwayWin)
  assert.equal(scheduleEntry.pAwayWin, matchupEntry.pAwayWin)
  assert.equal(dashboardEntry.pOT, matchupEntry.pOT)
  assert.equal(dashboardEntry.pSO, matchupEntry.pSO)
  assert.ok(Math.abs(dashboardEntry.pHomeWin - 0.4623) < 1e-12)

  // 3) Jede Pipeline hat ihren eigenen, absichtlich stark abweichenden
  // Live-Fallback tatsächlich verworfen (Beweis, dass der Snapshot wirklich
  // gewonnen hat, nicht nur zufällig gleich war).
  assert.notEqual(scheduleEntry.pHomeWin, scheduleLiveFallback.pHomeWin)
  assert.notEqual(matchupEntry.pHomeWin, matchupLiveFallback.pHomeWin)

  // 4) OT/SO bleiben eine separate Zusatzinfo, nicht Teil von pHomeWin/pAwayWin.
  assert.ok(dashboardEntry.pOT + dashboardEntry.pSO < dashboardEntry.pHomeWin + dashboardEntry.pAwayWin)
  assert.ok(Math.abs((dashboardEntry.pHomeWin + dashboardEntry.pAwayWin) - 1) < 1e-9)
})

test('Ohne Snapshot: computeMatchForecasts()-Pfad und ein manueller Live-Fallback-Aufruf stimmen für dasselbe Spiel überein', () => {
  const gameIdNoSnapshot = 'game_without_snapshot'
  const gamesNoSnap = [{ id: gameIdNoSnapshot, homeTeamId: 'team_klo', awayTeamId: 'team_lug', date: '2026-09-25', status: 'scheduled' }]
  const listForecasts = computeMatchForecasts(teams, gamesNoSnap, settings, players)
  const liveEntry = listForecasts.find((f) => f.gameId === gameIdNoSnapshot)
  assert.ok(liveEntry)

  const resolved = getPregamePrediction(gameIdNoSnapshot, predictions, liveEntry)
  assert.equal(resolved.source, 'live')
  assert.equal(resolved.pHomeWin, liveEntry.pHomeWin)
  assert.equal(resolved.pAwayWin, liveEntry.pAwayWin)
  assert.equal(resolved.pOT, liveEntry.pOT)
  assert.equal(resolved.pSO, liveEntry.pSO)
})
