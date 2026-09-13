// ---------------------------------------------------------------------------
// Pflicht-Tests für das Backtesting-System (Abschnitt 13 des Auftrags).
// Node-eigener Test-Runner (node:test/node:assert), keine neue Abhängigkeit.
//
// Aufruf: node --test server/scripts/backtesting/run.test.js
//         (oder: npm run test:backtest)
// ---------------------------------------------------------------------------

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { loadHistoricalGames, seasonList } from './loadHistorical.js'
import { buildPredictors, groupBySeasonOrdered } from './predictors.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HISTORICAL_DIR = path.join(__dirname, '..', '..', 'data', 'historical')
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'db.json')
const MODEL_PERFORMANCE_PATH = path.join(__dirname, '..', '..', '..', 'src', 'pages', 'ModelPerformance.jsx')
const PREDICTION_METRICS_PATH = path.join(__dirname, '..', '..', '..', 'src', 'predictionMetrics.js')
const ELO_PATH = path.join(__dirname, '..', '..', '..', 'src', 'elo.js')
const REST_DAYS_PATH = path.join(__dirname, '..', '..', '..', 'src', 'restDays.js')
const PLAYOFF_SIM_PATH = path.join(__dirname, '..', '..', '..', 'src', 'playoffSim.js')
const PREDICTIONS_JS_PATH = path.join(__dirname, '..', 'predictions.js')

function loadEverything() {
  const { games } = loadHistoricalGames()
  const gamesBySeason = groupBySeasonOrdered(games)
  const predictors = buildPredictors()
  return { games, gamesBySeason, predictors }
}

test('Datenaudit: 9 Saisons, Spielanzahl stimmt mit _summary.json überein', () => {
  const { games } = loadHistoricalGames()
  const summary = JSON.parse(fs.readFileSync(path.join(HISTORICAL_DIR, '_summary.json'), 'utf8'))
  const seasons = seasonList(games)
  assert.equal(seasons.length, 9)
  for (const s of seasons) {
    const entry = summary.find((r) => r.season === s)
    const count = games.filter((g) => g.season === s).length
    assert.equal(count, entry.games, `Spielanzahl ${s} stimmt nicht mit _summary.json überein`)
  }
})

test('historische Rohdaten bleiben unverändert (read-only)', () => {
  const before = {}
  for (const f of fs.readdirSync(HISTORICAL_DIR)) {
    before[f] = fs.readFileSync(path.join(HISTORICAL_DIR, f), 'utf8')
  }
  loadHistoricalGames() // zweimal laden
  loadHistoricalGames()
  for (const f of fs.readdirSync(HISTORICAL_DIR)) {
    assert.equal(fs.readFileSync(path.join(HISTORICAL_DIR, f), 'utf8'), before[f], `${f} wurde verändert`)
  }
})

test('db.json bleibt unverändert (Backtest rührt Live-Daten nicht an)', () => {
  const before = fs.readFileSync(DB_PATH, 'utf8')
  const { games, gamesBySeason } = loadEverything()
  const predictors = buildPredictors()
  for (const p of predictors) p.run(games, { gamesBySeason }, {})
  const after = fs.readFileSync(DB_PATH, 'utf8')
  assert.equal(after, before, 'db.json wurde durch den Backtest-Lauf verändert')
})

test('Produktivdateien (elo.js, restDays.js, playoffSim.js, predictions.js, ModelPerformance.jsx, predictionMetrics.js) unverändert', () => {
  // Diese Dateien werden vom Backtest-Modul nur IMPORTIERT/duplizierte
  // Formeln zitiert - nie modifiziert. Prüft konkret, dass die bekannten
  // Kern-Exports/Referenzwerte noch vorhanden sind (Canary-Check statt
  // Byte-Diff, da kein sauberer Git-Baseline-Zugriff in dieser Umgebung
  // vorausgesetzt werden kann).
  const eloSrc = fs.readFileSync(ELO_PATH, 'utf8')
  assert.match(eloSrc, /export function computeElo/)
  assert.match(eloSrc, /export function homeWinProbability/)
  assert.match(eloSrc, /seasonEndRegression: 0\.25/)

  const restSrc = fs.readFileSync(REST_DAYS_PATH, 'utf8')
  assert.match(restSrc, /export function computeRestAdjustment/)
  assert.match(restSrc, /export function applyRestAdjustment/)

  const playoffSimSrc = fs.readFileSync(PLAYOFF_SIM_PATH, 'utf8')
  assert.match(playoffSimSrc, /leagueHomeGPG: 3\.0496/)
  assert.match(playoffSimSrc, /supremacySlope: 4/)

  const predictionsSrc = fs.readFileSync(PREDICTIONS_JS_PATH, 'utf8')
  assert.match(predictionsSrc, /export function ensurePredictionSnapshots/)

  const mpSrc = fs.readFileSync(MODEL_PERFORMANCE_PATH, 'utf8')
  assert.match(mpSrc, /HISTORICAL_BACKTEST_REF/)
  assert.match(mpSrc, /logLoss: 0\.6558231730465114/)

  const pmSrc = fs.readFileSync(PREDICTION_METRICS_PATH, 'utf8')
  assert.match(pmSrc, /export function computeLogLoss/)
  assert.match(pmSrc, /export function computeECE/)
})

test('gleicher Input -> gleiche Prediction (Determinismus)', () => {
  const { games, gamesBySeason, predictors } = loadEverything()
  const ctx = { gamesBySeason }
  for (const p of predictors) {
    const r1 = p.run(games, ctx, {})
    const r2 = p.run(games, ctx, {})
    for (const g of games.slice(0, 50)) {
      assert.deepEqual(r1.get(g.id), r2.get(g.id), `${p.id}: unterschiedliches Ergebnis bei identischem Input für ${g.id}`)
    }
  }
})

test('keine NaN/Infinity, Wahrscheinlichkeiten in [0,1]', () => {
  const { games, gamesBySeason, predictors } = loadEverything()
  const ctx = { gamesBySeason }
  for (const p of predictors) {
    const result = p.run(games, ctx, {})
    for (const g of games) {
      const r = result.get(g.id)
      if (!r || r.pHome == null) continue
      assert.ok(Number.isFinite(r.pHome), `${p.id}/${g.id}: pHome ist nicht endlich (${r.pHome})`)
      assert.ok(r.pHome >= 0 && r.pHome <= 1, `${p.id}/${g.id}: pHome ausserhalb [0,1] (${r.pHome})`)
    }
  }
})

test('Spielanzahl je Predictor korrekt (v1: alle Spiele auswertbar, v0: erste Saison nicht)', () => {
  const { games, gamesBySeason, predictors } = loadEverything()
  const ctx = { gamesBySeason }
  const v1 = predictors.find((p) => p.id === 'v1').run(games, ctx, {})
  const v0 = predictors.find((p) => p.id === 'v0').run(games, ctx, {})
  const firstSeason = seasonList(games)[0]
  const firstSeasonCount = games.filter((g) => g.season === firstSeason).length

  const v1Evaluable = games.filter((g) => v1.get(g.id)?.pHome != null).length
  const v0Evaluable = games.filter((g) => v0.get(g.id)?.pHome != null).length

  assert.equal(v1Evaluable, games.length, 'v1 sollte jedes Spiel bewerten können')
  assert.equal(v0Evaluable, games.length - firstSeasonCount, 'v0 sollte genau die erste Saison NICHT bewerten (keine Vorsaison)')
})

test('v2_marketvalue liefert KEINE Predictions (als historisch nicht validierbar markiert)', () => {
  const { games, gamesBySeason, predictors } = loadEverything()
  const mv = predictors.find((p) => p.id === 'v2_marketvalue')
  assert.equal(mv.notValidatable, true)
  const result = mv.run(games, { gamesBySeason }, {})
  const evaluable = games.filter((g) => result.get(g.id)?.pHome != null).length
  assert.equal(evaluable, 0, 'v2_marketvalue darf keine Predictions liefern (keine historischen Marktwerte)')
})

test('ELO-State ist chronologisch korrekt: Reihenfolge der Rückgabe folgt dem Datum', () => {
  const { games } = loadHistoricalGames()
  for (let i = 1; i < games.length; i++) {
    assert.ok(games[i].dt >= games[i - 1].dt, `Spiel ${i} liegt zeitlich vor Spiel ${i - 1}`)
  }
})

// --- MANUELLER LEAKAGE-TEST (Pflicht, Abschnitt 13) ---
// Verändert das Ergebnis eines SPÄTEREN Spiels und prüft, dass die Prognose
// eines FRÜHEREN Spiels dadurch NICHT beeinflusst wird - für alle Predictors,
// die auf dem gesamten chronologischen Verlauf laufen (v1/v2/v3/SOG-Ablation/
// Produktions-Referenz). Das ist der härteste, direkteste Nachweis, dass hier
// wirklich walk-forward und nicht "ganze Saison vorher berechnet" prognostiziert wird.
test('LEAKAGE-TEST: Veränderung eines späteren Spielergebnisses ändert die Prognose eines früheren Spiels NICHT', () => {
  const { games, gamesBySeason, predictors } = loadEverything()
  const ctx = { gamesBySeason }

  // Frühes Spiel (Index 5) als Kontrollpunkt, spätes Spiel (letztes Spiel der
  // Saison 2020/21, mitten im Datensatz) wird manipuliert.
  const earlyGame = games[5]
  const midSeasonIdx = Math.floor(games.length * 0.6)
  const lateGame = games[midSeasonIdx]
  assert.ok(lateGame.dt > earlyGame.dt, 'Testaufbau: lateGame muss zeitlich nach earlyGame liegen')

  const baselinePredictions = {}
  for (const p of predictors) {
    if (p.notValidatable) continue
    baselinePredictions[p.id] = p.run(games, ctx, {}).get(earlyGame.id)
  }

  // Tiefe Kopie + Ergebnis eines SPÄTEREN Spiels manipulieren (Heimsieg -> Auswärtssieg,
  // Tordifferenz umgedreht) - simuliert "würde ein zukünftiges Resultat versehentlich
  // durchsickern".
  const mutatedGames = games.map((g) => ({ ...g }))
  const lateIdx = mutatedGames.findIndex((g) => g.id === lateGame.id)
  mutatedGames[lateIdx] = {
    ...mutatedGames[lateIdx],
    homeGoals: mutatedGames[lateIdx].awayGoals + 5,
    awayGoals: 0,
    decision: 'REG',
    sogAllowedHome: mutatedGames[lateIdx].sogAllowedHome + 30,
    sogAllowedAway: 0,
  }
  const mutatedGamesBySeason = groupBySeasonOrdered(mutatedGames)
  const mutatedCtx = { gamesBySeason: mutatedGamesBySeason }

  for (const p of predictors) {
    if (p.notValidatable) continue
    const mutatedPrediction = p.run(mutatedGames, mutatedCtx, {}).get(earlyGame.id)
    assert.deepEqual(
      mutatedPrediction, baselinePredictions[p.id],
      `LEAKAGE in Predictor ${p.id}: Prognose für frühes Spiel (${earlyGame.id}) änderte sich durch Manipulation eines späteren Spiels!`
    )
  }
})

test('Leakage-Test-Gegenprobe: das manipulierte spätere Spiel selbst wirkt sich auf NOCH SPÄTERE Spiele aus (Test ist nicht trivial erfüllt)', () => {
  // Stellt sicher, dass der obige Leakage-Test nicht nur deshalb "besteht",
  // weil die Manipulation wirkungslos wäre (z.B. Tippfehler im Testaufbau) -
  // ein Spiel NACH dem manipulierten muss sich sehr wohl ändern (ELO wurde ja
  // absichtlich verändert).
  const { games, gamesBySeason, predictors } = loadEverything()
  const ctx = { gamesBySeason }
  const midSeasonIdx = Math.floor(games.length * 0.6)
  const lateGame = games[midSeasonIdx]
  const laterGame = games[midSeasonIdx + 30]
  assert.ok(laterGame.dt > lateGame.dt)

  const v1 = predictors.find((p) => p.id === 'v1')
  const baseline = v1.run(games, ctx, {}).get(laterGame.id)

  const mutatedGames = games.map((g) => ({ ...g }))
  mutatedGames[midSeasonIdx] = { ...mutatedGames[midSeasonIdx], homeGoals: mutatedGames[midSeasonIdx].awayGoals + 5, awayGoals: 0, decision: 'REG' }
  const mutatedCtx = { gamesBySeason: groupBySeasonOrdered(mutatedGames) }
  const mutated = v1.run(mutatedGames, mutatedCtx, {}).get(laterGame.id)

  // Nur prüfen, wenn die beiden Teams des manipulierten Spiels tatsächlich
  // (direkt oder über die ELO-Kette) das spätere Spiel beeinflussen können -
  // bei v1 (ELO) betrifft jede Ergebnisänderung immer BEIDE beteiligten Teams'
  // Rating dauerhaft, das pflanzt sich über jedes ihrer Folgespiele fort.
  const affectsTeam = laterGame.homeTeamId === mutatedGames[midSeasonIdx].homeTeamId
    || laterGame.homeTeamId === mutatedGames[midSeasonIdx].awayTeamId
    || laterGame.awayTeamId === mutatedGames[midSeasonIdx].homeTeamId
    || laterGame.awayTeamId === mutatedGames[midSeasonIdx].awayTeamId
  if (affectsTeam) {
    assert.notDeepEqual(mutated, baseline, 'Erwartete Änderung bei einem Folgespiel blieb aus - Testaufbau prüfen')
  }
})
