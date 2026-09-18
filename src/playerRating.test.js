// ---------------------------------------------------------------------------
// Tests für die Player-Rating-Engine (src/playerRating.js) - synthetische,
// aber realistisch geformte Liga-Daten (gleiches game.playerStats-Format wie
// server/nlGameDetailSync.js tatsächlich erzeugt, siehe advancedStats.test.js
// für dasselbe Muster). Fokus: Positionslogik, Small-Sample-Verhalten,
// Data-Leakage-Schutz, Grenzen [0,100], keine NaN/Infinity, keine
// Übergewichtung einzelner Ausreisser-Komponenten (Goals-xG).
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculatePlayerRating, gamesBeforeDate, buildSkaterRatingBaselines, buildGoalieRatingBaselines,
  buildGoalieCareerBaseline, RATING_BLEND_WEIGHTS,
} from './playerRating.js'
import { buildPositionBaselines } from './playerHistory.js'

// ---------------------------------------------------------------------------
// Liga-Fixture-Generator - baut eine Baseline-Population (>= 20 Skater/Position,
// genug für SKATER_MIN_BASELINE_N) plus beliebige Zusatzspieler on top.
// ---------------------------------------------------------------------------

function skaterRow(playerId, i, gameIndex, overrides = {}) {
  const base = {
    playerId,
    goals: i % 5 === 0 ? 1 : 0,
    assists: i % 3 === 0 ? 1 : 0,
    sog: 2 + (i % 4),
    toiSec: 700 + (i % 6) * 40,
    toiEqSec: 500 + (i % 6) * 30,
    toiPpSec: i % 4 === 0 ? 60 + (i % 3) * 10 : 0,
    toiPkSec: i % 5 === 0 ? 40 + (i % 3) * 10 : 0,
    plusMinus: (i % 7) - 3,
    blockedShots: i % 6 === 0 ? 1 : 0,
    faceoffsWon: i % 4 === 0 ? 6 + (i % 3) : 0,
    faceoffsLost: i % 4 === 0 ? 4 + (i % 2) : 0,
    xg: 0.1 + ((i + gameIndex) % 5) * 0.04,
    powerplayGoals: i % 9 === 0 ? 1 : 0,
    powerplayAssists: i % 11 === 0 ? 1 : 0,
    shorthandedGoals: 0,
    shorthandedAssists: 0,
  }
  base.points = base.goals + base.assists
  return { ...base, ...overrides }
}

function goalieRow(playerId, i, overrides = {}) {
  const shotsAgainst = 24 + (i % 6)
  const goalsAgainst = 1 + (i % 4)
  const base = {
    playerId,
    saves: shotsAgainst - goalsAgainst,
    goalsAgainst,
    shotsAgainst,
    toiSec: 3600,
    shutout: goalsAgainst === 0,
  }
  return { ...base, ...overrides }
}

// Baut nlShots-Einträge für jeden Skater (GOAL/SOG-Typ-Schüsse, damit
// shotAttempts/xgPerShot berechenbar sind) - grob proportional zu sog/goals.
function shotsForSkaters(players, i_by_id, gameIndex) {
  const home = []
  for (const p of players) {
    if (p.position === 'G') continue
    const i = i_by_id.get(p.id)
    const row = skaterRow(p.id, i, gameIndex)
    for (let g = 0; g < row.goals; g++) home.push({ playerId: p.id, type: 'GOAL', sit: 'EQ', xg: 0.3 })
    for (let s = 0; s < row.sog - row.goals; s++) home.push({ playerId: p.id, type: 'SOG', sit: 'EQ', xg: 0.08 })
  }
  return { home, away: [] }
}

// `numForwards`/`numDefense`/`numGoalies` bilden die Baseline-Population,
// `gamesPerSkater` Spiele mit LEICHT variierender, aber deterministischer
// Verteilung (gleiches Muster wie buildSyntheticLeague() in
// advancedStats.test.js).
function buildLeague({ numForwards = 24, numDefense = 24, numGoalies = 8, gamesPerSkater = 12, datePrefix = '2026-10-' } = {}) {
  const players = []
  const i_by_id = new Map()
  for (let i = 0; i < numForwards; i++) { players.push({ id: `fwd${i}`, position: 'F' }); i_by_id.set(`fwd${i}`, i) }
  for (let i = 0; i < numDefense; i++) { players.push({ id: `def${i}`, position: 'D' }); i_by_id.set(`def${i}`, i) }
  for (let i = 0; i < numGoalies; i++) { players.push({ id: `glt${i}`, position: 'G' }); i_by_id.set(`glt${i}`, i) }

  const games = []
  for (let g = 0; g < gamesPerSkater; g++) {
    const playerStats = []
    for (const p of players) {
      const i = i_by_id.get(p.id)
      if (p.position === 'G') playerStats.push(goalieRow(p.id, i))
      else playerStats.push(skaterRow(p.id, i, g))
    }
    games.push({
      id: `g${g}`, date: `${datePrefix}${String(g + 1).padStart(2, '0')}`, status: 'final',
      playerStats, nlShots: shotsForSkaters(players, i_by_id, g),
    })
  }
  return { players, games, i_by_id }
}

function lastDate(games) { return games[games.length - 1].date }
function dayAfter(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// `maxGp` in components.blendWeights ist ABSICHTLICH Infinity (offene
// Obergrenze des 10+-Spiele-Buckets, siehe RATING_BLEND_WEIGHTS) - kein Bug,
// wird von der Prüfung bewusst ausgenommen.
function assertNoNaNOrInfinity(obj, path = 'root') {
  if (obj == null) return
  if (typeof obj === 'number') {
    if (path.endsWith('.maxGp')) return
    assert.ok(Number.isFinite(obj), `${path} is not finite: ${obj}`)
    return
  }
  if (Array.isArray(obj)) { obj.forEach((v, i) => assertNoNaNOrInfinity(v, `${path}[${i}]`)); return }
  if (typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) assertNoNaNOrInfinity(v, `${path}.${k}`) }
}

// ---------------------------------------------------------------------------
// gamesBeforeDate / Data-Leakage-Schutz (Auftrag Punkt 12)
// ---------------------------------------------------------------------------

test('gamesBeforeDate: nur status=final UND date < asOfDate (exklusiv)', () => {
  const games = [
    { id: 'a', date: '2026-10-01', status: 'final' },
    { id: 'b', date: '2026-10-05', status: 'final' },
    { id: 'c', date: '2026-10-05', status: 'scheduled' }, // gleiches Datum, aber nicht final
    { id: 'd', date: '2026-10-10', status: 'final' }, // "Zukunft" relativ zu asOfDate
  ]
  const out = gamesBeforeDate(games, '2026-10-05')
  assert.deepEqual(out.map((g) => g.id), ['a'])
})

test('calculatePlayerRating: ein Spiel NACH asOfDate verändert das Rating nicht (kein Data Leakage)', () => {
  const { players, games } = buildLeague()
  const cutoff = games[9].date // nach den ersten 10 Spielen
  const before = calculatePlayerRating('fwd0', games, { players, asOfDate: dayAfter(cutoff) })

  // Extreme "Zukunfts"-Spiele anhängen (weit nach dem Cutoff) - dürfen das
  // bereits berechnete Rating NICHT verändern.
  const futureGames = [...games]
  for (let g = 0; g < 5; g++) {
    futureGames.push({
      id: `future${g}`, date: `2026-12-${String(g + 1).padStart(2, '0')}`, status: 'final',
      playerStats: [{ playerId: 'fwd0', goals: 5, assists: 5, points: 10, sog: 10, toiSec: 1500, plusMinus: 5, xg: 0.1 }],
      nlShots: { home: [{ playerId: 'fwd0', type: 'GOAL', sit: 'EQ', xg: 0.1 }], away: [] },
    })
  }
  const after = calculatePlayerRating('fwd0', futureGames, { players, asOfDate: dayAfter(cutoff) })
  assert.deepEqual(before, after)
})

test('calculatePlayerRating: unbekannter Spieler liefert null (keine Position ableitbar)', () => {
  const { players, games } = buildLeague()
  assert.equal(calculatePlayerRating('does_not_exist', games, { players, asOfDate: dayAfter(lastDate(games)) }), null)
})

// ---------------------------------------------------------------------------
// Grundlegende Bounds/Robustheit über eine breite Stichprobe (Auftrag Punkt 14:
// "Rating bleibt zwischen 0 und 100", "Confidence bleibt zwischen 0 und 100",
// "keine NaN", "keine Infinity")
// ---------------------------------------------------------------------------

test('Rating/Confidence bleiben für ALLE Spieler der synthetischen Liga in [0,100], keine NaN/Infinity', () => {
  const { players, games } = buildLeague()
  const asOfDate = dayAfter(lastDate(games))
  for (const p of players) {
    const r = calculatePlayerRating(p.id, games, { players, asOfDate })
    assert.ok(r, `Rating für ${p.id} sollte nicht null sein (genug Spiele vorhanden)`)
    for (const key of ['overall', 'confidence', 'offense', 'defense', 'specialTeams', 'usage', 'form']) {
      const v = r[key]
      if (v != null) {
        assert.ok(Number.isFinite(v), `${p.id}.${key} ist nicht endlich: ${v}`)
        assert.ok(v >= 0 && v <= 100, `${p.id}.${key}=${v} ausserhalb [0,100]`)
      }
    }
    assert.ok(r.confidence >= 0 && r.confidence <= 100)
    assertNoNaNOrInfinity(r, p.id)
  }
})

// ---------------------------------------------------------------------------
// Positionslogik (Auftrag Punkt 3/9)
// ---------------------------------------------------------------------------

test('Elite Forward: deutlich überdurchschnittliche Offense-Stats ergeben ein hohes Overall-Rating', () => {
  const { players, games } = buildLeague()
  const eliteGames = games.map((g, gi) => ({
    ...g,
    playerStats: [...g.playerStats, skaterRow('eliteF', 999, gi, {
      goals: 2, assists: 2, points: 4, sog: 8, toiSec: 1400, toiPpSec: 180, plusMinus: 3, xg: 0.3,
      faceoffsWon: 10, faceoffsLost: 3, powerplayGoals: 1, powerplayAssists: 1,
    })],
    nlShots: {
      home: [...g.nlShots.home,
        { playerId: 'eliteF', type: 'GOAL', sit: 'EQ', xg: 0.3 }, { playerId: 'eliteF', type: 'GOAL', sit: 'PP', xg: 0.3 },
        { playerId: 'eliteF', type: 'SOG', sit: 'EQ', xg: 0.1 }, { playerId: 'eliteF', type: 'SOG', sit: 'EQ', xg: 0.1 },
        { playerId: 'eliteF', type: 'SOG', sit: 'EQ', xg: 0.1 }, { playerId: 'eliteF', type: 'SOG', sit: 'EQ', xg: 0.1 },
        { playerId: 'eliteF', type: 'SOG', sit: 'EQ', xg: 0.1 }, { playerId: 'eliteF', type: 'SOG', sit: 'EQ', xg: 0.1 },
      ],
      away: g.nlShots.away,
    },
  }))
  const playersWithElite = [...players, { id: 'eliteF', position: 'F' }]
  const r = calculatePlayerRating('eliteF', eliteGames, { players: playersWithElite, asOfDate: dayAfter(lastDate(games)) })
  assert.ok(r.overall > 75, `Elite-Forward-Overall zu niedrig: ${r.overall}`)
  assert.ok(r.offense > 75, `Elite-Forward-Offense zu niedrig: ${r.offense}`)
  assert.equal(r.position, 'F')
})

test('durchschnittlicher Forward (Teil der Baseline-Population selbst) liegt nahe der Mitte', () => {
  const { players, games } = buildLeague()
  const r = calculatePlayerRating('fwd3', games, { players, asOfDate: dayAfter(lastDate(games)) })
  assert.ok(r.overall > 25 && r.overall < 75, `Overall für einen Baseline-Durchschnittsspieler unerwartet extrem: ${r.overall}`)
})

test('Defenseman: hoher +/-, viele Blocks, viel PK-TOI ergeben ein hohes Defense-Rating', () => {
  const { players, games } = buildLeague()
  const eliteGames = games.map((g, gi) => ({
    ...g,
    playerStats: [...g.playerStats, skaterRow('eliteD', 999, gi, {
      goals: 0, assists: 1, points: 1, sog: 2, toiSec: 1500, toiPkSec: 200, plusMinus: 4, blockedShots: 3, xg: 0.05,
      faceoffsWon: 0, faceoffsLost: 0,
    })],
  }))
  const playersWithElite = [...players, { id: 'eliteD', position: 'D' }]
  const r = calculatePlayerRating('eliteD', eliteGames, { players: playersWithElite, asOfDate: dayAfter(lastDate(games)) })
  assert.ok(r.defense > 70, `Elite-Defenseman-Defense zu niedrig: ${r.defense}`)
  assert.equal(r.position, 'D')
})

test('Goalie: hohe SV%/niedrige GAA ergeben ein hohes Overall-/Defense-Rating, offense/specialTeams sind null', () => {
  const { players, games } = buildLeague()
  const eliteGames = games.map((g) => ({
    ...g,
    playerStats: [...g.playerStats, goalieRow('eliteG', 999, { saves: 32, goalsAgainst: 1, shotsAgainst: 33, toiSec: 3600, shutout: false })],
  }))
  const playersWithElite = [...players, { id: 'eliteG', position: 'G' }]
  const r = calculatePlayerRating('eliteG', eliteGames, { players: playersWithElite, asOfDate: dayAfter(lastDate(games)) })
  assert.equal(r.position, 'G')
  assert.equal(r.offense, null)
  assert.equal(r.specialTeams, null)
  assert.ok(r.defense > 70, `Elite-Goalie-Defense (Shot-Stopping) zu niedrig: ${r.defense}`)
  assert.ok(r.overall > 60, `Elite-Goalie-Overall zu niedrig: ${r.overall}`)
})

// ---------------------------------------------------------------------------
// Small Sample (Auftrag Punkt 5)
// ---------------------------------------------------------------------------

test('Spieler mit 1 Spiel: career-lastiges Blending (1-4-GP-Bucket), keine Form (< 5 Spiele)', () => {
  const { players, games } = buildLeague()
  const oneGame = [{
    id: 'solo1', date: '2026-11-01', status: 'final',
    playerStats: [{ playerId: 'rookie1', goals: 1, assists: 0, points: 1, sog: 3, toiSec: 600, plusMinus: 1, xg: 0.2 }],
    nlShots: { home: [{ playerId: 'rookie1', type: 'GOAL', sit: 'EQ', xg: 0.2 }, { playerId: 'rookie1', type: 'SOG', sit: 'EQ', xg: 0.1 }], away: [] },
  }]
  const playersWithRookie = [...players, { id: 'rookie1', position: 'F' }]
  const r = calculatePlayerRating('rookie1', oneGame, { players: playersWithRookie, asOfDate: '2026-11-02' })
  assert.equal(r.sampleSize.currentSeasonGp, 1)
  assert.equal(r.form, null)
  const expected = RATING_BLEND_WEIGHTS.find((w) => 1 <= w.maxGp)
  assert.deepEqual(r.components.blendWeights, expected)
  assert.equal(r.components.blendWeights.career, 0.75)
})

test('Spieler mit 5 Spielen: 5-9-GP-Bucket, Form JETZT verfügbar (last5)', () => {
  const { players, games } = buildLeague()
  const fiveGames = games.slice(0, 5).map((g, gi) => ({
    ...g,
    playerStats: [...g.playerStats, skaterRow('midSample', 2, gi, { goals: 1 })],
  }))
  const playersWithMid = [...players, { id: 'midSample', position: 'F' }]
  const r = calculatePlayerRating('midSample', fiveGames, { players: playersWithMid, asOfDate: dayAfter(lastDate(fiveGames)) })
  assert.equal(r.sampleSize.currentSeasonGp, 5)
  assert.notEqual(r.form, null)
  assert.equal(r.components.blendWeights.career, 0.45)
  assert.equal(r.components.blendWeights.form, 0.20)
})

test('Spieler mit 20+ Spielen: "normale" Gewichtung (10+-GP-Bucket), Form nutzt last10', () => {
  const { players, games } = buildLeague({ gamesPerSkater: 22 })
  const r = calculatePlayerRating('fwd5', games, { players, asOfDate: dayAfter(lastDate(games)) })
  assert.equal(r.sampleSize.currentSeasonGp, 22)
  assert.notEqual(r.form, null)
  assert.equal(r.components.blendWeights.career, 0.25)
  assert.equal(r.components.blendWeights.current, 0.50)
})

// ---------------------------------------------------------------------------
// Fehlende Signale - graceful degradation statt Absturz/erfundener Werte
// (Auftrag Punkt 14)
// ---------------------------------------------------------------------------

test('Spieler ohne xG-Daten: Offense weiterhin berechenbar aus den übrigen Komponenten', () => {
  const { players, games } = buildLeague()
  const noXgGames = games.map((g, gi) => ({
    ...g,
    playerStats: [...g.playerStats, { playerId: 'noXg', goals: 1, assists: 1, points: 2, sog: 4, toiSec: 900, plusMinus: 1 }],
    // KEIN nlShots-Eintrag für diesen Spieler -> xg/shotAttempts bleiben null
  }))
  const playersWithNoXg = [...players, { id: 'noXg', position: 'F' }]
  const r = calculatePlayerRating('noXg', noXgGames, { players: playersWithNoXg, asOfDate: dayAfter(lastDate(games)) })
  assert.equal(r.components.rates.xgPerGame, null)
  assert.notEqual(r.offense, null)
  assertNoNaNOrInfinity(r)
})

test('Spieler ohne Faceoff-Daten: Usage weiterhin berechenbar (Faceoff% nur Bonus-Komponente)', () => {
  const { players, games } = buildLeague()
  const noFoGames = games.map((g, gi) => ({
    ...g,
    playerStats: [...g.playerStats, skaterRow('noFo', 6, gi, { faceoffsWon: 0, faceoffsLost: 0 })],
  }))
  const playersWithNoFo = [...players, { id: 'noFo', position: 'F' }]
  const r = calculatePlayerRating('noFo', noFoGames, { players: playersWithNoFo, asOfDate: dayAfter(lastDate(games)) })
  assert.equal(r.components.rates.faceoffPercentage, null)
  assert.notEqual(r.usage, null)
})

test('Spieler ohne PP/PK-Daten: specialTeams bleibt null (kein erfundener Wert), overall trotzdem berechenbar', () => {
  const { players, games } = buildLeague()
  const noSpecialGames = games.map((g, gi) => ({
    ...g,
    playerStats: [...g.playerStats, {
      playerId: 'noSpecial', goals: 1, assists: 0, points: 1, sog: 3, toiSec: 900, toiEqSec: 900,
      plusMinus: 0, xg: 0.15,
      // keine toiPpSec/toiPkSec/powerplayGoals/powerplayAssists/shorthandedGoals/shorthandedAssists
    }],
  }))
  const playersWithNoSpecial = [...players, { id: 'noSpecial', position: 'F' }]
  const r = calculatePlayerRating('noSpecial', noSpecialGames, { players: playersWithNoSpecial, asOfDate: dayAfter(lastDate(games)) })
  assert.equal(r.specialTeams, null)
  assert.notEqual(r.overall, null)
  assertNoNaNOrInfinity(r)
})

// ---------------------------------------------------------------------------
// Ausreisser-Schutz (Auftrag Punkt 4/8: "keine Übergewichtung einzelner
// extremer Werte, insbesondere Goals-xG")
// ---------------------------------------------------------------------------

test('extrem hohe Shooting-Percentage (1 Schuss, 1 Tor) dominiert das Rating nicht (Clamp greift)', () => {
  const { players, games } = buildLeague()
  const extremeGames = games.slice(0, 3).map((g, gi) => ({
    ...g,
    playerStats: [...g.playerStats, { playerId: 'hotShot', goals: gi === 0 ? 1 : 0, assists: 0, points: gi === 0 ? 1 : 0, sog: gi === 0 ? 1 : 0, toiSec: 500, plusMinus: 0, xg: 0.05 }],
  }))
  const playersWithHot = [...players, { id: 'hotShot', position: 'F' }]
  const r = calculatePlayerRating('hotShot', extremeGames, { players: playersWithHot, asOfDate: dayAfter(lastDate(extremeGames)) })
  assert.ok(r.overall <= 100 && r.offense <= 100)
  assertNoNaNOrInfinity(r)
})

test('hohe Goals-xG-Abweichung (2 Tore bei 0.4 xG in einem Spiel) hebt Offense nur moderat, nicht extrem an', () => {
  const { players, games } = buildLeague()
  const baseRow = (gi) => skaterRow('control', 4, gi, { goals: 0, assists: 1, points: 1, sog: 3, xg: 0.2 })
  const deviationRow = (gi) => skaterRow('deviant', 4, gi, { goals: 2, assists: 0, points: 2, sog: 2, xg: 0.2 })
  // "deviant" bekommt am ERSTEN Spiel die extreme Abweichung (2 Tore, xg 0.4
  // fürs gesamte Spiel statt 0.2) - alle anderen Werte identisch zu "control".
  const testGames = games.slice(0, 3).map((g, gi) => ({
    ...g,
    playerStats: [...g.playerStats, baseRow(gi), gi === 0 ? { ...deviationRow(gi), xg: 0.4 } : deviationRow(gi)],
  }))
  const playersExt = [...players, { id: 'control', position: 'F' }, { id: 'deviant', position: 'F' }]
  const asOfDate = dayAfter(lastDate(testGames))
  const rControl = calculatePlayerRating('control', testGames, { players: playersExt, asOfDate })
  const rDeviant = calculatePlayerRating('deviant', testGames, { players: playersExt, asOfDate })
  // "deviant" hat klar mehr Tore -> darf höher liegen, aber die Differenz darf
  // nicht durch eine einzelne Goals-xG-Ausreisser-Komponente explodieren.
  assert.ok(rDeviant.offense > rControl.offense, 'mehr Tore sollten das Offense-Rating klar anheben')
  assert.ok(rDeviant.offense - rControl.offense < 40, `Differenz zu extrem, Goals-xG scheint übergewichtet: ${rDeviant.offense - rControl.offense}`)
})

// ---------------------------------------------------------------------------
// Struktur-Vertrag (Auftrag Punkt 13)
// ---------------------------------------------------------------------------

test('Rückgabestruktur enthält alle geforderten Top-Level-Felder', () => {
  const { players, games } = buildLeague()
  const r = calculatePlayerRating('fwd0', games, { players, asOfDate: dayAfter(lastDate(games)) })
  for (const key of ['overall', 'confidence', 'offense', 'defense', 'specialTeams', 'usage', 'form', 'sampleSize', 'position', 'components']) {
    assert.ok(key in r, `Feld ${key} fehlt in der Rating-Struktur`)
  }
  assert.ok('currentSeasonGp' in r.sampleSize)
  assert.ok('careerGp' in r.sampleSize)
})

// ---------------------------------------------------------------------------
// Baseline-Hilfsfunktionen - eigenständig testbar
// ---------------------------------------------------------------------------

test('buildSkaterRatingBaselines: liefert F/D getrennt, n = Anzahl Spieler mit Saison-Daten', () => {
  const { players, games } = buildLeague()
  const b = buildSkaterRatingBaselines(players, games)
  assert.equal(b.F.n, 24)
  assert.equal(b.D.n, 24)
  assert.ok(b.F.pointsPerGame.std > 0)
})

test('buildGoalieRatingBaselines: n = Anzahl Torhüter mit Saison-Daten', () => {
  const { players, games } = buildLeague()
  const b = buildGoalieRatingBaselines(players, games)
  assert.equal(b.n, 8)
  assert.ok(b.savePct.mean > 0 && b.savePct.mean < 1)
})

test('buildGoalieCareerBaseline: liefert n und plausible SV%-Bandbreite aus dem historischen Archiv', () => {
  const playerHistoryData = {
    players: {
      p1: { seasons: [{ season: '2020/21', gp: 30, saves: 700, goalsAgainst: 60, shotsAgainst: 760, toiSec: 90000 }] },
      p2: { seasons: [{ season: '2020/21', gp: 25, saves: 550, goalsAgainst: 50, shotsAgainst: 600, toiSec: 75000 }] },
    },
  }
  const b = buildGoalieCareerBaseline(playerHistoryData)
  assert.equal(b.n, 2)
  assert.ok(b.savePct.mean > 0.85 && b.savePct.mean < 1)
})
