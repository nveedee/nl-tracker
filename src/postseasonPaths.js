// ---------------------------------------------------------------------------
// Postseason Paths / Most Likely Matchups
//
// Reine Aggregation über die `postseasonRaw`-Rohdaten, die
// simulateSeasonProjections({ trackPaths: true }) (src/playoffSim.js) pro
// Simulationslauf zusätzlich sammelt - KEINE eigene Simulation, KEINE neue
// Zufalls-/Wahrscheinlichkeitsformel. Jeder Eintrag in `postseasonRaw` ist
// bereits das reale Ergebnis EINES vollständigen Monte-Carlo-Laufs (inkl.
// der für diesen Lauf simulierten Regular Season -> Seeding -> Bracket) -
// diese Funktion zählt nur, wie oft welche Konstellation vorkam.
//
// Aufgerufen genau EINMAL nach den 10'000 Läufen (siehe Punkt 17 im Auftrag:
// "10'000 Simulationen -> ein aggregiertes Ergebnis"); die UI (Postseason.jsx)
// rechnet danach ausschliesslich auf diesem aggregierten Objekt weiter.
// ---------------------------------------------------------------------------

// Canonical Key für ein ungeordnetes Team-Paar - "A vs B" und "B vs A" sind
// dasselbe Matchup (Punkt 7 im Auftrag).
export function matchupKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

function bumpMap(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by)
}

// Wie bumpMap für globalMatchups, zählt zusätzlich mit, welches der beiden
// Teams die Serie gewann (für "wahrscheinlichster Sieger dieser Paarung" in
// der Bracket-Ansicht, PostseasonBracket.jsx) - reines Auslesen von `winner`,
// keine zusätzliche Berechnung/Formel.
function bumpMatchupWinner(map, higher, lower, winner) {
  const key = matchupKey(higher, lower)
  let entry = map.get(key)
  if (!entry) { entry = { teamA: higher, teamB: lower, count: 0, winners: new Map() }; map.set(key, entry) }
  entry.count++
  entry.winners.set(winner, (entry.winners.get(winner) || 0) + 1)
}

function bumpSeriesLength(roundMap, higher, lower, games) {
  const key = matchupKey(higher, lower)
  let entry = roundMap.get(key)
  if (!entry) {
    entry = { teamA: higher, teamB: lower, counts: { 4: 0, 5: 0, 6: 0, 7: 0 } }
    roundMap.set(key, entry)
  }
  entry.counts[games] = (entry.counts[games] || 0) + 1
}

// Canonical "Paarung=Sieger"-String für eine Serie (z.B. "team_bie:team_lug=team_lug") -
// Baustein für den Bracket-Signature-Key unten. matchupKey() macht die
// Paarung selbst unabhängig von der Aufrufreihenfolge (A vs B == B vs A);
// der Sieger wird zusätzlich angehängt, macht den kompletten Verlauf (nicht
// nur die Paarung) Teil der Signatur.
function pairResult(teamA, teamB, winner) {
  return `${matchupKey(teamA, teamB)}=${winner}`
}

// Baut aus einem einzelnen Simulationslauf (`rec` aus postseasonRaw) den
// EXAKTEN, tatsächlich in diesem Lauf entstandenen Bracket-Verlauf - Play-in
// (alle 3 Spiele: 7v8, 9v10, Entscheidung), Viertelfinal (4 Serien),
// Halbfinal (2 Serien), Final (1 Serie), je inkl. Sieger. Zwei Läufe mit
// exakt demselben `key` sind bracket-identisch (gleiche Paarungen UND
// gleiche Sieger in jeder Runde). Reines Umformen von bereits im Lauf
// vorhandenen Daten - keine neue Simulation, keine Rekombination aus
// Team-Marginalen.
function bracketFromRun(rec) {
  const { gameA, gameB, decision } = rec.playIn
  const playIn = {
    gameA: { teamAId: gameA.higher, teamBId: gameA.lower, winnerId: gameA.winner },
    gameB: { teamAId: gameB.higher, teamBId: gameB.lower, winnerId: gameB.winner },
    decision: { teamAId: decision.participants[0], teamBId: decision.participants[1], winnerId: decision.winner },
  }
  const quarterfinal = rec.quarterfinal.map((s) => ({ teamAId: s.higher, teamBId: s.lower, winnerId: s.winner, gamesPlayed: s.gamesPlayed }))
  const semifinal = rec.semifinal.map((s) => ({ teamAId: s.higher, teamBId: s.lower, winnerId: s.winner, gamesPlayed: s.gamesPlayed }))
  const final = { teamAId: rec.final.higher, teamBId: rec.final.lower, winnerId: rec.final.winner, gamesPlayed: rec.final.gamesPlayed }

  // Reihenfolge der QF-/SF-Paarungen ist nur ein Artefakt der Bracket-Slots
  // (1v8/2v7/... bzw. Reseeding) und identifiziert den Bracket NICHT
  // eindeutig - zwei Läufe mit denselben Paarungen in vertauschter Slot-
  // Reihenfolge sind derselbe reale Bracket. Für den Key deshalb sortiert;
  // Play-in-Spiele bleiben unsortiert (3 strukturell verschiedene Rollen:
  // 7v8/9v10/Entscheidung, nicht austauschbar).
  const key = JSON.stringify([
    [pairResult(gameA.higher, gameA.lower, gameA.winner), pairResult(gameB.higher, gameB.lower, gameB.winner), pairResult(decision.participants[0], decision.participants[1], decision.winner)],
    quarterfinal.map((s) => pairResult(s.teamAId, s.teamBId, s.winnerId)).sort(),
    semifinal.map((s) => pairResult(s.teamAId, s.teamBId, s.winnerId)).sort(),
    pairResult(final.teamAId, final.teamBId, final.winnerId),
  ])

  return { key, playIn, quarterfinal, semifinal, final, champion: rec.final.winner }
}

function newTeamAcc() {
  return {
    playIn: {
      reached: 0, firstWin: 0, firstLoss: 0,
      secondChanceOpportunities: 0, secondChanceWins: 0, qualified: 0,
      opponents: new Map(),
    },
    quarterfinal: { reached: 0, won: 0, opponents: new Map() },
    semifinal: { reached: 0, won: 0, opponents: new Map() },
    final: { reached: 0, won: 0, opponents: new Map() },
    champion: 0,
    playout: { reached: 0, won: 0, opponents: new Map() },
    ligaqualifikation: 0,
    paths: new Map(),
  }
}

function recordPath(teamAcc, segs) {
  if (segs.length === 0) return
  const key = segs.join('|')
  bumpMap(teamAcc.paths, key, 1)
}

// Baut aus einem Pfad-Key ("PI:12|QF:3|SF:7") eine anzeigefertige Liste
// [{ stage, opponentId }] - Stage-Reihenfolge entspricht der tatsächlich
// erreichten Runden.
export function parsePathKey(key) {
  return key.split('|').map((seg) => {
    const [stage, opponentId] = seg.split(':')
    return { stage, opponentId: Number.isNaN(Number(opponentId)) ? opponentId : Number(opponentId) }
  })
}

export function aggregatePostseasonPaths(simResult, teams) {
  if (!simResult?.postseasonRaw || simResult.postseasonRaw.length === 0) return null
  const raw = simResult.postseasonRaw
  const runs = raw.length
  const teamIds = teams.map((t) => t.id)

  const acc = {}
  teamIds.forEach((id) => { acc[id] = newTeamAcc() })

  const globalMatchups = {
    quarterfinal: new Map(), semifinal: new Map(), final: new Map(), playout: new Map(),
  }
  const seriesLength = {
    quarterfinal: new Map(), semifinal: new Map(), final: new Map(), playout: new Map(),
  }

  // Bracket-Signature-Zählung (siehe bracketFromRun() oben): `key` ->
  // { bracket, count }. `bracket` wird nur beim ERSTEN Auftreten dieses Keys
  // gespeichert (jeder weitere Lauf mit demselben Key ist per Definition
  // identisch) - kein Rekonstruieren aus Marginalen, jeder gezählte Bracket
  // ist ein tatsächlich in genau diesem Lauf simulierter kompletter Verlauf.
  const bracketCounts = new Map()

  for (const rec of raw) {
    const { gameA, gameB, decision } = rec.playIn

    const bracket = bracketFromRun(rec)
    let bracketEntry = bracketCounts.get(bracket.key)
    if (!bracketEntry) { bracketEntry = { bracket, count: 0 }; bracketCounts.set(bracket.key, bracketEntry) }
    bracketEntry.count++

    // --- Play-in: beide Erstrunden-Spiele ---
    for (const g of [gameA, gameB]) {
      acc[g.higher].playIn.reached++
      acc[g.lower].playIn.reached++
      bumpMap(acc[g.higher].playIn.opponents, g.lower)
      bumpMap(acc[g.lower].playIn.opponents, g.higher)
      acc[g.winner].playIn.firstWin++
      acc[g.loser].playIn.firstLoss++
    }
    // Nur der Verlierer von Spiel A (7v8) bekommt eine ECHTE "zweite Chance"
    // (Entscheidung gegen den Sieger von 9v10) - der Verlierer von Spiel B
    // scheidet direkt aus (siehe Formatkommentar in playoffSim.js).
    acc[gameA.loser].playIn.secondChanceOpportunities++
    if (decision.winner === gameA.loser) acc[gameA.loser].playIn.secondChanceWins++
    acc[gameA.winner].playIn.qualified++
    acc[decision.winner].playIn.qualified++

    // --- Viertelfinal ---
    for (const s of rec.quarterfinal) {
      acc[s.higher].quarterfinal.reached++
      acc[s.lower].quarterfinal.reached++
      bumpMap(acc[s.higher].quarterfinal.opponents, s.lower)
      bumpMap(acc[s.lower].quarterfinal.opponents, s.higher)
      acc[s.winner].quarterfinal.won++
      bumpMatchupWinner(globalMatchups.quarterfinal, s.higher, s.lower, s.winner)
      bumpSeriesLength(seriesLength.quarterfinal, s.higher, s.lower, s.gamesPlayed)
    }

    // --- Halbfinal ---
    for (const s of rec.semifinal) {
      acc[s.higher].semifinal.reached++
      acc[s.lower].semifinal.reached++
      bumpMap(acc[s.higher].semifinal.opponents, s.lower)
      bumpMap(acc[s.lower].semifinal.opponents, s.higher)
      acc[s.winner].semifinal.won++
      bumpMatchupWinner(globalMatchups.semifinal, s.higher, s.lower, s.winner)
      bumpSeriesLength(seriesLength.semifinal, s.higher, s.lower, s.gamesPlayed)
    }

    // --- Final ---
    const f = rec.final
    acc[f.higher].final.reached++
    acc[f.lower].final.reached++
    bumpMap(acc[f.higher].final.opponents, f.lower)
    bumpMap(acc[f.lower].final.opponents, f.higher)
    acc[f.winner].final.won++
    acc[f.winner].champion++
    bumpMatchupWinner(globalMatchups.final, f.higher, f.lower, f.winner)
    bumpSeriesLength(seriesLength.final, f.higher, f.lower, f.gamesPlayed)

    // --- Play-out (Rang 13/14) ---
    const po = rec.playout
    acc[po.higher].playout.reached++
    acc[po.lower].playout.reached++
    bumpMap(acc[po.higher].playout.opponents, po.lower)
    bumpMap(acc[po.lower].playout.opponents, po.higher)
    acc[po.winner].playout.won++
    acc[po.loser].ligaqualifikation++
    bumpMatchupWinner(globalMatchups.playout, po.higher, po.lower, po.winner)
    bumpSeriesLength(seriesLength.playout, po.higher, po.lower, po.gamesPlayed)

    // --- Vollständiger Pfad je Team (nur Teams, die tatsächlich im Play-in
    //     oder Playoff-Bracket standen - Rang 11/12/Play-out werden hier
    //     nicht als "Pfad" geführt, siehe acc[id].playout/.ligaqualifikation) ---
    for (const id of teamIds) {
      const segs = []
      let eliminated = false

      let firstLeg = null
      if (gameA.higher === id || gameA.lower === id) firstLeg = gameA
      else if (gameB.higher === id || gameB.lower === id) firstLeg = gameB

      if (firstLeg) {
        const inDecision = decision.participants.includes(id)
        if (!inDecision) {
          // direkt gewonnen (Bracket-Seed 7) oder ohne zweite Chance verloren (Seed 9/10-Verlierer)
          const opp = firstLeg.higher === id ? firstLeg.lower : firstLeg.higher
          segs.push(`PI:${opp}`)
          if (firstLeg.winner !== id) eliminated = true
        } else {
          const opp = decision.participants[0] === id ? decision.participants[1] : decision.participants[0]
          segs.push(`PI:${opp}`)
          if (decision.winner !== id) eliminated = true
        }
      }

      if (eliminated) { recordPath(acc[id], segs); continue }

      const qf = rec.quarterfinal.find((s) => s.higher === id || s.lower === id)
      if (!qf) { if (segs.length) recordPath(acc[id], segs); continue }
      segs.push(`QF:${qf.higher === id ? qf.lower : qf.higher}`)
      if (qf.winner !== id) { recordPath(acc[id], segs); continue }

      const sf = rec.semifinal.find((s) => s.higher === id || s.lower === id)
      if (!sf) { recordPath(acc[id], segs); continue }
      segs.push(`SF:${sf.higher === id ? sf.lower : sf.higher}`)
      if (sf.winner !== id) { recordPath(acc[id], segs); continue }

      segs.push(`F:${f.higher === id ? f.lower : f.higher}`)
      recordPath(acc[id], segs)
    }
  }

  // === Formatierung ===

  const opponentsOut = (map, reached) => {
    return [...map.entries()]
      .map(([opponentId, count]) => ({
        opponentId,
        count,
        absoluteProbability: count / runs,
        conditionalProbability: reached > 0 ? count / reached : 0,
      }))
      .sort((a, b) => b.count - a.count)
  }

  const teamPaths = {}
  teamIds.forEach((id) => {
    const a = acc[id]
    const pi = a.playIn
    const topPaths = [...a.paths.entries()]
      .map(([key, count]) => ({ key, path: parsePathKey(key), count, probability: count / runs }))
      .sort((x, y) => y.count - x.count)

    teamPaths[id] = {
      teamId: id,
      playIn: {
        reachProbability: pi.reached / runs,
        firstGameWinProbability: pi.reached > 0 ? pi.firstWin / pi.reached : null,
        firstGameLossProbability: pi.reached > 0 ? pi.firstLoss / pi.reached : null,
        secondChanceProbability: pi.secondChanceOpportunities > 0 ? pi.secondChanceWins / pi.secondChanceOpportunities : null,
        qualificationProbability: pi.qualified / runs,
        conditionalQualificationProbability: pi.reached > 0 ? pi.qualified / pi.reached : null,
        opponents: opponentsOut(pi.opponents, pi.reached),
      },
      quarterfinal: {
        reachProbability: a.quarterfinal.reached / runs,
        wonProbability: a.quarterfinal.reached > 0 ? a.quarterfinal.won / a.quarterfinal.reached : null,
        opponents: opponentsOut(a.quarterfinal.opponents, a.quarterfinal.reached),
      },
      semifinal: {
        reachProbability: a.semifinal.reached / runs,
        wonProbability: a.semifinal.reached > 0 ? a.semifinal.won / a.semifinal.reached : null,
        opponents: opponentsOut(a.semifinal.opponents, a.semifinal.reached),
      },
      final: {
        reachProbability: a.final.reached / runs,
        wonProbability: a.final.reached > 0 ? a.final.won / a.final.reached : null,
        opponents: opponentsOut(a.final.opponents, a.final.reached),
      },
      championshipProbability: a.champion / runs,
      playout: {
        reachProbability: a.playout.reached / runs,
        winProbability: a.playout.reached > 0 ? a.playout.won / a.playout.reached : null,
        opponents: opponentsOut(a.playout.opponents, a.playout.reached),
      },
      ligaQualifikationProbability: a.ligaqualifikation / runs,
      mostLikelyPath: topPaths[0] || null,
      topPaths: topPaths.slice(0, 5),
      distinctPathCount: topPaths.length,
    }
  })

  const matchupsOut = (map) => [...map.entries()]
    .map(([key, entry]) => {
      let winnerId = null, winnerCount = 0
      for (const [teamId, c] of entry.winners.entries()) {
        if (c > winnerCount) { winnerCount = c; winnerId = teamId }
      }
      return {
        key, teamAId: entry.teamA, teamBId: entry.teamB, count: entry.count, probability: entry.count / runs,
        mostLikelyWinnerId: winnerId,
        mostLikelyWinnerProbability: entry.count > 0 ? winnerCount / entry.count : 0,
      }
    })
    .sort((a, b) => b.count - a.count)

  const seriesLengthOut = (map) => [...map.values()]
    .map((entry) => {
      const total = entry.counts[4] + entry.counts[5] + entry.counts[6] + entry.counts[7]
      const probabilities = {}
      for (const g of [4, 5, 6, 7]) probabilities[g] = total > 0 ? entry.counts[g] / total : 0
      return { key: matchupKey(entry.teamA, entry.teamB), teamAId: entry.teamA, teamBId: entry.teamB, counts: entry.counts, total, probabilities }
    })
    .sort((a, b) => b.total - a.total)

  // Most Likely Bracket = der häufigste vollständige Bracket-Key (siehe
  // bracketFromRun() oben) - NICHT aus Team-Marginalen kombiniert. Bei
  // Gleichstand deterministischer Tie-Break über den (stabilen, da über
  // matchupKey()+Sieger gebildeten) Key selbst, damit dasselbe Simulations-
  // ergebnis immer denselben "Most Likely Bracket" liefert.
  const bracketEntries = [...bracketCounts.values()].sort((a, b) => b.count - a.count || (a.bracket.key < b.bracket.key ? -1 : 1))
  const topBracket = bracketEntries[0]
  const mostLikelyBracket = topBracket
    ? {
        ...topBracket.bracket,
        count: topBracket.count,
        probability: topBracket.count / runs,
      }
    : null

  return {
    runs,
    teamPaths,
    globalMatchups: {
      quarterfinal: matchupsOut(globalMatchups.quarterfinal),
      semifinal: matchupsOut(globalMatchups.semifinal),
      final: matchupsOut(globalMatchups.final),
      playout: matchupsOut(globalMatchups.playout),
    },
    seriesLength: {
      quarterfinal: seriesLengthOut(seriesLength.quarterfinal),
      semifinal: seriesLengthOut(seriesLength.semifinal),
      final: seriesLengthOut(seriesLength.final),
      playout: seriesLengthOut(seriesLength.playout),
    },
    mostLikelyBracket,
    distinctBracketCount: bracketCounts.size,
  }
}

// ---------------------------------------------------------------------------
// Mathematische Validierung (Punkt 18 im Auftrag) - läuft nach jeder
// Aggregation, rein informativ (Warnungen), wirft nicht.
// ---------------------------------------------------------------------------

const EPS = 0.02 // 2 Prozentpunkte Tolerenz (Rundungs-/Sampling-Rauschen bei 10k Läufen)

function isValidProb(v) {
  return v == null || (Number.isFinite(v) && v >= -1e-9 && v <= 1 + 1e-9)
}

export function validatePostseasonAggregate(aggregate, teamIds) {
  const issues = []
  if (!aggregate) return issues

  let championSum = 0, finalSum = 0, semifinalSum = 0, quarterfinalSum = 0

  for (const id of teamIds) {
    const tp = aggregate.teamPaths[id]
    if (!tp) continue

    const allProbs = [
      tp.playIn.reachProbability, tp.playIn.firstGameWinProbability, tp.playIn.firstGameLossProbability,
      tp.playIn.secondChanceProbability, tp.playIn.qualificationProbability,
      tp.quarterfinal.reachProbability, tp.quarterfinal.wonProbability,
      tp.semifinal.reachProbability, tp.semifinal.wonProbability,
      tp.final.reachProbability, tp.final.wonProbability,
      tp.championshipProbability, tp.playout.reachProbability, tp.playout.winProbability,
      tp.ligaQualifikationProbability,
    ]
    for (const p of allProbs) {
      if (!isValidProb(p)) issues.push(`Team ${id}: ungültige Wahrscheinlichkeit ${p}`)
    }

    for (const stage of ['playIn', 'quarterfinal', 'semifinal', 'final', 'playout']) {
      const reached = tp[stage].reachProbability
      const condSum = tp[stage].opponents.reduce((s, o) => s + o.conditionalProbability, 0)
      if (reached > 0.01 && Math.abs(condSum - 1) > EPS) {
        issues.push(`Team ${id} ${stage}: Summe conditionalProbability der Gegner = ${condSum.toFixed(3)} (erwartet ~1)`)
      }
      const absSum = tp[stage].opponents.reduce((s, o) => s + o.absoluteProbability, 0)
      if (Math.abs(absSum - reached) > EPS) {
        issues.push(`Team ${id} ${stage}: Summe absoluteProbability der Gegner (${absSum.toFixed(3)}) != reachProbability (${reached.toFixed(3)})`)
      }
    }

    championSum += tp.championshipProbability
    finalSum += tp.final.reachProbability
    semifinalSum += tp.semifinal.reachProbability
    quarterfinalSum += tp.quarterfinal.reachProbability
  }

  if (Math.abs(championSum - 1) > EPS) issues.push(`Championship-Summe über alle Teams = ${championSum.toFixed(3)} (erwartet ~1)`)
  if (Math.abs(finalSum - 2) > EPS) issues.push(`Final-Teilnahme-Summe über alle Teams = ${finalSum.toFixed(3)} (erwartet ~2)`)
  if (Math.abs(semifinalSum - 4) > EPS) issues.push(`Halbfinal-Teilnahme-Summe über alle Teams = ${semifinalSum.toFixed(3)} (erwartet ~4)`)
  if (Math.abs(quarterfinalSum - 8) > EPS) issues.push(`Viertelfinal-Teilnahme-Summe über alle Teams = ${quarterfinalSum.toFixed(3)} (erwartet ~8)`)

  return issues
}
