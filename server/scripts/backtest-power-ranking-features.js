// ---------------------------------------------------------------------------
// Analyse: Können gegnerbereinigte Offensive/Defensive-Kennzahlen (Tore, SOG,
// PP/PK, Heim/Auswärts-Splits) zusätzlich zu ELO einen messbaren
// Prognosewert liefern?
//
// Hintergrund: Der Power-Ranking-Backtest (server/scripts/backtest-power-ranking.js)
// zeigte, dass die AKTUELLEN Offensive/Defensive/Form-Komponenten (einfache
// Saison-Durchschnitte, nicht gegnerbereinigt) leak-frei keinen Mehrwert
// gegenüber ELO liefern. Diese Analyse testet, ob BESSERE, gegnerbereinigte
// Kennzahlen das ändern.
//
// Read-only: verändert weder historische Daten noch src/elo.js noch
// src/powerRankings.js noch playoffSim.js. Reines Analyse-Tool.
//
// Methodik (identisch zum ELO-/Power-Ranking-Backtest):
//   - Walk-forward, chronologisch, leak-frei: jede Kennzahl wird für ein
//     Spiel ausschliesslich aus Daten VOR diesem Spiel berechnet.
//   - "Gegnerbereinigt" heisst: z.B. wird die Offensive eines Teams nicht am
//     Liga-Durchschnitt gemessen, sondern an der TATSÄCHLICHEN
//     Gegentore-Quote JEDES EINZELNEN bisherigen Gegners (Stand VOR dem
//     jeweiligen Spiel gegen diesen Gegner) - vollständig leak-frei, weil
//     jeder Vergangenheitswert nur Vergangenheitsdaten verwendet.
//   - Modell: logit(p) = g * eloLogit + h * featureDiff_standardisiert + c
//     ELO-Anteil (g, eloLogit) bleibt das Referenzmodell; h prüft, ob eine
//     Kennzahl ZUSÄTZLICH etwas beiträgt. g/h/c werden je Kennzahl separat
//     kalibriert (Core-Saisons, ohne Corona), damit der Vergleich fair ist.
//
// Aufruf: node server/scripts/backtest-power-ranking-features.js
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
// 1. Daten laden (inkl. teamStats für SOG/PP/PK)
// ============================================================================

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

function loadGames() {
  const games = []
  for (const f of SEASON_FILES) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8'))
    for (const g of raw.games) {
      const ts = g.teamStats || {}
      const sog = ts['SOG Total'] || {}
      const ppOp = ts['PP OP'] || {}, ppg = ts['PPG'] || {}
      const pkSi = ts['PK SI'] || {}, pkGa = ts['PK GA'] || {}
      games.push({
        season: g.season,
        corona: CORONA_SEASONS.has(g.season),
        date: g.date,
        dt: g.startDateTime || g.date,
        homeId: g.homeTeam.sihfId,
        awayId: g.awayTeam.sihfId,
        homeGoals: g.homeGoals,
        awayGoals: g.awayGoals,
        decision: g.decision,
        sogHome: num(sog.home), sogAway: num(sog.away),
        ppOpHome: num(ppOp.home), ppgHome: num(ppg.home),
        ppOpAway: num(ppOp.away), ppgAway: num(ppg.away),
        pkSiHome: num(pkSi.home), pkGaHome: num(pkGa.home),
        pkSiAway: num(pkSi.away), pkGaAway: num(pkGa.away),
      })
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  games.forEach((g, i) => { g.__idx = i })
  return games
}

// ============================================================================
// 2. ELO-Snapshot — identisch zu backtest-power-ranking.js (unveränderte
//    Produktiv-Parameter aus src/elo.js), liefert Rating je Team VOR jedem Spiel
// ============================================================================

const ELO = {
  start: 1500, baseK: 16, homeAdv: 65, goalDiffFactor: 0.7, seasonRegression: 0.25,
  resultWeights: { regulationWin: 1.0, regulationLoss: 0.0, otWin: 0.70, otLoss: 0.30, soWin: 0.55, soLoss: 0.45 },
  kTiers: [
    { maxGames: 5, kRatio: 32 / 24 }, { maxGames: 15, kRatio: 28 / 24 },
    { maxGames: 30, kRatio: 24 / 24 }, { maxGames: 50, kRatio: 20 / 24 },
    { maxGames: Infinity, kRatio: 16 / 24 },
  ],
}
function eloK(gp) { for (const t of ELO.kTiers) if (gp <= t.maxGames) return ELO.baseK * t.kRatio; return ELO.baseK * ELO.kTiers.at(-1).kRatio }
function eloGoalMult(diff) { if (diff === 0) return 1.0; return 1.0 + ELO.goalDiffFactor * (Math.log(diff + 1) - 1) }
function eloResultScore(homeWon, decision) {
  if (decision === 'SO') return homeWon ? ELO.resultWeights.soWin : ELO.resultWeights.soLoss
  if (decision === 'OT') return homeWon ? ELO.resultWeights.otWin : ELO.resultWeights.otLoss
  return homeWon ? ELO.resultWeights.regulationWin : ELO.resultWeights.regulationLoss
}
function computeEloSnapshots(games) {
  const ratings = new Map(), gp = new Map()
  let curSeason = null
  const snaps = new Array(games.length)
  for (const g of games) {
    if (curSeason !== null && g.season !== curSeason) {
      for (const [id, r] of ratings) ratings.set(id, ELO.start + (r - ELO.start) * (1 - ELO.seasonRegression))
    }
    curSeason = g.season
    snaps[g.__idx] = { home: ratings.get(g.homeId) ?? ELO.start, away: ratings.get(g.awayId) ?? ELO.start }
    const rh = snaps[g.__idx].home, ra = snaps[g.__idx].away
    const gpH = gp.get(g.homeId) ?? 0, gpA = gp.get(g.awayId) ?? 0
    const homeWon = g.homeGoals > g.awayGoals
    const expH = 1 / (1 + Math.pow(10, (ra - (rh + ELO.homeAdv)) / 400))
    const goalMult = eloGoalMult(Math.abs(g.homeGoals - g.awayGoals))
    const scoreH = eloResultScore(homeWon, g.decision)
    const kH = eloK(gpH), kA = eloK(gpA)
    ratings.set(g.homeId, rh + kH * goalMult * (scoreH - expH))
    ratings.set(g.awayId, ra + kA * goalMult * ((1 - scoreH) - (1 - expH)))
    gp.set(g.homeId, gpH + 1); gp.set(g.awayId, gpA + 1)
  }
  return snaps
}
// logit, sodass sigmoid(eloLogit) == ELO-Modell-eigene Wahrscheinlichkeit
function eloLogitOf(snap) { return (snap.home + ELO.homeAdv - snap.away) * Math.LN10 / 400 }

// ============================================================================
// 3. Gegnerbereinigte Feature-Engine (walk-forward, leak-frei)
// ============================================================================

function groupBySeasonWithActiveTeams(games) {
  const bySeason = new Map()
  for (const g of games) {
    if (!bySeason.has(g.season)) bySeason.set(g.season, { games: [], teams: new Set() })
    const e = bySeason.get(g.season)
    e.games.push(g); e.teams.add(g.homeId); e.teams.add(g.awayId)
  }
  return bySeason
}

function newTeamState() {
  return {
    gp: 0, gf: 0, ga: 0,
    homeGp: 0, homeGf: 0, homeGa: 0,
    awayGp: 0, awayGf: 0, awayGa: 0,
    sogFor: 0, sogAgainst: 0,
    ppOp: 0, ppg: 0, pkSi: 0, pkGa: 0,
    recentAdjOff: [], recentAdjDef: [],
  }
}
function avg(arr) { return arr.length === 0 ? null : arr.reduce((s, x) => s + x, 0) / arr.length }

// Liefert für jedes Spiel (chronologisch) einen Datensatz mit allen
// Rohdifferenzen (home - away, bereits so orientiert dass "höher = besser für Heimteam")
function computeFeatureSeries(bySeason, eloSnapshots) {
  const rows = []

  for (const [, entry] of bySeason) {
    const teamIds = [...entry.teams]
    const stat = new Map()
    teamIds.forEach((id) => stat.set(id, newTeamState()))

    for (const g of entry.games) {
      const H = stat.get(g.homeId), A = stat.get(g.awayId)
      const elo = eloSnapshots[g.__idx]

      // Liga-Fallbacks (Stand vor diesem Spiel)
      let lgGF = 0, lgGA = 0, lgGP = 0, lgPPOp = 0, lgPPG = 0, lgPKSi = 0, lgPKGa = 0
      for (const id of teamIds) {
        const s = stat.get(id)
        lgGF += s.gf; lgGA += s.ga; lgGP += s.gp
        lgPPOp += s.ppOp; lgPPG += s.ppg; lgPKSi += s.pkSi; lgPKGa += s.pkGa
      }
      const leagueGPG = lgGF / Math.max(1, lgGP)
      const leagueGAG = lgGA / Math.max(1, lgGP)
      const leaguePPPct = lgPPOp >= 20 ? lgPPG / lgPPOp : 0.18
      const leaguePKPct = lgPKSi >= 20 ? 1 - lgPKGa / lgPKSi : 0.82

      // --- F1/F2: gegnerbereinigte Offensive/Defensive (rollierend, letzte 10) ---
      const adjOffH = avg(H.recentAdjOff), adjOffA = avg(A.recentAdjOff)
      const adjDefH = avg(H.recentAdjDef), adjDefA = avg(A.recentAdjDef) // niedriger = besser
      const f1_adjOffenseDiff = (adjOffH ?? 1) - (adjOffA ?? 1)
      const f2_adjDefenseDiff = (adjDefA ?? 1) - (adjDefH ?? 1) // invertiert: höher = Heimteam-Defense besser

      // --- F3: SOG/Schussdifferenz (Saison-Durchschnitt) ---
      const sogForH = H.gp > 0 ? H.sogFor / H.gp : null
      const sogForA = A.gp > 0 ? A.sogFor / A.gp : null
      const sogAgH = H.gp > 0 ? H.sogAgainst / H.gp : null
      const sogAgA = A.gp > 0 ? A.sogAgainst / A.gp : null
      const f3a_sogForDiff = (sogForH ?? 30) - (sogForA ?? 30)
      const f3b_sogAgainstDiff = (sogAgA ?? 30) - (sogAgH ?? 30) // höher = Heimteam lässt weniger zu
      const shotDiffH = H.gp > 0 ? (H.sogFor - H.sogAgainst) / H.gp : 0
      const shotDiffA = A.gp > 0 ? (A.sogFor - A.sogAgainst) / A.gp : 0
      const f3c_shotDiffDiff = shotDiffH - shotDiffA

      // --- F4/F5: PP%/PK% (Mindeststichprobe 10 Gelegenheiten, sonst Liga-Fallback) ---
      const ppPctH = H.ppOp >= 10 ? H.ppg / H.ppOp : leaguePPPct
      const ppPctA = A.ppOp >= 10 ? A.ppg / A.ppOp : leaguePPPct
      const pkPctH = H.pkSi >= 10 ? 1 - H.pkGa / H.pkSi : leaguePKPct
      const pkPctA = A.pkSi >= 10 ? 1 - A.pkGa / A.pkSi : leaguePKPct
      const f4_ppDiff = ppPctH - ppPctA
      const f5_pkDiff = pkPctH - pkPctA
      const f6_specialTeamsDiff = f4_ppDiff + f5_pkDiff

      // --- F7: Heim/Auswärts-Split (Heimteam-Heimform vs. Auswärtsteam-Auswärtsform) ---
      const homeSplitH = H.homeGp > 0 ? (H.homeGf - H.homeGa) / H.homeGp : (H.gp > 0 ? (H.gf - H.ga) / H.gp : 0)
      const awaySplitA = A.awayGp > 0 ? (A.awayGf - A.awayGa) / A.awayGp : (A.gp > 0 ? (A.gf - A.ga) / A.gp : 0)
      const f7_homeAwaySplitDiff = homeSplitH - awaySplitA

      rows.push({
        season: g.season, corona: g.corona, homeWon: g.homeGoals > g.awayGoals,
        eloLogit: eloLogitOf(elo),
        f1_adjOffenseDiff, f2_adjDefenseDiff,
        f3a_sogForDiff, f3b_sogAgainstDiff, f3c_shotDiffDiff,
        f4_ppDiff, f5_pkDiff, f6_specialTeamsDiff,
        f7_homeAwaySplitDiff,
        hasAdjHistory: H.recentAdjOff.length > 0 && A.recentAdjOff.length > 0,
      })

      // === UPDATE (nach der Prognose) ===
      const oppGAG_forH = A.gp > 0 ? A.ga / A.gp : leagueGAG
      const oppGPG_forH = A.gp > 0 ? A.gf / A.gp : leagueGPG
      const oppGAG_forA = H.gp > 0 ? H.ga / H.gp : leagueGAG
      const oppGPG_forA = H.gp > 0 ? H.gf / H.gp : leagueGPG
      const adjOffValH = g.homeGoals / Math.max(0.5, oppGAG_forH)
      const adjDefValH = g.awayGoals / Math.max(0.5, oppGPG_forH)
      const adjOffValA = g.awayGoals / Math.max(0.5, oppGAG_forA)
      const adjDefValA = g.homeGoals / Math.max(0.5, oppGPG_forA)

      H.recentAdjOff.push(adjOffValH); if (H.recentAdjOff.length > 10) H.recentAdjOff.shift()
      H.recentAdjDef.push(adjDefValH); if (H.recentAdjDef.length > 10) H.recentAdjDef.shift()
      A.recentAdjOff.push(adjOffValA); if (A.recentAdjOff.length > 10) A.recentAdjOff.shift()
      A.recentAdjDef.push(adjDefValA); if (A.recentAdjDef.length > 10) A.recentAdjDef.shift()

      H.gp++; A.gp++
      H.gf += g.homeGoals; H.ga += g.awayGoals
      A.gf += g.awayGoals; A.ga += g.homeGoals
      H.homeGp++; H.homeGf += g.homeGoals; H.homeGa += g.awayGoals
      A.awayGp++; A.awayGf += g.awayGoals; A.awayGa += g.homeGoals
      H.sogFor += g.sogHome; H.sogAgainst += g.sogAway
      A.sogFor += g.sogAway; A.sogAgainst += g.sogHome
      H.ppOp += g.ppOpHome; H.ppg += g.ppgHome; H.pkSi += g.pkSiHome; H.pkGa += g.pkGaHome
      A.ppOp += g.ppOpAway; A.ppg += g.ppgAway; A.pkSi += g.pkSiAway; A.pkGa += g.pkGaAway
    }
  }
  return rows
}

// ============================================================================
// 4. Standardisierung + Kalibrierung + Metriken
// ============================================================================

function stdOf(rows, key) {
  const core = rows.filter((r) => !r.corona)
  const mean = core.reduce((s, r) => s + r[key], 0) / core.length
  const variance = core.reduce((s, r) => s + (r[key] - mean) ** 2, 0) / core.length
  return Math.sqrt(variance) || 1
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)) }

function metricsFor(rows, predictFn, filterFn) {
  let n = 0, correct = 0, brier = 0, logloss = 0
  const EPS = 1e-10
  for (const r of rows) {
    if (!filterFn(r)) continue
    const p = Math.min(1 - EPS, Math.max(EPS, predictFn(r)))
    const y = r.homeWon ? 1 : 0
    n++
    if ((p >= 0.5 ? 1 : 0) === y) correct++
    brier += (p - y) ** 2
    logloss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
  }
  return n === 0 ? null : { n, accuracy: correct / n, brier: brier / n, logloss: logloss / n }
}

const G_GRID = [0.6, 0.8, 1.0, 1.15, 1.3]
const H_GRID = [-2, -1.5, -1, -0.6, -0.3, -0.15, 0, 0.15, 0.3, 0.6, 1, 1.5, 2]
const C_GRID = [-0.3, -0.15, 0, 0.15, 0.3]

const core = (r) => !r.corona
const corona = (r) => r.corona
const total = () => true

// Fittet logit(p) = g*eloLogit + h*stdFeature + c gegen Core-LogLoss+Brier
function fitCombined(rows, featureKey, std) {
  let best = null
  for (const g of G_GRID) {
    for (const h of H_GRID) {
      for (const c of C_GRID) {
        const predict = (r) => sigmoid(g * r.eloLogit + h * (r[featureKey] / std) + c)
        const m = metricsFor(rows, predict, core)
        const score = m.logloss + m.brier
        if (!best || score < best.score) best = { g, h, c, m, score }
      }
    }
  }
  return best
}

// ELO-only Baseline (h fest 0, aber g/c trotzdem kalibriert für fairen Vergleich)
function fitEloOnly(rows) {
  let best = null
  for (const g of G_GRID) {
    for (const c of C_GRID) {
      const predict = (r) => sigmoid(g * r.eloLogit + c)
      const m = metricsFor(rows, predict, core)
      const score = m.logloss + m.brier
      if (!best || score < best.score) best = { g, c, m, score }
    }
  }
  return best
}

// ============================================================================
// MAIN
// ============================================================================

function fmt(m) { return m ? `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}` : 'n/a' }

function main() {
  const games = loadGames()
  const eloSnapshots = computeEloSnapshots(games)
  const bySeason = groupBySeasonWithActiveTeams(games)
  const rows = computeFeatureSeries(bySeason, eloSnapshots)
  console.log(`Geladen: ${rows.length} Spiele, ${bySeason.size} Saisons`)

  const eloOnly = fitEloOnly(rows)
  console.log('\n=== ELO-ONLY REFERENZ ===')
  console.log(`g=${eloOnly.g} c=${eloOnly.c}  Core: ${fmt(eloOnly.m)}`)
  console.log('Corona:', fmt(metricsFor(rows, (r) => sigmoid(eloOnly.g * r.eloLogit + eloOnly.c), corona)))
  console.log('Gesamt:', fmt(metricsFor(rows, (r) => sigmoid(eloOnly.g * r.eloLogit + eloOnly.c), total)))

  const features = [
    ['f1_adjOffenseDiff', 'Gegnerbereinigte Offensive (Tore vs. Gegner-GAG, rolling 10)'],
    ['f2_adjDefenseDiff', 'Gegnerbereinigte Defensive (Gegentore vs. Gegner-GPG, rolling 10)'],
    ['f3a_sogForDiff', 'SOG erzielt/Spiel (Saison)'],
    ['f3b_sogAgainstDiff', 'SOG zugelassen/Spiel (Saison, invertiert)'],
    ['f3c_shotDiffDiff', 'Schussdifferenz/Spiel (Saison)'],
    ['f4_ppDiff', 'PP% (min. 10 Gelegenheiten)'],
    ['f5_pkDiff', 'PK% (min. 10 Gelegenheiten)'],
    ['f6_specialTeamsDiff', 'Special Teams gesamt (PP%+PK%)'],
    ['f7_homeAwaySplitDiff', 'Heim/Auswärts-Split-Tordifferenz'],
  ]

  console.log('\n=== ELO + EINZELNE KENNZAHL (Core, ohne Corona) ===')
  console.log('Kennzahl                                              | g    | h      | ΔBrier   | ΔLogLoss | Brier  | LogLoss | Acc')
  const stds = {}
  const fitted = {}
  for (const [key, label] of features) {
    const std = stdOf(rows, key)
    stds[key] = std
    const fit = fitCombined(rows, key, std)
    fitted[key] = fit
    const dBrier = fit.m.brier - eloOnly.m.brier
    const dLogloss = fit.m.logloss - eloOnly.m.logloss
    console.log(`${label.padEnd(54)} | ${fit.g.toFixed(2).padStart(4)} | ${fit.h.toFixed(2).padStart(6)} | ${dBrier >= 0 ? '+' : ''}${dBrier.toFixed(4)} | ${dLogloss >= 0 ? '+' : ''}${dLogloss.toFixed(4)} | ${fit.m.brier.toFixed(4)} | ${fit.m.logloss.toFixed(4)} | ${(fit.m.accuracy * 100).toFixed(1)}%`)
  }

  // --- Greedy Forward Selection: kombiniere die Kennzahlen, die tatsächlich helfen ---
  console.log('\n=== GREEDY FORWARD SELECTION (kombiniertes Modell) ===')
  const selected = []
  let currentPredict = (r) => sigmoid(eloOnly.g * r.eloLogit + eloOnly.c)
  let currentScore = eloOnly.m.logloss + eloOnly.m.brier
  console.log(`Start (ELO only): logloss=${eloOnly.m.logloss.toFixed(4)} brier=${eloOnly.m.brier.toFixed(4)}`)

  let improved = true
  const remaining = features.map(([key]) => key)
  const chosenCoeffs = { g: eloOnly.g, c: eloOnly.c, terms: [] }

  while (improved && remaining.length > 0) {
    improved = false
    let bestCandidate = null
    for (const key of remaining) {
      const std = stds[key]
      // Re-fit: bereits gewählte Terme fix, neuer Term (h) + g + c neu kalibriert
      let bestForKey = null
      for (const g of G_GRID) {
        for (const h of H_GRID) {
          for (const c of C_GRID) {
            const predict = (r) => {
              let z = g * r.eloLogit + c
              for (const t of chosenCoeffs.terms) z += t.h * (r[t.key] / t.std)
              z += h * (r[key] / std)
              return sigmoid(z)
            }
            const m = metricsFor(rows, predict, core)
            const score = m.logloss + m.brier
            if (!bestForKey || score < bestForKey.score) bestForKey = { g, h, c, m, score, key, std }
          }
        }
      }
      if (!bestCandidate || bestForKey.score < bestCandidate.score) bestCandidate = bestForKey
    }
    const relImprovement = (currentScore - bestCandidate.score) / currentScore
    if (relImprovement > 0.001) { // >0.1% relative Verbesserung nötig
      chosenCoeffs.g = bestCandidate.g
      chosenCoeffs.c = bestCandidate.c
      chosenCoeffs.terms.push({ key: bestCandidate.key, h: bestCandidate.h, std: bestCandidate.std })
      currentScore = bestCandidate.score
      remaining.splice(remaining.indexOf(bestCandidate.key), 1)
      selected.push(bestCandidate.key)
      console.log(`+ ${bestCandidate.key} (h=${bestCandidate.h})  -> logloss=${bestCandidate.m.logloss.toFixed(4)} brier=${bestCandidate.m.brier.toFixed(4)} acc=${(bestCandidate.m.accuracy * 100).toFixed(1)}%  (rel. Verbesserung ${(relImprovement * 100).toFixed(2)}%)`)
      improved = true
    }
  }
  if (selected.length === 0) {
    console.log('Keine Kennzahl verbesserte das Modell um mehr als 0.1% -> ELO-only bleibt bestes Modell.')
  }

  const finalPredict = (r) => {
    let z = chosenCoeffs.g * r.eloLogit + chosenCoeffs.c
    for (const t of chosenCoeffs.terms) z += t.h * (r[t.key] / t.std)
    return sigmoid(z)
  }
  const finalCore = metricsFor(rows, finalPredict, core)
  const finalCorona = metricsFor(rows, finalPredict, corona)
  const finalTotal = metricsFor(rows, finalPredict, total)

  console.log('\n=== VERGLEICH ===')
  console.log('Modell                                   | Accuracy | Brier  | LogLoss')
  console.log(`ELO only                                 | ${(eloOnly.m.accuracy * 100).toFixed(1)}%    | ${eloOnly.m.brier.toFixed(4)} | ${eloOnly.m.logloss.toFixed(4)}`)
  console.log(`ELO + gegnerbereinigte Kennzahlen (${selected.length > 0 ? selected.join('+') : 'keine'}) | ${(finalCore.accuracy * 100).toFixed(1)}%    | ${finalCore.brier.toFixed(4)} | ${finalCore.logloss.toFixed(4)}`)
  console.log('\nCorona-Saisons (final Modell):', fmt(finalCorona))
  console.log('Gesamt (final Modell):        ', fmt(finalTotal))

  fs.writeFileSync(path.join(__dirname, 'backtest-power-ranking-features-result.json'), JSON.stringify({
    eloOnly: { g: eloOnly.g, c: eloOnly.c, metrics: eloOnly.m },
    perFeature: features.map(([key, label]) => ({ key, label, std: stds[key], fit: { g: fitted[key].g, h: fitted[key].h, c: fitted[key].c }, metrics: fitted[key].m })),
    greedySelected: chosenCoeffs,
    finalMetrics: { core: finalCore, corona: finalCorona, total: finalTotal },
  }, null, 2))
  console.log('\nDetails gespeichert: server/scripts/backtest-power-ranking-features-result.json')
}

main()
