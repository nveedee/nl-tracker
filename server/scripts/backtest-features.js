// ---------------------------------------------------------------------------
// Umfassender, leak-freier Walk-Forward-Backtest: welche zusätzlichen
// Informationen verbessern die Spielprognose gegenüber dem validierten
// Referenzmodell (ELO + SOG-Allowed) tatsächlich, out-of-sample?
//
// Read-only: verändert weder src/elo.js, src/powerRankings.js,
// src/playoffSim.js noch die historischen Rohdaten noch db.json/seed.json.
//
// Referenzmodell (unverändert repliziert, wie in server/scripts/backtest-h2h.js):
//   ELO: K=16 (Tiers), homeAdv=65, goalDiffFactor=0.7, OT .70/.30, SO .55/.45,
//   Saisonregression 25%. SOG-Allowed: weight=0.15, minGamesFullConfidence=10,
//   maxZScore=2.5, 400/ln(10)-Skalierung.
//
// Methodik: logit(p) = g*refLogitB + h*(feature/std) + c, g auf dem bereits
// kalibrierten Baseline-Optimum fixiert, h/c neu gefittet -> isoliert den
// Grenznutzen jedes einzelnen Features fair. Auswahl/Bewertung ausschliesslich
// auf den 7 Nicht-Corona-Saisons (Core). Alle Feature-Berechnungen sind
// strikt walk-forward: nur Daten aus VOR dem jeweiligen Spiel bereits
// gespielten Partien.
//
// Kategorie 6 (Absenzen/Lineup) wird NICHT getestet: SIHF-Boxscores haben
// keine "verletzt/gesperrt/aufgeboten"-Kennzeichnung. Ob ein Spieler in
// players.home/away fehlt, kann Verletzung, gesunder Skratch, Transfer oder
// Formationswechsel bedeuten - eine Unterscheidung wäre reine Spekulation
// (rückwirkend hineininterpretiert). Daher hier bewusst nicht getestet.
//
// Aufruf: node server/scripts/backtest-features.js
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
function secToNum(s) { // "MM:SS" -> Sekunden
  if (!s || typeof s !== 'string' || !s.includes(':')) return 0
  const [m, sec] = s.split(':').map(Number)
  return (m || 0) * 60 + (sec || 0)
}

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
        goalies: g.goalies || { home: [], away: [] },
        players: g.players || { home: [], away: [] },
      })
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  games.forEach((g, i) => { g.__idx = i })
  return games
}

// ============================================================================
// ELO + SOG-Allowed (unverändert, Produktiv-Parameter) - identisch zu
// server/scripts/backtest-h2h.js
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
// Feature-Zustand (pro Team, walk-forward über ALLE Saisons hinweg für
// "career"-Werte; Saison-Reset für saisongebundene Werte)
// ============================================================================

function newTeamSeasonState() {
  return {
    gp: 0, pts: 0, gf: 0, ga: 0,
    sogFor: 0, sogAgainst: 0,
    sogAgainstHome: 0, sogAgainstHomeGp: 0,
    sogAgainstAway: 0, sogAgainstAwayGp: 0,
    recent: [], // {pts, goalDiff, sog}  (max 10, für R/S last3/5/10)
    lastGameDate: null,
    recentDates: [], // Daten der letzten Spiele (für Rest-Features)
    awayStreak: 0,
    skatersSeason: new Map(), // key -> {toi, g, a, sog, gp}
  }
}

// Goalie-/Skater-"Karriere"-Historie läuft über alle Saisons (global), Key = Name+TeamId
function keyOf(name, teamId) { return name + '||' + teamId }

function main() {
  const games = loadGames()
  const eloSnapshots = computeEloSnapshots(games)
  const bySeason = groupBySeason(games)
  const sogAdjSnapshots = computeSogAdjSnapshots(bySeason, games.length)

  const teamSeasonState = new Map() // teamId -> current season state (reset per season)
  const goalieHistory = new Map() // key -> [{date, shotsAgainst, saves}] (career, chronological)
  const eloHistoryByTeam = new Map() // teamId -> [rating-before-each-game] (career, chronological, parallel zu recent games)

  let curSeason = null
  const rows = new Array(games.length)

  for (const g of games) {
    if (curSeason !== null && g.season !== curSeason) {
      teamSeasonState.clear() // Saison-Reset für alle saisongebundenen Werte
    }
    curSeason = g.season

    const H = teamSeasonState.get(g.homeId) || newTeamSeasonState()
    const A = teamSeasonState.get(g.awayId) || newTeamSeasonState()
    teamSeasonState.set(g.homeId, H)
    teamSeasonState.set(g.awayId, A)

    const elo = eloSnapshots[g.__idx], sogAdj = sogAdjSnapshots[g.__idx]
    const refLogitB = ((elo.home + sogAdj.home) + ELO.homeAdv - (elo.away + sogAdj.away)) * Math.LN10 / 400

    // === Torhüter: Starter dieses Spiels bestimmen (max secondsPlayed) ===
    function starterOf(goalieList, teamId) {
      let best = null
      for (const gk of goalieList || []) {
        const sec = secToNum(gk.secondsPlayed)
        if (!best || sec > best.sec) best = { name: gk.player, sec, shotsAgainst: num(gk.shotsAgainst), saves: num(gk.saves) }
      }
      return best
    }
    const starterH = starterOf(g.goalies.home, g.homeId)
    const starterA = starterOf(g.goalies.away, g.awayId)

    function goalieFeatures(starter, teamId) {
      if (!starter || starter.sec < 600) return { seasonSV: null, last5SV: null, last10SV: null, careerSV: null, shotsFacedPerGame: null, qualityGap: 0 }
      const key = keyOf(starter.name, teamId)
      const hist = goalieHistory.get(key) || []
      const sum = (arr) => arr.reduce((s, x) => s + x.saves, 0)
      const sumShots = (arr) => arr.reduce((s, x) => s + x.shotsAgainst, 0)
      const seasonHist = hist.filter((x) => x.season === g.season)
      const last5 = hist.slice(-5)
      const last10 = hist.slice(-10)
      const seasonSV = seasonHist.length >= 3 && sumShots(seasonHist) > 0 ? sum(seasonHist) / sumShots(seasonHist) : null
      const last5SV = last5.length >= 3 && sumShots(last5) > 0 ? sum(last5) / sumShots(last5) : null
      const last10SV = last10.length >= 5 && sumShots(last10) > 0 ? sum(last10) / sumShots(last10) : null
      const careerSV = hist.length >= 10 && sumShots(hist) > 0 ? sum(hist) / sumShots(hist) : null
      const seasonShots = sumShots(seasonHist)
      const shotsFacedPerGame = seasonHist.length > 0 ? seasonShots / seasonHist.length : null
      return { seasonSV, last5SV, last10SV, careerSV, shotsFacedPerGame }
    }
    const gfH = goalieFeatures(starterH, g.homeId)
    const gfA = goalieFeatures(starterA, g.awayId)

    // === Skater-basierte Team-Stärke (TOI-gewichtet, saison-to-date) ===
    function skaterFeatures(playerList, teamState) {
      // playerList: dieses Spiels players.home/away (für Top6/9-Ermittlung per TOI SO FAR)
      const candidates = (playerList || []).map((p) => {
        const key = p.player
        const hist = teamState.skatersSeason.get(key)
        return { key, position: p.playerPosition, toiSoFar: hist ? hist.toi : 0, gpSoFar: hist ? hist.gp : 0, hist }
      })
      const forwards = candidates.filter((c) => c.position === 'Stürmer').sort((a, b) => b.toiSoFar - a.toiSoFar)
      function ratePts60(list) {
        let toi = 0, pts = 0
        for (const c of list) { if (c.hist) { toi += c.hist.toi; pts += c.hist.g + c.hist.a } }
        return toi > 0 ? pts / (toi / 3600) : null
      }
      const top6 = ratePts60(forwards.slice(0, 6))
      const top9 = ratePts60(forwards.slice(0, 9))

      let toiAll = 0, ptsAll = 0, goalsAll = 0, sogAll = 0, pmAll = 0, gpMax = 0
      for (const [, s] of teamState.skatersSeason) {
        toiAll += s.toi; ptsAll += (s.g + s.a); goalsAll += s.g; sogAll += s.sog; pmAll += s.pm
        gpMax = Math.max(gpMax, s.gp)
      }
      const hours = toiAll / 3600
      return {
        ptsPer60: hours > 0.5 ? ptsAll / hours : null,
        goalsPer60: hours > 0.5 ? goalsAll / hours : null,
        sogPer60: hours > 0.5 ? sogAll / hours : null,
        plusMinusPer60: hours > 0.5 ? pmAll / hours : null,
        top6Pts60: top6, top9Pts60: top9,
        gp: gpMax,
      }
    }
    const skH = skaterFeatures(g.players.home, H)
    const skA = skaterFeatures(g.players.away, A)

    // === Recent Team Performance + ELO-Change ===
    function recentFeatures(teamState, teamId) {
      const r = teamState.recent
      const lastN = (n, key) => {
        const sub = r.slice(-n)
        return sub.length >= Math.min(n, 3) ? sub.reduce((s, x) => s + x[key], 0) / sub.length : null
      }
      const eloHist = eloHistoryByTeam.get(teamId) || []
      const eloChange = (n) => {
        if (eloHist.length < n + 1) return null
        return eloHist[eloHist.length - 1] - eloHist[eloHist.length - 1 - n]
      }
      return {
        pts3: lastN(3, 'pts'), pts5: lastN(5, 'pts'), pts10: lastN(10, 'pts'),
        diff3: lastN(3, 'goalDiff'), diff5: lastN(5, 'goalDiff'), diff10: lastN(10, 'goalDiff'),
        eloChange3: eloChange(3), eloChange5: eloChange(5), eloChange10: eloChange(10),
      }
    }
    const rH = recentFeatures(H, g.homeId)
    const rA = recentFeatures(A, g.awayId)

    // === SOG-Trend ===
    function sogFeatures(teamState, isHomeContext) {
      const r = teamState.recent
      const lastN = (n) => {
        const sub = r.slice(-n)
        return sub.length >= Math.min(n, 3) ? sub.reduce((s, x) => s + x.sog, 0) / sub.length : null
      }
      const seasonVal = teamState.gp >= 3 ? teamState.sogAgainst / teamState.gp : null
      const last5 = lastN(5)
      const trend = (last5 != null && teamState.gp >= 8) ? last5 - seasonVal : null
      const splitVal = isHomeContext
        ? (teamState.sogAgainstHomeGp >= 3 ? teamState.sogAgainstHome / teamState.sogAgainstHomeGp : null)
        : (teamState.sogAgainstAwayGp >= 3 ? teamState.sogAgainstAway / teamState.sogAgainstAwayGp : null)
      return { last3: lastN(3), last5, last10: lastN(10), season: seasonVal, trend, split: splitVal }
    }
    const sH = sogFeatures(H, true)
    const sA = sogFeatures(A, false)

    // === Rest/Belastung ===
    function restFeatures(teamState, currentDate) {
      const days = teamState.lastGameDate ? (new Date(currentDate) - new Date(teamState.lastGameDate)) / 86400000 : null
      const cappedDays = days == null ? null : Math.min(days, 10)
      const backToBack = days != null ? (days <= 1.5 ? 1 : 0) : null
      const cutoff7 = new Date(currentDate).getTime() - 7 * 86400000
      const cutoff14 = new Date(currentDate).getTime() - 14 * 86400000
      const games7 = teamState.recentDates.filter((d) => new Date(d).getTime() >= cutoff7).length
      const games14 = teamState.recentDates.filter((d) => new Date(d).getTime() >= cutoff14).length
      return { daysSince: cappedDays, backToBack, games7, games14, awayStreak: teamState.awayStreak }
    }
    const restH = restFeatures(H, g.date)
    const restA = restFeatures(A, g.date)

    // --- Zeile speichern (Diff home-away wo sinnvoll) ---
    rows[g.__idx] = {
      season: g.season, corona: g.corona, homeWon: g.homeGoals > g.awayGoals, refLogitB,
      g_seasonSV: diffOrNull(gfH.seasonSV, gfA.seasonSV),
      g_last5SV: diffOrNull(gfH.last5SV, gfA.last5SV),
      g_last10SV: diffOrNull(gfH.last10SV, gfA.last10SV),
      g_careerSV: diffOrNull(gfH.careerSV, gfA.careerSV),
      g_shotsFacedPerGame: diffOrNull(gfH.shotsFacedPerGame, gfA.shotsFacedPerGame),
      p_ptsPer60: diffOrNull(skH.ptsPer60, skA.ptsPer60),
      p_goalsPer60: diffOrNull(skH.goalsPer60, skA.goalsPer60),
      p_sogPer60: diffOrNull(skH.sogPer60, skA.sogPer60),
      p_plusMinusPer60: diffOrNull(skH.plusMinusPer60, skA.plusMinusPer60),
      p_top6Pts60: diffOrNull(skH.top6Pts60, skA.top6Pts60),
      p_top9Pts60: diffOrNull(skH.top9Pts60, skA.top9Pts60),
      r_pts3: diffOrNull(rH.pts3, rA.pts3), r_pts5: diffOrNull(rH.pts5, rA.pts5), r_pts10: diffOrNull(rH.pts10, rA.pts10),
      r_diff3: diffOrNull(rH.diff3, rA.diff3), r_diff5: diffOrNull(rH.diff5, rA.diff5), r_diff10: diffOrNull(rH.diff10, rA.diff10),
      r_eloChange3: diffOrNull(rH.eloChange3, rA.eloChange3), r_eloChange5: diffOrNull(rH.eloChange5, rA.eloChange5), r_eloChange10: diffOrNull(rH.eloChange10, rA.eloChange10),
      s_last3: diffOrNullInv(sH.last3, sA.last3), s_last5: diffOrNullInv(sH.last5, sA.last5), s_last10: diffOrNullInv(sH.last10, sA.last10),
      s_season: diffOrNullInv(sH.season, sA.season),
      s_trend: diffOrNullInv(sH.trend, sA.trend),
      s_split: diffOrNullInv(sH.split, sA.split),
      b_daysSince: diffOrNull(restH.daysSince, restA.daysSince),
      b_backToBack: diffOrNullInv(restH.backToBack, restA.backToBack),
      b_games7: diffOrNullInv(restH.games7, restA.games7),
      b_games14: diffOrNullInv(restH.games14, restA.games14),
      b_awayStreak: diffOrNullInv(restH.awayStreak, restA.awayStreak),
    }

    // === Update state (NACH Feature-Berechnung) ===
    function updateTeam(teamState, teamId, myGoals, oppGoals, isHome, sogFor, sogAgainst, playerList, goalieList, starter) {
      const won = myGoals > oppGoals
      const overtime = g.decision === 'OT' || g.decision === 'SO'
      const pts = overtime ? (won ? 2 : 1) : (won ? 3 : 0)
      teamState.gp++; teamState.pts += pts; teamState.gf += myGoals; teamState.ga += oppGoals
      teamState.sogFor += sogFor; teamState.sogAgainst += sogAgainst
      if (isHome) { teamState.sogAgainstHome += sogAgainst; teamState.sogAgainstHomeGp++ }
      else { teamState.sogAgainstAway += sogAgainst; teamState.sogAgainstAwayGp++ }
      teamState.recent.push({ pts, goalDiff: myGoals - oppGoals, sog: sogAgainst })
      if (teamState.recent.length > 10) teamState.recent.shift()
      teamState.lastGameDate = g.date
      teamState.recentDates.push(g.date)
      teamState.recentDates = teamState.recentDates.filter((d) => (new Date(g.date) - new Date(d)) <= 14 * 86400000)
      teamState.awayStreak = isHome ? 0 : teamState.awayStreak + 1

      for (const p of playerList || []) {
        const key = p.player
        const cur = teamState.skatersSeason.get(key) || { toi: 0, g: 0, a: 0, sog: 0, pm: 0, gp: 0 }
        cur.toi += secToNum(p.timeOnIce); cur.g += num(p.goals); cur.a += num(p.assists)
        cur.sog += num(p.shotsOnGoal); cur.pm += num(p.plusMinus); cur.gp++
        teamState.skatersSeason.set(key, cur)
      }
      if (starter) {
        const key = keyOf(starter.name, teamId)
        const hist = goalieHistory.get(key) || []
        hist.push({ date: g.date, season: g.season, shotsAgainst: starter.shotsAgainst, saves: starter.saves })
        goalieHistory.set(key, hist)
      }
      const eh = eloHistoryByTeam.get(teamId) || []
      eh.push(isHome ? elo.home : elo.away)
      eloHistoryByTeam.set(teamId, eh)
    }
    updateTeam(H, g.homeId, g.homeGoals, g.awayGoals, true, g.sogHome, g.sogAway, g.players.home, g.goalies.home, starterH)
    updateTeam(A, g.awayId, g.awayGoals, g.homeGoals, false, g.sogAway, g.sogHome, g.players.away, g.goalies.away, starterA)
  }

  return { rows, games }
}

function diffOrNull(h, a) { return (h == null || a == null) ? null : h - a }
function diffOrNullInv(h, a) { return (h == null || a == null) ? null : h - a } // Vorzeichen wird pro Feature bei Bedarf im Fit interpretiert

// ============================================================================
// Metriken + Kalibrierung (identisch zur Methodik in backtest-h2h.js)
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

function stdOf(rowsWithFeature, key) {
  const core = rowsWithFeature.filter(isCore)
  const mean = core.reduce((s, r) => s + r[key], 0) / core.length
  const variance = core.reduce((s, r) => s + (r[key] - mean) ** 2, 0) / core.length
  return Math.sqrt(variance) || 1
}

const G_GRID = [0.7, 0.85, 1.0, 1.15, 1.3]
const C_GRID = [-0.3, -0.15, 0, 0.15, 0.3]
function fitBaseline(rows) {
  let best = null
  for (const g of G_GRID) for (const c of C_GRID) {
    const predict = (r) => sigmoid(g * r.refLogitB + c)
    const m = metricsFor(rows, predict, isCore)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { g, c, m, score }
  }
  return best
}

const H_GRID = [-2, -1.5, -1, -0.6, -0.3, -0.15, 0, 0.15, 0.3, 0.6, 1, 1.5, 2]
function fitWithFeature(rows, baseG, featureKey, std) {
  let best = null
  for (const h of H_GRID) for (const c of C_GRID) {
    const predict = (r) => sigmoid(baseG * r.refLogitB + h * (r[featureKey] / std) + c)
    const m = metricsFor(rows, predict, isCore)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { h, c, m, score }
  }
  return best
}

function fmt(m) { return m ? `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}` : 'n/a' }

// ============================================================================
// RUN
// ============================================================================

const { rows: allRows } = main()

console.log(`Geladen: ${allRows.length} Spiele (Core ohne Corona: ${allRows.filter(isCore).length})`)

const baseB = fitBaseline(allRows)
console.log('\n=== BASELINE B: ELO + SOG-Allowed ===')
console.log(`g=${baseB.g} c=${baseB.c}  Core: ${fmt(baseB.m)}`)

const FEATURES = {
  // Kategorie 1: Torhüter
  g_seasonSV: 'Torhüter: Saison-SV%', g_last5SV: 'Torhüter: letzte 5 Sp. SV%', g_last10SV: 'Torhüter: letzte 10 Sp. SV%',
  g_careerSV: 'Torhüter: Karriere-SV%', g_shotsFacedPerGame: 'Torhüter: Shots faced/Spiel',
  // Kategorie 2: Spielerstärke
  p_ptsPer60: 'Kader: Punkte/60', p_goalsPer60: 'Kader: Tore/60', p_sogPer60: 'Kader: SOG/60',
  p_plusMinusPer60: 'Kader: +/-/60 (Defensiv-Proxy)', p_top6Pts60: 'Kader: Top-6-Stürmer Pkt/60', p_top9Pts60: 'Kader: Top-9-Stürmer Pkt/60',
  // Kategorie 3: Recent Form
  r_pts3: 'Form: Pkt/Sp. letzte 3', r_pts5: 'Form: Pkt/Sp. letzte 5', r_pts10: 'Form: Pkt/Sp. letzte 10',
  r_diff3: 'Form: Tordiff. letzte 3', r_diff5: 'Form: Tordiff. letzte 5', r_diff10: 'Form: Tordiff. letzte 10',
  r_eloChange3: 'Form: ELO-Änderung letzte 3', r_eloChange5: 'Form: ELO-Änderung letzte 5', r_eloChange10: 'Form: ELO-Änderung letzte 10',
  // Kategorie 4: SOG-Trend
  s_last3: 'SOG-Allowed letzte 3', s_last5: 'SOG-Allowed letzte 5', s_last10: 'SOG-Allowed letzte 10',
  s_season: 'SOG-Allowed Saisonwert (roh)', s_trend: 'SOG-Allowed Trend (letzte5 - Saison)', s_split: 'SOG-Allowed Heim/Auswärts-Split',
  // Kategorie 5: Rest/Belastung
  b_daysSince: 'Rest: Tage seit letztem Spiel', b_backToBack: 'Rest: Back-to-Back', b_games7: 'Rest: Spiele letzte 7 Tage',
  b_games14: 'Rest: Spiele letzte 14 Tage', b_awayStreak: 'Rest: Auswärtsspiel-Serie',
}

console.log(`\n=== EINZELFEATURES (${Object.keys(FEATURES).length}) - Modell C: Baseline + Feature ===`)
const results = []
for (const [key, label] of Object.entries(FEATURES)) {
  const rowsWithFeature = allRows.filter((r) => r[key] != null)
  const coverage = rowsWithFeature.length / allRows.length
  if (rowsWithFeature.filter(isCore).length < 200) {
    results.push({ key, label, skipped: true, coverage })
    continue
  }
  const std = stdOf(rowsWithFeature, key)
  const fit = fitWithFeature(rowsWithFeature, baseB.g, key, std)
  const localBase = metricsFor(rowsWithFeature, (r) => sigmoid(baseB.g * r.refLogitB + baseB.c), isCore)
  const dLogloss = fit.m.logloss - localBase.logloss
  const dBrier = fit.m.brier - localBase.brier
  results.push({ key, label, coverage, std, fit, localBase, dLogloss, dBrier })
}

results.sort((a, b) => {
  if (a.skipped && b.skipped) return 0
  if (a.skipped) return 1
  if (b.skipped) return 0
  return (a.dLogloss + a.dBrier) - (b.dLogloss + b.dBrier)
})

console.log('\nRanking (bester Nutzen zuerst):')
console.log('Feature                                   | Abdeckung | h     | ΔLogLoss | ΔBrier  | Acc   | LogLoss | Brier')
for (const r of results) {
  if (r.skipped) { console.log(`${r.label.padEnd(42)} | ${(r.coverage * 100).toFixed(0)}%       | ÜBERSPRUNGEN (zu wenig Datenabdeckung, n<200)`); continue }
  console.log(`${r.label.padEnd(42)} | ${(r.coverage * 100).toFixed(0).padStart(8)}% | ${r.fit.h.toFixed(2).padStart(5)} | ${r.dLogloss >= 0 ? '+' : ''}${r.dLogloss.toFixed(4)} | ${r.dBrier >= 0 ? '+' : ''}${r.dBrier.toFixed(4)} | ${(r.fit.m.accuracy * 100).toFixed(1)}% | ${r.fit.m.logloss.toFixed(4)} | ${r.fit.m.brier.toFixed(4)}`)
}

// --- Stabilitätscheck für alle Features mit |ΔLogLoss| > 0.0005 (jenseits Rausch-Schwelle) ---
const THRESHOLD = 0.0005
const notable = results.filter((r) => !r.skipped && r.dLogloss < -THRESHOLD)
console.log(`\n=== STABILITÄTSCHECK (Features mit ΔLogLoss < -${THRESHOLD}, jenseits der Rausch-Schwelle) ===`)
if (notable.length === 0) {
  console.log('Keine Features überschreiten die Rausch-Schwelle von 0.0005 LogLoss-Verbesserung.')
} else {
  for (const r of notable) {
    const rowsWithFeature = allRows.filter((x) => x[r.key] != null)
    const predict = (x) => sigmoid(baseB.g * x.refLogitB + r.fit.h * (x[r.key] / r.std) + r.fit.c)
    const predictBase = (x) => sigmoid(baseB.g * x.refLogitB + baseB.c)
    const seasons = [...new Set(rowsWithFeature.map((x) => x.season))].sort()
    let improved = 0, coreCount = 0
    console.log(`\n${r.label} (${r.key}):`)
    for (const s of seasons) {
      const seasonRows = rowsWithFeature.filter((x) => x.season === s)
      if (seasonRows.length < 20) continue
      const mB = metricsFor(seasonRows, predictBase, isAll)
      const mF = metricsFor(seasonRows, predict, isAll)
      const d = mF.logloss - mB.logloss
      const corona = CORONA_SEASONS.has(s)
      if (!corona) { coreCount++; if (d < 0) improved++ }
      console.log(`  ${s}${corona ? ' [CORONA]' : '         '} Δlogloss=${d >= 0 ? '+' : ''}${d.toFixed(4)}`)
    }
    console.log(`  -> Verbesserung in ${improved}/${coreCount} Nicht-Corona-Saisons.`)
  }
}

// --- Modell D: Greedy Forward Selection aus den Kandidaten, die die Schwelle überschreiten ---
console.log('\n=== MODELL D: Greedy-Kombination der besten Features ===')
let chosen = []
let remaining = notable.map((r) => r.key)
let currentScore = baseB.m.logloss + baseB.m.brier
let currentPredict = (r) => sigmoid(baseB.g * r.refLogitB + baseB.c)
console.log(`Start (Baseline B): logloss=${baseB.m.logloss.toFixed(4)} brier=${baseB.m.brier.toFixed(4)}`)

let improvedRound = true
while (improvedRound && remaining.length > 0) {
  improvedRound = false
  let bestCandidate = null
  for (const key of remaining) {
    const std = results.find((r) => r.key === key).std
    let bestForKey = null
    for (const h of H_GRID) for (const c of C_GRID) {
      const predict = (r) => {
        if (r[key] == null) return currentPredict(r)
        let z = baseB.g * r.refLogitB + c
        for (const t of chosen) z += t.h * ((r[t.key] ?? 0) / t.std)
        z += h * (r[key] / std)
        return sigmoid(z)
      }
      const testRows = allRows.filter((r) => r[key] != null && chosen.every((t) => r[t.key] != null))
      const m = metricsFor(testRows, predict, isCore)
      const score = m.logloss + m.brier
      if (!bestForKey || score < bestForKey.score) bestForKey = { h, c, m, score, key, std }
    }
    if (!bestCandidate || bestForKey.score < bestCandidate.score) bestCandidate = bestForKey
  }
  const relImprovement = (currentScore - bestCandidate.score) / currentScore
  if (relImprovement > 0.0005) {
    chosen.push({ key: bestCandidate.key, h: bestCandidate.h, std: bestCandidate.std })
    currentScore = bestCandidate.score
    remaining.splice(remaining.indexOf(bestCandidate.key), 1)
    const label = FEATURES[bestCandidate.key]
    console.log(`+ ${label} (${bestCandidate.key}, h=${bestCandidate.h}) -> logloss=${bestCandidate.m.logloss.toFixed(4)} brier=${bestCandidate.m.brier.toFixed(4)} acc=${(bestCandidate.m.accuracy * 100).toFixed(1)}%`)
    improvedRound = true
  }
}
if (chosen.length === 0) console.log('Kein Feature verbesserte die Kombination um mehr als 0.05% relativ -> Baseline B bleibt bestes Modell.')

// --- Finale Vergleichstabelle ---
const finalPredict = (r) => {
  let z = baseB.g * r.refLogitB + baseB.c
  for (const t of chosen) z += t.h * ((r[t.key] ?? 0) / t.std)
  return sigmoid(z)
}
const finalRows = allRows.filter((r) => chosen.every((t) => r[t.key] != null))
console.log('\n=== VERGLEICH: Baseline (ELO+SOG) vs. Modell D (Core, ohne Corona) ===')
console.log('Modell     | n    | Accuracy | Brier  | LogLoss')
console.log(`Baseline B | ${baseB.m.n} | ${(baseB.m.accuracy * 100).toFixed(1)}%    | ${baseB.m.brier.toFixed(4)} | ${baseB.m.logloss.toFixed(4)}`)
const finalCore = metricsFor(finalRows, finalPredict, isCore)
console.log(`Modell D   | ${finalCore.n} | ${(finalCore.accuracy * 100).toFixed(1)}%    | ${finalCore.brier.toFixed(4)} | ${finalCore.logloss.toFixed(4)}`)
console.log('\nGesamt (9 Saisons) / Corona separat:')
console.log('Baseline B:', fmt(metricsFor(allRows, (r) => sigmoid(baseB.g * r.refLogitB + baseB.c), isAll)), ' | Corona:', fmt(metricsFor(allRows, (r) => sigmoid(baseB.g * r.refLogitB + baseB.c), isCorona)))
console.log('Modell D:  ', fmt(metricsFor(finalRows, finalPredict, isAll)), ' | Corona:', fmt(metricsFor(finalRows, finalPredict, isCorona)))

fs.writeFileSync(path.join(__dirname, 'backtest-features-result.json'), JSON.stringify({
  baseline: { g: baseB.g, c: baseB.c, m: baseB.m },
  featureRanking: results.map((r) => r.skipped ? { key: r.key, label: r.label, skipped: true } : { key: r.key, label: r.label, coverage: r.coverage, std: r.std, h: r.fit.h, c: r.fit.c, m: r.fit.m, dLogloss: r.dLogloss, dBrier: r.dBrier }),
  modelD: { chosen: chosen.map((c) => ({ key: c.key, h: c.h })), m: finalCore },
}, null, 2))
console.log('\nDetails gespeichert: server/scripts/backtest-features-result.json')
