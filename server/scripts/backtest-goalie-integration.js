// ---------------------------------------------------------------------------
// Strenger Rekalibrierungs-Backtest der Torhüter-Historie-Komponente vor
// Produktivintegration (Folgeauftrag zu server/scripts/backtest-player-features.js).
//
// WICHTIGER METHODIK-UNTERSCHIED zum vorherigen Backtest: dort wurde als
// Referenzmodell "ELO mit Regression=1.0" (= voller Reset auf 1500 pro
// Saison) verwendet - das entspricht NICHT dem tatsächlichen aktuellen
// Produktivmodell, das seit einer späteren Aufgabe Pre-Season-ELO
// (Regression=0.25, siehe src/elo.js ELO_CONFIG.seasonEndRegression) nutzt.
// Dieser Backtest korrigiert das: Referenzmodell A = ELO(Regression=0.25) +
// SOG-Allowed + Heimvorteil - exakt das, was aktuell produktiv läuft.
//
// AUSSERDEM: echter Train/Test-Split statt Kalibrierung auf der gesamten
// Stichprobe. Der Koeffizient h für die Torhüter-Komponente wird
// AUSSCHLIESSLICH auf den Trainings-Saisons gefittet, danach auf der
// zurückgehaltenen, nie zur Kalibrierung verwendeten Test-Saison ausgewertet.
// Split: Test = 2025/26 (jüngste Nicht-Corona-Saison, vollständig
// ungesehen). Train = alle übrigen Saisons (Corona-Saisons 2019/20+2020/21
// weiterhin nur informativ mitgeführt, nie zur Kalibrierung/Auswahl
// verwendet - identische Konvention wie in allen bisherigen Backtests
// dieses Projekts).
//
// Torhüter-Feature-Formel: 1:1 identisch zu goalie_last2 aus
// backtest-player-features.js (dort bereits validiert) - siehe
// computeGoalieFeatureForTeamSeason() unten, wortgleich übernommen.
//
// READ-ONLY: verändert weder src/elo.js, src/playoffSim.js,
// src/powerRankings.js noch historische Rohdaten noch db.json/seed.json.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'historical')
const OUT_PATH = path.join(__dirname, 'backtest-goalie-integration-result.json')

const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]
const CORONA_SEASONS = new Set(['2019/20', '2020/21'])
const TEST_SEASON = '2025/26'

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)) }

function loadRaw() {
  return SEASON_FILES.map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8')))
}

function parseGame(g) {
  const sog = (g.teamStats || {})['SOG Total'] || {}
  const base = {
    season: g.season, corona: CORONA_SEASONS.has(g.season),
    dt: g.startDateTime || g.date,
    homeId: g.homeTeam.sihfId, awayId: g.awayTeam.sihfId,
    homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision,
    sogHome: num(sog.home), sogAway: num(sog.away),
  }
  const rosterByTeam = { [g.homeTeam.sihfId]: new Map(), [g.awayTeam.sihfId]: new Map() }
  for (const key of Object.keys(g.roster || {})) {
    const r = g.roster[key]
    if (rosterByTeam[r.teamId]) rosterByTeam[r.teamId].set(r.fullName, r)
  }
  const goalieRows = []
  for (const [side, teamId] of [['home', g.homeTeam.sihfId], ['away', g.awayTeam.sihfId]]) {
    for (const p of (g.goalies && g.goalies[side]) || []) {
      const r = rosterByTeam[teamId].get(p.player)
      if (!r) continue
      goalieRows.push({
        id: r.id, teamId, season: g.season,
        saves: num(p.saves), goalsAgainst: num(p.goalsAgainst), shotsAgainst: num(p.shotsAgainst),
        toiSec: typeof p.secondsPlayed === 'string'
          ? (() => { const [m, s] = p.secondsPlayed.split(':').map(Number); return (m || 0) * 60 + (s || 0) })()
          : num(p.secondsPlayed),
      })
    }
  }
  return { base, goalieRows }
}

function seasonOrder(games) { return [...new Set(games.map((g) => g.season))].sort() }

function buildGoalieSeasonStats(allGoalieRows) {
  const m = new Map()
  for (const r of allGoalieRows) {
    if (!m.has(r.id)) m.set(r.id, new Map())
    const bySeason = m.get(r.id)
    if (!bySeason.has(r.season)) bySeason.set(r.season, { teamCounts: new Map(), saves: 0, ga: 0, shotsAgainst: 0, toiSec: 0 })
    const s = bySeason.get(r.season)
    s.saves += r.saves; s.ga += r.goalsAgainst; s.shotsAgainst += r.shotsAgainst; s.toiSec += r.toiSec
    s.teamCounts.set(r.teamId, (s.teamCounts.get(r.teamId) || 0) + 1)
  }
  const out = new Map()
  for (const [id, bySeason] of m) {
    const seasonMap = new Map()
    for (const [season, s] of bySeason) {
      const team = [...s.teamCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      seasonMap.set(season, { teamId: team, svPct: s.shotsAgainst > 0 ? s.saves / s.shotsAgainst : null, toiSec: s.toiSec, shotsAgainst: s.shotsAgainst })
    }
    out.set(id, seasonMap)
  }
  return out
}
function buildGoalieRosterBySeason(allGoalieRows) {
  const m = new Map()
  for (const r of allGoalieRows) {
    if (!m.has(r.season)) m.set(r.season, new Map())
    const bySeason = m.get(r.season)
    if (!bySeason.has(r.teamId)) bySeason.set(r.teamId, new Set())
    bySeason.get(r.teamId).add(r.id)
  }
  return m
}

// Identisch zu backtest-player-features.js::computeGoalieFeatureForTeamSeason
// (2-Jahres-gewichtete SV%-Historie, TOI-gewichtet über mehrere Torhüter,
// Mindest-Einsatzzeit 600s pro Saison-Eintrag gegen Rauschen bei Kurzeinsätzen).
const GOALIE_WEIGHTS_LAST2 = [0.65, 0.35]
function computeGoalieFeature(teamId, targetSeason, seasons, goalieRosterBySeason, goalieSeasonStats, depth = 2, weights = GOALIE_WEIGHTS_LAST2) {
  const targetIdx = seasons.indexOf(targetSeason)
  if (targetIdx < 0 || targetIdx - depth < 0) return null
  const currentGoalieIds = goalieRosterBySeason.get(targetSeason)?.get(teamId)
  if (!currentGoalieIds || currentGoalieIds.size === 0) return null
  let wSum = 0, svSum = 0
  for (const gid of currentGoalieIds) {
    const hist = goalieSeasonStats.get(gid)
    if (!hist) continue
    for (let k = 0; k < depth; k++) {
      const s = hist.get(seasons[targetIdx - 1 - k])
      if (!s || s.svPct == null || s.toiSec < 600) continue
      const w = weights[k] * s.toiSec
      wSum += w; svSum += w * s.svPct
    }
  }
  if (wSum === 0) return null
  return svSum / wSum
}

// ============================================================================
// ELO (Referenzmodell, Regression=0.25 = PRODUKTIVES Pre-Season-ELO, siehe
// src/elo.js ELO_CONFIG.seasonEndRegression) + SOG-Allowed. Formel/Parameter
// wortgleiche Kopie aus src/elo.js / src/powerRankings.js (K-Tiers,
// Heimvorteil, Torunterschied-Dämpfung, OT/SO-Gewichte, SOG-z-Normalisierung
// + Konfidenzrampe) - identisch zu backtest-player-features.js, nur die
// Regression von 1.0 auf 0.25 korrigiert.
// ============================================================================
const ELO = {
  start: 1500, baseK: 16, homeAdv: 65, goalDiffFactor: 0.7,
  rw: { regulationWin: 1.0, regulationLoss: 0.0, otWin: 0.70, otLoss: 0.30, soWin: 0.55, soLoss: 0.45 },
  kTiers: [
    { m: 5, r: 32 / 24 }, { m: 15, r: 28 / 24 }, { m: 30, r: 24 / 24 },
    { m: 50, r: 20 / 24 }, { m: Infinity, r: 16 / 24 },
  ],
  seasonEndRegression: 0.25, // <- produktiver Wert, siehe src/elo.js
}
function eloK(gp) { for (const t of ELO.kTiers) if (gp <= t.m) return ELO.baseK * t.r; return ELO.baseK * ELO.kTiers.at(-1).r }
function goalMult(d) { if (d === 0) return 1; return 1 + ELO.goalDiffFactor * (Math.log(d + 1) - 1) }
function eloResultScore(homeWon, decision) {
  if (decision === 'SO') return homeWon ? ELO.rw.soWin : ELO.rw.soLoss
  if (decision === 'OT') return homeWon ? ELO.rw.otWin : ELO.rw.otLoss
  return homeWon ? ELO.rw.regulationWin : ELO.rw.regulationLoss
}
function computeEloSnapshots(games, regressionFraction) {
  const ratings = new Map(), gp = new Map()
  let curSeason = null
  const snaps = new Array(games.length)
  for (const g of games) {
    if (curSeason !== null && g.season !== curSeason) {
      for (const [id, r] of ratings) ratings.set(id, ELO.start + (r - ELO.start) * (1 - regressionFraction))
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
  return { snaps }
}
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
      const h = stat.get(g.homeId), a = stat.get(g.awayId)
      adj[g.__idx] = { home: computeAdjFromStat(stat, teamIds, g.homeId), away: computeAdjFromStat(stat, teamIds, g.awayId) }
      h.gp++; h.sogAgainst += g.sogAway
      a.gp++; a.sogAgainst += g.sogHome
    }
  }
  return adj
}
function computeAdjFromStat(stat, teamIds, teamId) {
  const withData = teamIds.map((id) => stat.get(id)).filter((s) => s.gp > 0)
  if (withData.length < 2) return 0
  const perGame = withData.map((s) => s.sogAgainst / s.gp)
  const mean = perGame.reduce((a, b) => a + b, 0) / perGame.length
  const variance = perGame.reduce((a, b) => a + (b - mean) ** 2, 0) / perGame.length
  const std = Math.sqrt(variance)
  const s = stat.get(teamId)
  if (s.gp === 0 || std === 0) return 0
  const teamPerGame = s.sogAgainst / s.gp
  const rawZ = (mean - teamPerGame) / std
  const z = Math.max(-SOG_CFG.maxZScore, Math.min(SOG_CFG.maxZScore, rawZ))
  const confidence = Math.min(1, s.gp / SOG_CFG.minGamesFullConfidence)
  return SOG_CFG.weight * z * confidence * LOGIT_TO_ELO
}

// ============================================================================
// Metriken + Kalibrierung (identisch zu den bisherigen Backtests)
// ============================================================================
const isCore = (r) => !r.corona
const inFirst = (frac) => (r) => !r.corona && r.seasonFraction < frac
const inMid = (r) => !r.corona && r.seasonFraction >= 0.30 && r.seasonFraction < 0.70
const inEnd = (r) => !r.corona && r.seasonFraction >= 0.70
const inTrain = (r) => isCore(r) && r.season !== TEST_SEASON
const inTest = (r) => r.season === TEST_SEASON

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
function stdOf(rows, filterFn, key) {
  const s = rows.filter((r) => filterFn(r) && r[key] != null)
  if (s.length === 0) return 1
  const mean = s.reduce((a, r) => a + r[key], 0) / s.length
  const variance = s.reduce((a, r) => a + (r[key] - mean) ** 2, 0) / s.length
  return Math.sqrt(variance) || 1
}
const G_GRID = [0.7, 0.85, 1.0, 1.15, 1.3]
const C_GRID = [-0.3, -0.15, 0, 0.15, 0.3]
const H_GRID = [-2, -1.5, -1, -0.6, -0.3, -0.15, 0, 0.15, 0.3, 0.6, 1, 1.5, 2]

function fitBaseline(rows, filterFn) {
  let best = null
  for (const g of G_GRID) for (const c of C_GRID) {
    const predict = (r) => sigmoid(g * r.refLogit + c)
    const m = metricsFor(rows, predict, filterFn)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { g, c, m, score }
  }
  return best
}
function fitWithFeature(rows, baseG, std, filterFn) {
  let best = null
  for (const h of H_GRID) for (const c of C_GRID) {
    const predict = (r) => sigmoid(baseG * r.refLogit + h * ((r.goalie ?? 0) / std) + c)
    const m = metricsFor(rows, predict, filterFn)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { h, c, m, score }
  }
  return best
}
function fmt(m) { return m ? `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}` : 'n/a' }

// ============================================================================
// MAIN
// ============================================================================
function main() {
  const t0 = Date.now()
  console.log('Lade historische Rohdaten (9 Saisons)...')
  const seasonsRaw = loadRaw()
  const games = [], allGoalieRows = []
  for (const raw of seasonsRaw) {
    for (const g of raw.games) {
      const { base, goalieRows } = parseGame(g)
      games.push(base)
      for (const r of goalieRows) allGoalieRows.push(r)
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  games.forEach((g, i) => { g.__idx = i })
  const perSeasonCount = new Map()
  for (const g of games) perSeasonCount.set(g.season, (perSeasonCount.get(g.season) || 0) + 1)
  const perSeasonRunning = new Map()
  for (const g of games) {
    const idx = perSeasonRunning.get(g.season) || 0
    g.seasonFraction = idx / perSeasonCount.get(g.season)
    perSeasonRunning.set(g.season, idx + 1)
  }
  const seasons = seasonOrder(games)
  console.log(`Geladen: ${games.length} Spiele, ${seasons.length} Saisons: ${seasons.join(', ')}`)
  console.log(`Test-Saison (vollständig ungesehen, nie zur Kalibrierung): ${TEST_SEASON}`)

  const goalieSeasonStats = buildGoalieSeasonStats(allGoalieRows)
  const goalieRosterBySeason = buildGoalieRosterBySeason(allGoalieRows)

  console.log('\nBerechne Referenzmodell-Snapshots: ELO(Regression=0.25, PRODUKTIV) + SOG-Allowed...')
  const { snaps: eloSnaps } = computeEloSnapshots(games, ELO.seasonEndRegression)
  const bySeason = groupBySeason(games)
  const sogAdj = computeSogAdjSnapshots(bySeason, games.length)

  const goalieCache = new Map()
  function getGoalie(teamId, season) {
    const key = teamId + '|' + season
    if (goalieCache.has(key)) return goalieCache.get(key)
    const v = computeGoalieFeature(teamId, season, seasons, goalieRosterBySeason, goalieSeasonStats)
    goalieCache.set(key, v)
    return v
  }

  const rows = games.map((g) => {
    const e = eloSnaps[g.__idx]
    const sAdj = sogAdj[g.__idx]
    const refLogit = ((e.home + sAdj.home) + ELO.homeAdv - (e.away + sAdj.away)) * Math.LN10 / 400
    const gh = getGoalie(g.homeId, g.season), ga = getGoalie(g.awayId, g.season)
    return {
      season: g.season, corona: g.corona, homeWon: g.homeGoals > g.awayGoals, seasonFraction: g.seasonFraction,
      refLogit, goalie: (gh != null && ga != null) ? gh - ga : null,
    }
  })

  const coreRows = rows.filter(isCore)
  const withGoalie = coreRows.filter((r) => r.goalie != null).length
  console.log(`Torhüter-Feature-Abdeckung (Core): ${((withGoalie / coreRows.length) * 100).toFixed(1)}% (${withGoalie}/${coreRows.length})`)
  const trainRows = rows.filter(inTrain), testRows = rows.filter(inTest)
  console.log(`Train: ${trainRows.length} Spiele (Core, ohne ${TEST_SEASON}) | Test: ${testRows.length} Spiele (nur ${TEST_SEASON}, nie zur Kalibrierung verwendet)`)

  // --- Baseline A (Referenzmodell), NUR auf Trainingsdaten kalibriert ---
  const baseA = fitBaseline(rows, inTrain)
  console.log(`\nBaseline A (ELO+PreSeason+SOG) auf TRAIN kalibriert: g=${baseA.g} c=${baseA.c} -> Train ${fmt(baseA.m)}`)

  // --- Modell B (+ Torhüter), h/c NUR auf Trainingsdaten kalibriert, g von A übernommen ---
  const std = stdOf(rows, inTrain, 'goalie')
  const fitB = fitWithFeature(rows, baseA.g, std, inTrain)
  console.log(`Modell B (+Torhüter) auf TRAIN kalibriert: h=${fitB.h} c=${fitB.c} (std=${std.toFixed(4)}) -> Train ${fmt(fitB.m)}`)

  // --- Beide auf dem NIE gesehenen Test-Set auswerten ---
  const predictA = (r) => sigmoid(baseA.g * r.refLogit + baseA.c)
  const predictB = (r) => sigmoid(baseA.g * r.refLogit + fitB.h * ((r.goalie ?? 0) / std) + fitB.c)

  const testA = metricsFor(rows, predictA, inTest)
  const testB = metricsFor(rows, predictB, inTest)
  console.log(`\n=== OUT-OF-SAMPLE TEST (${TEST_SEASON}, nie zur Kalibrierung verwendet) ===`)
  console.log(`A (Referenz): ${fmt(testA)}`)
  console.log(`B (+Torhüter): ${fmt(testB)}`)
  console.log(`Delta LogLoss: ${(testB.logloss - testA.logloss).toFixed(5)} | Delta Brier: ${(testB.brier - testA.brier).toFixed(5)}`)

  // --- Test-Set nach Saisonanteil aufgeschlüsselt ---
  const segments = { first10: inFirst(0.10), first20: inFirst(0.20), mid: inMid, end: inEnd }
  const segResults = {}
  for (const [label, seg] of Object.entries(segments)) {
    const f = (r) => inTest(r) && seg(r)
    const a = metricsFor(rows, predictA, f), b = metricsFor(rows, predictB, f)
    segResults[label] = { a, b, deltaLogloss: a && b ? b.logloss - a.logloss : null, deltaBrier: a && b ? b.brier - a.brier : null }
    console.log(`  ${label.padEnd(8)}: A ${fmt(a)} | B ${fmt(b)} | ΔLogLoss ${a && b ? (b.logloss - a.logloss).toFixed(5) : 'n/a'}`)
  }

  // --- Per-Saison-Übersicht (informativ, alle Saisons inkl. Train, Corona separat) ---
  console.log('\nPer-Saison-Übersicht (informativ; nur Test-Saison ist echtes Out-of-Sample):')
  const perSeason = {}
  for (const s of seasons) {
    const f = (r) => r.season === s
    const a = metricsFor(rows, predictA, f), b = metricsFor(rows, predictB, f)
    perSeason[s] = { corona: CORONA_SEASONS.has(s), isTest: s === TEST_SEASON, a, b, deltaLogloss: a && b ? b.logloss - a.logloss : null }
    console.log(`  ${s}${CORONA_SEASONS.has(s) ? ' (Corona)' : ''}${s === TEST_SEASON ? ' (TEST)' : ''}: A ${fmt(a)} | B ${fmt(b)}`)
  }

  // --- Determinismus-Check: gleiche Inputs -> gleiche Prognose ---
  const detCheck = testRows.slice(0, 5).every((r) => predictB(r) === predictB(r))
  // --- Wertebereich-/NaN-Check ---
  const allPreds = rows.map(predictB)
  const anyBad = allPreds.some((p) => !Number.isFinite(p) || p < 0 || p > 1)

  const meaningful = testB.logloss < testA.logloss - 0.0005 // identische Schwelle wie in bisherigen Backtests
  const robust = meaningful && segResults.first20.deltaLogloss < 0
  const decision = robust ? 'ROBUST_AUF_TEST_SET' : 'NICHT_ROBUST_AUF_TEST_SET'

  console.log(`\n=== ENTSCHEIDUNG ===`)
  console.log(`Meaningful (ΔLogLoss < -0.0005 auf Test-Set): ${meaningful}`)
  console.log(`Saisonstart-Effekt auf Test-Set negativ (verbessert): ${segResults.first20.deltaLogloss < 0}`)
  console.log(`=> ${decision}`)
  console.log(`\nFertig in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const result = {
    seasons, testSeason: TEST_SEASON, coverage: withGoalie / coreRows.length,
    baseA: { g: baseA.g, c: baseA.c, trainMetrics: baseA.m },
    modelB: { h: fitB.h, c: fitB.c, std, trainMetrics: fitB.m },
    testSet: { a: testA, b: testB, deltaLogloss: testB.logloss - testA.logloss, deltaBrier: testB.brier - testA.brier },
    segments: segResults,
    perSeason,
    checks: { deterministic: detCheck, anyInvalidProbability: anyBad },
    decision: { meaningful, seasonStartHelps: segResults.first20.deltaLogloss < 0, robust, label: decision },
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2))
  console.log(`Ergebnis geschrieben: ${OUT_PATH}`)
}

main()
