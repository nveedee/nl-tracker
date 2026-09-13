// ---------------------------------------------------------------------------
// Prediction Tracking & Model Performance - reine Auswertungsfunktionen
// (kein React, keine neue Prognoseformel). Werten ausschliesslich bereits
// gespeicherte, unveränderliche Pre-Game Prediction Snapshots
// (db.predictions[], siehe server/scripts/predictions.js) gegen die
// tatsächlichen Spielergebnisse (db.games[]) aus.
//
// Leak-frei per Konstruktion: die hier verwendeten Wahrscheinlichkeiten
// stammen 1:1 aus dem beim Sync eingefrorenen Snapshot - diese Datei
// berechnet nichts aus dem heutigen ELO/Power Ranking neu. Ein Spiel ohne
// vorherigen Snapshot wird sauber ausgeschlossen (kein Crash, keine
// erfundene Prediction).
//
// OT/SO: der tatsächliche Sieger ergibt sich immer aus homeGoals/awayGoals
// (SIHF liefert das entscheidende OT/SO-Tor bereits im Endstand) - keine
// Sonderbehandlung nötig, "wer mehr Tore hat, hat gewonnen" gilt unabhängig
// von REG/OT/SO.
// ---------------------------------------------------------------------------

import { isFinalGame } from './stats.js'

const EPS = 1e-10

// Buckets nach der vom Modell favorisierten Wahrscheinlichkeit
// (max(homeWinProbability, awayWinProbability)), nicht nach Heim-/
// Auswärts-Perspektive - so lässt sich prüfen, ob z.B. "70-75%-Favoriten"
// über alle Spiele hinweg wirklich ~70-75% ihrer Spiele gewinnen.
export const CALIBRATION_BUCKETS = [
  { lo: 0.50, hi: 0.55, label: '50–55%' },
  { lo: 0.55, hi: 0.60, label: '55–60%' },
  { lo: 0.60, hi: 0.65, label: '60–65%' },
  { lo: 0.65, hi: 0.70, label: '65–70%' },
  { lo: 0.70, hi: 0.75, label: '70–75%' },
  { lo: 0.75, hi: 0.80, label: '75–80%' },
  { lo: 0.80, hi: 1.0001, label: '80%+' },
]

// Verknüpft jeden Prediction-Snapshot mit seinem (falls vorhandenen,
// tatsächlich beendeten) Spielergebnis. Spiele ohne Snapshot oder Snapshots
// zu noch nicht beendeten Spielen werden nicht in die Auswertung
// aufgenommen. Chronologisch sortiert (für Zeitverlauf/Checkpoints).
export function joinPredictionsWithResults(predictions, games) {
  const gameById = new Map((games || []).map((g) => [g.id, g]))
  const rows = []
  for (const p of predictions || []) {
    const g = gameById.get(p.gameId)
    if (!g || !isFinalGame(g)) continue
    if (p.homeWinProbability == null || p.awayWinProbability == null) continue

    const homeWon = g.homeGoals > g.awayGoals
    const favoriteIsHome = p.homeWinProbability >= p.awayWinProbability
    const favoriteProbability = Math.max(p.homeWinProbability, p.awayWinProbability)
    const correct = favoriteIsHome === homeWon

    rows.push({ prediction: p, game: g, homeWon, favoriteIsHome, favoriteProbability, correct })
  }
  rows.sort((a, b) => {
    const da = a.game.date + (a.game.time || '')
    const db_ = b.game.date + (b.game.time || '')
    return da < db_ ? -1 : da > db_ ? 1 : 0
  })
  return rows
}

export function computeAccuracy(rows) {
  if (!rows || rows.length === 0) return null
  return rows.filter((r) => r.correct).length / rows.length
}

// Standard binärer Brier Score: Mittelwert von (p_home - tatsächlicherHeimsieg)².
export function computeBrierScore(rows) {
  if (!rows || rows.length === 0) return null
  const sum = rows.reduce((s, r) => {
    const actual = r.homeWon ? 1 : 0
    const p = r.prediction.homeWinProbability
    return s + (p - actual) ** 2
  }, 0)
  return sum / rows.length
}

// Standard Log Loss mit Epsilon-Clipping (verhindert -Infinity bei p nahe 0/1).
export function computeLogLoss(rows) {
  if (!rows || rows.length === 0) return null
  const sum = rows.reduce((s, r) => {
    const actual = r.homeWon ? 1 : 0
    const p = Math.min(1 - EPS, Math.max(EPS, r.prediction.homeWinProbability))
    return s - (actual * Math.log(p) + (1 - actual) * Math.log(1 - p))
  }, 0)
  return sum / rows.length
}

// Anteil Spiele, in denen der vom Modell favorisierte Team gewonnen hat -
// inhaltlich identisch zu computeAccuracy(), hier nur unter dem im Auftrag
// verwendeten Namen für die "Model-vs-Result"-Darstellung.
export function computeFavoriteWinRate(rows) {
  return computeAccuracy(rows)
}

// Upset = Team mit der NIEDRIGEREN Modellwahrscheinlichkeit gewinnt -
// exaktes Komplement der Favoriten-Trefferquote.
export function computeUpsetRate(rows) {
  const acc = computeAccuracy(rows)
  return acc == null ? null : 1 - acc
}

export function computeCalibration(rows) {
  return CALIBRATION_BUCKETS.map((b) => {
    const inBucket = (rows || []).filter((r) => r.favoriteProbability >= b.lo && r.favoriteProbability < b.hi)
    const hits = inBucket.filter((r) => r.correct).length
    return {
      ...b,
      count: inBucket.length,
      actualRate: inBucket.length > 0 ? hits / inBucket.length : null,
    }
  })
}

// Kumulative Kennzahlen NACH den ersten n ausgewerteten Spielen (chronologisch),
// nur für Checkpoints, die tatsächlich erreicht wurden.
export function computeCheckpoints(rows, checkpoints = [25, 50, 100, 200]) {
  return checkpoints
    .filter((n) => n <= (rows ? rows.length : 0))
    .map((n) => {
      const subset = rows.slice(0, n)
      return { n, accuracy: computeAccuracy(subset), brier: computeBrierScore(subset), logLoss: computeLogLoss(subset) }
    })
}

// Kumulativer Verlauf für ein einfaches Liniendiagramm: Accuracy/Brier/LogLoss
// nach jedem einzelnen ausgewerteten Spiel (n=1..Anzahl).
export function computeCumulativeSeries(rows) {
  const out = []
  let correct = 0
  let brierSum = 0
  let logLossSum = 0
  for (let i = 0; i < (rows ? rows.length : 0); i++) {
    const r = rows[i]
    const actual = r.homeWon ? 1 : 0
    const p = r.prediction.homeWinProbability
    if (r.correct) correct++
    brierSum += (p - actual) ** 2
    const pClipped = Math.min(1 - EPS, Math.max(EPS, p))
    logLossSum -= (actual * Math.log(pClipped) + (1 - actual) * Math.log(1 - pClipped))
    const n = i + 1
    out.push({ n, accuracy: correct / n, brier: brierSum / n, logLoss: logLossSum / n })
  }
  return out
}

// ---------------------------------------------------------------------------
// Erweiterung: Real-Season Model Evaluation (zusätzlich zu den obigen,
// bereits produktiv genutzten Grundfunktionen - rein additiv, nichts oben
// wurde verändert). Weiterhin: ausschliesslich die gespeicherten Snapshot-
// Werte, keine Neuberechnung mit heutigen Modelldaten.
// ---------------------------------------------------------------------------

// Mean Absolute Error der vorhergesagten Heim-Wahrscheinlichkeit gegen den
// tatsächlichen Heimsieg-Indikator (0/1).
export function computeMAE(rows) {
  if (!rows || rows.length === 0) return null
  const sum = rows.reduce((s, r) => s + Math.abs(r.prediction.homeWinProbability - (r.homeWon ? 1 : 0)), 0)
  return sum / rows.length
}

// Durchschnittliche vorhergesagte Heim-Wahrscheinlichkeit vs. tatsächliche
// Heimsieg-Rate - einfachster aggregierter Bias-Check (systematisch zu
// hoch/tief?), unabhängig von der feineren Bin-Calibration weiter unten.
export function computeAggregateBias(rows) {
  if (!rows || rows.length === 0) return null
  const avgPredicted = rows.reduce((s, r) => s + r.prediction.homeWinProbability, 0) / rows.length
  const actualRate = rows.reduce((s, r) => s + (r.homeWon ? 1 : 0), 0) / rows.length
  return { avgPredicted, actualRate, diff: avgPredicted - actualRate }
}

function metricsForSubset(rows) {
  if (!rows || rows.length === 0) return null
  return {
    n: rows.length,
    accuracy: computeAccuracy(rows),
    brier: computeBrierScore(rows),
    logLoss: computeLogLoss(rows),
  }
}

// OT/SO separat vs. reguläre Spiele - derselbe tatsächliche-Sieger-Logik
// (homeGoals/awayGoals) gilt für beide, hier nur nach `decision` aufgeteilt,
// um zu sehen ob das Modell bei Verlängerungs-/Penalty-Spielen anders
// abschneidet (die per Definition näher am Münzwurf liegen).
export function computeOtSoBreakdown(rows) {
  const reg = (rows || []).filter((r) => r.game.decision === 'REG')
  const otso = (rows || []).filter((r) => r.game.decision === 'OT' || r.game.decision === 'SO')
  const ot = (rows || []).filter((r) => r.game.decision === 'OT')
  const so = (rows || []).filter((r) => r.game.decision === 'SO')
  return {
    reg: metricsForSubset(reg),
    otso: metricsForSubset(otso),
    ot: metricsForSubset(ot),
    so: metricsForSubset(so),
  }
}

// 10 Bins über den VOLLEN 0-100%-Bereich der rohen Heim-Wahrscheinlichkeit
// (klassisches Reliability-Diagram-Bucketing, ein Datenpunkt pro Spiel:
// (homeWinProbability, homeWon) - NICHT nach Favorit gefaltet, im
// Unterschied zu computeCalibration() oben, das absichtlich für die
// einfachere "Favorit"-Sicht beibehalten wird).
export const CALIBRATION_BINS_10 = Array.from({ length: 10 }, (_, i) => ({
  lo: i / 10, hi: (i + 1) / 10, label: `${i * 10}–${(i + 1) * 10}%`,
}))
const LOW_SAMPLE_THRESHOLD = 10

export function computeCalibrationBins10(rows) {
  return CALIBRATION_BINS_10.map((b) => {
    const inBin = (rows || []).filter((r) => {
      const p = r.prediction.homeWinProbability
      return p >= b.lo && (b.hi === 1 ? p <= b.hi : p < b.hi)
    })
    const n = inBin.length
    if (n === 0) return { ...b, count: 0, avgPredicted: null, actualRate: null, diff: null, lowSample: true }
    const avgPredicted = inBin.reduce((s, r) => s + r.prediction.homeWinProbability, 0) / n
    const actualRate = inBin.reduce((s, r) => s + (r.homeWon ? 1 : 0), 0) / n
    return { ...b, count: n, avgPredicted, actualRate, diff: avgPredicted - actualRate, lowSample: n < LOW_SAMPLE_THRESHOLD }
  })
}

// Expected Calibration Error: gewichtete Summe der absoluten Differenz
// zwischen Ø-Prediction und tatsächlicher Rate über die Bins, gewichtet mit
// dem Anteil jedes Bins an der Gesamtzahl (Standard-ECE-Formel):
//   ECE = Σ_bins (n_bin / N) · |avgPredicted_bin - actualRate_bin|
export function computeECE(rows, bins = null) {
  const total = rows ? rows.length : 0
  if (total === 0) return null
  const b = bins || computeCalibrationBins10(rows)
  const sum = b.reduce((s, bin) => (bin.count > 0 ? s + (bin.count / total) * Math.abs(bin.diff) : s), 0)
  return sum
}

// Gleitender Durchschnitt über die letzten `window` Spiele (chronologisch),
// zusätzlich zur bestehenden kumulativen Serie (computeCumulativeSeries).
export function computeRollingSeries(rows, window = 25) {
  const out = []
  for (let i = 0; i < (rows ? rows.length : 0); i++) {
    const start = Math.max(0, i - window + 1)
    const subset = rows.slice(start, i + 1)
    out.push({ n: i + 1, accuracy: computeAccuracy(subset), brier: computeBrierScore(subset), logLoss: computeLogLoss(subset) })
  }
  return out
}

// Segment-Analyse: (A/B) Heim- vs. Auswärtsfavorit, (C-F) Favoriten-Stärke-
// Stufen anhand der gefalteten Favoriten-Wahrscheinlichkeit. accuracy/brier/
// logLoss werden weiterhin aus der Heim-Perspektive berechnet (Standard,
// ordnungsunabhängig) - nur die Teilmengen unterscheiden sich.
export function computeSegments(rows) {
  const r = rows || []
  const homeFavorite = r.filter((x) => x.favoriteIsHome)
  const awayFavorite = r.filter((x) => !x.favoriteIsHome)
  const closeGames = r.filter((x) => x.favoriteProbability >= 0.45 && x.favoriteProbability < 0.55)
  const lightFavorites = r.filter((x) => x.favoriteProbability >= 0.55 && x.favoriteProbability < 0.65)
  const clearFavorites = r.filter((x) => x.favoriteProbability >= 0.65 && x.favoriteProbability < 0.80)
  const veryClearFavorites = r.filter((x) => x.favoriteProbability >= 0.80)
  const withFavRate = (subset) => {
    const m = metricsForSubset(subset)
    return m ? { ...m, favoriteWinRate: computeFavoriteWinRate(subset) } : null
  }
  return {
    homeFavorite: withFavRate(homeFavorite),
    awayFavorite: withFavRate(awayFavorite),
    closeGames: withFavRate(closeGames),
    lightFavorites: withFavRate(lightFavorites),
    clearFavorites: withFavRate(clearFavorites),
    veryClearFavorites: withFavRate(veryClearFavorites),
  }
}

// Team-Analyse: pro Team getrennt Heim/Auswärts, jeweils aus der Sicht
// DIESES Teams (eigene Sieg-Wahrscheinlichkeit vs. eigener tatsächlicher
// Sieg) - bewusst nicht einfach die Heim-Perspektive wiederverwendet, da ein
// Team abwechselnd Heim und Auswärts ist.
export function computeTeamStats(rows, minGames = 5) {
  const byTeam = new Map()
  const ensure = (teamId) => {
    if (!byTeam.has(teamId)) byTeam.set(teamId, { home: [], away: [] })
    return byTeam.get(teamId)
  }
  for (const r of rows || []) {
    ensure(r.game.homeTeamId).home.push({ p: r.prediction.homeWinProbability, won: r.homeWon })
    ensure(r.game.awayTeamId).away.push({ p: r.prediction.awayWinProbability, won: !r.homeWon })
  }
  const summarize = (entries) => {
    if (!entries || entries.length === 0) return null
    const n = entries.length
    const correct = entries.filter((e) => (e.p >= 0.5) === e.won).length
    const brier = entries.reduce((s, e) => s + (e.p - (e.won ? 1 : 0)) ** 2, 0) / n
    const avgPredicted = entries.reduce((s, e) => s + e.p, 0) / n
    const actualRate = entries.reduce((s, e) => s + (e.won ? 1 : 0), 0) / n
    return { n, accuracy: correct / n, brier, avgPredicted, actualRate, lowSample: n < minGames }
  }
  const out = {}
  for (const [teamId, v] of byTeam) out[teamId] = { home: summarize(v.home), away: summarize(v.away) }
  return out
}

// Grösste Fehlprognosen: NICHT naiv "Prozentpunkte-Abstand vom Favoriten",
// sondern korrekt anhand des tatsächlichen Brier-Beitrags ((p-y)²) und der
// LogLoss-Penalty (-log(p_korrekt)) der tatsächlich eingetroffenen Seite.
export function computeBiggestMisses(rows, n = 10) {
  return [...(rows || [])]
    .map((r) => {
      const actual = r.homeWon ? 1 : 0
      const p = r.prediction.homeWinProbability
      const brierContribution = (p - actual) ** 2
      const pCorrectSide = Math.min(1 - EPS, Math.max(EPS, r.homeWon ? p : 1 - p))
      const logLossPenalty = -Math.log(pCorrectSide)
      return { ...r, brierContribution, logLossPenalty }
    })
    .sort((a, b) => b.logLossPenalty - a.logLossPenalty)
    .slice(0, n)
}

// Model Drift: erste vs. letzte `window` ausgewertete Spiele (chronologisch).
// Nur sinnvoll interpretierbar ab minTotal Spielen (Aufrufer prüft das).
export function computeDrift(rows, window = 25) {
  if (!rows || rows.length < window * 2) return null
  const first = rows.slice(0, window)
  const last = rows.slice(-window)
  const withCalibError = (subset) => {
    const bias = computeAggregateBias(subset)
    return { ...metricsForSubset(subset), calibrationError: bias ? Math.abs(bias.diff) : null }
  }
  return { first: withCalibError(first), last: withCalibError(last) }
}
