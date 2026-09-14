// ---------------------------------------------------------------------------
// Sanity-Checks für die Monte-Carlo-Simulation (src/playoffSim.js):
//   - Positions-Matrix: jede Team-Zeile summiert über alle Ränge zu `runs`
//   - Bracket-Summen über alle Teams entsprechen dem Turnierformat
//     (Top6=6, Playoffs=8, Play-in=4, Meister=1, Play-out=2, Ligaqual=1)
//   - Determinismus: gleicher Seed -> byte-identisches Ergebnis
//   - Keine NaN/Infinity, alle Wahrscheinlichkeiten in [0,1]
//   - What-if (Overrides): voll vorgegebener Spielplan -> deterministische
//     Endtabelle (P=100% je Rang); Determinismus bei Teil-Overrides
//   - Swing-Analyse: liefert für jedes Spiel eines Spieltags plausible,
//     endliche Max-/Expected-Swing-Werte
// Nutzt server/data/seed.json (committed, im Gegensatz zu db.json) als
// deterministische Datengrundlage - unabhängig vom aktuellen Saisonstand.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  simulateSeasonProjections, computeMatchForecasts, computeSwingAnalysisForMatchday, SWING_CATEGORIES,
  filterLockedRuns, computePointsTargets, LOCK_MIN_SAMPLE, POINTS_CONFIDENCE_LEVELS, POINTS_TARGET_CATEGORIES,
} from './playoffSim.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED_PATH = path.join(__dirname, '..', 'server', 'data', 'seed.json')
const db = JSON.parse(readFileSync(SEED_PATH, 'utf-8'))
const { teams, games, players, settings } = db

const PROB_FIELDS = [
  'pPlayoffs', 'pTop6', 'pTop4', 'pPlayIn', 'pSemifinal', 'pFinal',
  'pChampion', 'pPlayout1314', 'pLigaQualifikation',
]

test('Positions-Matrix: jede Team-Zeile summiert über alle Ränge zu runs', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 2000, seed: 777, players })
  for (const row of sim.rows) {
    const total = Object.values(row.rankDistribution).reduce((a, b) => a + b, 0)
    assert.equal(total, sim.runs, `${row.team.name}: Summe Rangverteilung (${total}) != runs (${sim.runs})`)
  }
})

test('Bracket-Summen über alle Teams entsprechen dem Turnierformat (14 Teams)', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 2000, seed: 777, players })
  assert.ok(sim.bracketSimulated, 'Bracket-Simulation sollte bei 14 Teams laufen')

  const sumRuns = (field) => Math.round(sim.rows.reduce((s, r) => s + r[field], 0) * sim.runs)
  assert.equal(sumRuns('pTop6'), 6 * sim.runs, 'Top6 muss über alle Teams 6 ergeben')
  assert.equal(sumRuns('pPlayoffs'), 8 * sim.runs, 'Playoffs (VF-Teilnehmer) muss über alle Teams 8 ergeben')
  assert.equal(sumRuns('pPlayIn'), 4 * sim.runs, 'Play-in muss über alle Teams 4 ergeben')
  assert.equal(sumRuns('pChampion'), 1 * sim.runs, 'Meister muss über alle Teams 1 ergeben')
  assert.equal(sumRuns('pPlayout1314'), 2 * sim.runs, 'Play-out 13/14 muss über alle Teams 2 ergeben')
  assert.equal(sumRuns('pLigaQualifikation'), 1 * sim.runs, 'Ligaqualifikation muss über alle Teams 1 ergeben')
})

test('Determinismus: gleicher Seed -> identisches Ergebnis (Aggregate + Median/σ)', () => {
  const a = simulateSeasonProjections(teams, games, settings, { runs: 1500, seed: 42, players })
  const b = simulateSeasonProjections(teams, games, settings, { runs: 1500, seed: 42, players })
  assert.equal(a.rows.length, b.rows.length)
  for (let i = 0; i < a.rows.length; i++) {
    assert.equal(a.rows[i].team.id, b.rows[i].team.id)
    assert.equal(a.rows[i].pChampion, b.rows[i].pChampion)
    assert.equal(a.rows[i].avgRank, b.rows[i].avgRank)
    assert.equal(a.rows[i].medianRank, b.rows[i].medianRank)
    assert.equal(a.rows[i].stdDevRank, b.rows[i].stdDevRank)
    assert.equal(a.rows[i].medianPts, b.rows[i].medianPts)
    assert.equal(a.rows[i].stdDevPts, b.rows[i].stdDevPts)
  }
})

test('N wählbar (1k-10k): kleinere/grössere Laufzahl funktioniert und skaliert die Rangverteilung', () => {
  for (const runs of [1000, 5000, 10000]) {
    const sim = simulateSeasonProjections(teams, games, settings, { runs, seed: 99, players })
    assert.equal(sim.runs, runs)
    const total = Object.values(sim.rows[0].rankDistribution).reduce((a, b) => a + b, 0)
    assert.equal(total, runs)
  }
})

test('Keine NaN/Infinity, alle Bracket-Wahrscheinlichkeiten in [0,1]', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 1000, seed: 5, players })
  for (const row of sim.rows) {
    for (const field of PROB_FIELDS) {
      const v = row[field]
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${row.team.name}.${field} = ${v}`)
    }
    assert.ok(Number.isFinite(row.avgRank) && Number.isFinite(row.medianRank) && Number.isFinite(row.stdDevRank))
    assert.ok(Number.isFinite(row.avgPts) && Number.isFinite(row.medianPts) && Number.isFinite(row.stdDevPts))
  }
})

test('What-if: voll vorgegebener Spielplan liefert deterministische Endtabelle (P=100% je Rang)', () => {
  const scheduled = games.filter((g) => g.status === 'scheduled')
  const overrides = {}
  scheduled.forEach((g, i) => { overrides[g.id] = i % 2 === 0 ? 'HOME_REG' : 'AWAY_REG' })

  const sim = simulateSeasonProjections(teams, games, settings, { runs: 300, seed: 1, players, overrides })
  assert.ok(sim, 'Simulation darf bei voll abgedecktem Spielplan nicht null zurückgeben')
  assert.equal(sim.scheduledCount, 0, 'Alle Spiele sind fix vorgegeben -> keine unsimulierten Fixtures mehr')

  for (const row of sim.rows) {
    assert.equal(row.stdDevRank, 0, `${row.team.name}: σ-Rang muss 0 sein (Regular Season vollständig fix)`)
    const nonZero = Object.entries(row.rankDistribution).filter(([, c]) => c > 0)
    assert.equal(nonZero.length, 1, `${row.team.name}: genau ein Rang mit P>0 erwartet`)
    assert.equal(nonZero[0][1], sim.runs, `${row.team.name}: dieser Rang muss P=100% (=runs) haben`)
  }
  // Playoff-/Play-in-/Play-out-Serien bleiben zufällig (nicht Teil der Overrides) -
  // Bracket-Summen müssen trotzdem weiterhin exakt dem Turnierformat entsprechen.
  const sumRuns = (field) => Math.round(sim.rows.reduce((s, r) => s + r[field], 0) * sim.runs)
  assert.equal(sumRuns('pChampion'), 1 * sim.runs)
  assert.equal(sumRuns('pPlayoffs'), 8 * sim.runs)
})

test('What-if: Determinismus bei Teil-Overrides mit festem Seed', () => {
  const scheduled = games.filter((g) => g.status === 'scheduled')
  const overrides = { [scheduled[0].id]: 'HOME_OT', [scheduled[1].id]: 'AWAY_REG' }
  const a = simulateSeasonProjections(teams, games, settings, { runs: 800, seed: 55, players, overrides })
  const b = simulateSeasonProjections(teams, games, settings, { runs: 800, seed: 55, players, overrides })
  for (let i = 0; i < a.rows.length; i++) {
    assert.equal(a.rows[i].pChampion, b.rows[i].pChampion)
    assert.equal(a.rows[i].pPlayoffs, b.rows[i].pPlayoffs)
  }
})

test('Swing-Analyse: endliche, plausible Max-/Expected-Swing-Werte pro Spiel/Team/Kategorie', () => {
  const forecasts = computeMatchForecasts(teams, games, settings, players)
  const firstDate = forecasts[0].date
  const matchdayGameIds = forecasts.filter((f) => f.date === firstDate).map((f) => f.gameId)
  assert.ok(matchdayGameIds.length > 0, 'erster Spieltag sollte mindestens ein Spiel haben')

  const baseResults = simulateSeasonProjections(teams, games, settings, { runs: 1000, seed: 999, players })
  const swing = computeSwingAnalysisForMatchday(teams, games, settings, matchdayGameIds, {
    runs: 500, seed: 999, players, baseResults, forecasts,
  })

  assert.equal(swing.length, matchdayGameIds.length)
  // Absteigend nach Einfluss sortiert
  for (let i = 1; i < swing.length; i++) assert.ok(swing[i - 1].influence >= swing[i].influence)

  for (const game of swing) {
    assert.ok(Number.isFinite(game.influence) && game.influence >= 0)
    for (const t of game.teams) {
      for (const cat of SWING_CATEGORIES) {
        const c = t.categories[cat.key]
        assert.ok(Number.isFinite(c.maxSwing) && c.maxSwing >= 0 && c.maxSwing <= 1, `${t.team.name}.${cat.key}.maxSwing`)
        // expectedSwing ist NICHT hart durch maxSwing begrenzt (P0 stammt aus
        // einer separaten Simulation und kann durch Simulationsrauschen leicht
        // ausserhalb der Szenario-Spanne liegen) - nur [0,1] ist garantiert.
        assert.ok(Number.isFinite(c.expectedSwing) && c.expectedSwing >= 0 && c.expectedSwing <= 1, `${t.team.name}.${cat.key}.expectedSwing`)
      }
    }
  }
})

test('LOCK FINAL STANDINGS: Slicing erzeugt keine neuen Läufe (raw-Summe = aggregierte Wahrscheinlichkeit)', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 3000, seed: 321, players })
  const t = sim.rows[0].team
  let rawSum = 0
  for (let i = 0; i < sim.runs; i++) rawSum += sim.raw.champion[t.id][i]
  assert.equal(rawSum / sim.runs, sim.rows.find((r) => r.team.id === t.id).pChampion)
})

test('LOCK FINAL STANDINGS: Rang-Lock liefert deterministisches Teilergebnis, Bracket-Summen bleiben korrekt', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 3000, seed: 321, players })
  const target = sim.rows[0].team

  const locked = filterLockedRuns(sim, [{ teamId: target.id, kind: 'rank', rank: 1 }])
  assert.ok(locked.matchingRuns > 0, 'Rang 1 sollte in einigen Läufen vorkommen')
  assert.equal(locked.totalRuns, sim.runs)

  const row = locked.rows.find((r) => r.team.id === target.id)
  assert.equal(row.avgRank, 1)
  assert.equal(row.medianRank, 1)
  assert.equal(row.stdDevRank, 0)
  assert.equal(row.pTop6, 1)

  // Bracket-Summen (Top6=6 etc.) gelten für JEDE konsistente Teilmenge von
  // vollständigen Saisonverläufen, nicht nur für alle Läufe.
  const sumRuns = (field) => Math.round(locked.rows.reduce((s, r) => s + r[field], 0) * locked.matchingRuns)
  assert.equal(sumRuns('pTop6'), 6 * locked.matchingRuns)
  assert.equal(sumRuns('pPlayoffs'), 8 * locked.matchingRuns)
  assert.equal(sumRuns('pChampion'), 1 * locked.matchingRuns)

  // Rangverteilung: alle 14 Rang-Schlüssel vorhanden, Summe = matchingRuns,
  // kein anderes Team kann in dieser Teilmenge ebenfalls Rang 1 haben.
  const other = locked.rows.find((r) => r.team.id !== target.id)
  assert.equal(Object.keys(other.rankDistribution).length, sim.teamCount)
  assert.equal(Object.values(other.rankDistribution).reduce((a, b) => a + b, 0), locked.matchingRuns)
  assert.equal(other.rankDistribution[1], 0)
})

test('LOCK FINAL STANDINGS: widersprüchliche Locks liefern 0 Läufe statt Absturz', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 1000, seed: 321, players })
  const [a, b] = sim.rows
  const locked = filterLockedRuns(sim, [
    { teamId: a.team.id, kind: 'rank', rank: 1 },
    { teamId: b.team.id, kind: 'rank', rank: 1 },
  ])
  assert.equal(locked.matchingRuns, 0)
  assert.equal(locked.sufficientSample, false)
  assert.ok(locked.matchingRuns < LOCK_MIN_SAMPLE)
})

test('POINTS-TARGETS: monoton steigende Punkte-Schwellen über die Konfidenzstufen, oder Dash', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 3000, seed: 321, players })
  const targets = computePointsTargets(sim)
  assert.equal(targets.length, sim.rows.length)

  for (const t of targets) {
    for (const cat of POINTS_TARGET_CATEGORIES) {
      const levels = POINTS_CONFIDENCE_LEVELS.map((l) => t.targets[cat.key][l])
      let prevNonNull = -Infinity
      for (const v of levels) {
        if (v == null) continue // Dash ist erlaubt (Konfidenz nie erreicht)
        assert.ok(Number.isFinite(v))
        assert.ok(v >= prevNonNull, `${t.team.name}.${cat.key}: Punkte-Schwellen sollten mit der Konfidenz nicht sinken`)
        prevNonNull = v
      }
    }
  }
})
