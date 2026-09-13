// ---------------------------------------------------------------------------
// READ-ONLY Diagnose der Seed-Sensitivität von simulateSeasonProjections()
// (src/playoffSim.js, UNVERÄNDERT importiert und aufgerufen - kein Byte
// dieser Datei wird angefasst). Liest nur server/data/db.json, schreibt
// nirgends hin.
//
// Instrumentierung: SeededRandom.prototype.next wird zur Laufzeit von
// AUSSEN (aus diesem Skript) mit einem Zähler umhüllt, um zu messen, wie
// viele Zufallszahlen ein einzelner Saison+Playoff-Durchlauf verbraucht.
// Das ist reines Monkey-Patching zur Beobachtung - der Quellcode auf der
// Festplatte bleibt unverändert, und die Patch-Funktion ruft die
// Original-Implementierung unverändert auf (reine Zähl-Instrumentierung,
// keine Verhaltensänderung).
// ---------------------------------------------------------------------------

import fs from 'fs'
import { simulateSeasonProjections, SeededRandom } from '../../src/playoffSim.js'
import { ELO_CONFIG } from '../../src/elo.js'

const db = JSON.parse(fs.readFileSync('./server/data/db.json', 'utf-8'))
const { teams, games, settings, players } = db

// Pre-Season-ELO (identische Formel wie src/preseasonElo.js::computePreseasonRatings,
// hier dupliziert statt importiert, da preseasonElo.js ein React-Hook-Modul ist -
// exakt das bereits im Projekt etablierte Muster, siehe server/scripts/predictions.js).
function computePreseasonRatings(seasonEndRatings, eloStart) {
  if (!seasonEndRatings) return null
  const regression = ELO_CONFIG.seasonEndRegression
  const out = {}
  for (const [teamId, rating] of Object.entries(seasonEndRatings)) {
    out[teamId] = eloStart + (rating - eloStart) * (1 - regression)
  }
  return out
}
let preseasonSeasonEnd = null
try { preseasonSeasonEnd = JSON.parse(fs.readFileSync('./public/preseason-elo.json', 'utf-8')) } catch {}
const initialRatings = computePreseasonRatings(preseasonSeasonEnd, settings?.eloStart ?? ELO_CONFIG.eloStart)

const N_SEEDS = 50
const RUNS = 10000

function randSeed() {
  return Math.floor(Math.random() * 2_000_000_000) + 1
}

// ---------------------------------------------------------------------------
// 1) RNG-Perioden-Analyse: Konstanten aus dem tatsächlich importierten
//    SeededRandom auslesen (nicht raten - über eine Testinstanz beobachten).
// ---------------------------------------------------------------------------
console.log('='.repeat(78))
console.log('1) RNG-ANALYSE (SeededRandom, src/playoffSim.js)')
console.log('='.repeat(78))
{
  // Periode empirisch bestimmen: wie viele next()-Aufrufe, bis derselbe
  // interne Zustand (== derselbe zurückgegebene Wert an derselben Position)
  // wieder auftritt.
  const probe = new SeededRandom(1)
  const seen = new Map()
  let period = null
  let val = null
  for (let i = 0; i < 500000; i++) {
    val = probe.next()
    const state = probe.seed // interner Zustand nach next()
    if (seen.has(state)) { period = i - seen.get(state); break }
    seen.set(state, i)
  }
  console.log(`Empirisch gemessene Periode des LCG: ${period ?? '>500000 (nicht gefunden)'}`)
  console.log(`(Quellcode: seed = (seed*9301+49297) % 233280 -> theoretische Maximalperiode = 233280)`)
}

// ---------------------------------------------------------------------------
// 2) Verbrauchte rng.next()-Aufrufe pro vollständigem Saison+Playoff-Durchlauf
//    messen (Monkey-Patch-Zähler, kleiner dedizierter Lauf).
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(78))
console.log('2) RNG-VERBRAUCH PRO SAISON-SIMULATION')
console.log('='.repeat(78))
let callCounts = []
{
  const origNext = SeededRandom.prototype.next
  let counter = 0
  SeededRandom.prototype.next = function () { counter++; return origNext.call(this) }

  const MEASURE_RUNS = 300
  // Wir messen den GESAMTVERBRAUCH eines Batches mit MEASURE_RUNS Läufen und
  // teilen durch MEASURE_RUNS -> Durchschnitt pro Saison-Simulation.
  counter = 0
  simulateSeasonProjections(teams, games, settings, { runs: MEASURE_RUNS, seed: 777, players, initialRatings })
  const avgCallsPerSeason = counter / MEASURE_RUNS
  callCounts.push(avgCallsPerSeason)

  SeededRandom.prototype.next = origNext // Patch wieder entfernen

  const period = 233280 // aus Quellcode, siehe oben bestätigt
  const callsPerFullBatch = avgCallsPerSeason * RUNS
  const cyclesPerBatch = callsPerFullBatch / period

  console.log(`Ø rng.next()-Aufrufe pro vollständiger Saison+Playoff-Simulation: ${avgCallsPerSeason.toFixed(1)}`)
  console.log(`Hochgerechnet auf einen 10'000er-Batch: ${Math.round(callsPerFullBatch).toLocaleString()} Aufrufe`)
  console.log(`LCG-Periode: ${period.toLocaleString()}`)
  console.log(`=> Die LCG-Periode wird pro 10'000er-Batch ca. ${cyclesPerBatch.toFixed(1)}x vollständig durchlaufen (wiederholt).`)
}

// ---------------------------------------------------------------------------
// 3) Determinismus-Gegenprobe: gleicher Seed zweimal -> bitidentisch?
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(78))
console.log('3) DETERMINISMUS-GEGENPROBE (gleicher Seed, 2x ausgeführt)')
console.log('='.repeat(78))
{
  const testSeed = 123456789
  const runA = simulateSeasonProjections(teams, games, settings, { runs: 2000, seed: testSeed, players, initialRatings })
  const runB = simulateSeasonProjections(teams, games, settings, { runs: 2000, seed: testSeed, players, initialRatings })
  const identical = JSON.stringify(runA.rows) === JSON.stringify(runB.rows) && runA.seed === runB.seed
  console.log(`Seed ${testSeed}, 2x mit runs=2000 ausgeführt: ${identical ? 'BITIDENTISCH ✓' : 'ABWEICHEND ✗ (Determinismus verletzt!)'}`)
}

// ---------------------------------------------------------------------------
// 4) Hauptdurchlauf: 50 unabhängige Seeds x 10'000 Simulationen
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(78))
console.log(`4) HAUPTDURCHLAUF: ${N_SEEDS} Seeds x ${RUNS.toLocaleString()} Simulationen`)
console.log('='.repeat(78))

const t0 = Date.now()
const seeds = Array.from({ length: N_SEEDS }, randSeed)
const batches = []
const sumChampionPerBatch = []

for (let i = 0; i < seeds.length; i++) {
  const seed = seeds[i]
  const result = simulateSeasonProjections(teams, games, settings, { runs: RUNS, seed, players, initialRatings })
  batches.push(result)
  const sumChampion = result.rows.reduce((s, r) => s + r.pChampion, 0)
  sumChampionPerBatch.push(sumChampion)
  if ((i + 1) % 10 === 0) console.log(`  ... ${i + 1}/${seeds.length} Batches fertig (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}
const elapsed = (Date.now() - t0) / 1000
console.log(`Fertig in ${elapsed.toFixed(1)}s (${(elapsed / N_SEEDS * 1000).toFixed(0)}ms pro 10'000er-Batch)`)

// Summe Meisterwahrscheinlichkeiten pro Lauf = 100%?
console.log()
console.log('--- Summe Meisterwahrscheinlichkeiten pro Batch (Soll: 1.0) ---')
const sumDeviations = sumChampionPerBatch.map((s) => Math.abs(s - 1))
console.log(`Max. Abweichung von 1.0 über alle ${N_SEEDS} Batches: ${Math.max(...sumDeviations).toExponential(3)}`)
console.log(`Alle Batches summieren exakt (Floating-Point-Toleranz 1e-9) auf 1.0: ${sumDeviations.every((d) => d < 1e-9) ? 'JA ✓' : 'NEIN ✗'}`)

// ---------------------------------------------------------------------------
// 5) Statistik pro Team über die 50 Batches
// ---------------------------------------------------------------------------
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length }
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length / 2; return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[Math.floor(m)] }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) }
function percentile(a, p) { const s = [...a].sort((x, y) => x - y); const idx = (s.length - 1) * p; const lo = Math.floor(idx), hi = Math.ceil(idx); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo) }

const teamStats = teams.map((t) => {
  const champVals = batches.map((b) => b.rows.find((r) => r.team.id === t.id).pChampion)
  const playoffVals = batches.map((b) => b.rows.find((r) => r.team.id === t.id).pPlayoffs)
  const top6Vals = batches.map((b) => b.rows.find((r) => r.team.id === t.id).pTop6)
  const top4Vals = batches.map((b) => b.rows.find((r) => r.team.id === t.id).pTop4)
  const finalVals = batches.map((b) => b.rows.find((r) => r.team.id === t.id).pFinal)
  const avgPtsVals = batches.map((b) => b.rows.find((r) => r.team.id === t.id).avgPts)
  const avgRankVals = batches.map((b) => b.rows.find((r) => r.team.id === t.id).avgRank)

  const champMean = mean(champVals)
  const champStd = std(champVals)
  const theoreticalStd = Math.sqrt(champMean * (1 - champMean) / RUNS)
  const ratio = theoreticalStd > 0 ? champStd / theoreticalStd : null

  return {
    team: t.short || t.name,
    champMean, champMedian: median(champVals), champStd,
    champMin: Math.min(...champVals), champMax: Math.max(...champVals),
    champP5: percentile(champVals, 0.05), champP95: percentile(champVals, 0.95),
    theoreticalStd, ratio,
    playoffMean: mean(playoffVals), top6Mean: mean(top6Vals), top4Mean: mean(top4Vals), finalMean: mean(finalVals),
    avgPtsMean: mean(avgPtsVals), avgRankMean: mean(avgRankVals),
  }
})
teamStats.sort((a, b) => b.champMean - a.champMean)

console.log()
console.log('='.repeat(78))
console.log('5) STATISTIK PRO TEAM (Meisterchance über 50 Batches à 10\'000 Läufe)')
console.log('='.repeat(78))
console.log('Team'.padEnd(6), 'Mean%'.padStart(7), 'Median%'.padStart(8), 'SD(pp)'.padStart(7), 'Min%'.padStart(6), 'Max%'.padStart(6), 'P5%'.padStart(6), 'P95%'.padStart(6), 'TheorSD(pp)'.padStart(12), 'Ratio'.padStart(7))
for (const s of teamStats) {
  console.log(
    s.team.padEnd(6),
    (s.champMean * 100).toFixed(2).padStart(7),
    (s.champMedian * 100).toFixed(2).padStart(8),
    (s.champStd * 100).toFixed(3).padStart(7),
    (s.champMin * 100).toFixed(2).padStart(6),
    (s.champMax * 100).toFixed(2).padStart(6),
    (s.champP5 * 100).toFixed(2).padStart(6),
    (s.champP95 * 100).toFixed(2).padStart(6),
    (s.theoreticalStd * 100).toFixed(3).padStart(12),
    s.ratio != null ? s.ratio.toFixed(1).padStart(7) : '   n/a'
  )
}

console.log()
console.log('--- Mittelwerte weiterer Kennzahlen (über 50 Batches) ---')
console.log('Team'.padEnd(6), 'Playoffs%'.padStart(10), 'Top6%'.padStart(7), 'Top4%'.padStart(7), 'Final%'.padStart(7), 'ØPkt'.padStart(7), 'ØRang'.padStart(7))
for (const s of teamStats) {
  console.log(
    s.team.padEnd(6),
    (s.playoffMean * 100).toFixed(1).padStart(10),
    (s.top6Mean * 100).toFixed(1).padStart(7),
    (s.top4Mean * 100).toFixed(1).padStart(7),
    (s.finalMean * 100).toFixed(1).padStart(7),
    s.avgPtsMean.toFixed(1).padStart(7),
    s.avgRankMean.toFixed(2).padStart(7)
  )
}

console.log()
console.log('='.repeat(78))
console.log('6) VERHÄLTNIS EMPIRISCH/THEORETISCH - ZUSAMMENFASSUNG')
console.log('='.repeat(78))
const ratios = teamStats.filter((s) => s.ratio != null).map((s) => s.ratio)
console.log(`Ratio-Bereich über alle Teams: ${Math.min(...ratios).toFixed(1)}x - ${Math.max(...ratios).toFixed(1)}x`)
console.log(`Ratio-Median über alle Teams: ${median(ratios).toFixed(1)}x`)
const worst = [...teamStats].sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0)).slice(0, 5)
console.log('Teams mit dem höchsten Verhältnis (am stärksten überproportional streuend):')
worst.forEach((s) => console.log(`  ${s.team}: ${s.ratio.toFixed(1)}x (Mean ${(s.champMean * 100).toFixed(1)}%)`))

console.log()
console.log('Diagnose-Skript abgeschlossen. Keine Produktivdatei wurde verändert.')
