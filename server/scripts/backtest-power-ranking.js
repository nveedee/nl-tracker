// ---------------------------------------------------------------------------
// Power-Ranking-Backtesting auf historischen SIHF-Daten (2017/18–2025/26).
//
// Read-only: verändert weder die historischen Daten noch src/powerRankings.js
// noch src/elo.js. Reines Analyse-Tool, exakt dieselbe leak-freie
// Walk-Forward-Methodik wie server/scripts/backtest-elo.js:
//   - Spiele chronologisch sortiert
//   - Alle Power-Ranking-Komponenten werden VOR jedem Spiel ausschliesslich
//     aus bereits gespielten Spielen berechnet (inkl. ELO-Rating "zum
//     Zeitpunkt X", nicht das Endrating der Saison)
//   - Update (Statistiken/Form-Fenster/ELO) erst NACH der Prognose
//
// ELO wird NICHT verändert: die ELO-Komponente wird mit den (jetzt
// produktiven) Parametern aus src/elo.js repliziert (K=16, homeAdv=65,
// goalDiffFactor=0.7, OT 0.70/0.30, SO 0.55/0.45, Saisonregression 25%,
// formDecay=0) und EINMALIG vorab für alle Spiele berechnet (ELO hängt nicht
// von den Power-Ranking-Gewichten ab -> Snapshot wird über alle
// Gewichtskombinationen wiederverwendet).
//
// Power-Score-Differenzen werden wie im Produktivcode 0–100 normalisiert und
// per logistischer Funktion in eine Heimsieg-Wahrscheinlichkeit übersetzt:
//   p = 1 / (1 + exp(-a * (diff + homeBonus)))
// a (Steilheit) und homeBonus (Heimvorteil auf der 0–100-Skala) werden pro
// Gewichtskombination separat kalibriert, damit der Vergleich fair bleibt.
//
// Aufruf: node server/scripts/backtest-power-ranking.js
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
// 1. Daten laden
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
        decision: g.decision,
      })
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  games.forEach((g, i) => { g.__idx = i })
  return games
}

// ============================================================================
// 2. ELO — exakte Replik der (unveränderten) Produktiv-Parameter aus src/elo.js
//    Läuft EINMAL über alle Spiele, liefert für jedes Spiel einen Snapshot
//    ALLER Team-Ratings zum Zeitpunkt VOR diesem Spiel.
// ============================================================================

const ELO = {
  start: 1500,
  baseK: 16,
  homeAdv: 65,
  goalDiffFactor: 0.7,
  seasonRegression: 0.25,
  resultWeights: {
    regulationWin: 1.0, regulationLoss: 0.0,
    otWin: 0.70, otLoss: 0.30,
    soWin: 0.55, soLoss: 0.45,
  },
  kTiers: [
    { maxGames: 5, kRatio: 32 / 24 },
    { maxGames: 15, kRatio: 28 / 24 },
    { maxGames: 30, kRatio: 24 / 24 },
    { maxGames: 50, kRatio: 20 / 24 },
    { maxGames: Infinity, kRatio: 16 / 24 },
  ],
}

function eloK(gamesPlayed) {
  for (const t of ELO.kTiers) if (gamesPlayed <= t.maxGames) return ELO.baseK * t.kRatio
  return ELO.baseK * ELO.kTiers[ELO.kTiers.length - 1].kRatio
}
function eloGoalMult(diff) {
  if (diff === 0) return 1.0
  return 1.0 + ELO.goalDiffFactor * (Math.log(diff + 1) - 1)
}
function eloResultScore(homeWon, decision) {
  if (decision === 'SO') return homeWon ? ELO.resultWeights.soWin : ELO.resultWeights.soLoss
  if (decision === 'OT') return homeWon ? ELO.resultWeights.otWin : ELO.resultWeights.otLoss
  return homeWon ? ELO.resultWeights.regulationWin : ELO.resultWeights.regulationLoss
}

// Liefert ein Array (parallel zu games): Snapshot { teamId: rating } VOR dem jeweiligen Spiel
function computeEloSnapshots(games) {
  const ratings = new Map()
  const gp = new Map()
  let curSeason = null
  const snapshots = new Array(games.length)

  for (const g of games) {
    if (curSeason !== null && g.season !== curSeason) {
      for (const [id, r] of ratings) ratings.set(id, ELO.start + (r - ELO.start) * (1 - ELO.seasonRegression))
    }
    curSeason = g.season

    // Snapshot VOR diesem Spiel (flaches Objekt, billig zu kopieren: ~14 Teams)
    snapshots[g.__idx] = Object.fromEntries(ratings)

    const rh = ratings.get(g.homeId) ?? ELO.start
    const ra = ratings.get(g.awayId) ?? ELO.start
    const gpH = gp.get(g.homeId) ?? 0
    const gpA = gp.get(g.awayId) ?? 0

    const homeWon = g.homeGoals > g.awayGoals
    const expH = 1 / (1 + Math.pow(10, (ra - (rh + ELO.homeAdv)) / 400))
    const goalMult = eloGoalMult(Math.abs(g.homeGoals - g.awayGoals))
    const scoreH = eloResultScore(homeWon, g.decision)
    const kH = eloK(gpH), kA = eloK(gpA)

    const deltaH = kH * goalMult * (scoreH - expH)
    const deltaA = kA * goalMult * ((1 - scoreH) - (1 - expH))

    ratings.set(g.homeId, rh + deltaH)
    ratings.set(g.awayId, ra + deltaA)
    gp.set(g.homeId, gpH + 1)
    gp.set(g.awayId, gpA + 1)
  }
  return snapshots
}

// ============================================================================
// 3. Power-Ranking-Komponenten — exakte Replik von src/powerRankings.js,
//    aber inkrementell (leak-frei: Stand unmittelbar VOR dem aktuellen Spiel)
// ============================================================================

const PR = {
  strengthWeights: { elo: 0.50, pointsPerGame: 0.35, winRate: 0.15 },
  formShort: 5,
  formLong: 10,
  formLongWeight: 0.3,
  relativeWindow: 10,
  eloMin: 1300,
  eloMax: 1700,
}

function normalize(values, invert = false) {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return values.map(() => 50)
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  return values.map((v) => {
    if (!Number.isFinite(v) || max === min) return 50
    const n = (v - min) / (max - min)
    return invert ? (1 - n) * 100 : n * 100
  })
}
function normalizeElo(elo) {
  if (elo < PR.eloMin) return 0
  if (elo > PR.eloMax) return 100
  return ((elo - PR.eloMin) / (PR.eloMax - PR.eloMin)) * 100
}
function avgLastN(deque, n, field) {
  if (deque.length === 0) return 0
  const slice = deque.slice(-n)
  return slice.reduce((s, x) => s + x[field], 0) / slice.length
}
function ptsForResult(isHome, homeGoals, awayGoals, decision) {
  const homeWon = homeGoals > awayGoals
  const overtime = decision === 'OT' || decision === 'SO'
  const won = isHome ? homeWon : !homeWon
  if (overtime) return won ? 2 : 1
  return won ? 3 : 0
}

// Gruppiert Spiele pro Saison (in chronologischer Reihenfolge) und ermittelt
// die in dieser Saison aktiven Teams.
function groupBySeasonWithActiveTeams(games) {
  const bySeason = new Map()
  for (const g of games) {
    if (!bySeason.has(g.season)) bySeason.set(g.season, { games: [], teams: new Set() })
    const entry = bySeason.get(g.season)
    entry.games.push(g)
    entry.teams.add(g.homeId)
    entry.teams.add(g.awayId)
  }
  return bySeason
}

// Läuft einmal walk-forward durch alle Spiele und liefert für jedes Spiel den
// powerScore-Diff (home - away) für eine gegebene Gewichtskombination.
// eloSnapshots ist bereits vorab (unabhängig von den Gewichten) berechnet.
function computeDiffSeries(bySeason, eloSnapshots, weights) {
  const results = []

  for (const [, entry] of bySeason) {
    const teamIds = [...entry.teams]
    const stat = new Map()
    teamIds.forEach((id) => stat.set(id, { gp: 0, w: 0, otw: 0, otl: 0, l: 0, pts: 0, gf: 0, ga: 0, recent: [] }))

    for (const g of entry.games) {
      const eloSnap = eloSnapshots[g.__idx]

      let leagueGF = 0, leagueGA = 0, leagueGP = 0
      for (const id of teamIds) {
        const s = stat.get(id)
        leagueGF += s.gf; leagueGA += s.ga; leagueGP += s.gp
      }
      const leagueGPG = leagueGF / Math.max(1, leagueGP)
      const leagueGAG = leagueGA / Math.max(1, leagueGP)

      const eloNorm = [], ptsPerGameArr = [], winRateArr = []
      const gpgArr = [], gagArr = [], relOffArr = [], relDefArr = []
      const formShortArr = [], formLongArr = []

      for (const id of teamIds) {
        const s = stat.get(id)
        const elo = eloSnap[id] ?? ELO.start
        eloNorm.push(normalizeElo(elo))
        ptsPerGameArr.push(s.gp > 0 ? s.pts / s.gp : 0)
        winRateArr.push(s.gp > 0 ? (s.w + s.otw) / s.gp : 0)
        gpgArr.push(s.gp > 0 ? s.gf / s.gp : 0)
        gagArr.push(s.gp > 0 ? s.ga / s.gp : 0)

        const teamGPG = avgLastN(s.recent, PR.relativeWindow, 'gf')
        relOffArr.push(s.recent.length === 0 ? 0 : (teamGPG - leagueGPG) / Math.max(0.1, leagueGPG))
        const teamGAG = avgLastN(s.recent, PR.relativeWindow, 'ga')
        relDefArr.push(s.recent.length === 0 ? 0 : (leagueGAG - teamGAG) / Math.max(0.1, leagueGAG))

        formShortArr.push(avgLastN(s.recent, PR.formShort, 'pts'))
        formLongArr.push(avgLastN(s.recent, PR.formLong, 'pts'))
      }

      const ptsPerGameNorm = normalize(ptsPerGameArr)
      const winRateNorm = normalize(winRateArr)
      const gpgNorm = normalize(gpgArr)
      const gagNorm = normalize(gagArr, true)
      const relOffNorm = normalize(relOffArr)
      const relDefNorm = normalize(relDefArr)
      const formShortNorm = normalize(formShortArr)
      const formLongNorm = normalize(formLongArr)

      const powerScore = new Map()
      teamIds.forEach((id, i) => {
        const strength = eloNorm[i] * PR.strengthWeights.elo +
          ptsPerGameNorm[i] * PR.strengthWeights.pointsPerGame +
          winRateNorm[i] * PR.strengthWeights.winRate
        const offense = gpgNorm[i] * 0.6 + relOffNorm[i] * 0.4
        const defense = gagNorm[i] * 0.6 + relDefNorm[i] * 0.4
        const form = formShortNorm[i] * (1 - PR.formLongWeight) + formLongNorm[i] * PR.formLongWeight
        powerScore.set(id, strength * weights.strength + offense * weights.offense + defense * weights.defense + form * weights.form)
      })

      // === PROGNOSE (Stand VOR diesem Spiel) ===
      results.push({
        diff: powerScore.get(g.homeId) - powerScore.get(g.awayId),
        homeWon: g.homeGoals > g.awayGoals,
        corona: g.corona,
        season: g.season,
      })

      // === UPDATE (erst NACH der Prognose) ===
      const h = stat.get(g.homeId), a = stat.get(g.awayId)
      const hp = ptsForResult(true, g.homeGoals, g.awayGoals, g.decision)
      const ap = ptsForResult(false, g.homeGoals, g.awayGoals, g.decision)
      const overtime = g.decision === 'OT' || g.decision === 'SO'
      const homeWon = g.homeGoals > g.awayGoals

      h.gp++; a.gp++
      h.pts += hp; a.pts += ap
      h.gf += g.homeGoals; h.ga += g.awayGoals
      a.gf += g.awayGoals; a.ga += g.homeGoals
      if (overtime) {
        if (homeWon) { h.otw++; a.otl++ } else { h.otl++; a.otw++ }
      } else {
        if (homeWon) { h.w++; a.l++ } else { h.l++; a.w++ }
      }
      h.recent.push({ gf: g.homeGoals, ga: g.awayGoals, pts: hp })
      a.recent.push({ gf: g.awayGoals, ga: g.homeGoals, pts: ap })
      if (h.recent.length > 10) h.recent.shift()
      if (a.recent.length > 10) a.recent.shift()
    }
  }

  return results
}

// ============================================================================
// 4. Kalibrierung (a, homeBonus) + Metriken
// ============================================================================

function predictProb(diff, a, homeBonus) {
  return 1 / (1 + Math.exp(-a * (diff + homeBonus)))
}

function metricsFor(results, a, homeBonus, filterFn) {
  let n = 0, correct = 0, brier = 0, logloss = 0
  const EPS = 1e-10
  for (const r of results) {
    if (!filterFn(r)) continue
    const p = Math.min(1 - EPS, Math.max(EPS, predictProb(r.diff, a, homeBonus)))
    const y = r.homeWon ? 1 : 0
    n++
    if ((p >= 0.5 ? 1 : 0) === y) correct++
    brier += (p - y) ** 2
    logloss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
  }
  if (n === 0) return null
  return { n, accuracy: correct / n, brier: brier / n, logloss: logloss / n }
}

const A_GRID = [0.002, 0.005, 0.01, 0.02, 0.03, 0.04, 0.06, 0.08, 0.10, 0.15, 0.20]
const HOMEBONUS_GRID = [0, 2, 4, 6, 8, 10, 12, 16, 20, 25, 30, 40, 50]

// Findet beste (a, homeBonus) für eine Diff-Serie, Kriterium = Core-LogLoss+Brier
function calibrate(results) {
  const core = (r) => !r.corona
  let best = null
  for (const a of A_GRID) {
    for (const homeBonus of HOMEBONUS_GRID) {
      const m = metricsFor(results, a, homeBonus, core)
      if (!best || (m.logloss + m.brier) < (best.m.logloss + best.m.brier)) {
        best = { a, homeBonus, m }
      }
    }
  }
  return best
}

// ============================================================================
// 5. Gewichtsraster (Simplex, Schritt 0.1, strength+offense+defense+form=1)
// ============================================================================

function* weightCombos(step = 0.1) {
  const units = Math.round(1 / step)
  for (let s = 0; s <= units; s++) {
    for (let o = 0; o <= units - s; o++) {
      for (let d = 0; d <= units - s - o; d++) {
        const f = units - s - o - d
        yield { strength: s * step, offense: o * step, defense: d * step, form: f * step }
      }
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

function fmt(m) {
  if (!m) return 'n/a'
  return `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}`
}
function fmtW(w) {
  return `strength=${w.strength.toFixed(1)} offense=${w.offense.toFixed(1)} defense=${w.defense.toFixed(1)} form=${w.form.toFixed(1)}`
}

function main() {
  const games = loadGames()
  const eloSnapshots = computeEloSnapshots(games)
  const bySeason = groupBySeasonWithActiveTeams(games)
  console.log(`Geladen: ${games.length} Spiele, ${bySeason.size} Saisons`)

  const core = (r) => !r.corona
  const corona = (r) => r.corona
  const total = () => true

  // --- Baseline: aktuelle Produktiv-Gewichte ---
  const baselineWeights = { strength: 0.40, offense: 0.25, defense: 0.25, form: 0.10 }
  const baselineResults = computeDiffSeries(bySeason, eloSnapshots, baselineWeights)
  const baselineCal = calibrate(baselineResults)
  console.log('\n=== BASELINE (aktuelle Produktiv-Gewichte) ===')
  console.log('Gewichte:', fmtW(baselineWeights), ' | kalibriert a=' + baselineCal.a + ' homeBonus=' + baselineCal.homeBonus)
  console.log('Core (ohne Corona):', fmt(metricsFor(baselineResults, baselineCal.a, baselineCal.homeBonus, core)))
  console.log('Corona-Saisons:    ', fmt(metricsFor(baselineResults, baselineCal.a, baselineCal.homeBonus, corona)))
  console.log('Gesamt:            ', fmt(metricsFor(baselineResults, baselineCal.a, baselineCal.homeBonus, total)))

  // --- Referenz: reine Siegkraft (strength=1.0) ---
  const strengthOnly = { strength: 1.0, offense: 0, defense: 0, form: 0 }
  const strengthOnlyResults = computeDiffSeries(bySeason, eloSnapshots, strengthOnly)
  const strengthOnlyCal = calibrate(strengthOnlyResults)
  console.log('\n=== REFERENZ: nur Siegkraft (ELO+Punkte+Winrate, keine Offense/Defense/Form) ===')
  console.log('Core:', fmt(metricsFor(strengthOnlyResults, strengthOnlyCal.a, strengthOnlyCal.homeBonus, core)))

  // --- Grid Search über Gewichte ---
  console.log('\n=== GRID SEARCH (Gewichte, Schritt 0.1) ===')
  const t0 = Date.now()
  const all = []
  let count = 0
  for (const w of weightCombos(0.1)) {
    const results = computeDiffSeries(bySeason, eloSnapshots, w)
    const cal = calibrate(results)
    all.push({ weights: w, cal, results })
    count++
  }
  console.log(`Getestet: ${count} Gewichtskombinationen in ${Date.now() - t0}ms`)

  const byLogloss = [...all].sort((a, b) => a.cal.m.logloss - b.cal.m.logloss)
  const byBrier = [...all].sort((a, b) => a.cal.m.brier - b.cal.m.brier)
  for (const item of all) {
    item.rankLogloss = byLogloss.indexOf(item)
    item.rankBrier = byBrier.indexOf(item)
    item.combinedRank = item.rankLogloss + item.rankBrier
  }
  const ranked = [...all].sort((a, b) => {
    if (a.combinedRank !== b.combinedRank) return a.combinedRank - b.combinedRank
    return b.cal.m.accuracy - a.cal.m.accuracy
  })
  const best = ranked[0]

  console.log('\n=== TOP 10 GEWICHTSKOMBINATIONEN (Core LogLoss+Brier) ===')
  for (let i = 0; i < 10; i++) {
    const c = ranked[i]
    console.log(`#${i + 1} ${fmtW(c.weights)}  a=${c.cal.a} homeBonus=${c.cal.homeBonus}  ${fmt(c.cal.m)}`)
  }

  console.log('\n=== BESTE KONFIGURATION ===')
  console.log('Gewichte:', fmtW(best.weights))
  console.log('Kalibrierung: a=' + best.cal.a + ' homeBonus=' + best.cal.homeBonus)
  console.log('Core (ohne Corona):', fmt(metricsFor(best.results, best.cal.a, best.cal.homeBonus, core)))
  console.log('Corona-Saisons:    ', fmt(metricsFor(best.results, best.cal.a, best.cal.homeBonus, corona)))
  console.log('Gesamt:            ', fmt(metricsFor(best.results, best.cal.a, best.cal.homeBonus, total)))
  console.log('Pro Saison:')
  const perSeason = new Map()
  for (const r of best.results) {
    if (!perSeason.has(r.season)) perSeason.set(r.season, [])
    perSeason.get(r.season).push(r)
  }
  for (const [s, arr] of perSeason) {
    const m = metricsFor(arr, best.cal.a, best.cal.homeBonus, total)
    console.log(`  ${s}${CORONA_SEASONS.has(s) ? ' [CORONA]' : '          '}  ${fmt(m)}`)
  }

  // --- Plateau: alle Kombis innerhalb 1% Core-LogLoss vom Optimum ---
  const bestLogloss = best.cal.m.logloss
  const plateau = ranked.filter((c) => c.cal.m.logloss <= bestLogloss * 1.01)
  console.log(`\n=== ROBUSTES PLATEAU (Core LogLoss innerhalb 1% vom Optimum, n=${plateau.length}) ===`)
  const dims = ['strength', 'offense', 'defense', 'form']
  for (const dim of dims) {
    const vals = plateau.map((c) => c.weights[dim]).sort((a, b) => a - b)
    console.log(`  ${dim.padEnd(10)} min=${vals[0].toFixed(1)} max=${vals[vals.length - 1].toFixed(1)} median=${vals[Math.floor(vals.length / 2)].toFixed(1)}`)
  }

  // --- Sensitivität um das Optimum ---
  console.log('\n=== SENSITIVITÄT (Core LogLoss, ein Gewicht verschoben, Rest proportional skaliert) ===')
  for (const dim of dims) {
    const row = []
    for (const delta of [-0.2, -0.1, 0, 0.1, 0.2]) {
      const w = { ...best.weights }
      w[dim] = Math.max(0, Math.min(1, w[dim] + delta))
      const remaining = 1 - w[dim]
      const otherDims = dims.filter((d) => d !== dim)
      const otherSum = otherDims.reduce((s, d) => s + best.weights[d], 0)
      otherDims.forEach((d) => { w[d] = otherSum > 0 ? (best.weights[d] / otherSum) * remaining : remaining / otherDims.length })
      const results = computeDiffSeries(bySeason, eloSnapshots, w)
      const m = metricsFor(results, best.cal.a, best.cal.homeBonus, core)
      row.push(`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}:${m.logloss.toFixed(4)}`)
    }
    console.log(`  ${dim.padEnd(10)} ${row.join('  ')}`)
  }

  // --- Pragmatische Kandidaten innerhalb des Plateaus (interpretierbarer Mix statt Randlösung) ---
  console.log('\n=== PRAGMATISCHE KANDIDATEN (feste Kalibrierung des Optimums: a=' + best.cal.a + ' homeBonus=' + best.cal.homeBonus + ') ===')
  const candidates = [
    { strength: 1.0, offense: 0.0, defense: 0.0, form: 0.0 },
    { strength: 0.6, offense: 0.2, defense: 0.2, form: 0.0 },
    { strength: 0.5, offense: 0.2, defense: 0.2, form: 0.1 },
    { strength: 0.4, offense: 0.25, defense: 0.25, form: 0.1 },
  ]
  for (const w of candidates) {
    const results = computeDiffSeries(bySeason, eloSnapshots, w)
    const m = metricsFor(results, best.cal.a, best.cal.homeBonus, core)
    console.log(`  ${fmtW(w)}  ${fmt(m)}`)
  }

  // --- Vergleichstabelle ---
  const baseM = metricsFor(baselineResults, baselineCal.a, baselineCal.homeBonus, core)
  const strM = metricsFor(strengthOnlyResults, strengthOnlyCal.a, strengthOnlyCal.homeBonus, core)
  const bestM = metricsFor(best.results, best.cal.a, best.cal.homeBonus, core)
  console.log('\n=== VERGLEICH (Core, ohne Corona) ===')
  console.log('Modell                                      | Accuracy | Brier  | LogLoss')
  console.log(`Bisheriges Power Ranking (.40/.25/.25/.10)   | ${(baseM.accuracy * 100).toFixed(1)}%    | ${baseM.brier.toFixed(4)} | ${baseM.logloss.toFixed(4)}`)
  console.log(`Nur Siegkraft (Referenz, 1.0/0/0/0)          | ${(strM.accuracy * 100).toFixed(1)}%    | ${strM.brier.toFixed(4)} | ${strM.logloss.toFixed(4)}`)
  console.log(`Optimiertes Power Ranking (${fmtW(best.weights)}) | ${(bestM.accuracy * 100).toFixed(1)}%    | ${bestM.brier.toFixed(4)} | ${bestM.logloss.toFixed(4)}`)
  console.log(`Referenz reines ELO (Vorlauf-Backtest)       | 60.6%    | 0.2322 | 0.6566`)

  fs.writeFileSync(path.join(__dirname, 'backtest-power-ranking-result.json'), JSON.stringify({
    baseline: { weights: baselineWeights, cal: { a: baselineCal.a, homeBonus: baselineCal.homeBonus }, metrics: { core: baseM, corona: metricsFor(baselineResults, baselineCal.a, baselineCal.homeBonus, corona), total: metricsFor(baselineResults, baselineCal.a, baselineCal.homeBonus, total) } },
    strengthOnly: { weights: strengthOnly, cal: { a: strengthOnlyCal.a, homeBonus: strengthOnlyCal.homeBonus }, metrics: { core: strM } },
    best: { weights: best.weights, cal: { a: best.cal.a, homeBonus: best.cal.homeBonus }, metrics: { core: bestM, corona: metricsFor(best.results, best.cal.a, best.cal.homeBonus, corona), total: metricsFor(best.results, best.cal.a, best.cal.homeBonus, total) } },
    top10: ranked.slice(0, 10).map((c) => ({ weights: c.weights, cal: { a: c.cal.a, homeBonus: c.cal.homeBonus }, metrics: c.cal.m })),
    plateauSize: plateau.length,
  }, null, 2))
  console.log('\nDetails gespeichert: server/scripts/backtest-power-ranking-result.json')
}

main()
