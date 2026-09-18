// ---------------------------------------------------------------------------
// Tests für die zentrale Advanced-Stats-Berechnungsebene (src/advancedStats.js) -
// synthetische, aber realistische game.playerStats-Objekte (Form, wie sie
// server/nlGameDetailSync.js tatsächlich erzeugt), keine erfundenen Fälle.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectPlayerGameStats, computeAdvancedStats, computeRollingAdvancedStats, computePlayerAdvancedStats,
  buildAdvancedBaselines, computeAdvancedPercentile, computeCurrentSeasonAdvancedScore,
  collectPlayerShots, describeGoalsVsXg,
} from './advancedStats.js'

function game(id, date, playerStats, nlShots) {
  return { id, date, status: 'final', homeTeamId: 'team_a', awayTeamId: 'team_b', playerStats, nlShots }
}

test('collectPlayerGameStats: nur abgeschlossene Spiele mit einer Zeile für diesen Spieler, chronologisch', () => {
  const games = [
    game('g3', '2026-10-03', [{ playerId: 'p1', goals: 1 }]),
    { id: 'g_scheduled', date: '2026-10-05', status: 'scheduled', playerStats: [{ playerId: 'p1', goals: 9 }] },
    game('g1', '2026-10-01', [{ playerId: 'p1', goals: 0 }]),
    game('g2', '2026-10-02', [{ playerId: 'other', goals: 5 }]),
  ]
  const rows = collectPlayerGameStats(games, 'p1')
  assert.deepEqual(rows.map((r) => r.game.id), ['g1', 'g3'])
})

test('computeAdvancedStats: P/GP, G/GP, A/GP, SOG%, xG korrekt aus realistischen Boxscore-Zeilen', () => {
  const rows = [
    { s: { goals: 1, assists: 1, points: 2, sog: 4, xg: 0.3 } },
    { s: { goals: 0, assists: 2, points: 2, sog: 2, xg: 0.15 } },
  ]
  const out = computeAdvancedStats(rows)
  assert.equal(out.gp, 2)
  assert.equal(out.pointsPerGame, 2)
  assert.equal(out.goalsPerGame, 0.5)
  assert.equal(out.assistsPerGame, 1.5)
  assert.equal(out.sogPerGame, 3)
  assert.ok(Math.abs(out.shootingPercentage - 1 / 6) < 1e-9) // 1 Tor / 6 SOG
  assert.ok(Math.abs(out.xg - 0.45) < 1e-9)
  assert.ok(Math.abs(out.goalsMinusXg - 0.55) < 1e-9) // 1 Tor - 0.45 xG
})

test('computeAdvancedStats: fehlende Felder liefern null statt geschätzter Werte', () => {
  const rows = [{ s: { goals: 1 } }, { s: { goals: 2 } }] // keine sog/xg/faceoffs/toi
  const out = computeAdvancedStats(rows)
  assert.equal(out.goalsPerGame, 1.5)
  assert.equal(out.sogPerGame, null)
  assert.equal(out.shootingPercentage, null)
  assert.equal(out.xg, null)
  assert.equal(out.xgPerShot, null)
  assert.equal(out.faceoffPercentage, null)
  assert.equal(out.toiPerGame, null)
})

test('computeAdvancedStats: faceoffPercentage aus Summe won/lost über mehrere Spiele (nicht Mittel der Einzel-%)', () => {
  const rows = [
    { s: { faceoffsWon: 8, faceoffsLost: 2 } }, // 80%
    { s: { faceoffsWon: 1, faceoffsLost: 9 } }, // 10%
  ]
  const out = computeAdvancedStats(rows)
  // Gesamt: 9 gewonnen / 20 total = 45% - NICHT der einfache Mittelwert (80+10)/2=45% (zufällig gleich hier,
  // daher zusätzlich Rohdaten geprüft, um die tatsächliche Summenbildung zu verifizieren statt Mittelwertbildung)
  assert.equal(out.raw.faceoffsWon, 9)
  assert.equal(out.raw.faceoffsTotal, 20)
  assert.ok(Math.abs(out.faceoffPercentage - 0.45) < 1e-9)
})

test('computeAdvancedStats: null bei leerer Zeilenmenge', () => {
  assert.equal(computeAdvancedStats([]), null)
  assert.equal(computeAdvancedStats(null), null)
})

test('computeRollingAdvancedStats: null unterhalb der Fenstergrösse n, sonst nur die letzten n Spiele', () => {
  const rows = [1, 2, 3, 4].map((i) => ({ s: { goals: i } }))
  assert.equal(computeRollingAdvancedStats(rows, 5), null)
  const last3 = computeRollingAdvancedStats(rows, 3)
  assert.equal(last3.gp, 3)
  assert.equal(last3.raw.goals, 2 + 3 + 4) // die letzten 3 Spiele (goals=2,3,4), nicht die ersten 3
})

test('computePlayerAdvancedStats: season/last5/last10 konsistent aus denselben Rohdaten', () => {
  const games = []
  for (let i = 1; i <= 12; i++) {
    games.push(game(`g${i}`, `2026-10-${String(i).padStart(2, '0')}`, [{ playerId: 'p1', goals: 1, sog: 3, xg: 0.2 }]))
  }
  const out = computePlayerAdvancedStats(games, 'p1')
  assert.equal(out.season.gp, 12)
  assert.equal(out.last5.gp, 5)
  assert.equal(out.last10.gp, 10)
  assert.equal(out.gamesTotal, 12)
})

test('computeAdvancedStats: xgPerShot nutzt die rohen Schuss-Versuche (GOAL+SOG+MISS+BLOCK), nicht die Boxscore-sog-Zahl', () => {
  const shots = { home: [
    { playerId: 'p1', type: 'GOAL', xg: 0.3 },
    { playerId: 'p1', type: 'MISS', xg: 0.05 },
    { playerId: 'p1', type: 'BLOCK', xg: 0.02 },
  ], away: [] }
  const g = game('g1', '2026-10-01', [{ playerId: 'p1', goals: 1, sog: 1, xg: 0.35 }], shots)
  const rows = collectPlayerGameStats([g], 'p1')
  const out = computeAdvancedStats(rows)
  assert.equal(out.raw.shotAttempts, 3) // 3 rohe Schuss-Versuche, nicht die sog=1 aus der Boxscore-Zeile
  assert.ok(Math.abs(out.xgPerShot - 0.35 / 3) < 1e-9)
})

// ---------------------------------------------------------------------------
// Baselines / Perzentile / "Season Impact Signal" (Auftrag Punkt 10/11)
// ---------------------------------------------------------------------------

// Baut eine synthetische Liga: 25 Stürmer (genug für MIN_BASELINE_N=20),
// jeder mit 10 Spielen und leicht unterschiedlicher P/GP-Rate (0.10..0.34),
// damit die Baseline eine echte Streuung hat statt lauter identischer Werte.
function buildSyntheticLeague() {
  const players = []
  const games = []
  for (let p = 0; p < 25; p++) {
    players.push({ id: `fwd${p}`, position: 'F' })
  }
  for (let g = 0; g < 10; g++) {
    const playerStats = players.map((pl, i) => ({
      playerId: pl.id,
      goals: (i % 5 === 0) ? 1 : 0,
      assists: (i % 3 === 0) ? 1 : 0,
      points: ((i % 5 === 0) ? 1 : 0) + ((i % 3 === 0) ? 1 : 0),
      sog: 2 + (i % 4),
      toiSec: 600 + i * 20,
      xg: 0.1 + (i % 5) * 0.05,
    }))
    games.push({ id: `g${g}`, date: `2026-10-${String(g + 1).padStart(2, '0')}`, status: 'final', playerStats })
  }
  return { players, games }
}

test('buildAdvancedBaselines: liefert Mittel/Std je Position, n = Anzahl Spieler mit Saison-Daten', () => {
  const { players, games } = buildSyntheticLeague()
  const baselines = buildAdvancedBaselines(players, games)
  assert.equal(baselines.Stürmer.n, 25)
  assert.ok(baselines.Stürmer.pointsPerGame.mean > 0)
  assert.ok(baselines.Stürmer.pointsPerGame.std > 0)
  assert.equal(baselines.Verteidiger.n, 0)
})

test('computeAdvancedPercentile: höherer Wert -> höheres Perzentil, null unter Mindest-Stichprobe', () => {
  const { players, games } = buildSyntheticLeague()
  const baselines = buildAdvancedBaselines(players, games)
  const low = computeAdvancedPercentile(0.01, 'Stürmer', 'pointsPerGame', baselines)
  const high = computeAdvancedPercentile(5, 'Stürmer', 'pointsPerGame', baselines)
  assert.ok(low < high)
  assert.ok(low >= 0 && low <= 100 && high >= 0 && high <= 100)
  // Verteidiger-Baseline hat n=0 < MIN_BASELINE_N -> kein Perzentil
  assert.equal(computeAdvancedPercentile(1, 'Verteidiger', 'pointsPerGame', baselines), null)
  assert.equal(computeAdvancedPercentile(null, 'Stürmer', 'pointsPerGame', baselines), null)
})

test('computeCurrentSeasonAdvancedScore: liegt in [0,100], null ohne Baseline/Saison-Daten', () => {
  const { players, games } = buildSyntheticLeague()
  const baselines = buildAdvancedBaselines(players, games)
  const season = computeAdvancedStats(collectPlayerGameStats(games, 'fwd10'))
  const score = computeCurrentSeasonAdvancedScore(season, 'Stürmer', baselines)
  assert.ok(score.score >= 0 && score.score <= 100)
  assert.ok(score.componentsUsed > 0)
  assert.equal(computeCurrentSeasonAdvancedScore(null, 'Stürmer', baselines), null)
  assert.equal(computeCurrentSeasonAdvancedScore(season, 'Torhüter', baselines), null)
})

test('Goalies: keine Feldspieler-Baseline/-Perzentile, keine NaN', () => {
  const games = [{ id: 'g1', date: '2026-10-01', status: 'final', playerStats: [{ playerId: 'g1p', goalsAgainstNl: 2, savesNl: 20, shotsAgainst: 22 }] }]
  const rows = collectPlayerGameStats(games, 'g1p')
  const out = computeAdvancedStats(rows)
  // Torhüter-Felder tauchen in computeAdvancedStats (Feldspieler-orientiert) nicht auf -> alles null, aber kein Crash/NaN
  assert.equal(out.goalsPerGame, null)
  assert.equal(out.xg, null)
  for (const v of Object.values(out)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v))
  }
})

// ---------------------------------------------------------------------------
// Shots / xG-Beschreibung (Auftrag Punkt 3/4)
// ---------------------------------------------------------------------------

test('collectPlayerShots: nur Schüsse des Spielers, aus final-Spielen, chronologisch, unveränderte Koordinaten', () => {
  const games = [
    {
      id: 'g2', date: '2026-10-02', status: 'final',
      nlShots: { home: [{ playerId: 'p1', type: 'SOG', x: 12, y: 5, gameSecond: 300, xg: 0.1 }], away: [{ playerId: 'other', type: 'GOAL', x: 1, y: 1, gameSecond: 100 }] },
    },
    { id: 'g_sched', date: '2026-10-03', status: 'scheduled', nlShots: { home: [{ playerId: 'p1', type: 'GOAL', x: 9, y: 9 }], away: [] } },
    {
      id: 'g1', date: '2026-10-01', status: 'final',
      nlShots: { home: [], away: [{ playerId: 'p1', type: 'MISS', x: 20, y: 15, gameSecond: 50, xg: 0.02 }] },
    },
  ]
  const shots = collectPlayerShots(games, 'p1')
  assert.equal(shots.length, 2)
  assert.deepEqual(shots.map((s) => s.gameId), ['g1', 'g2']) // chronologisch nach Datum
  assert.equal(shots[0].x, 20) // Rohkoordinate unverändert übernommen
  assert.equal(shots[0].y, 15)
})

test('collectPlayerShots: leeres Array (kein Crash), wenn game.nlShots fehlt', () => {
  const games = [{ id: 'g1', date: '2026-10-01', status: 'final' }]
  assert.deepEqual(collectPlayerShots(games, 'p1'), [])
})

test('describeGoalsVsXg: neutrale, datenbeschreibende Sätze ohne "Lucky/Unlucky"-Label', () => {
  const more = describeGoalsVsXg(8, 4.2)
  const less = describeGoalsVsXg(2, 6.1)
  const about = describeGoalsVsXg(5, 4.6)
  assert.match(more, /mehr Tore/)
  assert.match(less, /weniger Tore/)
  assert.match(about, /entsprechen etwa/)
  for (const s of [more, less, about]) {
    assert.doesNotMatch(s.toLowerCase(), /lucky|unlucky|glück|pech/)
  }
  assert.equal(describeGoalsVsXg(null, 4), null)
  assert.equal(describeGoalsVsXg(4, null), null)
})
