// ---------------------------------------------------------------------------
// Backtest: verbesserte Monte-Carlo-Playoff-Simulation.
//
// Read-only: verändert weder src/playoffSim.js noch src/elo.js noch
// src/powerRankings.js noch die historischen Daten. Reines Analyse-/
// Prototyp-Tool zur Vorbereitung einer künftigen Integration.
//
// Diagnose der BISHERIGEN Simulation (src/playoffSim.js):
//   Bug 1 (Tore massiv zu hoch): simulateGoals() bekommt `leagueGPG` (Tore
//   BEIDER Teams zusammen, ø 5.6) als Erwartungswert für JEDES Team einzeln
//   übergeben -> simulierte Gesamttore pro Spiel ~doppelt so hoch wie real.
//   Bug 2 (kein Heimvorteil bei der Torerzeugung): Heimvorteil fliesst nur in
//   die OT/SO-Gewinner-Wahrscheinlichkeit ein, NICHT in die Torzahlen selbst
//   -> simulierte Heim-/Auswärts-Tordifferenz ist ~0 statt real ~+0.5 Tore.
//   Bug 3 (OT/SO-Anteil semantisch vertauscht): `otProb = leagueOTRate`
//   (OT+SO zusammen, ø 20.6%) wird als Wahrscheinlichkeit verwendet, dass ein
//   UNENTSCHIEDENES Spiel in OT (statt SO) endet. Korrekt wäre der Anteil von
//   OT AN (OT+SO), also ~60.6%, nicht ~20.6%. Aktuell landen ~79% aller
//   Unentschieden fälschlich in SO statt real ~39%.
//
// Neues Modell (siehe simulateGameNew):
//   1. Teamstärke zuerst: produktives ELO (src/elo.js, UNVERÄNDERT) + der in
//      Aufgabe 4 validierte SOG-zugelassen-Faktor (identische Formel wie in
//      src/powerRankings.js) ergeben eine Heimsieg-Wahrscheinlichkeit
//      (homeWinProbability aus elo.js, unverändert).
//   2. Daraus wird eine Tor-Supremacy (erwartete Tordifferenz vor OT/SO)
//      abgeleitet, per Backtest kalibriert (Parameter `supremacySlope`).
//   3. Offensive/Defensive-Ratio (wie bisher) wirkt nur noch moderat auf die
//      GESAMT-Torzahl (Pace), NICHT mehr auf die Siegwahrscheinlichkeit
//      (Begründung: Aufgabe 3 zeigte, dass reine Tor-Statistiken über ELO
//      hinaus keinen Prognosewert liefern -> nicht als primäres Stärkesignal
//      verwenden).
//   4. Regulationstore ~ Poisson(erwartetHeim)/Poisson(erwartetAuswärts) -
//      empirisch die beste Näherung (siehe Diagnose unten: Varianz ≈
//      Mittelwert in den historischen Nicht-Corona-Daten).
//   5. Unentschieden nach 60 Min -> OT/SO-Split kalibriert auf den
//      historischen Anteil (60.6% OT / 39.4% SO unter den Unentschieden),
//      Gewinner via derselben ELO+SOG-Wahrscheinlichkeit wie oben.
//
// Kalibrierungsbasis: NUR Nicht-Corona-Saisons (2017/18, 2018/19, 2021/22,
// 2022/23, 2023/24, 2024/25, 2025/26). 2019/20 & 2020/21 fliessen NICHT in
// die Zielwerte ein.
//
// Aufruf: node server/scripts/backtest-montecarlo.js
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
// 1. Historische Ziel-Benchmarks (NUR Nicht-Corona-Saisons)
// ============================================================================

function computeNonCoronaBenchmarks(games) {
  const nc = games.filter((g) => !g.corona)
  let hg = 0, ag = 0, ot = 0, so = 0, reg = 0
  let regDiffSum = 0
  for (const g of nc) {
    hg += g.homeGoals; ag += g.awayGoals
    if (g.decision === 'OT') ot++
    else if (g.decision === 'SO') so++
    else { reg++; regDiffSum += Math.abs(g.homeGoals - g.awayGoals) }
  }
  const n = nc.length
  return {
    n,
    homeGPG: hg / n,
    awayGPG: ag / n,
    totalGPG: (hg + ag) / n,
    otRate: ot / n,
    soRate: so / n,
    regRate: reg / n,
    tieRate: (ot + so) / n,
    otShareOfTies: ot / (ot + so),
    regMeanAbsDiff: regDiffSum / reg,
  }
}

// ============================================================================
// 2. ELO-Snapshot (unverändert, Produktiv-Parameter aus src/elo.js)
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
function resultScore(hw, dec) {
  if (dec === 'SO') return hw ? ELO.rw.soWin : ELO.rw.soLoss
  if (dec === 'OT') return hw ? ELO.rw.otWin : ELO.rw.otLoss
  return hw ? ELO.rw.regulationWin : ELO.rw.regulationLoss
}
// homeWinProbability, exakt wie src/elo.js (unverändert)
function homeWinProbability(ratingHome, ratingAway, homeAdvantage) {
  return 1 / (1 + Math.pow(10, (ratingAway - (ratingHome + homeAdvantage)) / 400))
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
    const sH = resultScore(hw, g.decision)
    const kH = eloK(gpH), kA = eloK(gpA)
    ratings.set(g.homeId, rh + kH * gm * (sH - expH))
    ratings.set(g.awayId, ra + kA * gm * ((1 - sH) - (1 - expH)))
    gp.set(g.homeId, gpH + 1); gp.set(g.awayId, gpA + 1)
  }
  return snaps
}

// ============================================================================
// 3. SOG-zugelassen-Adjustierung (identische Formel wie src/powerRankings.js)
// ============================================================================

const SOG_CFG = { weight: 0.15, minGamesFullConfidence: 10, maxZScore: 2.5 }
const LOGIT_TO_ELO = 400 / Math.LN10

function groupBySeasonWithActiveTeams(games) {
  const bySeason = new Map()
  for (const g of games) {
    if (!bySeason.has(g.season)) bySeason.set(g.season, { games: [], teams: new Set() })
    const e = bySeason.get(g.season)
    e.games.push(g); e.teams.add(g.homeId); e.teams.add(g.awayId)
  }
  return bySeason
}

// Liefert parallel zu games: { sogAdj: {home,away}, offDef: {home:{off,def},away:{off,def}} }
// alles Stand VOR dem jeweiligen Spiel (leak-frei), zurückgesetzt pro Saison.
function computeContextSnapshots(bySeason) {
  const ctx = new Array([...bySeason.values()].reduce((s, e) => s + e.games.length, 0))
  for (const [, entry] of bySeason) {
    const teamIds = [...entry.teams]
    const stat = new Map()
    teamIds.forEach((id) => stat.set(id, { gp: 0, gf: 0, ga: 0, sogAgainst: 0 }))

    for (const g of entry.games) {
      let lgGF = 0, lgGA = 0, lgGP = 0
      for (const id of teamIds) { const s = stat.get(id); lgGF += s.gf; lgGA += s.ga; lgGP += s.gp }
      const leagueGPG = lgGF / Math.max(1, lgGP)
      const leagueGAG = lgGA / Math.max(1, lgGP)

      const H = stat.get(g.homeId), A = stat.get(g.awayId)
      const offDefHome = { off: H.gp > 0 ? (H.gf / H.gp) / Math.max(0.1, leagueGPG) : 1, def: H.gp > 0 ? leagueGAG / Math.max(0.1, H.ga / H.gp) : 1 }
      const offDefAway = { off: A.gp > 0 ? (A.gf / A.gp) / Math.max(0.1, leagueGPG) : 1, def: A.gp > 0 ? leagueGAG / Math.max(0.1, A.ga / A.gp) : 1 }

      // SOG-zugelassen z-Score, ligaweit (wie Power Ranking)
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

      ctx[g.__idx] = {
        sogAdjHome: sogAdjMap[g.homeId] ?? 0, sogAdjAway: sogAdjMap[g.awayId] ?? 0,
        offDefHome, offDefAway,
      }

      // Update (nach "Prognose")
      H.gp++; A.gp++
      H.gf += g.homeGoals; H.ga += g.awayGoals
      A.gf += g.awayGoals; A.ga += g.homeGoals
      H.sogAgainst += g.sogAway; A.sogAgainst += g.sogHome
    }
  }
  return ctx
}

// ============================================================================
// 4. Exakte Poisson-Paar-Statistik (für schnelle, rauschfreie Kalibrierung)
// ============================================================================

function poissonPMF(k, lambda) {
  let logP = -lambda + k * Math.log(lambda)
  for (let i = 2; i <= k; i++) logP -= Math.log(i)
  return Math.exp(logP)
}
// Gibt { pTie, sumAbsDiffNonTie, probNonTie, expHome, expAway } für ein (lambdaH, lambdaA)-Paar
function poissonPairStats(lambdaH, lambdaA, maxK = 30) {
  let pTie = 0, sumAbsDiffNonTie = 0
  const pmfH = [], pmfA = []
  for (let k = 0; k <= maxK; k++) { pmfH.push(poissonPMF(k, lambdaH)); pmfA.push(poissonPMF(k, lambdaA)) }
  for (let h = 0; h <= maxK; h++) {
    for (let a = 0; a <= maxK; a++) {
      const p = pmfH[h] * pmfA[a]
      if (h === a) pTie += p
      else sumAbsDiffNonTie += p * Math.abs(h - a)
    }
  }
  return { pTie, sumAbsDiffNonTie }
}

// ============================================================================
// 5. Neues Modell: Team-Strength -> erwartete Tore
// ============================================================================

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

function expectedGoalsNew(eloSnap, ctx, benchmarks, params) {
  const pHome = homeWinProbability(eloSnap.home + ctx.sogAdjHome, eloSnap.away + ctx.sogAdjAway, ELO.homeAdv)
  const supremacy = params.supremacySlope * (pHome - 0.5)

  const paceRaw = (ctx.offDefHome.off * ctx.offDefAway.def + ctx.offDefAway.off * ctx.offDefHome.def) / 2
  const pace = clamp(paceRaw, params.paceMin, params.paceMax)

  const totalExpected = (benchmarks.homeGPG + benchmarks.awayGPG) * pace
  let expHome = totalExpected / 2 + supremacy / 2
  let expAway = totalExpected / 2 - supremacy / 2
  expHome = Math.max(0.2, expHome)
  expAway = Math.max(0.2, expAway)
  return { expHome, expAway, pHome }
}

// ============================================================================
// 6. Kalibrierung: supremacySlope + Pace-Clamp per Grid Search (exakte Poisson-Mathematik)
// ============================================================================

function calibrateSupremacySlope(games, eloSnapshots, ctxSnapshots, benchmarks) {
  const idxNonCorona = games.map((g, i) => (!g.corona ? i : -1)).filter((i) => i >= 0)

  const SLOPE_GRID = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12]
  const PACE_GRID = [
    { min: 1, max: 1 },      // Pace-Faktor deaktiviert (nur Baseline)
    { min: 0.9, max: 1.1 },
    { min: 0.85, max: 1.15 },
    { min: 0.75, max: 1.25 },
  ]

  let best = null
  for (const slope of SLOPE_GRID) {
    for (const pace of PACE_GRID) {
      let sumExpHome = 0, sumExpAway = 0, sumPTie = 0, sumNonTieDiff = 0, sumProbNonTie = 0
      for (const i of idxNonCorona) {
        const { expHome, expAway } = expectedGoalsNew(eloSnapshots[i], ctxSnapshots[i], benchmarks, { supremacySlope: slope, paceMin: pace.min, paceMax: pace.max })
        sumExpHome += expHome; sumExpAway += expAway
        const { pTie, sumAbsDiffNonTie } = poissonPairStats(expHome, expAway)
        sumPTie += pTie
        sumNonTieDiff += sumAbsDiffNonTie
        sumProbNonTie += (1 - pTie)
      }
      const n = idxNonCorona.length
      const simHomeGPG = sumExpHome / n
      const simAwayGPG = sumExpAway / n
      const simTieRate = sumPTie / n
      const simNonTieDiff = sumNonTieDiff / sumProbNonTie

      // Zielabweichung (relative Fehler^2, gleich gewichtet)
      const err =
        ((simHomeGPG - benchmarks.homeGPG) / benchmarks.homeGPG) ** 2 +
        ((simAwayGPG - benchmarks.awayGPG) / benchmarks.awayGPG) ** 2 +
        ((simTieRate - benchmarks.tieRate) / benchmarks.tieRate) ** 2 +
        ((simNonTieDiff - benchmarks.regMeanAbsDiff) / benchmarks.regMeanAbsDiff) ** 2

      const candidate = { slope, pace, simHomeGPG, simAwayGPG, simTieRate, simNonTieDiff, err }
      if (!best || err < best.err) best = candidate
    }
  }
  return best
}

// ============================================================================
// 7. Monte-Carlo-Sampler (alt & neu) für Season-Replay-Backtest
// ============================================================================

class SeededRandom {
  constructor(seed = 12345) { this.seed = seed }
  next() { this.seed = (this.seed * 9301 + 49297) % 233280; return this.seed / 233280 }
}
function poissonSample(rng, lambda) {
  // Knuth-Algorithmus (ausreichend für lambda < ~15, hier immer der Fall)
  const L = Math.exp(-lambda)
  let k = 0, p = 1
  do { k++; p *= rng.next() } while (p > L)
  return k - 1
}

// ALTE Engine, 1:1 wie src/playoffSim.js nachgebaut (inkl. Bugs)
function simulateGameOld(rng, params) {
  const { leagueGPG, homeOff, awayDef, awayOff, homeDef, otProbBuggy, pHome } = params
  function simulateGoalsOld(baseGoals, teamRating, oppDefRating) {
    const expected = baseGoals * teamRating / oppDefRating
    const sigma = Math.sqrt(Math.max(0.5, expected))
    const normal = Math.sqrt(-2 * Math.log(rng.next())) * Math.cos(2 * Math.PI * rng.next())
    const goals = Math.max(0, Math.round(expected + normal * sigma))
    return Math.min(goals, 12)
  }
  const homeGoals = simulateGoalsOld(leagueGPG, homeOff, awayDef)
  const awayGoals = simulateGoalsOld(leagueGPG, awayOff, homeDef)
  if (homeGoals === awayGoals) {
    const isOT = rng.next() < otProbBuggy
    const winnerHome = rng.next() < pHome
    return { home: homeGoals + (winnerHome ? 1 : 0), away: awayGoals + (winnerHome ? 0 : 1), decision: isOT ? 'OT' : 'SO' }
  }
  return { home: homeGoals, away: awayGoals, decision: 'REG' }
}

// NEUE Engine
function simulateGameNew(rng, expHome, expAway, pHome, otShareOfTies) {
  const homeGoals = poissonSample(rng, expHome)
  const awayGoals = poissonSample(rng, expAway)
  if (homeGoals === awayGoals) {
    const isOT = rng.next() < otShareOfTies
    const winnerHome = rng.next() < pHome
    return { home: homeGoals + (winnerHome ? 1 : 0), away: awayGoals + (winnerHome ? 0 : 1), decision: isOT ? 'OT' : 'SO' }
  }
  return { home: homeGoals, away: awayGoals, decision: 'REG' }
}

// ============================================================================
// 8. Makro-Verteilungs-Vergleich (alt vs. neu vs. real) über ALLE Nicht-Corona-Spiele
//    Monte-Carlo-Sampling (nicht analytisch) für einen fairen 1:1-Vergleich
// ============================================================================

function macroComparison(games, eloSnapshots, ctxSnapshots, benchmarks, bestCal, samplesPerGame = 30) {
  const idxNonCorona = games.map((g, i) => (!g.corona ? i : -1)).filter((i) => i >= 0)
  const rng = new SeededRandom(777)

  const accOld = { hg: 0, ag: 0, ot: 0, so: 0, reg: 0, n: 0, diffSum: 0 }
  const accNew = { hg: 0, ag: 0, ot: 0, so: 0, reg: 0, n: 0, diffSum: 0 }

  // Für die alte Engine: legacy leagueGPG (Gesamt, wie im Produktivcode, Bug 1 inklusive)
  const legacyLeagueGPG = benchmarks.totalGPG

  for (const i of idxNonCorona) {
    const g = games[i]
    const eloSnap = eloSnapshots[i]
    const ctx = ctxSnapshots[i]
    const pHome = homeWinProbability(eloSnap.home + ctx.sogAdjHome, eloSnap.away + ctx.sogAdjAway, ELO.homeAdv)

    // ALT: otProbBuggy = leagueOTRate (Gesamtanteil OT+SO an allen Spielen) - exakt wie Produktivcode
    const otProbBuggy = benchmarks.tieRate

    for (let s = 0; s < samplesPerGame; s++) {
      const rOld = simulateGameOld(rng, {
        leagueGPG: legacyLeagueGPG,
        homeOff: ctx.offDefHome.off, awayDef: ctx.offDefAway.def,
        awayOff: ctx.offDefAway.off, homeDef: ctx.offDefHome.def,
        otProbBuggy, pHome,
      })
      accOld.hg += rOld.home; accOld.ag += rOld.away; accOld.n++
      accOld.diffSum += Math.abs(rOld.home - rOld.away)
      if (rOld.decision === 'OT') accOld.ot++
      else if (rOld.decision === 'SO') accOld.so++
      else accOld.reg++

      const { expHome, expAway } = expectedGoalsNew(eloSnap, ctx, benchmarks, { supremacySlope: bestCal.slope, paceMin: bestCal.pace.min, paceMax: bestCal.pace.max })
      const rNew = simulateGameNew(rng, expHome, expAway, pHome, benchmarks.otShareOfTies)
      accNew.hg += rNew.home; accNew.ag += rNew.away; accNew.n++
      accNew.diffSum += Math.abs(rNew.home - rNew.away)
      if (rNew.decision === 'OT') accNew.ot++
      else if (rNew.decision === 'SO') accNew.so++
      else accNew.reg++
    }
  }

  function summarize(acc) {
    return {
      n: acc.n,
      homeGPG: acc.hg / acc.n, awayGPG: acc.ag / acc.n, totalGPG: (acc.hg + acc.ag) / acc.n,
      otRate: acc.ot / acc.n, soRate: acc.so / acc.n, regRate: acc.reg / acc.n,
      meanAbsDiff: acc.diffSum / acc.n,
    }
  }
  return { old: summarize(accOld), new: summarize(accNew) }
}

// ============================================================================
// 9. Season-Replay-Backtest: ab Saisonmitte restliche Spiele 10'000x simulieren,
//    simulierte Endpunkte vs. reale Endpunkte vergleichen (RMSE)
// ============================================================================

function seasonReplayBacktest(games, eloSnapshots, ctxSnapshots, benchmarks, bestCal, seasonName, runs = 3000) {
  const seasonGames = games.filter((g) => g.season === seasonName)
  const teams = [...new Set(seasonGames.flatMap((g) => [g.homeId, g.awayId]))]
  const cutoff = Math.floor(seasonGames.length * 0.4) // ~40% der Saison bereits gespielt

  const playedGames = seasonGames.slice(0, cutoff)
  const remainingGames = seasonGames.slice(cutoff)

  // Reale Punkte aus den bereits gespielten Spielen (NL-System: 3/2/1/0)
  function nlPoints(games) {
    const pts = {}
    teams.forEach((t) => { pts[t] = 0 })
    for (const g of games) {
      const homeWon = g.homeGoals > g.awayGoals
      const overtime = g.decision === 'OT' || g.decision === 'SO'
      if (overtime) { pts[g.homeId] += homeWon ? 2 : 1; pts[g.awayId] += homeWon ? 1 : 2 }
      else { pts[g.homeId] += homeWon ? 3 : 0; pts[g.awayId] += homeWon ? 0 : 3 }
    }
    return pts
  }
  const startPts = nlPoints(playedGames)
  const actualFinalPts = nlPoints(seasonGames)

  // ELO/Kontext-Snapshots am Cutoff-Zeitpunkt (Rating VOR dem ersten Restspiel für jedes Team) -
  // wir nutzen den Snapshot des jeweils ERSTEN verbleibenden Spiels jedes Teams als "eingefrorenen" Stand,
  // exakt wie es die Produktion tut (computeElo einmalig auf Basis der bisherigen Spiele).
  const frozenElo = {}
  const frozenCtx = {}
  teams.forEach((t) => { frozenElo[t] = ELO.start; frozenCtx[t] = { off: 1, def: 1, sogAdj: 0 } })
  // ELO/Kontext "vor Cutoff" = der "vor diesem Spiel"-Snapshot des jeweils ERSTEN
  // Restspiels jedes Teams (das entspricht exakt dem Rating NACH dem letzten
  // gespielten Spiel, da computeElo genau dort keinen weiteren Schritt macht).
  for (const t of teams) {
    const nextGame = remainingGames.find((g) => g.homeId === t || g.awayId === t)
    if (nextGame) {
      const snap = eloSnapshots[nextGame.__idx]
      frozenElo[t] = nextGame.homeId === t ? snap.home : snap.away
      const ctx = ctxSnapshots[nextGame.__idx]
      frozenCtx[t] = nextGame.homeId === t
        ? { off: ctx.offDefHome.off, def: ctx.offDefHome.def, sogAdj: ctx.sogAdjHome }
        : { off: ctx.offDefAway.off, def: ctx.offDefAway.def, sogAdj: ctx.sogAdjAway }
    }
  }

  const legacyLeagueGPG = benchmarks.totalGPG

  function runReplay(engine) {
    const rng = new SeededRandom(4242)
    const sumPts = {}
    teams.forEach((t) => { sumPts[t] = 0 })

    for (let sim = 0; sim < runs; sim++) {
      const pts = { ...startPts }
      for (const g of remainingGames) {
        const eloHome = frozenElo[g.homeId], eloAway = frozenElo[g.awayId]
        const ctxHome = frozenCtx[g.homeId], ctxAway = frozenCtx[g.awayId]
        const pHome = homeWinProbability(eloHome + ctxHome.sogAdj, eloAway + ctxAway.sogAdj, ELO.homeAdv)

        let result
        if (engine === 'old') {
          result = simulateGameOld(rng, {
            leagueGPG: legacyLeagueGPG,
            homeOff: ctxHome.off, awayDef: ctxAway.def, awayOff: ctxAway.off, homeDef: ctxHome.def,
            otProbBuggy: benchmarks.tieRate, pHome,
          })
        } else {
          const paceRaw = (ctxHome.off * ctxAway.def + ctxAway.off * ctxHome.def) / 2
          const pace = clamp(paceRaw, bestCal.pace.min, bestCal.pace.max)
          const supremacy = bestCal.slope * (pHome - 0.5)
          const totalExpected = (benchmarks.homeGPG + benchmarks.awayGPG) * pace
          const expHome = Math.max(0.2, totalExpected / 2 + supremacy / 2)
          const expAway = Math.max(0.2, totalExpected / 2 - supremacy / 2)
          result = simulateGameNew(rng, expHome, expAway, pHome, benchmarks.otShareOfTies)
        }

        const homeWon = result.home > result.away
        const overtime = result.decision === 'OT' || result.decision === 'SO'
        if (overtime) { pts[g.homeId] += homeWon ? 2 : 1; pts[g.awayId] += homeWon ? 1 : 2 }
        else { pts[g.homeId] += homeWon ? 3 : 0; pts[g.awayId] += homeWon ? 0 : 3 }
      }
      teams.forEach((t) => { sumPts[t] += pts[t] })
    }
    const avgPts = {}
    teams.forEach((t) => { avgPts[t] = sumPts[t] / runs })
    return avgPts
  }

  const avgOld = runReplay('old')
  const avgNew = runReplay('new')

  function rmse(avgPts) {
    let sumSq = 0
    teams.forEach((t) => { sumSq += (avgPts[t] - actualFinalPts[t]) ** 2 })
    return Math.sqrt(sumSq / teams.length)
  }
  function meanAbsErr(avgPts) {
    let sum = 0
    teams.forEach((t) => { sum += Math.abs(avgPts[t] - actualFinalPts[t]) })
    return sum / teams.length
  }

  return {
    season: seasonName, teams: teams.length,
    cutoffGame: cutoff, remainingGames: remainingGames.length,
    rmseOld: rmse(avgOld), rmseNew: rmse(avgNew),
    maeOld: meanAbsErr(avgOld), maeNew: meanAbsErr(avgNew),
  }
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const games = loadGames()
  const benchmarks = computeNonCoronaBenchmarks(games)
  const eloSnapshots = computeEloSnapshots(games)
  const bySeason = groupBySeasonWithActiveTeams(games)
  const ctxSnapshots = computeContextSnapshots(bySeason)

  console.log('=== HISTORISCHE ZIEL-BENCHMARKS (Nicht-Corona, n=' + benchmarks.n + ') ===')
  console.log(`Ø Heimtore/Spiel:  ${benchmarks.homeGPG.toFixed(3)}`)
  console.log(`Ø Auswärtstore/Spiel: ${benchmarks.awayGPG.toFixed(3)}`)
  console.log(`Ø Tore/Spiel gesamt: ${benchmarks.totalGPG.toFixed(3)}`)
  console.log(`OT-Quote: ${(benchmarks.otRate * 100).toFixed(2)}%`)
  console.log(`SO-Quote: ${(benchmarks.soRate * 100).toFixed(2)}%`)
  console.log(`REG-Quote: ${(benchmarks.regRate * 100).toFixed(2)}%`)
  console.log(`OT-Anteil an Unentschieden (OT+SO): ${(benchmarks.otShareOfTies * 100).toFixed(2)}%`)
  console.log(`Ø |Tordifferenz| bei REG-Spielen: ${benchmarks.regMeanAbsDiff.toFixed(3)}`)

  console.log('\n=== KALIBRIERUNG: supremacySlope + Pace-Clamp (exakte Poisson-Mathematik, kein Sampling-Rauschen) ===')
  const bestCal = calibrateSupremacySlope(games, eloSnapshots, ctxSnapshots, benchmarks)
  console.log(`Bestes Ergebnis: slope=${bestCal.slope}  paceClamp=[${bestCal.pace.min},${bestCal.pace.max}]  (Fehler-Score=${bestCal.err.toFixed(5)})`)
  console.log(`  simulierte Heimtore/Spiel:    ${bestCal.simHomeGPG.toFixed(3)}  (Ziel ${benchmarks.homeGPG.toFixed(3)})`)
  console.log(`  simulierte Auswärtstore/Spiel: ${bestCal.simAwayGPG.toFixed(3)}  (Ziel ${benchmarks.awayGPG.toFixed(3)})`)
  console.log(`  simulierte Tie-Rate (OT+SO):   ${(bestCal.simTieRate * 100).toFixed(2)}%  (Ziel ${(benchmarks.tieRate * 100).toFixed(2)}%)`)
  console.log(`  simulierte Ø|Diff| (nicht-tie): ${bestCal.simNonTieDiff.toFixed(3)}  (Ziel ${benchmarks.regMeanAbsDiff.toFixed(3)})`)

  console.log('\n=== SENSITIVITÄT (Fehler-Score bei paceClamp=[' + bestCal.pace.min + ',' + bestCal.pace.max + ']) ===')
  for (const slope of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12]) {
    const idxNonCorona = games.map((g, i) => (!g.corona ? i : -1)).filter((i) => i >= 0)
    let sumExpHome = 0, sumExpAway = 0, sumPTie = 0, sumNonTieDiff = 0, sumProbNonTie = 0
    for (const i of idxNonCorona) {
      const { expHome, expAway } = expectedGoalsNew(eloSnapshots[i], ctxSnapshots[i], benchmarks, { supremacySlope: slope, paceMin: bestCal.pace.min, paceMax: bestCal.pace.max })
      sumExpHome += expHome; sumExpAway += expAway
      const { pTie, sumAbsDiffNonTie } = poissonPairStats(expHome, expAway)
      sumPTie += pTie; sumNonTieDiff += sumAbsDiffNonTie; sumProbNonTie += (1 - pTie)
    }
    const n = idxNonCorona.length
    console.log(`  slope=${String(slope).padStart(2)}  homeGPG=${(sumExpHome/n).toFixed(3)} awayGPG=${(sumExpAway/n).toFixed(3)} tieRate=${(sumPTie/n*100).toFixed(2)}% nonTieDiff=${(sumNonTieDiff/sumProbNonTie).toFixed(3)}`)
  }

  console.log('\n=== MAKRO-VERGLEICH: ALT vs. NEU vs. REAL (Monte-Carlo-Sampling über alle Nicht-Corona-Spiele) ===')
  const macro = macroComparison(games, eloSnapshots, ctxSnapshots, benchmarks, bestCal, 30)
  console.log('Kennzahl              | Real (Ziel) | Alte Simulation | Neue Simulation')
  console.log(`Heimtore/Spiel        | ${benchmarks.homeGPG.toFixed(3)}       | ${macro.old.homeGPG.toFixed(3)}           | ${macro.new.homeGPG.toFixed(3)}`)
  console.log(`Auswärtstore/Spiel    | ${benchmarks.awayGPG.toFixed(3)}       | ${macro.old.awayGPG.toFixed(3)}           | ${macro.new.awayGPG.toFixed(3)}`)
  console.log(`Tore/Spiel gesamt     | ${benchmarks.totalGPG.toFixed(3)}       | ${macro.old.totalGPG.toFixed(3)}           | ${macro.new.totalGPG.toFixed(3)}`)
  console.log(`OT-Quote              | ${(benchmarks.otRate*100).toFixed(2)}%      | ${(macro.old.otRate*100).toFixed(2)}%          | ${(macro.new.otRate*100).toFixed(2)}%`)
  console.log(`SO-Quote              | ${(benchmarks.soRate*100).toFixed(2)}%       | ${(macro.old.soRate*100).toFixed(2)}%          | ${(macro.new.soRate*100).toFixed(2)}%`)
  console.log(`REG-Quote             | ${(benchmarks.regRate*100).toFixed(2)}%      | ${(macro.old.regRate*100).toFixed(2)}%          | ${(macro.new.regRate*100).toFixed(2)}%`)

  console.log('\n=== SEASON-REPLAY-BACKTEST (ab 40% Saisonfortschritt, ' + 3000 + ' Replays) ===')
  const replaySeasons = ['2022/23', '2023/24', '2024/25']
  console.log('Saison  | Teams | Restspiele | RMSE alt | RMSE neu | MAE alt | MAE neu')
  for (const s of replaySeasons) {
    const r = seasonReplayBacktest(games, eloSnapshots, ctxSnapshots, benchmarks, bestCal, s, 3000)
    console.log(`${s} | ${r.teams}     | ${r.remainingGames}         | ${r.rmseOld.toFixed(2)}    | ${r.rmseNew.toFixed(2)}    | ${r.maeOld.toFixed(2)}   | ${r.maeNew.toFixed(2)}`)
  }

  fs.writeFileSync(path.join(__dirname, 'backtest-montecarlo-result.json'), JSON.stringify({
    benchmarks, bestCal: { slope: bestCal.slope, pace: bestCal.pace, err: bestCal.err }, macro,
  }, null, 2))
  console.log('\nDetails gespeichert: server/scripts/backtest-montecarlo-result.json')
}

main()
