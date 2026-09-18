// ---------------------------------------------------------------------------
// PLAYER-RATING-INTEGRATION-BACKTEST - testet, mit welchem Gewicht (0-25%)
// das Player Rating sinnvoll zusätzlich zum bestehenden ELO-Modell verwendet
// werden könnte. REIN ANALYTISCH: verändert/importiert NICHT die produktive
// Prediction Engine (src/elo.js, src/pregamePrediction.js,
// server/scripts/predictions.js) - alle Formeln werden read-only auf dem
// historischen Archiv repliziert, exakt wie in server/scripts/backtest-elo.js
// und server/scripts/backtest-player-rating.js etabliert (deren ELO-Baseline
// -Parameter hier 1:1 wiederverwendet werden, für Vergleichbarkeit mit dem
// ersten Player-Rating-Backtest).
//
// Aufruf: node server/scripts/backtest-player-rating-integration.js
// ---------------------------------------------------------------------------

import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import {
  loadHistoricalGames,
  createSkaterTracker, snapshotSkaterRates, updateSkaterTracker,
  createGoalieTracker, snapshotGoalieRates, updateGoalieTracker,
  buildSkaterBaselineFromRates, buildGoalieBaselineFromRates,
  computeHistSkaterRating, computeHistGoalieRating,
  normalCdf, evalBinaryPredictions, mean,
} from '../playerRatingBacktestCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url)

// Gleiche ELO-Baseline-Parameter wie server/scripts/backtest-elo.js/
// backtest-player-rating.js (dieselbe leak-freie Rekonstruktion des
// PRODUKTIVEN ELO - Home-Advantage NICHT entfernt, siehe Auftrag Punkt 2).
export const ELO_PARAMS = { kBase: 24, homeAdv: 50, goalDiffFactor: 0.5, regressionFraction: 0 }

// Die 6 zu testenden Gewichtungen (Auftrag Punkt 2) - ELO-Gewicht, Player-
// Rating-Gewicht ist jeweils der Rest zu 1.
export const WEIGHT_GRID = [
  { label: 'A: ELO 100% / Rating 0%', eloWeight: 1.00 },
  { label: 'B: ELO 95% / Rating 5%', eloWeight: 0.95 },
  { label: 'C: ELO 90% / Rating 10%', eloWeight: 0.90 },
  { label: 'D: ELO 85% / Rating 15%', eloWeight: 0.85 },
  { label: 'E: ELO 80% / Rating 20%', eloWeight: 0.80 },
  { label: 'F: ELO 75% / Rating 25%', eloWeight: 0.75 },
]

export const VALIDATION_SEASONS = ['2022/23', '2023/24', '2024/25', '2025/26']

function kTiers(kBase) { const s = kBase / 24; return [{ maxGames: 5, k: 32 * s }, { maxGames: 15, k: 28 * s }, { maxGames: 30, k: 24 * s }, { maxGames: 50, k: 20 * s }, { maxGames: Infinity, k: 16 * s }] }
function getK(tiers, gp) { for (const t of tiers) if (gp <= t.maxGames) return t.k; return tiers[tiers.length - 1].k }
function goalDiffMult(diff, factor) { if (diff === 0 || factor === 0) return 1; return 1 + factor * (Math.log(diff + 1) - 1) }

// Thurstone/Bradley-Terry-artige Umrechnung einer z-Score-Differenz zweier
// (approximativ standardnormalverteilter) Stärke-Signale in eine
// Gewinnwahrscheinlichkeit: P(X_home > X_away) = Φ((zHome-zAway)/√2), unter
// der Annahme, dass beide Seiten je Einheitsvarianz haben. Standardtechnik,
// KEIN neu erfundener/gefitteter Skalierungsfaktor (im Gegensatz zu Model
// B/C aus dem ersten Backtest, die eine gefittete logistische Regression
// nutzten - hier bewusst NICHT gefittet, da Punkt 2 feste, vorgegebene
// Gewichte testen will, kein weiteres freies Parameter-Fitting).
export function ratingWinProbability(zDiff) {
  if (zDiff == null) return null
  return normalCdf(zDiff / Math.SQRT2)
}

// ============================================================================
// GOALIE-"WAHRSCHEINLICHER STARTER"-PROXY (Auftrag Punkt 7 - leak-sicher):
// NICHT der tatsächlich im Spiel eingesetzte Torhüter (das wäre ein mildes
// Leck - wer WIRKLICH spielt, ist vor dem Bully nicht mit Sicherheit bekannt),
// sondern der Torhüter, der unter den letzten `window` VOR diesem Spiel
// bereits bekannten Team-Einsätzen am häufigsten im Tor stand (Modalwert).
// Rein aus VERGANGENEN Daten abgeleitet, daher leak-frei.
// ============================================================================
function createGoalieStartTracker() { return new Map() } // teamId -> [{playerId}] chronologisch
function likelyStarter(tracker, teamId, window = 10) {
  const hist = tracker.get(teamId)
  if (!hist || hist.length === 0) return null
  const recent = hist.slice(-window)
  const counts = new Map()
  for (const { playerId } of recent) counts.set(playerId, (counts.get(playerId) || 0) + 1)
  let best = null, bestCount = -1
  for (const [playerId, c] of counts) if (c > bestCount) { best = playerId; bestCount = c }
  return best
}
function updateGoalieStartTracker(tracker, teamId, playerId) {
  if (!tracker.has(teamId)) tracker.set(teamId, [])
  tracker.get(teamId).push({ playerId })
}

// ============================================================================
// HAUPT-WALK-FORWARD: EIN einziger chronologischer Durchlauf, der ELO +
// mehrere Lineup-Strength-Varianten GLEICHZEITIG leak-frei berechnet (Auftrag
// Punkt 7/8). Exportiert, damit ein Leakage-Test denselben Code direkt
// aufrufen kann (siehe server/playerRatingIntegration.test.js).
// ============================================================================
export function runIntegrationWalkForward(games, options = {}) {
  const skaterTracker = createSkaterTracker()
  const goalieTracker = createGoalieTracker()
  const goalieStartTracker = createGoalieStartTracker()
  const eloRatings = new Map(), eloGamesPlayed = new Map()
  const tiers = kTiers(ELO_PARAMS.kBase)
  let currentSeason = null
  let cachedDate = null, skaterBaseline = null, goalieBaseline = null

  function rebuildBaselines() {
    const ratesByPos = { F: [], D: [] }
    for (const [key] of skaterTracker.season) {
      const [pidStr, season] = key.split('#')
      if (season !== currentSeason) continue
      const snap = snapshotSkaterRates(skaterTracker, Number(pidStr), season)
      if (snap.season && snap.position) ratesByPos[snap.position]?.push(snap.season)
    }
    skaterBaseline = buildSkaterBaselineFromRates(ratesByPos)
    const goalieRows = []
    for (const [key] of goalieTracker.season) {
      const [pidStr, season] = key.split('#')
      if (season !== currentSeason) continue
      const snap = snapshotGoalieRates(goalieTracker, Number(pidStr), season)
      if (snap.season) goalieRows.push(snap.season)
    }
    goalieBaseline = buildGoalieBaselineFromRates(goalieRows)
  }

  const rows = [] // ein Eintrag pro Spiel

  for (const g of games) {
    if (currentSeason !== g.season) { currentSeason = g.season; cachedDate = null }
    if (g.date !== cachedDate) { rebuildBaselines(); cachedDate = g.date }

    // --- ELO-Vorhersage (VOR Update) ---
    const rh = eloRatings.get(g.homeTeamId) ?? 1500
    const ra = eloRatings.get(g.awayTeamId) ?? 1500
    const pElo = 1 / (1 + Math.pow(10, (ra - (rh + ELO_PARAMS.homeAdv)) / 400))

    // --- Skater-Snapshots (VOR Update) ---
    const homeZs = { F: [], D: [] }, awayZs = { F: [], D: [] }
    for (const row of g.skaters) {
      const snap = snapshotSkaterRates(skaterTracker, row.playerId, g.season)
      snap.position = snap.position || row.position
      const rating = computeHistSkaterRating(snap, skaterBaseline, { minN: options.minN })
      if (rating && rating.overallZ != null && (row.position === 'F' || row.position === 'D')) {
        (row.isHome ? homeZs : awayZs)[row.position].push(rating.overallZ)
      }
      updateSkaterTracker(skaterTracker, row, g.season)
    }

    // --- Goalie-Snapshots (VOR Update): tatsächlich eingesetzter Torhüter
    //     (meiste TOI - dokumentierte, milde Lookahead-Näherung, siehe
    //     Bericht) UND leak-freier "wahrscheinlicher Starter"-Proxy. ---
    let homeActualGoalieZ = null, awayActualGoalieZ = null
    let homePregameStarterId = { home: likelyStarter(goalieStartTracker, g.homeTeamId) }.home
    let awayPregameStarterId = likelyStarter(goalieStartTracker, g.awayTeamId)
    const goalieSnapCache = new Map() // playerId -> rating (innerhalb dieses Spiels wiederverwendbar)

    function goalieRatingFor(playerId) {
      if (playerId == null) return null
      if (goalieSnapCache.has(playerId)) return goalieSnapCache.get(playerId)
      const snap = snapshotGoalieRates(goalieTracker, playerId, g.season)
      const rating = computeHistGoalieRating(snap, goalieBaseline, { minN: options.goalieMinN })
      goalieSnapCache.set(playerId, rating)
      return rating
    }

    for (const row of g.goalies) {
      const rating = goalieRatingFor(row.playerId)
      if (rating && rating.overallZ != null) {
        if (row.isHome) { if (homeActualGoalieZ == null || row.toiSec > homeActualGoalieZ.toi) homeActualGoalieZ = { z: rating.overallZ, toi: row.toiSec } }
        else if (awayActualGoalieZ == null || row.toiSec > awayActualGoalieZ.toi) awayActualGoalieZ = { z: rating.overallZ, toi: row.toiSec }
      }
      updateGoalieTracker(goalieTracker, row, g.season)
      // Start-Tracker (für zukünftige Spiele) NACH Verarbeitung aktualisieren -
      // nur der Torhüter mit der meisten TOI gilt als "der Starter dieses Spiels".
    }
    // Start-Tracker-Update: für jedes Team der Torhüter mit max. TOI in DIESEM
    // Spiel (das ist im Nachhinein bekannt und beeinflusst nur ZUKÜNFTIGE
    // likelyStarter()-Aufrufe, niemals die Prognose für dieses Spiel selbst).
    if (homeActualGoalieZ) {
      const homeStarterRow = g.goalies.find((r) => r.isHome && r.toiSec === homeActualGoalieZ.toi)
      if (homeStarterRow) updateGoalieStartTracker(goalieStartTracker, g.homeTeamId, homeStarterRow.playerId)
    }
    if (awayActualGoalieZ) {
      const awayStarterRow = g.goalies.find((r) => !r.isHome && r.toiSec === awayActualGoalieZ.toi)
      if (awayStarterRow) updateGoalieStartTracker(goalieStartTracker, g.awayTeamId, awayStarterRow.playerId)
    }

    const homePregameGoalieRating = goalieRatingFor(homePregameStarterId)
    const awayPregameGoalieRating = goalieRatingFor(awayPregameStarterId)

    // --- Lineup-Strength-Varianten (Punkt 7) ---
    function combine(pairs) {
      let wSum = 0, vSum = 0
      for (const [v, w] of pairs) { if (v == null) continue; vSum += v * w; wSum += w }
      return wSum > 0 ? vSum / wSum : null
    }
    const fMean = (arr) => (arr.length ? mean(arr) : null)

    function lineupVariants(zs, goalieActual, goaliePregame) {
      const fZ = fMean(zs.F), dZ = fMean(zs.D)
      return {
        actualGoalie: combine([[fZ, 0.35], [dZ, 0.25], [goalieActual?.z ?? null, 0.40]]),
        pregameGoalie: combine([[fZ, 0.35], [dZ, 0.25], [goaliePregame?.overallZ ?? null, 0.40]]),
        noGoalie: combine([[fZ, 0.6], [dZ, 0.4]]),
        heavierGoalieActual: combine([[fZ, 0.25], [dZ, 0.20], [goalieActual?.z ?? null, 0.55]]),
      }
    }
    const homeLineup = lineupVariants(homeZs, homeActualGoalieZ, homePregameGoalieRating)
    const awayLineup = lineupVariants(awayZs, awayActualGoalieZ, awayPregameGoalieRating)

    const diffs = {}
    for (const key of ['actualGoalie', 'pregameGoalie', 'noGoalie', 'heavierGoalieActual']) {
      diffs[key] = homeLineup[key] != null && awayLineup[key] != null ? homeLineup[key] - awayLineup[key] : null
    }

    rows.push({
      season: g.season, corona: g.corona, date: g.date,
      homeWon: g.homeGoals > g.awayGoals, pElo, diffs,
    })

    // --- ELO-Update (NACH der Prognose) ---
    const homeWon = g.homeGoals > g.awayGoals
    const diff = Math.abs(g.homeGoals - g.awayGoals)
    const goalMult = goalDiffMult(diff, ELO_PARAMS.goalDiffFactor)
    const gpH = eloGamesPlayed.get(g.homeTeamId) ?? 0, gpA = eloGamesPlayed.get(g.awayTeamId) ?? 0
    const kH = getK(tiers, gpH), kA = getK(tiers, gpA)
    eloRatings.set(g.homeTeamId, rh + kH * goalMult * ((homeWon ? 1 : 0) - pElo))
    eloRatings.set(g.awayTeamId, ra + kA * goalMult * ((homeWon ? 0 : 1) - (1 - pElo)))
    eloGamesPlayed.set(g.homeTeamId, gpH + 1)
    eloGamesPlayed.set(g.awayTeamId, gpA + 1)
  }

  return rows
}

// ============================================================================
// BLEND + EVALUATION
// ============================================================================

export function blendPredictions(rows, eloWeight, diffKey = 'actualGoalie') {
  const out = []
  for (const r of rows) {
    const pRating = ratingWinProbability(r.diffs[diffKey])
    const p = pRating == null ? r.pElo : eloWeight * r.pElo + (1 - eloWeight) * pRating
    out.push({ season: r.season, corona: r.corona, p, y: r.homeWon ? 1 : 0 })
  }
  return out
}

export function calibrationTable(preds, bins = [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 1.0]]) {
  return bins.map(([lo, hi]) => {
    const inBin = preds.filter((r) => r.p >= lo && r.p < hi)
    if (inBin.length === 0) return { range: `[${lo},${hi})`, n: 0, predictedMean: null, actualRate: null }
    return {
      range: `[${lo},${hi})`, n: inBin.length,
      predictedMean: mean(inBin.map((r) => r.p)),
      actualRate: mean(inBin.map((r) => r.y)),
    }
  })
}

// Einfacher paariger Bootstrap (Auftrag Punkt 6 - "statistisch/inhaltlich
// relevant?"): resampled die Validation-Spiele MIT Zurücklegen `iterations`
// mal, misst jedes Mal die LogLoss-Differenz (baseline - variante), gibt
// Anteil der Resamples zurück, in denen die Variante besser war (>0), plus
// ein grobes 90%-Intervall der Differenz.
export function bootstrapLoglossDiff(baselinePreds, variantPreds, iterations = 500, seed = 42) {
  const n = baselinePreds.length
  if (n === 0 || variantPreds.length !== n) return null
  let rngState = seed
  function rand() { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff }
  const EPS = 1e-10
  function loglossOf(preds, idx) {
    let s = 0
    for (const i of idx) {
      const p = Math.min(1 - EPS, Math.max(EPS, preds[i].p))
      const y = preds[i].y
      s += -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
    }
    return s / idx.length
  }
  const diffs = []
  for (let it = 0; it < iterations; it++) {
    const idx = Array.from({ length: n }, () => Math.floor(rand() * n))
    diffs.push(loglossOf(baselinePreds, idx) - loglossOf(variantPreds, idx))
  }
  diffs.sort((a, b) => a - b)
  const positiveFrac = diffs.filter((d) => d > 0).length / iterations
  return {
    n: iterations,
    meanDiff: mean(diffs),
    p05: diffs[Math.floor(iterations * 0.05)],
    p95: diffs[Math.floor(iterations * 0.95)],
    fractionVariantBetter: positiveFrac,
  }
}

// ============================================================================
// REPORT
// ============================================================================

function fmtPct(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%' }
function fmt4(x) { return x == null ? 'n/a' : x.toFixed(4) }

function seasonMetrics(preds, season) {
  const inSeason = preds.filter((r) => r.season === season && !r.corona)
  return evalBinaryPredictions(inSeason)
}

function main() {
  console.log('PLAYER RATING INTEGRATION BACKTEST')
  console.log('='.repeat(90))
  const games = loadHistoricalGames()
  console.log(`Games loaded: ${games.length} (${games[0].season}-${games[games.length - 1].season})`)
  console.log(`Validation seasons: ${VALIDATION_SEASONS.join(', ')}`)

  console.log('\nRunning walk-forward reconstruction...')
  const t0 = Date.now()
  const rows = runIntegrationWalkForward(games)
  console.log(`Done in ${Date.now() - t0}ms`)

  const validationRows = rows.filter((r) => !r.corona && VALIDATION_SEASONS.includes(r.season))
  console.log(`Validation games: ${validationRows.length}`)

  // ------------------------------------------------------------------
  // A) Haupt-Gewichtstabelle (diffKey='actualGoalie' = Standard-Lineup-
  //    Strength wie im ersten Backtest, inkl. Torhüter)
  // ------------------------------------------------------------------
  console.log('\n' + '-'.repeat(90))
  console.log('A) GEWICHTS-TABELLE (Lineup Strength inkl. tatsächlich eingesetztem Torhüter)')
  console.log('-'.repeat(90))
  const header = 'Weight'.padEnd(26) + 'Accuracy'.padEnd(10) + 'Brier'.padEnd(9) + 'LogLoss'.padEnd(9) + '22/23'.padEnd(9) + '23/24'.padEnd(9) + '24/25'.padEnd(9) + '25/26'.padEnd(9) + 'ΔLogLoss'
  console.log(header)

  const baselinePreds = blendPredictions(validationRows, 1.00, 'actualGoalie')
  const baselineEv = evalBinaryPredictions(baselinePreds)

  const weightResults = []
  for (const { label, eloWeight } of WEIGHT_GRID) {
    const preds = blendPredictions(validationRows, eloWeight, 'actualGoalie')
    const ev = evalBinaryPredictions(preds)
    const perSeason = VALIDATION_SEASONS.map((s) => evalBinaryPredictions(preds.filter((r) => r.season === s)))
    const deltaLogloss = ev.logloss - baselineEv.logloss
    weightResults.push({ label, eloWeight, ev, perSeason, deltaLogloss, preds })
    console.log(
      label.padEnd(26) + fmtPct(ev.accuracy).padEnd(10) + fmt4(ev.brier).padEnd(9) + fmt4(ev.logloss).padEnd(9)
      + perSeason.map((m) => fmt4(m?.logloss)).map((s) => s.padEnd(9)).join('')
      + (deltaLogloss >= 0 ? '+' : '') + deltaLogloss.toFixed(4),
    )
  }

  // ------------------------------------------------------------------
  // B/C) Gesamt + pro Saison bereits oben; jetzt Calibration für Baseline
  //      und die beste (niedrigste LogLoss) Nicht-Baseline-Gewichtung.
  // ------------------------------------------------------------------
  const bestNonBaseline = [...weightResults].filter((w) => w.eloWeight < 1).sort((a, b) => a.ev.logloss - b.ev.logloss)[0]
  console.log('\n' + '-'.repeat(90))
  console.log(`CALIBRATION - Baseline (A: ELO 100%) vs. beste getestete Rating-Gewichtung (${bestNonBaseline.label})`)
  console.log('-'.repeat(90))
  function printCalib(name, preds) {
    console.log(`  ${name}:`)
    for (const bin of calibrationTable(preds)) {
      console.log(`    ${bin.range.padEnd(12)} n=${String(bin.n).padEnd(6)} predicted=${bin.predictedMean != null ? (bin.predictedMean * 100).toFixed(1) + '%' : 'n/a'}  actual=${bin.actualRate != null ? (bin.actualRate * 100).toFixed(1) + '%' : 'n/a'}`)
    }
  }
  printCalib('Baseline (ELO 100%)', baselinePreds)
  printCalib(bestNonBaseline.label, bestNonBaseline.preds)

  // ------------------------------------------------------------------
  // E) Robustheit - Bootstrap gegen die Baseline für JEDE Gewichtung
  // ------------------------------------------------------------------
  console.log('\n' + '-'.repeat(90))
  console.log('E) ROBUSTHEIT - Paariger Bootstrap (500 Resamples) der LogLoss-Differenz ggü. Baseline (ELO 100%)')
  console.log('-'.repeat(90))
  for (const w of weightResults) {
    if (w.eloWeight === 1) continue
    const bs = bootstrapLoglossDiff(baselinePreds, w.preds)
    console.log(`  ${w.label.padEnd(26)} meanΔLogLoss=${bs.meanDiff.toFixed(4)}  90%-CI=[${bs.p05.toFixed(4)}, ${bs.p95.toFixed(4)}]  Anteil Resamples mit Vorteil=${(bs.fractionVariantBetter * 100).toFixed(0)}%`)
  }

  // ------------------------------------------------------------------
  // Punkt 7: Lineup-Strength-Varianten - vergleiche bei EINER festen,
  // repräsentativen Gewichtung (C: ELO 90%/Rating 10%) die 4 Definitionen.
  // ------------------------------------------------------------------
  console.log('\n' + '-'.repeat(90))
  console.log('LINEUP-STRENGTH-VARIANTEN (bei Gewichtung C: ELO 90% / Rating 10%)')
  console.log('-'.repeat(90))
  const variantLabels = {
    actualGoalie: 'Lineup inkl. Torhüter (tatsächlich eingesetzt - milde Lookahead-Näherung)',
    pregameGoalie: 'Lineup inkl. Torhüter (leak-freier "wahrscheinlicher Starter"-Proxy)',
    noGoalie: 'Lineup OHNE Torhüter (nur F+D)',
    heavierGoalieActual: 'Lineup, Torhüter-Gewicht erhöht (0.55 statt 0.40, tatsächlicher Torhüter)',
  }
  for (const [key, label] of Object.entries(variantLabels)) {
    const preds = blendPredictions(validationRows, 0.90, key)
    const ev = evalBinaryPredictions(preds)
    console.log(`  ${label}`)
    console.log(`    ${fmtPct(ev.accuracy)} acc, brier=${fmt4(ev.brier)}, logloss=${fmt4(ev.logloss)}, ΔLogLoss ggü. Baseline=${(ev.logloss - baselineEv.logloss).toFixed(4)}`)
  }

  // ------------------------------------------------------------------
  // Output JSON
  // ------------------------------------------------------------------
  const outPath = path.join(__dirname, 'backtest-player-rating-integration-result.json')
  fs.writeFileSync(outPath, JSON.stringify({
    validationSeasons: VALIDATION_SEASONS,
    validationGames: validationRows.length,
    baseline: baselineEv,
    weights: weightResults.map((w) => ({ label: w.label, eloWeight: w.eloWeight, overall: w.ev, perSeason: Object.fromEntries(VALIDATION_SEASONS.map((s, i) => [s, w.perSeason[i]])), deltaLogloss: w.deltaLogloss })),
  }, null, 2))
  console.log(`\nDetails gespeichert: ${outPath}`)
}

if (IS_MAIN) main()
