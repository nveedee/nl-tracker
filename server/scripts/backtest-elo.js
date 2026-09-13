// ---------------------------------------------------------------------------
// ELO-Backtesting auf historischen SIHF-Daten (2017/18–2025/26).
//
// Read-only: verändert keine Dateien unter server/data/historical/ und
// importiert/verändert NICHT src/elo.js. Reines Analyse-Tool.
//
// Walk-forward-Simulation pro Saison chronologisch, Prognose IMMER vor dem
// ELO-Update berechnet -> kein Data Leakage. Getestet wird ein Parameterraster
// über K-Faktor, Heimvorteil, Torunterschied-Multiplikator, OT/SO-Gewichtung,
// Saisonend-Regression und optionale Formgewichtung.
//
// Aufruf: node server/scripts/backtest-elo.js
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'historical')

const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]
const CORONA_SEASONS = new Set(['2019/20', '2020/21'])

// ============================================================================
// 1. Daten laden & in flaches, chronologisches Spiel-Array umwandeln
// ============================================================================

function loadGames() {
  const games = []
  for (const f of SEASON_FILES) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8'))
    for (const g of raw.games) {
      games.push({
        season: g.season,
        corona: CORONA_SEASONS.has(g.season),
        date: g.date,
        dt: g.startDateTime || g.date,
        gameId: g.gameId,
        homeId: g.homeTeam.sihfId,
        awayId: g.awayTeam.sihfId,
        homeGoals: g.homeGoals,
        awayGoals: g.awayGoals,
        decision: g.decision, // REG | OT | SO
      })
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  return games
}

// ============================================================================
// 2. ELO-Engine (parametrisierbar, leak-free: Spielanzahl/Form nur aus
//    bereits verarbeiteten Spielen, nie aus der Zukunft)
// ============================================================================

// Torunterschied-Multiplikator: log(|diff|+1)-basiert, wie im Produktivsystem
function goalDiffMultiplier(diff, factor) {
  if (diff === 0 || factor === 0) return 1.0
  const f = Math.log(Math.abs(diff) + 1)
  return 1.0 + factor * (f - 1)
}

// K-Faktor-Tiers relativ zur Produktiv-Struktur (5/15/30/50 Spiele), skaliert
// auf kBase (Produktiv-Default: kBase=24 -> Tier bei 30 Spielen = 24)
function makeKTiers(kBase) {
  const scale = kBase / 24
  return [
    { maxGames: 5, k: 32 * scale },
    { maxGames: 15, k: 28 * scale },
    { maxGames: 30, k: 24 * scale },
    { maxGames: 50, k: 20 * scale },
    { maxGames: Infinity, k: 16 * scale },
  ]
}

function getK(tiers, gamesPlayed) {
  for (const t of tiers) if (gamesPlayed <= t.maxGames) return t.k
  return tiers[tiers.length - 1].k
}

// scoreH je nach Ausgang + OT/SO-Schema
function resultScore(homeWon, decision, scheme) {
  if (decision === 'SO') return homeWon ? scheme.so.win : scheme.so.loss
  if (decision === 'OT') return homeWon ? scheme.ot.win : scheme.ot.loss
  return homeWon ? 1.0 : 0.0
}

// Eine vollständige Walk-Forward-Simulation über alle Spiele mit gegebenen
// Parametern. Gibt Rohtreffer (pred, outcome) pro Spiel zurück, gruppiert für
// Metrik-Aggregation. Kein Zugriff auf zukünftige Spiele an irgendeiner Stelle.
function simulate(games, params) {
  const {
    kBase, homeAdv, goalDiffFactor, otsoScheme, regressionFraction, formDecay,
  } = params

  const kTiers = makeKTiers(kBase)
  const ratings = new Map() // teamId -> rating
  const gamesPlayed = new Map() // teamId -> count (nur Vergangenheit)
  let currentSeason = null

  // Ergebnis-Buffer: pro Spiel { season, corona, pHome, homeWon }
  const results = []

  for (const g of games) {
    // --- Saisonwechsel erkennen -> Regression zum Mittelwert (1500) ---
    if (currentSeason !== null && g.season !== currentSeason) {
      for (const [id, r] of ratings) {
        ratings.set(id, 1500 + (r - 1500) * (1 - regressionFraction))
      }
    }
    currentSeason = g.season

    const rh = ratings.get(g.homeId) ?? 1500
    const ra = ratings.get(g.awayId) ?? 1500
    const gpH = gamesPlayed.get(g.homeId) ?? 0
    const gpA = gamesPlayed.get(g.awayId) ?? 0

    // === PROGNOSE (nur aus Vergangenheit bekannt) ===
    const pHome = 1 / (1 + Math.pow(10, (ra - (rh + homeAdv)) / 400))
    const homeWon = g.homeGoals > g.awayGoals

    results.push({ season: g.season, corona: g.corona, pHome, homeWon })

    // === UPDATE (erst NACH der Prognose) ===
    const diff = Math.abs(g.homeGoals - g.awayGoals)
    const goalMult = goalDiffMultiplier(diff, goalDiffFactor)
    const scoreH = resultScore(homeWon, g.decision, otsoScheme)
    const scoreA = 1 - scoreH

    const kH = getK(kTiers, gpH)
    const kA = getK(kTiers, gpA)

    let formH = 1, formA = 1
    if (formDecay > 0) {
      // leak-freie Form: Gewicht steigt mit Spielerfahrung des Teams
      // (jüngere/erfahrenere Teams reagieren voll, sehr neue Teams gedämpft
      // stärker durch K-Tiers, hier nur ein leichter zusätzlicher Faktor)
      formH = 1 - Math.exp(-formDecay * (gpH + 1))
      formA = 1 - Math.exp(-formDecay * (gpA + 1))
    }

    const deltaH = kH * goalMult * formH * (scoreH - pHome)
    const deltaA = kA * goalMult * formA * (scoreA - (1 - pHome))

    ratings.set(g.homeId, rh + deltaH)
    ratings.set(g.awayId, ra + deltaA)
    gamesPlayed.set(g.homeId, gpH + 1)
    gamesPlayed.set(g.awayId, gpA + 1)
  }

  return results
}

// ============================================================================
// 3. Metriken
// ============================================================================

function evalResults(results) {
  // Aggregation: core (ohne Corona), corona, total, + pro Saison
  const buckets = { core: [], corona: [], total: results }
  const perSeason = new Map()

  for (const r of results) {
    ;(r.corona ? buckets.corona : buckets.core).push(r)
    if (!perSeason.has(r.season)) perSeason.set(r.season, [])
    perSeason.get(r.season).push(r)
  }

  function metrics(arr) {
    if (arr.length === 0) return null
    let correct = 0, brier = 0, logloss = 0
    const EPS = 1e-10
    for (const r of arr) {
      const p = Math.min(1 - EPS, Math.max(EPS, r.pHome))
      const y = r.homeWon ? 1 : 0
      const predWin = p >= 0.5 ? 1 : 0
      if (predWin === y) correct++
      brier += (p - y) ** 2
      logloss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
    }
    return {
      n: arr.length,
      accuracy: correct / arr.length,
      brier: brier / arr.length,
      logloss: logloss / arr.length,
    }
  }

  const perSeasonMetrics = {}
  for (const [s, arr] of perSeason) perSeasonMetrics[s] = metrics(arr)

  return {
    core: metrics(buckets.core),
    corona: metrics(buckets.corona),
    total: metrics(buckets.total),
    perSeason: perSeasonMetrics,
  }
}

// ============================================================================
// 4. Parameterraster
// ============================================================================

const OTSO_SCHEMES = {
  none: { ot: { win: 1.0, loss: 0.0 }, so: { win: 1.0, loss: 0.0 } },
  current_bug: { ot: { win: 0.75, loss: 0.25 }, so: { win: 0.75, loss: 0.25 } }, // repliziert Produktiv-Verhalten (OT==SO wegen Code-Bug)
  fixed_A: { ot: { win: 0.75, loss: 0.25 }, so: { win: 0.60, loss: 0.40 } },
  fixed_B: { ot: { win: 0.70, loss: 0.30 }, so: { win: 0.55, loss: 0.45 } },
  fixed_C: { ot: { win: 0.65, loss: 0.35 }, so: { win: 0.50, loss: 0.50 } },
}

const GRID = {
  kBase: [16, 20, 24, 28, 32],
  homeAdv: [0, 25, 40, 50, 65, 80],
  goalDiffFactor: [0, 0.3, 0.5, 0.7, 1.0],
  otsoScheme: Object.keys(OTSO_SCHEMES),
  regressionFraction: [0, 0.25, 0.5, 0.75, 1.0],
  formDecay: [0, 0.02],
}

function* paramCombos() {
  for (const kBase of GRID.kBase)
    for (const homeAdv of GRID.homeAdv)
      for (const goalDiffFactor of GRID.goalDiffFactor)
        for (const otsoName of GRID.otsoScheme)
          for (const regressionFraction of GRID.regressionFraction)
            for (const formDecay of GRID.formDecay)
              yield {
                kBase, homeAdv, goalDiffFactor,
                otsoScheme: OTSO_SCHEMES[otsoName], otsoName,
                regressionFraction, formDecay,
              }
}

// ============================================================================
// 5. Grid-Search
// ============================================================================

function runGridSearch(games) {
  const all = []
  let count = 0
  const t0 = Date.now()
  for (const params of paramCombos()) {
    const results = simulate(games, params)
    const ev = evalResults(results)
    all.push({ params, ev })
    count++
  }
  const ms = Date.now() - t0
  return { all, count, ms }
}

// Rang-basiertes kombiniertes Scoring: LogLoss + Brier auf Core-Saisons
// wichtiger als Accuracy (Vorgabe des Users).
function rankCombos(all) {
  const byLogloss = [...all].sort((a, b) => a.ev.core.logloss - b.ev.core.logloss)
  const byBrier = [...all].sort((a, b) => a.ev.core.brier - b.ev.core.brier)
  const rankOf = (arr, item) => arr.indexOf(item)

  for (const item of all) {
    item.rankLogloss = rankOf(byLogloss, item)
    item.rankBrier = rankOf(byBrier, item)
    item.combinedRank = item.rankLogloss + item.rankBrier
  }
  return [...all].sort((a, b) => {
    if (a.combinedRank !== b.combinedRank) return a.combinedRank - b.combinedRank
    return b.ev.core.accuracy - a.ev.core.accuracy
  })
}

// ============================================================================
// 6. Baseline = aktuelles Produktiv-ELO (elo.js Defaults), leak-free simuliert
// ============================================================================

const BASELINE_PARAMS = {
  kBase: 24,
  homeAdv: 50,
  goalDiffFactor: 0.5,
  otsoScheme: OTSO_SCHEMES.current_bug, // repliziert den bestehenden Code (OT/SO nicht unterschieden)
  otsoName: 'current_bug (Produktiv-Code: OT/SO nicht unterschieden)',
  regressionFraction: 0, // Produktiv-Code kennt aktuell KEINE Saisonend-Regression
  formDecay: 0.02,
}

// ============================================================================
// MAIN
// ============================================================================

function fmt(m) {
  if (!m) return 'n/a'
  return `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}`
}

function main() {
  const games = loadGames()
  console.log(`Geladen: ${games.length} Spiele, Saisons: ${[...new Set(games.map(g=>g.season))].join(', ')}`)

  console.log('\n=== BASELINE (aktuelles Produktiv-ELO, leak-free nachgebaut) ===')
  const baseResults = simulate(games, BASELINE_PARAMS)
  const baseEv = evalResults(baseResults)
  console.log('Core (ohne Corona):', fmt(baseEv.core))
  console.log('Corona-Saisons:    ', fmt(baseEv.corona))
  console.log('Gesamt (9 Saisons):', fmt(baseEv.total))
  console.log('Pro Saison:')
  for (const [s, m] of Object.entries(baseEv.perSeason)) {
    console.log(`  ${s}${CORONA_SEASONS.has(s) ? ' [CORONA]' : '          '}  ${fmt(m)}`)
  }

  console.log('\n=== GRID SEARCH ===')
  console.log(`Kombinationen: ${GRID.kBase.length * GRID.homeAdv.length * GRID.goalDiffFactor.length * GRID.otsoScheme.length * GRID.regressionFraction.length * GRID.formDecay.length}`)
  const { all, count, ms } = runGridSearch(games)
  console.log(`Getestet: ${count} Kombinationen in ${ms}ms`)

  const ranked = rankCombos(all)
  const best = ranked[0]

  console.log('\n=== TOP 5 KOMBINATIONEN (nach kombiniertem Rang LogLoss+Brier, Core-Saisons) ===')
  for (let i = 0; i < 5; i++) {
    const c = ranked[i]
    console.log(`#${i + 1} kBase=${c.params.kBase} homeAdv=${c.params.homeAdv} goalDiffFactor=${c.params.goalDiffFactor} otso=${c.params.otsoName} regression=${c.params.regressionFraction} formDecay=${c.params.formDecay}`)
    console.log(`    Core: ${fmt(c.ev.core)}`)
  }

  console.log('\n=== BESTE KONFIGURATION (Detail) ===')
  console.log(JSON.stringify(best.params, (k, v) => (k === 'otsoScheme' ? undefined : v), 2))
  console.log('Core (ohne Corona):', fmt(best.ev.core))
  console.log('Corona-Saisons:    ', fmt(best.ev.corona))
  console.log('Gesamt (9 Saisons):', fmt(best.ev.total))
  console.log('Pro Saison:')
  for (const [s, m] of Object.entries(best.ev.perSeason)) {
    console.log(`  ${s}${CORONA_SEASONS.has(s) ? ' [CORONA]' : '          '}  ${fmt(m)}`)
  }

  // Sensitivitätsanalyse rund um das Optimum: ein Parameter variieren, Rest fixieren
  console.log('\n=== SENSITIVITÄT (Core LogLoss, um Optimum) ===')
  for (const dim of ['kBase', 'homeAdv', 'goalDiffFactor', 'regressionFraction', 'formDecay']) {
    const row = GRID[dim].map((val) => {
      const p = { ...best.params, [dim]: val }
      const ev = evalResults(simulate(games, p))
      return `${val}:${ev.core.logloss.toFixed(4)}`
    })
    console.log(`  ${dim.padEnd(20)} ${row.join('  ')}`)
  }
  console.log('  otsoScheme (Name:LogLoss)')
  for (const name of GRID.otsoScheme) {
    const p = { ...best.params, otsoScheme: OTSO_SCHEMES[name] }
    const ev = evalResults(simulate(games, p))
    console.log(`    ${name.padEnd(15)} ${ev.core.logloss.toFixed(4)}`)
  }

  // Ergebnis als JSON für weitere Auswertung sichern (nur Analyse-Output, keine Produktivdaten)
  const outPath = path.join(__dirname, 'backtest-result.json')
  fs.writeFileSync(outPath, JSON.stringify({
    baseline: { params: BASELINE_PARAMS.otsoName ? { ...BASELINE_PARAMS, otsoScheme: undefined } : BASELINE_PARAMS, ev: baseEv },
    best: { params: { ...best.params, otsoScheme: undefined }, ev: best.ev },
    top5: ranked.slice(0, 5).map(c => ({ params: { ...c.params, otsoScheme: undefined }, ev: c.ev })),
  }, null, 2))
  console.log(`\nDetails gespeichert: ${outPath}`)
}

main()
