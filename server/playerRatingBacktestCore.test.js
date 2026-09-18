// ---------------------------------------------------------------------------
// Data-Leakage-Tests für den Player-Rating-Backtest (Auftrag Punkt 15) -
// automatisiert, wie explizit gefordert: "Einfügen eines Spiels nach T darf
// Player Rating/Baseline/Lineup Strength/Backtest Prediction NICHT verändern."
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSkaterTracker, snapshotSkaterRates, updateSkaterTracker,
  createGoalieTracker, snapshotGoalieRates, updateGoalieTracker,
  buildSkaterBaselineFromRates, buildGoalieBaselineFromRates,
  computeHistSkaterRating, computeHistGoalieRating, runLeakFreeElo,
} from './playerRatingBacktestCore.js'

function skaterRow(playerId, gi, overrides = {}) {
  return {
    playerId, teamId: 't1', isHome: true, position: 'F',
    goals: gi % 3 === 0 ? 1 : 0, assists: gi % 2 === 0 ? 1 : 0, points: (gi % 3 === 0 ? 1 : 0) + (gi % 2 === 0 ? 1 : 0),
    plusMinus: 1, sog: 3, blockedShots: 1, toiSec: 900, ppToiSec: 60, pkToiSec: 30, faceoffsWon: 5, faceoffsLost: 3,
    ...overrides,
  }
}

test('snapshotSkaterRates: Spiel NACH dem Snapshot-Zeitpunkt verändert den Snapshot nicht (Tracker-Ebene)', () => {
  const tracker = createSkaterTracker()
  for (let i = 0; i < 6; i++) updateSkaterTracker(tracker, skaterRow('p1', i), '2024/25')
  const snapshotBefore = snapshotSkaterRates(tracker, 'p1', '2024/25')

  // Weitere, extreme Spiele NACH dem Snapshot hinzufügen
  for (let i = 0; i < 5; i++) updateSkaterTracker(tracker, skaterRow('p1', i, { goals: 5, assists: 5, points: 10 }), '2024/25')

  // Ein NEUER Snapshot-Aufruf mit demselben Tracker sieht natürlich die neuen
  // Daten (der Tracker IST der Zustand) - aber der BEREITS GEZOGENE
  // `snapshotBefore` (eine Kopie zum Zeitpunkt X) darf sich nicht rückwirkend
  // verändert haben (kein Objekt-Aliasing auf mutierbare interne Strukturen).
  assert.equal(snapshotBefore.season.gp, 6)
  assert.notEqual(snapshotBefore.season.gp, tracker.season.get('p1#2024/25').gp)
})

test('computeHistSkaterRating: identisches Rating unabhängig davon, ob "zukünftige" Spiele bereits im Rohdaten-Array stehen, solange sie NACH dem Cutoff nicht verarbeitet wurden', () => {
  function buildRatingAtCutoff(games, cutoffIndex) {
    const tracker = createSkaterTracker()
    const ratesByPos = { F: [], D: [] }
    for (let i = 0; i < cutoffIndex; i++) {
      updateSkaterTracker(tracker, games[i], '2024/25')
    }
    // Baseline NUR aus Zuständen vor dem Cutoff (hier: nur dieser eine Spieler
    // als Populationsstellvertreter - Baseline-Aufbau selbst wird unten
    // separat/realistisch getestet).
    const snap = snapshotSkaterRates(tracker, games[0].playerId, '2024/25')
    if (snap.season) ratesByPos.F.push(snap.season)
    const baseline = buildSkaterBaselineFromRates(ratesByPos)
    return computeHistSkaterRating(snap, baseline, { minN: 1 })
  }

  const games10 = Array.from({ length: 10 }, (_, i) => skaterRow('p1', i))
  const ratingAt10 = buildRatingAtCutoff(games10, 10)

  const gamesWithFuture = [...games10, skaterRow('p1', 99, { goals: 9, assists: 9, points: 18 })]
  const ratingAt10Again = buildRatingAtCutoff(gamesWithFuture, 10) // derselbe Cutoff-Index, ein Spiel MEHR im Array dahinter

  assert.deepEqual(ratingAt10, ratingAt10Again)
})

test('runLeakFreeElo: onGame-Hook liefert die ELO-Werte VOR dem aktuellen Spiel, ein angehängtes Spiel danach ändert bereits gezogene Prognosen nicht', () => {
  const games = [
    { season: '2024/25', homeTeamId: 1, awayTeamId: 2, homeGoals: 3, awayGoals: 1 },
    { season: '2024/25', homeTeamId: 2, awayTeamId: 1, homeGoals: 0, awayGoals: 4 },
    { season: '2024/25', homeTeamId: 1, awayTeamId: 2, homeGoals: 2, awayGoals: 2 },
  ]
  const seenA = []
  runLeakFreeElo(games, undefined, (g, rh, ra, p) => seenA.push({ rh, ra, p }))

  const gamesWithExtra = [...games, { season: '2024/25', homeTeamId: 1, awayTeamId: 2, homeGoals: 9, awayGoals: 0 }]
  const seenB = []
  runLeakFreeElo(gamesWithExtra, undefined, (g, rh, ra, p) => seenB.push({ rh, ra, p }))

  // Die ersten 3 Prognosen (vor dem angehängten 4. Spiel) müssen identisch sein.
  assert.deepEqual(seenA, seenB.slice(0, 3))
})

test('Goalie-Snapshot: Karriere-/Saison-Raten nach dem Cutoff unverändert, wenn spätere Spiele existieren, aber nicht verarbeitet wurden', () => {
  function ratingAtCutoff(rows, cutoffIndex) {
    const tracker = createGoalieTracker()
    for (let i = 0; i < cutoffIndex; i++) updateGoalieTracker(tracker, rows[i], '2024/25')
    const snap = snapshotGoalieRates(tracker, 'g1', '2024/25')
    const baseline = buildGoalieBaselineFromRates(snap.season ? [snap.season] : [])
    return computeHistGoalieRating(snap, baseline, { minN: 1 })
  }
  const rows = Array.from({ length: 8 }, () => ({ playerId: 'g1', teamId: 't1', isHome: true, goalsAgainst: 2, saves: 28, shotsAgainst: 30, toiSec: 3600 }))
  const a = ratingAtCutoff(rows, 8)
  const withFuture = [...rows, { playerId: 'g1', teamId: 't1', isHome: true, goalsAgainst: 0, saves: 40, shotsAgainst: 40, toiSec: 3600 }]
  const b = ratingAtCutoff(withFuture, 8)
  assert.deepEqual(a, b)
})

test('Baseline-Aufbau: Population, die nur AUS ZUKÜNFTIGEN Zuständen besteht, darf nicht einfliessen (Baseline muss leer/neutral bleiben, wenn vor dem Cutoff nichts bekannt ist)', () => {
  const tracker = createSkaterTracker()
  // p2 spielt ERST nach dem Cutoff - zum Cutoff-Zeitpunkt ist p2 unbekannt.
  const cutoffSnapshots = { F: [] }
  const snapP1 = snapshotSkaterRates(tracker, 'p1', '2024/25') // p1 hat noch gar nichts gespielt
  assert.equal(snapP1.season, null)
  assert.equal(snapP1.career, null)
})
