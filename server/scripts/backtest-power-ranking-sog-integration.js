// ---------------------------------------------------------------------------
// Verifikations-Backtest für die SOG-zugelassen-Integration in
// src/powerRankings.js.
//
// Bildet EXAKT die jetzt produktive Formel nach (siehe
// computeSogAllowedEloAdjustments in src/powerRankings.js):
//   - ligaweiter z-Score von "zugelassene Schüsse/Spiel" (Saison bis dato)
//   - Koeffizient h = POWER_CONFIG.sogAllowed.weight = 0.15
//   - Konfidenz-Rampe bis POWER_CONFIG.sogAllowed.minGamesFullConfidence = 10 Spiele
//   - Clipping bei POWER_CONFIG.sogAllowed.maxZScore = 2.5
//   - Umrechnung in ELO-Punkte über dieselbe 400/ln(10)-Skalierung wie ELO
//
// Vergleicht innerhalb des bestehenden 4-Komponenten-Power-Ranking-Frameworks
// (Produktiv-Gewichte 0.40/0.25/0.25/0.10, UNVERÄNDERT) mit vs. ohne die
// SOG-Adjustierung der Siegkraft-Komponente. Read-only, leak-frei,
// Walk-Forward — identische Methodik wie die vorherigen Backtests.
//
// Aufruf: node server/scripts/backtest-power-ranking-sog-integration.js
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
        dt: g.startDateTime || g.date,
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

// --- ELO (unverändert, Produktiv-Parameter aus src/elo.js) ---
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

// --- Power-Ranking-Komponenten (identisch zu src/powerRankings.js) ---
const PR = {
  strengthWeights: { elo: 0.50, pointsPerGame: 0.35, winRate: 0.15 },
  formShort: 5, formLong: 10, formLongWeight: 0.3, relativeWindow: 10,
  eloMin: 1300, eloMax: 1700,
  sog: { weight: 0.15, minGamesFullConfidence: 10, maxZScore: 2.5 },
}
const LOGIT_TO_ELO = 400 / Math.LN10

function normalize(values, invert = false) {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return values.map(() => 50)
  const min = Math.min(...finite), max = Math.max(...finite)
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
function ptsForResult(isHome, hg, ag, decision) {
  const homeWon = hg > ag
  const overtime = decision === 'OT' || decision === 'SO'
  const won = isHome ? homeWon : !homeWon
  if (overtime) return won ? 2 : 1
  return won ? 3 : 0
}

function groupBySeasonWithActiveTeams(games) {
  const bySeason = new Map()
  for (const g of games) {
    if (!bySeason.has(g.season)) bySeason.set(g.season, { games: [], teams: new Set() })
    const e = bySeason.get(g.season)
    e.games.push(g); e.teams.add(g.homeId); e.teams.add(g.awayId)
  }
  return bySeason
}

// useSog: false = reines bisheriges Power Ranking, true = mit SOG-zugelassen-Adjustierung
function computeDiffSeries(bySeason, eloSnapshots, weights, useSog) {
  const results = []

  for (const [, entry] of bySeason) {
    const teamIds = [...entry.teams]
    const stat = new Map()
    teamIds.forEach((id) => stat.set(id, {
      gp: 0, w: 0, otw: 0, otl: 0, l: 0, pts: 0, gf: 0, ga: 0, recent: [],
      sogFor: 0, sogAgainst: 0,
    }))

    for (const g of entry.games) {
      const eloSnap = eloSnapshots[g.__idx]

      let leagueGF = 0, leagueGA = 0, leagueGP = 0
      for (const id of teamIds) {
        const s = stat.get(id)
        leagueGF += s.gf; leagueGA += s.ga; leagueGP += s.gp
      }
      const leagueGPG = leagueGF / Math.max(1, leagueGP)
      const leagueGAG = leagueGA / Math.max(1, leagueGP)

      // --- SOG-zugelassen-Adjustierung (ligaweiter z-Score, wie Produktivcode) ---
      let sogAdjustment = {}
      teamIds.forEach((id) => { sogAdjustment[id] = 0 })
      if (useSog) {
        const withData = teamIds
          .map((id) => ({ id, s: stat.get(id) }))
          .filter(({ s }) => s.gp > 0)
          .map(({ id, s }) => ({ id, perGame: s.sogAgainst / s.gp, gp: s.gp }))
        if (withData.length >= 2) {
          const mean = withData.reduce((s, x) => s + x.perGame, 0) / withData.length
          const variance = withData.reduce((s, x) => s + (x.perGame - mean) ** 2, 0) / withData.length
          const std = Math.sqrt(variance)
          if (std > 0) {
            for (const x of withData) {
              const rawZ = (mean - x.perGame) / std
              const z = Math.max(-PR.sog.maxZScore, Math.min(PR.sog.maxZScore, rawZ))
              const confidence = Math.min(1, x.gp / PR.sog.minGamesFullConfidence)
              sogAdjustment[x.id] = PR.sog.weight * z * confidence * LOGIT_TO_ELO
            }
          }
        }
      }

      const eloNorm = [], ptsPerGameArr = [], winRateArr = []
      const gpgArr = [], gagArr = [], relOffArr = [], relDefArr = []
      const formShortArr = [], formLongArr = []

      for (const id of teamIds) {
        const s = stat.get(id)
        const elo = (eloSnap[id] ?? ELO.start) + (sogAdjustment[id] ?? 0)
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

      results.push({
        diff: powerScore.get(g.homeId) - powerScore.get(g.awayId),
        homeWon: g.homeGoals > g.awayGoals, corona: g.corona, season: g.season,
      })

      // === UPDATE ===
      const h = stat.get(g.homeId), a = stat.get(g.awayId)
      const hp = ptsForResult(true, g.homeGoals, g.awayGoals, g.decision)
      const ap = ptsForResult(false, g.homeGoals, g.awayGoals, g.decision)
      const overtime = g.decision === 'OT' || g.decision === 'SO'
      const homeWon = g.homeGoals > g.awayGoals
      h.gp++; a.gp++
      h.pts += hp; a.pts += ap
      h.gf += g.homeGoals; h.ga += g.awayGoals
      a.gf += g.awayGoals; a.ga += g.homeGoals
      if (overtime) { if (homeWon) { h.otw++; a.otl++ } else { h.otl++; a.otw++ } }
      else { if (homeWon) { h.w++; a.l++ } else { h.l++; a.w++ } }
      h.recent.push({ gf: g.homeGoals, ga: g.awayGoals, pts: hp })
      a.recent.push({ gf: g.awayGoals, ga: g.homeGoals, pts: ap })
      if (h.recent.length > 10) h.recent.shift()
      if (a.recent.length > 10) a.recent.shift()
      h.sogFor += g.sogHome; h.sogAgainst += g.sogAway
      a.sogFor += g.sogAway; a.sogAgainst += g.sogHome
    }
  }
  return results
}

function predictProb(diff, a, homeBonus) { return 1 / (1 + Math.exp(-a * (diff + homeBonus))) }
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
  return n === 0 ? null : { n, accuracy: correct / n, brier: brier / n, logloss: logloss / n }
}
const A_GRID = [0.002, 0.005, 0.01, 0.02, 0.03, 0.04, 0.06, 0.08, 0.10, 0.15, 0.20]
const HOMEBONUS_GRID = [0, 2, 4, 6, 8, 10, 12, 16, 20, 25, 30, 40, 50]
function calibrate(results) {
  const core = (r) => !r.corona
  let best = null
  for (const a of A_GRID) for (const homeBonus of HOMEBONUS_GRID) {
    const m = metricsFor(results, a, homeBonus, core)
    if (!best || (m.logloss + m.brier) < (best.m.logloss + best.m.brier)) best = { a, homeBonus, m }
  }
  return best
}

function fmt(m) { return m ? `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}` : 'n/a' }

function main() {
  const games = loadGames()
  const eloSnapshots = computeEloSnapshots(games)
  const bySeason = groupBySeasonWithActiveTeams(games)
  const PROD_WEIGHTS = { strength: 0.40, offense: 0.25, defense: 0.25, form: 0.10 }

  const core = (r) => !r.corona, corona = (r) => r.corona, total = () => true

  console.log(`Geladen: ${games.length} Spiele, ${bySeason.size} Saisons`)
  console.log('Produktiv-Gewichte (unverändert):', JSON.stringify(PROD_WEIGHTS))

  const withoutSog = computeDiffSeries(bySeason, eloSnapshots, PROD_WEIGHTS, false)
  const withSog = computeDiffSeries(bySeason, eloSnapshots, PROD_WEIGHTS, true)

  const calWithout = calibrate(withoutSog)
  const calWith = calibrate(withSog)

  console.log('\n=== POWER RANKING: ELO-only (bisher) ===')
  console.log(`a=${calWithout.a} homeBonus=${calWithout.homeBonus}`)
  console.log('Core:  ', fmt(metricsFor(withoutSog, calWithout.a, calWithout.homeBonus, core)))
  console.log('Corona:', fmt(metricsFor(withoutSog, calWithout.a, calWithout.homeBonus, corona)))
  console.log('Gesamt:', fmt(metricsFor(withoutSog, calWithout.a, calWithout.homeBonus, total)))

  console.log('\n=== POWER RANKING: ELO + SOG zugelassen (neu) ===')
  console.log(`a=${calWith.a} homeBonus=${calWith.homeBonus}`)
  console.log('Core:  ', fmt(metricsFor(withSog, calWith.a, calWith.homeBonus, core)))
  console.log('Corona:', fmt(metricsFor(withSog, calWith.a, calWith.homeBonus, corona)))
  console.log('Gesamt:', fmt(metricsFor(withSog, calWith.a, calWith.homeBonus, total)))

  console.log('\nPro Saison (ELO+SOG, core-Kalibrierung):')
  const perSeason = new Map()
  for (const r of withSog) { if (!perSeason.has(r.season)) perSeason.set(r.season, []); perSeason.get(r.season).push(r) }
  for (const [s, arr] of perSeason) {
    const m = metricsFor(arr, calWith.a, calWith.homeBonus, total)
    console.log(`  ${s}${CORONA_SEASONS.has(s) ? ' [CORONA]' : '          '}  ${fmt(m)}`)
  }

  const coreWithout = metricsFor(withoutSog, calWithout.a, calWithout.homeBonus, core)
  const coreWith = metricsFor(withSog, calWith.a, calWith.homeBonus, core)
  console.log('\n=== VERGLEICH (Core, ohne Corona, n=' + coreWithout.n + ') ===')
  console.log('Modell                                    | Accuracy | Brier  | LogLoss')
  console.log(`Power Ranking ELO-only (bisher)           | ${(coreWithout.accuracy * 100).toFixed(1)}%    | ${coreWithout.brier.toFixed(4)} | ${coreWithout.logloss.toFixed(4)}`)
  console.log(`Power Ranking ELO + SOG zugelassen (neu)  | ${(coreWith.accuracy * 100).toFixed(1)}%    | ${coreWith.brier.toFixed(4)} | ${coreWith.logloss.toFixed(4)}`)
  console.log(`Referenz: reines ELO+SOG-Modell (Backtest ohne Power-Score-Verdünnung durch Offense/Defense/Form) | 61.6% | 0.2316 | 0.6553`)

  fs.writeFileSync(path.join(__dirname, 'backtest-power-ranking-sog-integration-result.json'), JSON.stringify({
    weights: PROD_WEIGHTS,
    withoutSog: { cal: calWithout, metrics: { core: coreWithout, corona: metricsFor(withoutSog, calWithout.a, calWithout.homeBonus, corona), total: metricsFor(withoutSog, calWithout.a, calWithout.homeBonus, total) } },
    withSog: { cal: calWith, metrics: { core: coreWith, corona: metricsFor(withSog, calWith.a, calWith.homeBonus, corona), total: metricsFor(withSog, calWith.a, calWith.homeBonus, total) } },
  }, null, 2))
  console.log('\nDetails gespeichert: server/scripts/backtest-power-ranking-sog-integration-result.json')
}

main()
