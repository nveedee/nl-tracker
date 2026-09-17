// ---------------------------------------------------------------------------
// Tests für Postseason Paths / Most Likely Matchups (src/postseasonPaths.js).
// Nutzt server/data/seed.json (committed) als deterministische Datengrundlage,
// identisch zu playoffSim.test.js.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { simulateSeasonProjections } from './playoffSim.js'
import { aggregatePostseasonPaths, matchupKey, parsePathKey, validatePostseasonAggregate } from './postseasonPaths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED_PATH = path.join(__dirname, '..', 'server', 'data', 'seed.json')
const db = JSON.parse(readFileSync(SEED_PATH, 'utf-8'))
const { teams, games, players, settings } = db
const teamIds = teams.map((t) => t.id)

function run(runs = 4000, seed = 777) {
  return simulateSeasonProjections(teams, games, settings, { runs, seed, players, trackPaths: true })
}

test('canonical matchup key: Reihenfolge egal (A vs B == B vs A)', () => {
  assert.equal(matchupKey(3, 7), matchupKey(7, 3))
  assert.equal(matchupKey(3, 7), '3:7')
})

test('trackPaths=false (Default): kein postseasonRaw, unverändertes Verhalten', () => {
  const sim = simulateSeasonProjections(teams, games, settings, { runs: 500, seed: 1, players })
  assert.equal(sim.postseasonRaw, null)
})

test('trackPaths=true: postseasonRaw hat genau `runs` Einträge mit vollständiger Bracket-Struktur', () => {
  const sim = run(500, 3)
  assert.equal(sim.postseasonRaw.length, 500)
  const rec = sim.postseasonRaw[0]
  assert.equal(rec.quarterfinal.length, 4)
  assert.equal(rec.semifinal.length, 2)
  assert.ok(rec.final.winner)
  assert.ok(rec.playout.winner)
  for (const s of [...rec.quarterfinal, ...rec.semifinal, rec.final, rec.playout]) {
    assert.ok(s.gamesPlayed >= 4 && s.gamesPlayed <= 7, `Serienlänge ausserhalb 4-7: ${s.gamesPlayed}`)
  }
})

test('trackPaths ändert bestehende Aggregate/Determinismus nicht (bytegleich zu trackPaths=false)', () => {
  const withTracking = simulateSeasonProjections(teams, games, settings, { runs: 800, seed: 55, players, trackPaths: true })
  const without = simulateSeasonProjections(teams, games, settings, { runs: 800, seed: 55, players, trackPaths: false })
  assert.equal(withTracking.rows.length, without.rows.length)
  for (let i = 0; i < withTracking.rows.length; i++) {
    assert.equal(withTracking.rows[i].team.id, without.rows[i].team.id)
    assert.equal(withTracking.rows[i].pChampion, without.rows[i].pChampion)
    assert.equal(withTracking.rows[i].pFinal, without.rows[i].pFinal)
    assert.equal(withTracking.rows[i].avgRank, without.rows[i].avgRank)
  }
})

test('Deterministischer Seed -> identische Postseason-Aggregation', () => {
  const a = aggregatePostseasonPaths(run(1500, 42), teams)
  const b = aggregatePostseasonPaths(run(1500, 42), teams)
  assert.deepEqual(a.globalMatchups.final, b.globalMatchups.final)
  for (const id of teamIds) {
    assert.equal(a.teamPaths[id].championshipProbability, b.teamPaths[id].championshipProbability)
    assert.deepEqual(a.teamPaths[id].topPaths, b.teamPaths[id].topPaths)
  }
})

test('Championship/Final/Semifinal/Quarterfinal-Summen über alle Teams entsprechen dem Turnierformat', () => {
  const agg = aggregatePostseasonPaths(run(4000, 9), teams)
  const sum = (fn) => teamIds.reduce((s, id) => s + fn(agg.teamPaths[id]), 0)
  assert.ok(Math.abs(sum((tp) => tp.championshipProbability) - 1) < 0.02)
  assert.ok(Math.abs(sum((tp) => tp.final.reachProbability) - 2) < 0.02)
  assert.ok(Math.abs(sum((tp) => tp.semifinal.reachProbability) - 4) < 0.02)
  assert.ok(Math.abs(sum((tp) => tp.quarterfinal.reachProbability) - 8) < 0.02)
})

test('Keine NaN/Infinity, alle Wahrscheinlichkeiten in [0,1], keine negativen Werte', () => {
  const agg = aggregatePostseasonPaths(run(2000, 21), teams)
  for (const id of teamIds) {
    const tp = agg.teamPaths[id]
    const flat = [
      tp.championshipProbability, tp.ligaQualifikationProbability,
      tp.playIn.reachProbability, tp.playIn.qualificationProbability,
      tp.quarterfinal.reachProbability, tp.semifinal.reachProbability, tp.final.reachProbability,
      tp.playout.reachProbability,
    ]
    for (const v of flat) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `Team ${id}: ${v}`)
    for (const stage of ['playIn', 'quarterfinal', 'semifinal', 'final', 'playout']) {
      for (const o of tp[stage].opponents) {
        assert.ok(Number.isFinite(o.absoluteProbability) && o.absoluteProbability >= 0 && o.absoluteProbability <= 1)
        assert.ok(Number.isFinite(o.conditionalProbability) && o.conditionalProbability >= 0 && o.conditionalProbability <= 1)
      }
    }
  }
  for (const round of Object.values(agg.globalMatchups)) {
    for (const m of round) assert.ok(Number.isFinite(m.probability) && m.probability >= 0 && m.probability <= 1)
  }
})

test('Conditional-Opponent-Wahrscheinlichkeiten summieren sich je Team/Runde auf ~100%, wenn die Runde erreicht wurde', () => {
  const agg = aggregatePostseasonPaths(run(4000, 123), teams)
  for (const id of teamIds) {
    const tp = agg.teamPaths[id]
    for (const stage of ['quarterfinal', 'semifinal', 'final']) {
      const s = tp[stage]
      if (s.reachProbability > 0.02) {
        const condSum = s.opponents.reduce((acc, o) => acc + o.conditionalProbability, 0)
        assert.ok(Math.abs(condSum - 1) < 0.03, `Team ${id} ${stage}: condSum=${condSum}`)
      }
    }
  }
})

test('Unmögliche Matchups tauchen nicht als Gegner auf (0%, kein Eintrag)', () => {
  const agg = aggregatePostseasonPaths(run(2000, 8), teams)
  for (const id of teamIds) {
    const tp = agg.teamPaths[id]
    for (const stage of ['quarterfinal', 'semifinal', 'final', 'playout', 'playIn']) {
      for (const o of tp[stage].opponents) {
        assert.notEqual(o.opponentId, id, `Team ${id} kann nicht gegen sich selbst antreten (${stage})`)
      }
    }
  }
})

test('Serienlänge (4-7 Spiele) je Matchup summiert sich zur Gesamtzahl dieses Matchups', () => {
  const agg = aggregatePostseasonPaths(run(2000, 4), teams)
  for (const round of Object.values(agg.seriesLength)) {
    for (const entry of round) {
      const sumCounts = entry.counts[4] + entry.counts[5] + entry.counts[6] + entry.counts[7]
      assert.equal(sumCounts, entry.total)
      const probSum = entry.probabilities[4] + entry.probabilities[5] + entry.probabilities[6] + entry.probabilities[7]
      assert.ok(Math.abs(probSum - 1) < 1e-9)
    }
  }
})

// Regressionstest: Team-IDs sind Strings ("team_zsc", nicht numerisch) - eine
// UI-Komponente hatte ursprünglich Math.min/Math.max auf teamAId/teamBId
// genutzt, um denselben Key wie matchupKey() zu bilden (funktioniert nur für
// numerische IDs, ergibt bei Strings NaN:NaN). seriesLengthOut() liefert
// deshalb jetzt direkt einen `key` = matchupKey(teamAId, teamBId) mit.
test('Serienlänge-Einträge tragen denselben canonical key wie matchupKey(teamAId, teamBId) (String-IDs)', () => {
  assert.equal(typeof teamIds[0], 'string')
  const agg = aggregatePostseasonPaths(run(2000, 4), teams)
  for (const round of Object.values(agg.seriesLength)) {
    for (const entry of round) {
      assert.equal(entry.key, matchupKey(entry.teamAId, entry.teamBId))
      assert.ok(!entry.key.includes('NaN'), `key enthält NaN: ${entry.key}`)
    }
  }
})

test('Play-in-Analytics: second-chance-Quote nur für Teams mit tatsächlichen Opportunities gesetzt', () => {
  const agg = aggregatePostseasonPaths(run(3000, 17), teams)
  for (const id of teamIds) {
    const pi = agg.teamPaths[id].playIn
    if (pi.secondChanceProbability != null) {
      assert.ok(pi.secondChanceProbability >= 0 && pi.secondChanceProbability <= 1)
    }
    assert.ok(pi.qualificationProbability <= pi.reachProbability + 1e-9, `Team ${id}: Qualifikation > Play-in-Teilnahme`)
  }
})

test('parsePathKey rekonstruiert Stage/Gegner aus dem Pfad-Key', () => {
  const parsed = parsePathKey('PI:3|QF:7|SF:1')
  assert.deepEqual(parsed, [
    { stage: 'PI', opponentId: 3 },
    { stage: 'QF', opponentId: 7 },
    { stage: 'SF', opponentId: 1 },
  ])
})

test('Most-Likely-Path ist ein tatsächlich beobachteter Pfad (Summe aller topPaths-Counts <= runs)', () => {
  const agg = aggregatePostseasonPaths(run(3000, 6), teams)
  for (const id of teamIds) {
    const tp = agg.teamPaths[id]
    if (tp.mostLikelyPath) {
      assert.ok(tp.mostLikelyPath.count > 0)
      assert.ok(tp.mostLikelyPath.probability > 0 && tp.mostLikelyPath.probability <= 1)
      const totalPathCount = [...tp.topPaths].reduce((s, p) => s + p.count, 0)
      assert.ok(totalPathCount <= agg.runs)
    }
  }
})

test('validatePostseasonAggregate: keine Issues bei ausreichend grossem Lauf', () => {
  const agg = aggregatePostseasonPaths(run(6000, 2026), teams)
  const issues = validatePostseasonAggregate(agg, teamIds)
  assert.deepEqual(issues, [], issues.join('\n'))
})

test('aggregatePostseasonPaths(null-ähnliches Ergebnis) liefert null statt zu crashen', () => {
  const simWithoutTracking = simulateSeasonProjections(teams, games, settings, { runs: 300, seed: 1, players })
  assert.equal(aggregatePostseasonPaths(simWithoutTracking, teams), null)
})
