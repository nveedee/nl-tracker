// ---------------------------------------------------------------------------
// PLAYER-RATING-BACKTEST (Auftrag: wissenschaftliche Validierung der neuen
// Rating-Engine, KEINE Integration ins Prediction-Modell). Read-only: liest
// server/data/historical/*.json und server/data/db.json, verändert nichts,
// importiert/verändert weder src/elo.js noch src/playerRating.js.
//
// Aufruf: node server/scripts/backtest-player-rating.js
// ---------------------------------------------------------------------------

import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import {
  loadHistoricalGames, CORONA_SEASONS,
  createSkaterTracker, snapshotSkaterRates, updateSkaterTracker,
  createGoalieTracker, snapshotGoalieRates, updateGoalieTracker,
  buildSkaterBaselineFromRates, buildGoalieBaselineFromRates,
  computeHistSkaterRating, computeHistGoalieRating,
  DEFAULT_SKATER_KEYS, HIST_TOP_WEIGHTS,
  fitLogistic, predictLogistic, evalBinaryPredictions, pearson, mae, rmse, mean,
} from '../playerRatingBacktestCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// TRAIN/VALIDATION-Split (Auftrag Punkt 7) - AUSSCHLIESSLICH chronologisch,
// Corona-Saisons (2019/20, 2020/21) aus BEIDEN Mengen ausgeschlossen (gleiche
// Konvention wie backtest-elo.js - verkürzte/anomale Saisons, siehe dort).
const TRAIN_SEASONS = new Set(['2017/18', '2018/19', '2021/22'])
const VALIDATION_SEASONS = ['2022/23', '2023/24', '2024/25', '2025/26']

function fmtBin(m) { return !m ? 'n/a' : `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}` }
function fmtR(r) { return !r ? 'n/a (zu wenig Daten)' : `r=${r.r.toFixed(3)} (n=${r.n})` }

// ============================================================================
// PASS 1: Chronologischer Walk-Forward über ALLE Spiele - baut GLEICHZEITIG
// (a) Spieler-Rating-Snapshots + "nächstes Spiel"-Zielwerte (für den
//     Predictive-Value-/Ablation-/Confidence-/Stabilitäts-Teil, Punkt 3/10/
//     11/12),
// (b) Team-ELO (leak-frei, identische Formel/Parameter wie
//     server/scripts/backtest-elo.js BASELINE_PARAMS) und Lineup-Strength
//     pro Spiel (Punkt 4/5).
// EINE einzige Stelle mit Zustands-Update - Reihenfolge PRO SPIEL ist immer:
// 1) Snapshot/Prognose ziehen, 2) danach Zustand aktualisieren. Nie umgekehrt.
// ============================================================================

const ELO_PARAMS = { kBase: 24, homeAdv: 50, goalDiffFactor: 0.5, regressionFraction: 0 }
function kTiers(kBase) { const s = kBase / 24; return [{ maxGames: 5, k: 32 * s }, { maxGames: 15, k: 28 * s }, { maxGames: 30, k: 24 * s }, { maxGames: 50, k: 20 * s }, { maxGames: Infinity, k: 16 * s }] }
function getK(tiers, gp) { for (const t of tiers) if (gp <= t.maxGames) return t.k; return tiers[tiers.length - 1].k }
function goalDiffMult(diff, factor) { if (diff === 0 || factor === 0) return 1; return 1 + factor * (Math.log(diff + 1) - 1) }
function logit(p) { const eps = 1e-9; const c = Math.min(1 - eps, Math.max(eps, p)); return Math.log(c / (1 - c)) }

// `skaterKeyOverrides`/`topWeightOverrides`/`blendOverrides`: für Ablation-
// Test (Punkt 10) und Gewichts-Varianten (Punkt 9) - ändert NUR die
// Rating-Formel, NICHT die zugrundeliegende Datenrekonstruktion.
function runWalkForward(games, options = {}) {
  const skaterTracker = createSkaterTracker()
  const goalieTracker = createGoalieTracker()
  const eloRatings = new Map(), eloGamesPlayed = new Map()
  const tiers = kTiers(ELO_PARAMS.kBase)
  let currentSeason = null

  // Positions-Baseline wird EINMAL PRO EINDEUTIGEM DATUM neu gebaut (nur aus
  // Zuständen VOR diesem Datum) - Performance-Kompromiss ohne Leck (siehe
  // Kern-Modul-Kommentar).
  let cachedDate = null, skaterBaseline = null, goalieBaseline = null

  // WICHTIG: Tracker-Keys für career/log/lastPosition sind mit dem
  // NUMERISCHEN playerId gesetzt (siehe playerRatingBacktestCore.js -
  // row.playerId kommt roh aus dem SIHF-Roster-Join, typeof number).
  // Map-Lookups sind typsensitiv (155564 !== "155564") - der aus dem
  // zusammengesetzten Saison-Key gesplittete `pid` ist aber ein STRING.
  // Muss vor jedem direkten `.get(pid)`-Aufruf zurückkonvertiert werden,
  // sonst liefert snapshotSkaterRates() u.a. `position: null` und der
  // Spieler fällt lautlos aus der Baseline (kein Crash, aber n=0 überall -
  // Regressionsgefahr, daher ausführlich dokumentiert).
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

  // Rating-Verlauf pro Spieler (für Stabilitäts-Analyse, Punkt 11) - jeder
  // Eintrag ist ein PRE-GAME-Snapshot (vor dem jeweiligen Spiel bekannt).
  const ratingHistory = new Map() // playerId -> [{date, season, overall, confidence, currentSeasonGp}]
  // Letzter PRE-GAME-Snapshot je Spieler (für die "nächstes Spiel"-Paarung).
  const pendingSnapshot = new Map() // playerId -> { rating, atDate }

  const skaterPairs = { target: [], gameRows: [] } // gameRows: {playerId,date,season, ratings:{...}, actual:{...}}
  const gameOutcomeRows = []

  for (const g of games) {
    if (currentSeason !== g.season) {
      currentSeason = g.season
      cachedDate = null // Baseline muss beim Saisonwechsel neu gebaut werden
    }
    if (g.date !== cachedDate) { rebuildBaselines(); cachedDate = g.date }

    // --- ELO-Vorhersage (VOR Update) ---
    const rh = eloRatings.get(g.homeTeamId) ?? 1500
    const ra = eloRatings.get(g.awayTeamId) ?? 1500
    const pElo = 1 / (1 + Math.pow(10, (ra - (rh + ELO_PARAMS.homeAdv)) / 400))

    // --- Spieler-Snapshots (VOR Update) + Lineup-Strength ---
    const homeZs = { F: [], D: [] }, awayZs = { F: [], D: [] }
    let homeGoalieZ = null, awayGoalieZ = null

    for (const row of g.skaters) {
      const snap = snapshotSkaterRates(skaterTracker, row.playerId, g.season)
      snap.position = snap.position || row.position // vor dem 1. eigenen Eintrag: aktuelle Spiel-Position verwenden
      const rating = computeHistSkaterRating(snap, skaterBaseline, {
        keys: options.skaterKeys, topWeights: options.topWeights, blendTable: options.blendTable, minN: options.minN,
      })

      if (rating && rating.overallZ != null) {
        const bucket = row.isHome ? homeZs : awayZs
        if (row.position === 'F' || row.position === 'D') bucket[row.position].push(rating.overallZ)
      }

      // "nächstes Spiel"-Zielpaar: gibt es bereits einen offenen Snapshot für
      // diesen Spieler (aus einem FRÜHEREN Spiel)? Dann ist DIESES Spiel sein
      // "nächstes Spiel" relativ dazu -> Paar sichern.
      const pending = pendingSnapshot.get(row.playerId)
      if (pending) {
        skaterPairs.gameRows.push({
          playerId: row.playerId, date: g.date, season: g.season,
          ratings: pending.rating, // Rating VOR diesem Spiel
          actual: { points: row.points, goals: row.goals, assists: row.assists, sog: row.sog, toiSec: row.toiSec },
        })
      }
      if (rating) {
        pendingSnapshot.set(row.playerId, { rating })
        if (!ratingHistory.has(row.playerId)) ratingHistory.set(row.playerId, [])
        ratingHistory.get(row.playerId).push({ date: g.date, season: g.season, overall: rating.overall, confidence: rating.confidence, gp: rating.sampleSize.currentSeasonGp })
      }

      updateSkaterTracker(skaterTracker, row, g.season)
    }

    for (const row of g.goalies) {
      const snap = snapshotGoalieRates(goalieTracker, row.playerId, g.season)
      const rating = computeHistGoalieRating(snap, goalieBaseline, { minN: options.goalieMinN })
      if (rating && rating.overallZ != null) {
        if (row.isHome) { if (homeGoalieZ == null || row.toiSec > (homeGoalieZ.toi ?? 0)) homeGoalieZ = { z: rating.overallZ, toi: row.toiSec } }
        else if (awayGoalieZ == null || row.toiSec > (awayGoalieZ.toi ?? 0)) awayGoalieZ = { z: rating.overallZ, toi: row.toiSec }
      }
      updateGoalieTracker(goalieTracker, row, g.season)
    }

    // --- Lineup-Strength (Punkt 4/5): gewichteter Mittelwert der verfügbaren
    //     Gruppen (F 35% / D 25% / Goalie 40%, HEURISTISCH dokumentiert wie
    //     alle übrigen neuen Gewichte - siehe Bericht). Fehlt eine Gruppe
    //     komplett (z.B. kein bewerteter Torhüter-Snapshot), wird sie
        //     übersprungen und der Rest renormalisiert.
    function lineupZ(zs, goalieZ) {
      const pairs = [[zs.F.length ? mean(zs.F) : null, 0.35], [zs.D.length ? mean(zs.D) : null, 0.25], [goalieZ?.z ?? null, 0.40]]
      let wSum = 0, vSum = 0
      for (const [v, w] of pairs) { if (v == null) continue; vSum += v * w; wSum += w }
      return wSum > 0 ? vSum / wSum : null
    }
    const homeLineupZ = lineupZ(homeZs, homeGoalieZ)
    const awayLineupZ = lineupZ(awayZs, awayGoalieZ)
    const lineupDiff = homeLineupZ != null && awayLineupZ != null ? homeLineupZ - awayLineupZ : null

    gameOutcomeRows.push({
      season: g.season, corona: g.corona, date: g.date,
      homeWon: g.homeGoals > g.awayGoals, pElo, eloLogit: logit(pElo), lineupDiff,
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

  return { gameOutcomeRows, skaterPairs, ratingHistory }
}

// ============================================================================
// MODEL A/B/C (Punkt 5/6/7) - Logistische Regression, NUR auf TRAIN-Saisons
// gefittet (wenige Parameter, siehe fitLogistic-Kommentar im Kern-Modul).
// ============================================================================

function splitRows(rows) {
  const train = rows.filter((r) => !r.corona && TRAIN_SEASONS.has(r.season))
  const validation = rows.filter((r) => !r.corona && VALIDATION_SEASONS.includes(r.season))
  return { train, validation }
}

function evalModel(rows, featureFn) {
  const withFeatures = rows.filter((r) => featureFn(r).every((v) => v != null))
  return evalBinaryPredictions(withFeatures.map((r) => ({ p: 0, y: r.homeWon ? 1 : 0, __r: r })).map((x) => x)) // placeholder, replaced below
}

function fitAndEval(trainRows, validationRows, featureFn) {
  const trainX = [], trainY = []
  for (const r of trainRows) {
    const f = featureFn(r)
    if (f.some((v) => v == null)) continue
    trainX.push(f); trainY.push(r.homeWon ? 1 : 0)
  }
  const model = fitLogistic(trainX, trainY)
  const rows = []
  for (const r of validationRows) {
    const f = featureFn(r)
    if (f.some((v) => v == null)) continue
    rows.push({ p: predictLogistic(model, f), y: r.homeWon ? 1 : 0 })
  }
  return { model, metrics: evalBinaryPredictions(rows), n: rows.length }
}

// ============================================================================
// PLAYER-RATING PREDICTIVE-VALUE-STUDIE (Punkt 3) - Pearson-Korrelation
// zwischen dem PRE-GAME-Rating (career-only / current-only / current+form /
// vollständig) und der TATSÄCHLICHEN Leistung im NÄCHSTEN Spiel.
// ============================================================================

function correlationStudy(gameRows, seasons) {
  const filtered = seasons ? gameRows.filter((r) => seasons.includes(r.season)) : gameRows
  const variants = {
    'A) Career only': (r) => r.ratings.careerOnly,
    'B) Current season only': (r) => r.ratings.currentOnly,
    'C) Current + Form (kein Career-Anteil)': (r) => {
      // Rekonstruiert aus offense/defense/usage (=currentOnly) + form, ohne
      // Karriere-Gewicht - näherungsweise über den Mittelwert der beiden
      // bereits vorhandenen Werte (dokumentierte Vereinfachung für die
      // Backtest-Auswertung, KEINE neue Produktionslogik).
      const cur = r.ratings.currentOnly, form = r.ratings.form
      if (cur == null && form == null) return null
      if (form == null) return cur
      if (cur == null) return form
      return (cur + form) / 2
    },
    'D) Full rating (overall)': (r) => r.ratings.overall,
  }
  const targets = {
    'Punkte nächstes Spiel': (r) => r.actual.points,
    'Tore nächstes Spiel': (r) => r.actual.goals,
    'Assists nächstes Spiel': (r) => r.actual.assists,
    'SOG nächstes Spiel': (r) => r.actual.sog,
    'TOI nächstes Spiel (Sek.)': (r) => r.actual.toiSec,
  }
  const out = {}
  for (const [tName, tFn] of Object.entries(targets)) {
    out[tName] = {}
    for (const [vName, vFn] of Object.entries(variants)) {
      out[tName][vName] = pearson(filtered.map(vFn), filtered.map(tFn))
    }
  }
  return out
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  console.log('PLAYER RATING BACKTEST')
  console.log('='.repeat(78))
  const games = loadHistoricalGames()
  const seasons = [...new Set(games.map((g) => g.season))]
  console.log(`Period: ${seasons[0]}-${seasons[seasons.length - 1]}`)
  console.log(`Games: ${games.length}`)
  const totalSkaterRows = games.reduce((s, g) => s + g.skaters.length, 0)
  const totalGoalieRows = games.reduce((s, g) => s + g.goalies.length, 0)
  console.log(`Player samples (skater game-rows): ${totalSkaterRows}, (goalie game-rows): ${totalGoalieRows}`)
  console.log(`Train seasons: ${[...TRAIN_SEASONS].join(', ')} | Validation seasons: ${VALIDATION_SEASONS.join(', ')}`)
  console.log(`(Corona-Saisons 2019/20, 2020/21 aus Train/Validation ausgeschlossen, siehe backtest-elo.js-Konvention)`)

  console.log('\nRunning walk-forward reconstruction (this can take a bit)...')
  const t0 = Date.now()
  const { gameOutcomeRows, skaterPairs } = runWalkForward(games)
  console.log(`Done in ${Date.now() - t0}ms`)

  const { train, validation } = splitRows(gameOutcomeRows)
  console.log(`\nOutcome rows: train=${train.length}, validation=${validation.length}`)

  // ---------------------------------------------------------------------
  // MODEL A/B/C
  // ---------------------------------------------------------------------
  console.log('\n' + '-'.repeat(78))
  console.log('MODEL A - Existing ELO/Team model (raw ELO win probability, production-equivalent formula, no fitting)')
  const modelARows = validation.map((r) => ({ p: r.pElo, y: r.homeWon ? 1 : 0 }))
  const modelAEv = evalBinaryPredictions(modelARows)
  console.log(fmtBin(modelAEv))

  console.log('\n' + '-'.repeat(78))
  console.log('MODEL B - Player Rating / Lineup Strength ALONE (logistic on lineupDiff, fit on TRAIN)')
  const { metrics: modelBEv, n: modelBN, model: modelBParams } = fitAndEval(train, validation, (r) => [r.lineupDiff])
  console.log(fmtBin(modelBEv), `(fitted: bias=${modelBParams.bias.toFixed(4)}, w=${modelBParams.weights[0].toFixed(4)})`)

  console.log('\n' + '-'.repeat(78))
  console.log('MODEL C - ELO + Player Rating / Lineup Strength (logistic on [eloLogit, lineupDiff], fit on TRAIN)')
  const { metrics: modelCEv, model: modelCParams } = fitAndEval(train, validation, (r) => [r.eloLogit, r.lineupDiff])
  console.log(fmtBin(modelCEv), `(fitted: bias=${modelCParams.bias.toFixed(4)}, wElo=${modelCParams.weights[0].toFixed(4)}, wLineup=${modelCParams.weights[1].toFixed(4)})`)

  console.log('\n' + '-'.repeat(78))
  console.log('Per-season validation breakdown (Model A vs B vs C):')
  for (const s of VALIDATION_SEASONS) {
    const seasonRows = validation.filter((r) => r.season === s)
    const a = evalBinaryPredictions(seasonRows.map((r) => ({ p: r.pElo, y: r.homeWon ? 1 : 0 })))
    const bRows = seasonRows.filter((r) => r.lineupDiff != null).map((r) => ({ p: predictLogistic(modelBParams, [r.lineupDiff]), y: r.homeWon ? 1 : 0 }))
    const cRows = seasonRows.filter((r) => r.lineupDiff != null).map((r) => ({ p: predictLogistic(modelCParams, [r.eloLogit, r.lineupDiff]), y: r.homeWon ? 1 : 0 }))
    console.log(`  ${s}  A: ${fmtBin(a)}`)
    console.log(`         B: ${fmtBin(evalBinaryPredictions(bRows))}`)
    console.log(`         C: ${fmtBin(evalBinaryPredictions(cRows))}`)
  }

  // ---------------------------------------------------------------------
  // PLAYER RATING PREDICTIVE VALUE (Punkt 3)
  // ---------------------------------------------------------------------
  console.log('\n' + '='.repeat(78))
  console.log('PLAYER RATING vs. NÄCHSTES-SPIEL-LEISTUNG (Pearson r, alle Saisons kombiniert)')
  console.log(`Skater-Paare (Rating vor Spiel N -> tatsächliche Leistung in Spiel N): ${skaterPairs.gameRows.length}`)
  const corrAll = correlationStudy(skaterPairs.gameRows)
  for (const [target, variants] of Object.entries(corrAll)) {
    console.log(`\n  ${target}:`)
    for (const [name, r] of Object.entries(variants)) console.log(`    ${name.padEnd(42)} ${fmtR(r)}`)
  }

  console.log('\nDasselbe NUR für Validation-Saisons (2022/23-2025/26):')
  const corrVal = correlationStudy(skaterPairs.gameRows, VALIDATION_SEASONS)
  for (const [target, variants] of Object.entries(corrVal)) {
    console.log(`\n  ${target}:`)
    for (const [name, r] of Object.entries(variants)) console.log(`    ${name.padEnd(42)} ${fmtR(r)}`)
  }

  // ---------------------------------------------------------------------
  // ABLATION TEST (Punkt 10)
  // ---------------------------------------------------------------------
  console.log('\n' + '='.repeat(78))
  console.log('ABLATION TEST (Full-Rating vs. Punkte im nächsten Spiel, Pearson r - Delta ggü. voller Formel)')
  const fullR = pearson(skaterPairs.gameRows.map((r) => r.ratings.overall), skaterPairs.gameRows.map((r) => r.actual.points))
  console.log(`  Volle Formel                    r=${fullR.r.toFixed(3)} (n=${fullR.n})`)

  const ablations = {
    'ohne SOG': { offense: DEFAULT_SKATER_KEYS.offense.filter(([k]) => k !== 'sogPerGame'), form: DEFAULT_SKATER_KEYS.form.filter(([k]) => k !== 'sogPerGame') },
    'ohne TOI (usage)': { usage: DEFAULT_SKATER_KEYS.usage.filter(([k]) => k !== 'toiPerGame'), form: DEFAULT_SKATER_KEYS.form.filter(([k]) => k !== 'toiPerGame') },
    'ohne PP/PK-TOI': { usage: DEFAULT_SKATER_KEYS.usage.filter(([k]) => !['ppToiPerGame', 'pkToiPerGame'].includes(k)), defense: DEFAULT_SKATER_KEYS.defense.filter(([k]) => k !== 'pkToiPerGame') },
    'ohne Faceoffs': { usage: DEFAULT_SKATER_KEYS.usage.filter(([k]) => k !== 'faceoffPercentage') },
    'ohne Blocks': { defense: DEFAULT_SKATER_KEYS.defense.filter(([k]) => k !== 'blockedShotsPerGame') },
    'ohne +/-': { defense: DEFAULT_SKATER_KEYS.defense.filter(([k]) => k !== 'plusMinusPerGame') },
    'ohne Form (Blend-Gewicht=0)': null, // Sonderfall unten (blendTable statt keys)
    'ohne Career (Blend-Gewicht=0)': null,
  }
  for (const [name, keyOverride] of Object.entries(ablations)) {
    let opts = {}
    if (name === 'ohne Form (Blend-Gewicht=0)') {
      opts.blendTable = [{ maxGp: 0, career: 1, current: 0, form: 0 }, { maxGp: 4, career: 1, current: 0, form: 0 }, { maxGp: 9, career: 0.56, current: 0.44, form: 0 }, { maxGp: Infinity, career: 0.33, current: 0.67, form: 0 }]
    } else if (name === 'ohne Career (Blend-Gewicht=0)') {
      opts.blendTable = [{ maxGp: 0, career: 0, current: 0, form: 0 }, { maxGp: 4, career: 0, current: 1, form: 0 }, { maxGp: 9, career: 0, current: 0.64, form: 0.36 }, { maxGp: Infinity, career: 0, current: 0.67, form: 0.33 }]
    } else {
      opts.skaterKeys = { ...DEFAULT_SKATER_KEYS, ...keyOverride }
    }
    const { skaterPairs: ablationPairs } = runWalkForward(games, opts)
    const r = pearson(ablationPairs.gameRows.map((x) => x.ratings.overall), ablationPairs.gameRows.map((x) => x.actual.points))
    const delta = r && fullR ? r.r - fullR.r : null
    console.log(`  ${name.padEnd(32)} r=${r ? r.r.toFixed(3) : 'n/a'} (n=${r?.n ?? 0})  Δ=${delta != null ? (delta >= 0 ? '+' : '') + delta.toFixed(3) : 'n/a'}`)
  }

  // ---------------------------------------------------------------------
  // GEWICHTS-VARIANTEN (Punkt 9) - TRAIN-Saisons wählen die Variante,
  // VALIDATION-Saisons zeigen das Ergebnis (kein Fitten auf denselben Daten).
  // ---------------------------------------------------------------------
  console.log('\n' + '='.repeat(78))
  console.log('GEWICHTS-VARIANTEN (Top-Level Offense/Defense/Usage) - Punkte-Korrelation, TRAIN wählt, VALIDATION zeigt')
  const weightVariants = {
    'aktuell (heuristisch)': HIST_TOP_WEIGHTS,
    'gleichgewichtet': { F: { offense: 0.34, defense: 0.33, usage: 0.33 }, D: { offense: 0.34, defense: 0.33, usage: 0.33 } },
    'defense-lastiger (konservativ)': { F: { offense: 0.30, defense: 0.30, usage: 0.40 }, D: { offense: 0.15, defense: 0.45, usage: 0.40 } },
  }
  const variantScores = []
  for (const [name, tw] of Object.entries(weightVariants)) {
    const { skaterPairs: vp } = runWalkForward(games, { topWeights: tw })
    const trainRows = vp.gameRows.filter((r) => TRAIN_SEASONS.has(r.season))
    const valRows = vp.gameRows.filter((r) => VALIDATION_SEASONS.includes(r.season))
    const rTrain = pearson(trainRows.map((r) => r.ratings.overall), trainRows.map((r) => r.actual.points))
    const rVal = pearson(valRows.map((r) => r.ratings.overall), valRows.map((r) => r.actual.points))
    variantScores.push({ name, rTrain, rVal })
    console.log(`  ${name.padEnd(32)} TRAIN r=${rTrain ? rTrain.r.toFixed(3) : 'n/a'}   VALIDATION r=${rVal ? rVal.r.toFixed(3) : 'n/a'}`)
  }
  const bestByTrain = [...variantScores].sort((a, b) => (b.rTrain?.r ?? -1) - (a.rTrain?.r ?? -1))[0]
  console.log(`  -> per TRAIN gewählte Variante: "${bestByTrain.name}" (VALIDATION-Ergebnis siehe oben - NICHT für die Auswahl verwendet)`)

  // ---------------------------------------------------------------------
  // STABILITÄT (Punkt 11)
  // ---------------------------------------------------------------------
  console.log('\n' + '='.repeat(78))
  console.log('RATING-STABILITÄT (Spiel-zu-Spiel-Delta des Overall-Ratings, Validation-Saisons, Spieler mit >=15 Spielen/Saison)')
  const { ratingHistory } = runWalkForward(games) // frischer, unveränderter (voller) Lauf für die Stabilitätsanalyse
  const deltas = []
  for (const [, history] of ratingHistory) {
    const bySeasonHist = new Map()
    for (const h of history) {
      if (!VALIDATION_SEASONS.includes(h.season)) continue
      if (!bySeasonHist.has(h.season)) bySeasonHist.set(h.season, [])
      bySeasonHist.get(h.season).push(h)
    }
    for (const [, seasonHist] of bySeasonHist) {
      if (seasonHist.length < 15) continue
      for (let i = 1; i < seasonHist.length; i++) {
        if (seasonHist[i].overall == null || seasonHist[i - 1].overall == null) continue
        deltas.push(Math.abs(seasonHist[i].overall - seasonHist[i - 1].overall))
      }
    }
  }
  if (deltas.length > 0) {
    const sorted = [...deltas].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p90 = sorted[Math.floor(sorted.length * 0.9)]
    const p99 = sorted[Math.floor(sorted.length * 0.99)]
    console.log(`  n=${deltas.length} Spiel-zu-Spiel-Übergänge`)
    console.log(`  Mittleres |Δ|: ${mean(deltas).toFixed(2)} Punkte (0-100-Skala)`)
    console.log(`  Median |Δ|:    ${p50.toFixed(2)}`)
    console.log(`  P90 |Δ|:       ${p90.toFixed(2)}`)
    console.log(`  P99 |Δ|:       ${p99.toFixed(2)}`)
    console.log(`  Max |Δ|:       ${sorted[sorted.length - 1].toFixed(2)}`)
  } else {
    console.log('  Keine Spieler mit >=15 Spielen in den Validation-Saisons gefunden.')
  }

  // ---------------------------------------------------------------------
  // CONFIDENCE-VALIDIERUNG (Punkt 12)
  // ---------------------------------------------------------------------
  console.log('\n' + '='.repeat(78))
  console.log('CONFIDENCE-BUCKETS vs. tatsächliche Vorhersagekraft (Rating vs. Punkte nächstes Spiel, Validation-Saisons)')
  const valPairs = skaterPairs.gameRows.filter((r) => VALIDATION_SEASONS.includes(r.season) && r.ratings.confidence != null)
  const buckets = [[0, 30], [30, 60], [60, 80], [80, 100]]
  for (const [lo, hi] of buckets) {
    const inBucket = valPairs.filter((r) => r.ratings.confidence >= lo && r.ratings.confidence < hi)
    const r = pearson(inBucket.map((x) => x.ratings.overall), inBucket.map((x) => x.actual.points))
    const maeVal = mae(inBucket.map((x) => x.ratings.overall != null ? x.ratings.overall / 20 : null), inBucket.map((x) => x.actual.points)) // grobe Skala nur zur MAE-Illustration
    console.log(`  Confidence [${lo},${hi}): n=${inBucket.length}  ${fmtR(r)}${inBucket.length < 30 ? '   [WARNUNG: sehr kleine Stichprobe, Aussage unsicher]' : ''}`)
  }

  // ---------------------------------------------------------------------
  // GOALS/TORE-BACKTEST (MAE/RMSE, Punkt 6)
  // ---------------------------------------------------------------------
  console.log('\n' + '='.repeat(78))
  console.log('TORE-PROGNOSEFEHLER (Full Rating "overall" [0-100] als roher Score, NICHT kalibriert auf Tor-Skala - nur zur Einordnung, siehe Bericht)')
  const goalsMae = mae(skaterPairs.gameRows.map((r) => (r.ratings.overall ?? 50) / 100), skaterPairs.gameRows.map((r) => Math.min(1, r.actual.goals)))
  console.log(`  MAE(Rating/100 vs. min(1,Tore)) = ${goalsMae != null ? goalsMae.toFixed(3) : 'n/a'} (Illustrativ - kein kalibriertes Torprognosemodell, siehe Interpretation unten)`)

  // ---------------------------------------------------------------------
  // OUTPUT: JSON-Detailergebnis
  // ---------------------------------------------------------------------
  const outPath = path.join(__dirname, 'backtest-player-rating-result.json')
  fs.writeFileSync(outPath, JSON.stringify({
    period: { from: seasons[0], to: seasons[seasons.length - 1] },
    games: games.length,
    skaterRows: totalSkaterRows,
    goalieRows: totalGoalieRows,
    modelA: modelAEv, modelB: modelBEv, modelC: modelCEv,
    correlationAllSeasons: corrAll, correlationValidation: corrVal,
    weightVariants: variantScores,
    stability: deltas.length > 0 ? { n: deltas.length, mean: mean(deltas) } : null,
  }, null, 2))
  console.log(`\nDetails gespeichert: ${outPath}`)
}

main()
