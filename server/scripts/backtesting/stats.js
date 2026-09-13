// ---------------------------------------------------------------------------
// Statistik-Hilfsfunktionen für den Backtest-Runner: baut mit
// src/predictionMetrics.js KOMPATIBLE "rows" (dieselbe Funktion misst so
// sowohl die echten 2026/27-Snapshots auf /model-performance als auch den
// historischen Backtest hier - keine zweite, abweichende Metrik-Definition),
// plus Bootstrap-Konfidenzintervalle für den paarweisen Modellvergleich
// (Abschnitt 8) und eine feinere Kalibrierungs-Bucket-Definition
// (Abschnitt 7: 50-55...90%+, statt der 7 gröberen Buckets aus
// predictionMetrics.js).
// ---------------------------------------------------------------------------

import { computeECE } from '../../../src/predictionMetrics.js'

// Baut eine mit src/predictionMetrics.js kompatible "row" aus einer
// Backtest-Prognose (pHome) + dem tatsächlichen historischen Spiel.
export function toMetricRow(game, pHome) {
  const homeWon = game.homeGoals > game.awayGoals
  const awayP = 1 - pHome
  const favoriteIsHome = pHome >= awayP
  const favoriteProbability = Math.max(pHome, awayP)
  return {
    prediction: { homeWinProbability: pHome, awayWinProbability: awayP },
    game,
    homeWon,
    favoriteIsHome,
    favoriteProbability,
    correct: favoriteIsHome === homeWon,
  }
}

// Feinere Kalibrierungs-Buckets (Abschnitt 7 der Aufgabe: 50-55...90%+, nicht
// die 7 gröberen Standard-Buckets aus predictionMetrics.js::CALIBRATION_BUCKETS).
export const FINE_CALIBRATION_BUCKETS = [
  { lo: 0.50, hi: 0.55, label: '50–55%' },
  { lo: 0.55, hi: 0.60, label: '55–60%' },
  { lo: 0.60, hi: 0.65, label: '60–65%' },
  { lo: 0.65, hi: 0.70, label: '65–70%' },
  { lo: 0.70, hi: 0.75, label: '70–75%' },
  { lo: 0.75, hi: 0.80, label: '75–80%' },
  { lo: 0.80, hi: 0.85, label: '80–85%' },
  { lo: 0.85, hi: 0.90, label: '85–90%' },
  { lo: 0.90, hi: 1.0001, label: '90%+' },
]

// Dünne Bins (Abschnitt 15e): unter dieser Fallzahl wird `lowSample:true`
// markiert, statt eine Quote aus wenigen Spielen als belastbar darzustellen.
const LOW_SAMPLE_THRESHOLD = 20

// Analog zu predictionMetrics.js::computeCalibration(), aber mit den
// feineren FINE_CALIBRATION_BUCKETS und explizitem lowSample-Flag - über
// beliebige (i.d.R. über mehrere Saisons gepoolte) rows.
export function computeFineCalibration(rows) {
  return FINE_CALIBRATION_BUCKETS.map((b) => {
    const inBucket = (rows || []).filter((r) => r.favoriteProbability >= b.lo && r.favoriteProbability < b.hi)
    const n = inBucket.length
    if (n === 0) return { ...b, count: 0, avgPredicted: null, actualRate: null, diff: null, lowSample: true }
    const avgPredicted = inBucket.reduce((s, r) => s + r.favoriteProbability, 0) / n
    const hits = inBucket.filter((r) => r.correct).length
    const actualRate = hits / n
    return { ...b, count: n, avgPredicted, actualRate, diff: avgPredicted - actualRate, lowSample: n < LOW_SAMPLE_THRESHOLD }
  })
}

// ECE über die feinen Buckets (wiederverwendet computeECE()s gewichtete
// Summenformel aus predictionMetrics.js unverändert, nur mit anderen Bins).
export function computeFineECE(rows) {
  return computeECE(rows, computeFineCalibration(rows))
}

// ============================================================================
// Bootstrap-Konfidenzintervall für den PAARWEISEN Vergleich zweier Modelle
// (Abschnitt 8) - resampelt SPIEL-INDIZES (nicht die Modelle unabhängig
// voneinander), damit die Paarung "beide Modelle sagen dasselbe Spiel voraus"
// über die Resamples erhalten bleibt (korrekt korrelierter Vergleich statt
// zweier unabhängiger Verteilungen).
// ============================================================================

// Einfacher, deterministischer PRNG (Mulberry32, wie src/playoffSim.js) -
// reproduzierbare Bootstrap-Läufe bei gleichem Seed, kein externer
// Zufalls-Abhängigkeit.
function mulberry32(seed) {
  let s = seed >>> 0
  return function next() {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function logLossOf(pairs) {
  const EPS = 1e-10
  let sum = 0
  for (const { p, y } of pairs) {
    const pc = Math.min(1 - EPS, Math.max(EPS, p))
    sum += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc))
  }
  return sum / pairs.length
}

// `pairsA`/`pairsB`: parallele Arrays gleicher Länge (dasselbe Spiel an
// Index i in beiden) mit { p: vorhergesagte Heimsieg-Wahrscheinlichkeit,
// y: tatsächlicher Heimsieg (0/1) }. Gibt Bootstrap-Verteilung der
// LogLoss-Differenz (B - A) zurück: negativ = B besser.
export function bootstrapLogLossDelta(pairsA, pairsB, { resamples = 2000, seed = 42 } = {}) {
  if (pairsA.length !== pairsB.length || pairsA.length === 0) {
    return { n: pairsA.length, deltas: [], ci95: null, pctBBetter: null, meanDelta: null }
  }
  const n = pairsA.length
  const rng = mulberry32(seed)
  const deltas = new Array(resamples)
  for (let r = 0; r < resamples; r++) {
    let llA = 0, llB = 0
    const EPS = 1e-10
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n)
      const a = pairsA[idx], b = pairsB[idx]
      const pa = Math.min(1 - EPS, Math.max(EPS, a.p))
      const pb = Math.min(1 - EPS, Math.max(EPS, b.p))
      llA += -(a.y * Math.log(pa) + (1 - a.y) * Math.log(1 - pa))
      llB += -(b.y * Math.log(pb) + (1 - b.y) * Math.log(1 - pb))
    }
    deltas[r] = (llB - llA) / n
  }
  deltas.sort((x, y) => x - y)
  const lo = deltas[Math.floor(0.025 * resamples)]
  const hi = deltas[Math.ceil(0.975 * resamples) - 1]
  const pctBBetter = deltas.filter((d) => d < 0).length / resamples
  const meanDelta = deltas.reduce((s, d) => s + d, 0) / resamples
  const observedDelta = logLossOf(pairsB) - logLossOf(pairsA)
  return { n, ci95: [lo, hi], pctBBetter, meanDelta, observedDelta }
}

// Für wie viele der übergebenen Saisons hat B eine niedrigere LogLoss als A
// (Abschnitt 8: "in wie vielen Saisons besser"). `perSeasonPairs`:
// Map(season -> { a: [{p,y}], b: [{p,y}] }).
export function countSeasonsBetter(perSeasonPairs) {
  let better = 0, total = 0
  const perSeason = {}
  for (const [season, { a, b }] of perSeasonPairs) {
    if (a.length === 0 || b.length === 0) continue
    total++
    const llA = logLossOf(a)
    const llB = logLossOf(b)
    const isBetter = llB < llA
    if (isBetter) better++
    perSeason[season] = { llA, llB, better: isBetter }
  }
  return { better, total, perSeason }
}
