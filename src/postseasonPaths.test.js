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

// ---------------------------------------------------------------------------
// Most Likely Bracket (Korrektur: vollständiger, tatsächlich beobachteter
// Bracket-Verlauf statt aus Einzelgegner-Marginalen kombiniert - siehe
// bracketFromRun()/mostLikelyBracket in src/postseasonPaths.js).
// ---------------------------------------------------------------------------

test('Most Likely Bracket stammt aus einer tatsächlich in postseasonRaw beobachteten Simulation', () => {
  const sim = run(4000, 55)
  const agg = aggregatePostseasonPaths(sim, teams)
  const b = agg.mostLikelyBracket
  assert.ok(b, 'mostLikelyBracket sollte gesetzt sein')

  const matchesRun = (rec) => {
    const { gameA, gameB, decision } = rec.playIn
    if (gameA.higher !== b.playIn.gameA.teamAId || gameA.lower !== b.playIn.gameA.teamBId || gameA.winner !== b.playIn.gameA.winnerId) return false
    if (gameB.higher !== b.playIn.gameB.teamAId || gameB.lower !== b.playIn.gameB.teamBId || gameB.winner !== b.playIn.gameB.winnerId) return false
    if (decision.participants[0] !== b.playIn.decision.teamAId || decision.participants[1] !== b.playIn.decision.teamBId || decision.winner !== b.playIn.decision.winnerId) return false
    const qfMatch = rec.quarterfinal.every((s, i) => s.higher === b.quarterfinal[i].teamAId && s.lower === b.quarterfinal[i].teamBId && s.winner === b.quarterfinal[i].winnerId)
    if (!qfMatch) return false
    const sfMatch = rec.semifinal.every((s, i) => s.higher === b.semifinal[i].teamAId && s.lower === b.semifinal[i].teamBId && s.winner === b.semifinal[i].winnerId)
    if (!sfMatch) return false
    return rec.final.higher === b.final.teamAId && rec.final.lower === b.final.teamBId && rec.final.winner === b.final.winnerId
  }

  const matchingRuns = sim.postseasonRaw.filter(matchesRun)
  assert.ok(matchingRuns.length > 0, 'mindestens ein realer Lauf muss exakt dem Most Likely Bracket entsprechen')
  assert.equal(matchingRuns.length, b.count, 'Anzahl übereinstimmender Läufe muss exakt b.count entsprechen')
})

test('Most Likely Bracket: kein Team erscheint zweimal in derselben Runde', () => {
  const agg = aggregatePostseasonPaths(run(4000, 55), teams)
  const b = agg.mostLikelyBracket

  const qfTeams = b.quarterfinal.flatMap((s) => [s.teamAId, s.teamBId])
  assert.equal(new Set(qfTeams).size, 8, 'Viertelfinal muss 8 verschiedene Teams enthalten')

  const sfTeams = b.semifinal.flatMap((s) => [s.teamAId, s.teamBId])
  assert.equal(new Set(sfTeams).size, 4, 'Halbfinal muss 4 verschiedene Teams enthalten')

  assert.notEqual(b.final.teamAId, b.final.teamBId, 'Final muss zwei verschiedene Teams enthalten')

  const playInFirstRound = [b.playIn.gameA.teamAId, b.playIn.gameA.teamBId, b.playIn.gameB.teamAId, b.playIn.gameB.teamBId]
  assert.equal(new Set(playInFirstRound).size, 4, 'Play-in-Erstrunde muss 4 verschiedene Teams enthalten')
  assert.notEqual(b.playIn.decision.teamAId, b.playIn.decision.teamBId, 'Play-in-Entscheidung muss zwei verschiedene Teams enthalten')
})

test('Most Likely Bracket: keine Paarung A-B und B-A gleichzeitig in derselben Runde', () => {
  const agg = aggregatePostseasonPaths(run(4000, 55), teams)
  const b = agg.mostLikelyBracket

  const qfKeys = b.quarterfinal.map((s) => matchupKey(s.teamAId, s.teamBId))
  assert.equal(new Set(qfKeys).size, qfKeys.length, 'Viertelfinal-Paarungen müssen alle eindeutig sein')

  const sfKeys = b.semifinal.map((s) => matchupKey(s.teamAId, s.teamBId))
  assert.equal(new Set(sfKeys).size, sfKeys.length, 'Halbfinal-Paarungen müssen alle eindeutig sein')
})

test('Most Likely Bracket: kein unmögliches Bracket (Play-in-Verlierer nicht im QF, QF/SF/Final-Sieger konsistent fortgeführt)', () => {
  const agg = aggregatePostseasonPaths(run(4000, 55), teams)
  const b = agg.mostLikelyBracket

  // Play-in-Entscheidung muss exakt {Verlierer Spiel A, Sieger Spiel B} sein
  const gameALoser = b.playIn.gameA.winnerId === b.playIn.gameA.teamAId ? b.playIn.gameA.teamBId : b.playIn.gameA.teamAId
  const decisionParticipants = new Set([b.playIn.decision.teamAId, b.playIn.decision.teamBId])
  assert.ok(decisionParticipants.has(gameALoser), 'Play-in-Entscheidung muss den Verlierer von Spiel A enthalten')
  assert.ok(decisionParticipants.has(b.playIn.gameB.winnerId), 'Play-in-Entscheidung muss den Sieger von Spiel B enthalten')

  // Die beiden Play-in-Qualifikanten (Sieger Spiel A + Sieger Entscheidung) müssen im Viertelfinal stehen,
  // alle vier Play-in-Erstrunden-Teilnehmer, die NICHT qualifiziert sind, dürfen dort nicht auftauchen.
  const qfTeams = new Set(b.quarterfinal.flatMap((s) => [s.teamAId, s.teamBId]))
  assert.ok(qfTeams.has(b.playIn.gameA.winnerId), 'Play-in-Sieger Spiel A muss im Viertelfinal stehen')
  assert.ok(qfTeams.has(b.playIn.decision.winnerId), 'Play-in-Entscheidungssieger muss im Viertelfinal stehen')
  const eliminatedInPlayIn = [b.playIn.gameA, b.playIn.gameB, b.playIn.decision]
    .flatMap((g) => [g.teamAId, g.teamBId])
    .filter((id) => id !== b.playIn.gameA.winnerId && id !== b.playIn.decision.winnerId)
  for (const id of eliminatedInPlayIn) {
    assert.ok(!qfTeams.has(id), `im Play-in ausgeschiedenes Team ${id} darf nicht im Viertelfinal stehen`)
  }

  // Halbfinal-Teilnehmer müssen exakt die 4 Viertelfinal-Sieger sein
  const qfWinners = new Set(b.quarterfinal.map((s) => s.winnerId))
  const sfTeams = new Set(b.semifinal.flatMap((s) => [s.teamAId, s.teamBId]))
  assert.deepEqual(sfTeams, qfWinners, 'Halbfinal-Teilnehmer müssen exakt die Viertelfinal-Sieger sein')

  // Final-Teilnehmer müssen exakt die 2 Halbfinal-Sieger sein
  const sfWinners = new Set(b.semifinal.map((s) => s.winnerId))
  const finalTeams = new Set([b.final.teamAId, b.final.teamBId])
  assert.deepEqual(finalTeams, sfWinners, 'Final-Teilnehmer müssen exakt die Halbfinal-Sieger sein')

  // Meister muss der Final-Sieger sein
  assert.equal(b.champion, b.final.winnerId, 'Meister muss der Final-Sieger sein')
})

test('Most Likely Bracket: probability = count / runs', () => {
  const agg = aggregatePostseasonPaths(run(4000, 55), teams)
  const b = agg.mostLikelyBracket
  assert.equal(b.probability, b.count / agg.runs)
})

test('Most Likely Bracket: bei zwei künstlichen Brackets wird das häufiger beobachtete gewählt', () => {
  const fakeTeams = Array.from({ length: 14 }, (_, i) => ({ id: `T${i + 1}` }))

  const bracketA = {
    playIn: {
      gameA: { higher: 'T7', lower: 'T8', winner: 'T7', loser: 'T8' },
      gameB: { higher: 'T9', lower: 'T10', winner: 'T9', loser: 'T10' },
      decision: { participants: ['T8', 'T9'], winner: 'T8', loser: 'T9' },
    },
    quarterfinal: [
      { higher: 'T1', lower: 'T8', winner: 'T1', loser: 'T8', gamesPlayed: 5 },
      { higher: 'T2', lower: 'T7', winner: 'T2', loser: 'T7', gamesPlayed: 6 },
      { higher: 'T3', lower: 'T6', winner: 'T3', loser: 'T6', gamesPlayed: 4 },
      { higher: 'T4', lower: 'T5', winner: 'T4', loser: 'T5', gamesPlayed: 7 },
    ],
    semifinal: [
      { higher: 'T1', lower: 'T4', winner: 'T1', loser: 'T4', gamesPlayed: 5 },
      { higher: 'T2', lower: 'T3', winner: 'T2', loser: 'T3', gamesPlayed: 6 },
    ],
    final: { higher: 'T1', lower: 'T2', winner: 'T1', loser: 'T2', gamesPlayed: 7 },
    playout: { higher: 'T13', lower: 'T14', winner: 'T13', loser: 'T14', gamesPlayed: 5 },
  }
  // Bracket B: identischer Verlauf bis auf den Final-Sieger (T2 statt T1) -
  // ein anderer kompletter Bracket-Verlauf, seltener beobachtet.
  const bracketB = {
    ...bracketA,
    final: { higher: 'T1', lower: 'T2', winner: 'T2', loser: 'T1', gamesPlayed: 7 },
  }

  const raw = []
  for (let i = 0; i < 10; i++) raw.push(i % 5 < 2 ? bracketB : bracketA) // 4x B (i=0,1,5,6), 6x A, interleaved

  const agg = aggregatePostseasonPaths({ postseasonRaw: raw }, fakeTeams)
  assert.equal(agg.mostLikelyBracket.count, 6)
  assert.equal(agg.mostLikelyBracket.probability, 0.6)
  assert.equal(agg.mostLikelyBracket.champion, 'T1')
  assert.equal(agg.distinctBracketCount, 2)
})
