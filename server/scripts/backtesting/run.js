// ---------------------------------------------------------------------------
// BACKTEST RUNNER - orchestriert Predictor-Registry (predictors.js) über die
// historischen Archiv-Saisons (loadHistorical.js), berechnet Metriken
// (src/predictionMetrics.js, WIEDERVERWENDET - identische Definitionen wie
// /model-performance) + Kalibrierung + paarweise Bootstrap-Vergleiche
// (stats.js), und schreibt das Ergebnis als statischen Export
// public/backtest-results.json (exakt dasselbe Muster wie
// public/preseason-elo.json / public/player-history.json - vom Frontend per
// fetch() gelesen, siehe src/pages/Backtesting.jsx).
//
// Read-only ausser dem einen Output-Pfad unten. Rührt KEINE Produktivdateien
// an (siehe Dateikopf-Kommentare in predictors.js).
//
// Aufruf: node server/scripts/backtesting/run.js
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { loadHistoricalGames, seasonList, teamLabel } from './loadHistorical.js'
import { buildPredictors, groupBySeasonOrdered } from './predictors.js'
import { toMetricRow, computeFineCalibration, computeFineECE, bootstrapLogLossDelta, countSeasonsBetter } from './stats.js'
import { MODEL_VERSION_REGISTRY } from './modelVersions.js'
import {
  computeAccuracy, computeBrierScore, computeLogLoss, computeMAE,
  computeFavoriteWinRate, computeUpsetRate, computeAggregateBias,
} from '../../../src/predictionMetrics.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_PATH = path.join(__dirname, '..', '..', '..', 'public', 'backtest-results.json')
const SUMMARY_PATH = path.join(__dirname, '..', '..', 'data', 'historical', '_summary.json')

const MEANINGFUL_LOGLOSS_DELTA = -0.0005 // identischer Schwellenwert wie server/scripts/backtest-preseason-h2h.js
const COMPARISONS = [
  ['v1', 'v2', 'Pre-Season-ELO-Zusatznutzen gegenüber flachem ELO-Start'],
  ['v2', 'v3', 'Ruhetage/Back-to-back-Zusatznutzen gegenüber v2'],
  ['v2', 'v2_sog', 'SOG-Allowed-Zusatznutzen gegenüber v2 (isolierte Ablation)'],
  ['v3', 'production_reference', 'SOG-Allowed + Poisson/Skellam-Transformation kombiniert gegenüber v3'],
]

function metricsFor(rows) {
  if (!rows || rows.length === 0) return null
  return {
    n: rows.length,
    accuracy: computeAccuracy(rows),
    brier: computeBrierScore(rows),
    logLoss: computeLogLoss(rows),
    mae: computeMAE(rows),
    favoriteWinRate: computeFavoriteWinRate(rows),
    upsetRate: computeUpsetRate(rows),
    bias: computeAggregateBias(rows),
  }
}

function round(v, d = 4) {
  if (v == null || !Number.isFinite(v)) return v
  const f = 10 ** d
  return Math.round(v * f) / f
}
function roundMetrics(m) {
  if (!m) return null
  return {
    n: m.n,
    accuracy: round(m.accuracy),
    brier: round(m.brier),
    logLoss: round(m.logLoss),
    mae: round(m.mae),
    favoriteWinRate: round(m.favoriteWinRate),
    upsetRate: round(m.upsetRate),
    bias: m.bias ? { avgPredicted: round(m.bias.avgPredicted), actualRate: round(m.bias.actualRate), diff: round(m.bias.diff) } : null,
  }
}

function main() {
  const t0 = Date.now()
  const { games, teamNames, skippedNoDecision } = loadHistoricalGames()
  const gamesBySeason = groupBySeasonOrdered(games)
  const seasons = seasonList(games)
  const ctx = { gamesBySeason }

  console.log(`Geladen: ${games.length} Spiele, ${seasons.length} Saisons: ${seasons.join(', ')} (${skippedNoDecision} ohne Endergebnis übersprungen)`)

  // --- Datenaudit (Abschnitt 2) ---
  const rawSummary = fs.existsSync(SUMMARY_PATH) ? JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8')) : []
  const dataAudit = {
    seasonsAvailable: seasons,
    perSeason: seasons.map((s) => {
      const sg = gamesBySeason[seasons.indexOf(s)]
      const summaryEntry = rawSummary.find((r) => r.season === s)
      return {
        season: s,
        games: sg.length,
        ot: sg.filter((g) => g.decision === 'OT').length,
        so: sg.filter((g) => g.decision === 'SO').length,
        corona: sg[0] ? sg[0].corona : false,
        failedImports: summaryEntry ? summaryEntry.failed : [],
      }
    }),
    marketValueHistoricallyAvailable: false,
    marketValueReason: 'Historische Archivdaten (server/data/historical/*.json) enthalten keine Marktwert-Felder - Marktwerte werden ausschliesslich live von nationalleague.ch synchronisiert (server/sync.js), kein saisonbezogenes Archiv vorhanden.',
    sogHistoricallyAvailable: true,
    sogSource: 'server/data/historical/*.json: games[].goalies.{home,away}[].{saves,goalsAgainst} (identische Definition wie src/playoffSim.js::computeSogAllowedStats, für alle 9 Saisons vollständig vorhanden).',
  }

  // --- Predictors ausführen ---
  const predictors = buildPredictors()
  const predictorResults = {} // id -> Map(gameId -> {pHome, restAdjustment?})
  for (const p of predictors) {
    console.log(`Predictor ${p.id}...`)
    predictorResults[p.id] = p.run(games, ctx, {})
  }

  // --- Pro Predictor: rows bauen (kompatibel mit src/predictionMetrics.js) ---
  const rowsByPredictor = {} // id -> row[] (nur auswertbare Spiele, chronologisch)
  for (const p of predictors) {
    const result = predictorResults[p.id]
    const rows = []
    for (const g of games) {
      const r = result.get(g.id)
      if (!r || r.pHome == null) continue
      rows.push(toMetricRow(g, r.pHome))
    }
    rowsByPredictor[p.id] = rows
  }

  // --- Metriken je Predictor: total / core (ohne Corona) / corona + pro Saison ---
  const predictorSummaries = predictors.map((p) => {
    const rows = rowsByPredictor[p.id]
    const coreRows = rows.filter((r) => !r.game.corona)
    const coronaRows = rows.filter((r) => r.game.corona)
    const perSeason = {}
    for (const s of seasons) {
      const seasonRows = rows.filter((r) => r.game.season === s)
      perSeason[s] = roundMetrics(metricsFor(seasonRows))
    }
    const calibration = computeFineCalibration(coreRows)
    const ece = round(computeFineECE(coreRows), 4)

    return {
      id: p.id,
      name: p.name,
      description: p.description,
      features: p.features,
      notValidatable: p.notValidatable || false,
      reason: p.reason || null,
      caveat: p.caveat || null,
      overall: {
        core: roundMetrics(metricsFor(coreRows)),
        corona: roundMetrics(metricsFor(coronaRows)),
        total: roundMetrics(metricsFor(rows)),
      },
      perSeason,
      calibration,
      ece,
    }
  })

  // --- Paarweise Vergleiche (Abschnitt 8) ---
  const comparisons = COMPARISONS.map(([aId, bId, label]) => {
    const rowsA = rowsByPredictor[aId]
    const rowsB = rowsByPredictor[bId]
    // Nur Spiele, die BEIDE Modelle bewerten konnten, paarweise (gleicher Index = gleiches Spiel).
    const byIdA = new Map(rowsA.map((r) => [r.game.id, r]))
    const byIdB = new Map(rowsB.map((r) => [r.game.id, r]))
    const commonCoreGameIds = games
      .filter((g) => !g.corona && byIdA.has(g.id) && byIdB.has(g.id))
      .map((g) => g.id)

    const pairsA = commonCoreGameIds.map((id) => ({ p: byIdA.get(id).prediction.homeWinProbability, y: byIdA.get(id).homeWon ? 1 : 0 }))
    const pairsB = commonCoreGameIds.map((id) => ({ p: byIdB.get(id).prediction.homeWinProbability, y: byIdB.get(id).homeWon ? 1 : 0 }))
    const bootstrap = bootstrapLogLossDelta(pairsA, pairsB, { resamples: 2000, seed: 42 })

    const perSeasonPairs = new Map()
    for (const s of seasons) {
      if (dataAudit.perSeason.find((x) => x.season === s)?.corona) continue
      const idsInSeason = commonCoreGameIds.filter((id) => byIdA.get(id).game.season === s)
      perSeasonPairs.set(s, {
        a: idsInSeason.map((id) => ({ p: byIdA.get(id).prediction.homeWinProbability, y: byIdA.get(id).homeWon ? 1 : 0 })),
        b: idsInSeason.map((id) => ({ p: byIdB.get(id).prediction.homeWinProbability, y: byIdB.get(id).homeWon ? 1 : 0 })),
      })
    }
    const seasonsBetter = countSeasonsBetter(perSeasonPairs)

    // "Robust" verlangt ALLE drei: (1) Effekt über der Rauschschwelle, (2) in
    // >=60% der Nicht-Corona-Saisons besser (identischer Schwellenwert wie
    // server/scripts/backtest-preseason-h2h.js), UND (3) das 95%-Bootstrap-CI
    // schliesst 0 aus - Kriterium (3) ist die schärfste Hürde: ein Effekt, der
    // in >=60% der Saisons "besser" ist, aber dessen Bootstrap-Unsicherheit 0
    // einschliesst, gilt hier explizit NICHT als robust (Abschnitt 8: "nicht
    // jeden kleinen Unterschied als Verbesserung darstellen").
    const ciExcludesZero = bootstrap.ci95 != null && bootstrap.ci95[1] < 0
    const robust = bootstrap.observedDelta != null && bootstrap.observedDelta < MEANINGFUL_LOGLOSS_DELTA
      && seasonsBetter.better >= Math.ceil(seasonsBetter.total * 0.6)
      && ciExcludesZero

    const failReasons = []
    if (bootstrap.n > 0 && !(bootstrap.observedDelta < MEANINGFUL_LOGLOSS_DELTA)) failReasons.push('Effekt zu klein/uneindeutig')
    if (bootstrap.n > 0 && seasonsBetter.better < Math.ceil(seasonsBetter.total * 0.6)) failReasons.push(`nur ${seasonsBetter.better}/${seasonsBetter.total} Saisons besser`)
    if (bootstrap.n > 0 && !ciExcludesZero) failReasons.push('95%-Bootstrap-CI schliesst 0 nicht aus (statistisch nicht von "kein Effekt" unterscheidbar)')

    const verdict = bootstrap.n === 0
      ? `${bId} konnte nicht mit ${aId} verglichen werden (keine gemeinsam auswertbaren Spiele).`
      : robust
        ? `${bId} verbessert LogLoss gegenüber ${aId} um ${Math.abs(bootstrap.observedDelta).toFixed(4)} (n=${bootstrap.n}). ${bId} war in ${seasonsBetter.better} von ${seasonsBetter.total} Nicht-Corona-Saisons besser, 95%-Bootstrap-CI [${bootstrap.ci95[0].toFixed(4)}, ${bootstrap.ci95[1].toFixed(4)}] schliesst 0 aus. Der Effekt ist ${Math.abs(bootstrap.observedDelta) < 0.003 ? 'klein, aber konsistent' : Math.abs(bootstrap.observedDelta) < 0.01 ? 'moderat und konsistent' : 'deutlich'}.`
        : `${bId} zeigt keinen robusten Zusatznutzen gegenüber ${aId} (ΔLogLoss=${bootstrap.observedDelta.toFixed(4)}, ${seasonsBetter.better}/${seasonsBetter.total} Saisons besser). Grund: ${failReasons.join('; ')}. Daher NICHT für Production übernehmen.`

    return {
      a: aId, b: bId, label,
      n: bootstrap.n,
      observedLogLossDelta: round(bootstrap.observedDelta, 5),
      bootstrapCi95: bootstrap.ci95 ? [round(bootstrap.ci95[0], 5), round(bootstrap.ci95[1], 5)] : null,
      pctResamplesBBetter: round(bootstrap.pctBBetter, 3),
      seasonsBetter: { better: seasonsBetter.better, total: seasonsBetter.total, perSeason: seasonsBetter.perSeason },
      robust,
      verdict,
    }
  })

  // --- Team-Namen-Lookup für die UI (nur zur Anzeige) ---
  const teamNamesOut = {}
  for (const [id] of teamNames) teamNamesOut[id] = teamLabel(teamNames, id)

  const out = {
    generatedAt: new Date().toISOString(),
    seasons,
    coronaSeasons: [...new Set(games.filter((g) => g.corona).map((g) => g.season))],
    totalGames: games.length,
    dataAudit,
    teamNames: teamNamesOut,
    predictors: predictorSummaries,
    comparisons,
    modelVersions: MODEL_VERSION_REGISTRY,
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))
  console.log(`\nGeschrieben: ${OUT_PATH}`)
  console.log(`Laufzeit: ${Date.now() - t0}ms`)

  console.log('\n=== ÜBERSICHT (Core, ohne Corona) ===')
  for (const p of predictorSummaries) {
    if (p.notValidatable) { console.log(`${p.id.padEnd(22)} NICHT VALIDIERBAR: ${p.reason}`); continue }
    const m = p.overall.core
    console.log(`${p.id.padEnd(22)} n=${m.n}  acc=${(m.accuracy * 100).toFixed(1)}%  brier=${m.brier.toFixed(4)}  logloss=${m.logLoss.toFixed(4)}  ece=${p.ece}`)
  }
  console.log('\n=== VERGLEICHE ===')
  for (const c of comparisons) console.log(`${c.a} -> ${c.b}: ${c.verdict}`)
}

main()
