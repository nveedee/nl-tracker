// ---------------------------------------------------------------------------
// Backtest: liefert direkte Head-to-Head-Historie (Team A vs. Team B) einen
// eigenständigen Prognosewert über das bestehende Referenzmodell hinaus?
//
// Referenzmodell (UNVERÄNDERT, exakt wie in src/elo.js / src/playoffSim.js /
// src/powerRankings.js repliziert, hier nur zu Analysezwecken dupliziert):
//   - ELO: K=16 (Tiers), homeAdv=65, goalDiffFactor=0.7, OT 0.70/0.30,
//     SO 0.55/0.45, Saisonregression 25%
//   - SOG-zugelassen-Faktor: weight=0.15, minGamesFullConfidence=10,
//     maxZScore=2.5, 400/ln(10)-Skalierung auf ELO-Punkte
//
// Modelle:
//   A) ELO
//   B) ELO + SOG-Allowed        (= aktuelles Produktiv-Referenzmodell)
//   C) ELO + H2H
//   D) ELO + SOG-Allowed + H2H
//
// H2H-Feature-Kandidaten (alle strikt leak-frei: nur Duelle VOR dem
// jeweiligen Spiel, bezogen auf die konkrete Paarung Team A vs. Team B):
//   - Siegquote (letzte 3/5/10, alle gleich gewichtet, exponentiell
//     abnehmend gewichtet)
//   - Tordifferenz/Spiel (dieselben Fenster)
//   - Punkte/Spiel, zentriert (dieselben Fenster)
//   - Heim/Auswärts-H2H (nur Duelle, in denen das Heimteam von heute auch
//     damals Heimteam war)
//   - H2H-vs-ELO-Mismatch: wie stark wich das TATSÄCHLICHE H2H-Ergebnis von
//     der ELO+SOG-Erwartung ZUM JEWEILIGEN ZEITPUNKT ab (wichtigstes Feature)
// Jedes Feature wird zusätzlich mit mehreren Shrinkage-Stärken (Richtung 0)
// getestet, um Overfitting bei wenigen Duellen zu verhindern.
//
// Read-only: verändert weder src/elo.js, src/powerRankings.js, src/
// playoffSim.js noch die historischen Rohdaten noch db.json/seed.json.
//
// Aufruf: node server/scripts/backtest-h2h.js
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

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

function loadGames() {
  const games = []
  for (const f of SEASON_FILES) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8'))
    for (const g of raw.games) {
      const sog = (g.teamStats || {})['SOG Total'] || {}
      games.push({
        season: g.season, corona: CORONA_SEASONS.has(g.season),
        dt: g.startDateTime || g.date, date: g.date,
        homeId: g.homeTeam.sihfId, awayId: g.awayTeam.sihfId,
        homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision,
        sogHome: num(sog.home), sogAway: num(sog.away),
      })
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  games.forEach((g, i) => { g.__idx = i })
  return games
}

// ============================================================================
// ELO (unverändert, Produktiv-Parameter aus src/elo.js)
// ============================================================================

const ELO = {
  start: 1500, baseK: 16, homeAdv: 65, goalDiffFactor: 0.7, seasonRegression: 0.25,
  rw: { regulationWin: 1.0, regulationLoss: 0.0, otWin: 0.70, otLoss: 0.30, soWin: 0.55, soLoss: 0.45 },
  kTiers: [
    { m: 5, r: 32 / 24 }, { m: 15, r: 28 / 24 }, { m: 30, r: 24 / 24 },
    { m: 50, r: 20 / 24 }, { m: Infinity, r: 16 / 24 },
  ],
}
function eloK(gp) { for (const t of ELO.kTiers) if (gp <= t.m) return ELO.baseK * t.r; return ELO.baseK * ELO.kTiers.at(-1).r }
function goalMult(d) { if (d === 0) return 1; return 1 + ELO.goalDiffFactor * (Math.log(d + 1) - 1) }
function eloResultScore(homeWon, decision) {
  if (decision === 'SO') return homeWon ? ELO.rw.soWin : ELO.rw.soLoss
  if (decision === 'OT') return homeWon ? ELO.rw.otWin : ELO.rw.otLoss
  return homeWon ? ELO.rw.regulationWin : ELO.rw.regulationLoss
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
    const hw = g.homeGoals > g.awayGoals
    const expH = 1 / (1 + Math.pow(10, (ra - (rh + ELO.homeAdv)) / 400))
    const gm = goalMult(Math.abs(g.homeGoals - g.awayGoals))
    const sH = eloResultScore(hw, g.decision)
    const kH = eloK(gpH), kA = eloK(gpA)
    ratings.set(g.homeId, rh + kH * gm * (sH - expH))
    ratings.set(g.awayId, ra + kA * gm * ((1 - sH) - (1 - expH)))
    gp.set(g.homeId, gpH + 1); gp.set(g.awayId, gpA + 1)
  }
  return snaps
}

// ============================================================================
// SOG-zugelassen-Adjustierung (unverändert, Produktiv-Parameter)
// ============================================================================

const SOG_CFG = { weight: 0.15, minGamesFullConfidence: 10, maxZScore: 2.5 }
const LOGIT_TO_ELO = 400 / Math.LN10

function groupBySeason(games) {
  const bySeason = new Map()
  for (const g of games) {
    if (!bySeason.has(g.season)) bySeason.set(g.season, { games: [], teams: new Set() })
    const e = bySeason.get(g.season)
    e.games.push(g); e.teams.add(g.homeId); e.teams.add(g.awayId)
  }
  return bySeason
}

function computeSogAdjSnapshots(bySeason, totalGames) {
  const adj = new Array(totalGames)
  for (const [, entry] of bySeason) {
    const teamIds = [...entry.teams]
    const stat = new Map()
    teamIds.forEach((id) => stat.set(id, { gp: 0, sogAgainst: 0 }))
    for (const g of entry.games) {
      const withData = teamIds.map((id) => ({ id, s: stat.get(id) })).filter(({ s }) => s.gp > 0).map(({ id, s }) => ({ id, perGame: s.sogAgainst / s.gp, gp: s.gp }))
      let sogAdjMap = {}
      teamIds.forEach((id) => { sogAdjMap[id] = 0 })
      if (withData.length >= 2) {
        const mean = withData.reduce((s, x) => s + x.perGame, 0) / withData.length
        const variance = withData.reduce((s, x) => s + (x.perGame - mean) ** 2, 0) / withData.length
        const std = Math.sqrt(variance)
        if (std > 0) {
          for (const x of withData) {
            const rawZ = (mean - x.perGame) / std
            const z = Math.max(-SOG_CFG.maxZScore, Math.min(SOG_CFG.maxZScore, rawZ))
            const confidence = Math.min(1, x.gp / SOG_CFG.minGamesFullConfidence)
            sogAdjMap[x.id] = SOG_CFG.weight * z * confidence * LOGIT_TO_ELO
          }
        }
      }
      adj[g.__idx] = { home: sogAdjMap[g.homeId] ?? 0, away: sogAdjMap[g.awayId] ?? 0 }

      const H = stat.get(g.homeId), A = stat.get(g.awayId)
      H.gp++; A.gp++
      H.sogAgainst += g.sogAway; A.sogAgainst += g.sogHome
    }
  }
  return adj
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)) }

// ============================================================================
// H2H-Historie (leak-frei, paarungsspezifisch) + Feature-Extraktion
// ============================================================================

const WINDOWS = [
  { key: 'last3', type: 'lastN', n: 3 },
  { key: 'last5', type: 'lastN', n: 5 },
  { key: 'last10', type: 'lastN', n: 10 },
  { key: 'allEqual', type: 'decay', decay: 1.0 },
  { key: 'decay85', type: 'decay', decay: 0.85 },
  { key: 'decay70', type: 'decay', decay: 0.7 },
]
const SHRINK_K = [0, 3, 6, 10, 15]

// Orientiert einen vergangenen Duell-Eintrag auf Team A (heutiges Heimteam).
function orientMeeting(m, A) {
  const aWasHome = m.homeId === A
  const homeWon = m.homeGoals > m.awayGoals
  const scoreHome = eloResultScore(homeWon, m.decision) // Partial-Credit wie ELO-Training
  const scoreForA = aWasHome ? scoreHome : (1 - scoreHome)
  const goalDiffForA = aWasHome ? (m.homeGoals - m.awayGoals) : (m.awayGoals - m.homeGoals)
  const wonForA = aWasHome ? (m.homeGoals > m.awayGoals ? 1 : 0) : (m.awayGoals > m.homeGoals ? 1 : 0)
  const ptsHomeNL = homeWon ? (m.decision === 'REG' ? 3 : 2) : (m.decision === 'REG' ? 0 : 1)
  const ptsForA = aWasHome ? ptsHomeNL : (3 - ptsHomeNL)
  const pForA = aWasHome ? m.pHomeAtTime : (1 - m.pHomeAtTime)
  const surpriseForA = scoreForA - pForA
  return { won01: wonForA, goalDiff: goalDiffForA, pts: 2 * ptsForA - 3, surprise: surpriseForA, sameVenue: aWasHome }
}

function windowedMean(list, key, windowSpec) {
  if (list.length === 0) return { mean: 0, n: 0 }
  if (windowSpec.type === 'lastN') {
    const sub = list.slice(-windowSpec.n)
    const n = sub.length
    return { mean: n > 0 ? sub.reduce((s, x) => s + x[key], 0) / n : 0, n }
  }
  let wsum = 0, vsum = 0
  for (let i = 0; i < list.length; i++) {
    const age = list.length - 1 - i
    const w = Math.pow(windowSpec.decay, age)
    wsum += w; vsum += w * list[i][key]
  }
  return { mean: wsum > 0 ? vsum / wsum : 0, n: list.length }
}

function shrink(mean, n, k) { return k === 0 ? mean : mean * (n / (n + k)) }

// Baut für jedes Spiel eine flache Feature-Zeile: alle (Feature x Fenster x
// Shrinkage)-Varianten + Referenz-Logits (A: reines ELO, B: ELO+SOG).
function buildFeatureRows(games, eloSnapshots, sogAdjSnapshots) {
  const rows = new Array(games.length)
  const pairHistory = new Map() // pairKey -> [{homeId,awayId,homeGoals,awayGoals,decision,pHomeAtTime}]

  for (const g of games) {
    const elo = eloSnapshots[g.__idx], sogAdj = sogAdjSnapshots[g.__idx]
    const refLogitA = (elo.home + ELO.homeAdv - elo.away) * Math.LN10 / 400
    const refLogitB = ((elo.home + sogAdj.home) + ELO.homeAdv - (elo.away + sogAdj.away)) * Math.LN10 / 400

    const pairKey = [g.homeId, g.awayId].slice().sort().join('|')
    const hist = pairHistory.get(pairKey) || []
    const oriented = hist.map((m) => orientMeeting(m, g.homeId))
    const sameVenueOnly = oriented.filter((x) => x.sameVenue)

    const row = {
      season: g.season, corona: g.corona, homeWon: g.homeGoals > g.awayGoals,
      refLogitA, refLogitB, h2hCount: oriented.length,
    }

    for (const w of WINDOWS) {
      for (const featKey of ['won01', 'goalDiff', 'pts', 'surprise']) {
        const { mean, n } = windowedMean(oriented, featKey, w)
        const centered = featKey === 'won01' ? mean - 0.5 : mean
        for (const k of SHRINK_K) {
          row[`${featKey}__${w.key}__k${k}`] = shrink(centered, n, k)
        }
      }
    }
    // Heim/Auswärts-H2H: nur Duelle mit gleicher Heim/Auswärts-Konstellation wie heute
    {
      const n = sameVenueOnly.length
      const mean = n > 0 ? sameVenueOnly.reduce((s, x) => s + x.won01, 0) / n - 0.5 : 0
      for (const k of SHRINK_K) row[`homeAway__k${k}`] = shrink(mean, n, k)
    }

    rows[g.__idx] = row

    hist.push({ homeId: g.homeId, awayId: g.awayId, homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision, pHomeAtTime: sigmoid(refLogitB) })
    pairHistory.set(pairKey, hist)
  }
  return rows
}

// ============================================================================
// Metriken + Kalibrierung
// ============================================================================

const isCore = (r) => !r.corona
const isCorona = (r) => r.corona
const isAll = () => true

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

function stdOf(rows, key) {
  const core = rows.filter(isCore)
  const mean = core.reduce((s, r) => s + r[key], 0) / core.length
  const variance = core.reduce((s, r) => s + (r[key] - mean) ** 2, 0) / core.length
  return Math.sqrt(variance) || 1
}

// Baseline-Kalibrierung (nur Referenz-Logit, kein H2H-Term): g,c-Grid
const G_GRID = [0.7, 0.85, 1.0, 1.15, 1.3]
const C_GRID = [-0.3, -0.15, 0, 0.15, 0.3]
function fitBaseline(rows, baseLogitKey) {
  let best = null
  for (const g of G_GRID) for (const c of C_GRID) {
    const predict = (r) => sigmoid(g * r[baseLogitKey] + c)
    const m = metricsFor(rows, predict, isCore)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { g, c, m, score }
  }
  return best
}

// H2H-Term-Kalibrierung: g fix auf dem Baseline-Optimum, nur h/c neu gefittet
// (isoliert den Grenznutzen des H2H-Terms fair gegenüber der bereits
// kalibrierten Referenz).
const H_GRID = [-2, -1.5, -1, -0.6, -0.3, -0.15, 0, 0.15, 0.3, 0.6, 1, 1.5, 2]
function fitWithFeature(rows, baseLogitKey, baseG, featureKey, std) {
  let best = null
  for (const h of H_GRID) for (const c of C_GRID) {
    const predict = (r) => sigmoid(baseG * r[baseLogitKey] + h * (r[featureKey] / std) + c)
    const m = metricsFor(rows, predict, isCore)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { h, c, m, score }
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
  const bySeason = groupBySeason(games)
  const sogAdjSnapshots = computeSogAdjSnapshots(bySeason, games.length)
  const rows = buildFeatureRows(games, eloSnapshots, sogAdjSnapshots)

  console.log(`Geladen: ${rows.length} Spiele, ${bySeason.size} Saisons (Core ohne Corona: ${rows.filter(isCore).length})`)

  // --- Baselines A (ELO) und B (ELO+SOG) ---
  const baseA = fitBaseline(rows, 'refLogitA')
  const baseB = fitBaseline(rows, 'refLogitB')
  console.log('\n=== BASELINE A: ELO ===')
  console.log(`g=${baseA.g} c=${baseA.c}  Core: ${fmt(baseA.m)}`)
  console.log('=== BASELINE B: ELO + SOG-Allowed (aktuelles Referenzmodell) ===')
  console.log(`g=${baseB.g} c=${baseB.c}  Core: ${fmt(baseB.m)}`)

  // --- Alle H2H-Feature-Varianten x Baseline A/B durchtesten ---
  const featureKeys = []
  for (const w of WINDOWS) for (const f of ['won01', 'goalDiff', 'pts', 'surprise']) for (const k of SHRINK_K) featureKeys.push(`${f}__${w.key}__k${k}`)
  for (const k of SHRINK_K) featureKeys.push(`homeAway__k${k}`)

  console.log(`\n=== GRID SEARCH: ${featureKeys.length} H2H-Feature-Varianten × 2 Baselines ===`)
  const t0 = Date.now()
  const resultsC = [] // ELO + H2H
  const resultsD = [] // ELO + SOG + H2H
  for (const fk of featureKeys) {
    const std = stdOf(rows, fk)
    const fitC = fitWithFeature(rows, 'refLogitA', baseA.g, fk, std)
    const fitD = fitWithFeature(rows, 'refLogitB', baseB.g, fk, std)
    resultsC.push({ feature: fk, std, fit: fitC })
    resultsD.push({ feature: fk, std, fit: fitD })
  }
  console.log(`Getestet in ${Date.now() - t0}ms`)

  resultsC.sort((a, b) => a.fit.score - b.fit.score)
  resultsD.sort((a, b) => a.fit.score - b.fit.score)

  console.log('\n=== TOP 10 H2H-FEATURES für MODELL C (ELO + H2H) ===')
  for (let i = 0; i < 10; i++) {
    const r = resultsC[i]
    const d = r.fit.m.logloss - baseA.m.logloss
    console.log(`#${i + 1} ${r.feature.padEnd(24)} h=${r.fit.h.toFixed(2).padStart(5)}  ${fmt(r.fit.m)}  ΔLogLoss=${d >= 0 ? '+' : ''}${d.toFixed(4)}`)
  }
  console.log('\n=== TOP 10 H2H-FEATURES für MODELL D (ELO + SOG + H2H) ===')
  for (let i = 0; i < 10; i++) {
    const r = resultsD[i]
    const d = r.fit.m.logloss - baseB.m.logloss
    console.log(`#${i + 1} ${r.feature.padEnd(24)} h=${r.fit.h.toFixed(2).padStart(5)}  ${fmt(r.fit.m)}  ΔLogLoss=${d >= 0 ? '+' : ''}${d.toFixed(4)}`)
  }

  // --- Bestes Feature pro Feature-Typ (Übersicht) ---
  console.log('\n=== BESTES FENSTER/SHRINKAGE JE FEATURE-TYP (Modell D, ELO+SOG+H2H) ===')
  for (const featType of ['won01', 'goalDiff', 'pts', 'surprise', 'homeAway']) {
    const best = resultsD.filter((r) => r.feature.startsWith(featType + '__') || r.feature.startsWith(featType)).sort((a, b) => a.fit.score - b.fit.score)[0]
    console.log(`  ${featType.padEnd(10)} -> ${best.feature.padEnd(24)} h=${best.fit.h.toFixed(2)}  ${fmt(best.fit.m)}`)
  }

  // --- Bestkandidat im Detail: Stabilität pro Saison ---
  const bestD = resultsD[0]
  const bestC = resultsC[0]
  console.log(`\n=== STABILITÄT: bestes Modell-D-Feature (${bestD.feature}) pro Saison ===`)
  const predictBestD = (r) => sigmoid(baseB.g * r.refLogitB + bestD.fit.h * (r[bestD.feature] / bestD.std) + bestD.fit.c)
  const predictBaseB = (r) => sigmoid(baseB.g * r.refLogitB + baseB.c)
  const seasons = [...new Set(rows.map((r) => r.season))].sort()
  let improvedSeasons = 0, coreSeasonCount = 0
  console.log('Saison       | LogLoss Basis(B) | LogLoss +H2H | Δ')
  for (const s of seasons) {
    const seasonRows = rows.filter((r) => r.season === s)
    const mB = metricsFor(seasonRows, predictBaseB, isAll)
    const mD = metricsFor(seasonRows, predictBestD, isAll)
    const d = mD.logloss - mB.logloss
    const corona = CORONA_SEASONS.has(s)
    if (!corona) { coreSeasonCount++; if (d < 0) improvedSeasons++ }
    console.log(`${s}${corona ? ' [CORONA]' : '         '} | ${mB.logloss.toFixed(4)}          | ${mD.logloss.toFixed(4)}       | ${d >= 0 ? '+' : ''}${d.toFixed(4)}`)
  }
  console.log(`\nVerbesserung in ${improvedSeasons}/${coreSeasonCount} Nicht-Corona-Saisons.`)

  // --- Sensitivität um das Optimum (Shrinkage/Fenster) ---
  console.log(`\n=== SENSITIVITÄT: gleiches Feature (${bestD.feature.split('__')[0]}), andere Fenster/Shrinkage (Modell D) ===`)
  const featBase = bestD.feature.split('__')[0]
  const variantsOfType = resultsD.filter((r) => r.feature.startsWith(featBase + '__') || r.feature === featBase).sort((a, b) => a.feature.localeCompare(b.feature))
  for (const v of variantsOfType) console.log(`  ${v.feature.padEnd(24)} h=${v.fit.h.toFixed(2).padStart(5)}  logloss=${v.fit.m.logloss.toFixed(4)} brier=${v.fit.m.brier.toFixed(4)}`)

  // --- Vergleichstabelle A/B/C/D (Core) ---
  console.log('\n=== VERGLEICH (Core, ohne Corona) ===')
  console.log('Modell                                  | Accuracy | Brier  | LogLoss')
  console.log(`A) ELO                                   | ${(baseA.m.accuracy * 100).toFixed(1)}%    | ${baseA.m.brier.toFixed(4)} | ${baseA.m.logloss.toFixed(4)}`)
  console.log(`B) ELO + SOG-Allowed                     | ${(baseB.m.accuracy * 100).toFixed(1)}%    | ${baseB.m.brier.toFixed(4)} | ${baseB.m.logloss.toFixed(4)}`)
  console.log(`C) ELO + H2H (${bestC.feature})${' '.repeat(Math.max(0, 15 - bestC.feature.length))} | ${(bestC.fit.m.accuracy * 100).toFixed(1)}%    | ${bestC.fit.m.brier.toFixed(4)} | ${bestC.fit.m.logloss.toFixed(4)}`)
  console.log(`D) ELO + SOG + H2H (${bestD.feature})${' '.repeat(Math.max(0, 8 - bestD.feature.length))} | ${(bestD.fit.m.accuracy * 100).toFixed(1)}%    | ${bestD.fit.m.brier.toFixed(4)} | ${bestD.fit.m.logloss.toFixed(4)}`)

  console.log('\nGesamt (alle 9 Saisons inkl. Corona) und Corona separat:')
  console.log('B) ELO+SOG    Gesamt:', fmt(metricsFor(rows, predictBaseB, isAll)), ' | Corona:', fmt(metricsFor(rows, predictBaseB, isCorona)))
  console.log('D) ELO+SOG+H2H Gesamt:', fmt(metricsFor(rows, predictBestD, isAll)), ' | Corona:', fmt(metricsFor(rows, predictBestD, isCorona)))

  fs.writeFileSync(path.join(__dirname, 'backtest-h2h-result.json'), JSON.stringify({
    baseA: { g: baseA.g, c: baseA.c, m: baseA.m },
    baseB: { g: baseB.g, c: baseB.c, m: baseB.m },
    top10C: resultsC.slice(0, 10).map((r) => ({ feature: r.feature, std: r.std, h: r.fit.h, c: r.fit.c, m: r.fit.m })),
    top10D: resultsD.slice(0, 10).map((r) => ({ feature: r.feature, std: r.std, h: r.fit.h, c: r.fit.c, m: r.fit.m })),
    stability: { improvedSeasons, coreSeasonCount },
  }, null, 2))
  console.log('\nDetails gespeichert: server/scripts/backtest-h2h-result.json')
}

main()
