// ---------------------------------------------------------------------------
// Backtest: hilft eine "Pre-Season-ELO" (Übertrag des Saisonend-ELO der
// Vorsaison, regressiert Richtung 1500) und/oder H2H-Kontext die Prognose
// AM SAISONANFANG, verglichen mit dem Status quo?
//
// STATUS QUO / PROBLEM (siehe User-Auftrag): Die produktive App berechnet
// computeElo() ausschliesslich über die Spiele der jeweils LAUFENDEN Saison
// (server/data/db.json enthält immer nur eine Saison; die historischen
// Archiv-Saisons unter server/data/historical/ sind damit NICHT verknüpft).
// Für eine neue Saison bedeutet das faktisch: alle Teams starten bei 1500,
// unabhängig von ihrer Vorsaison-Stärke - EGAL was src/elo.js' eigener
// `seasonEndRegression`-Parameter (0.25) theoretisch vorsieht, denn dieser
// greift nur, wenn `season`-Felder über Saisongrenzen hinweg im selben
// games-Array vorkommen, was in der Live-App aktuell nie der Fall ist.
//
// Modell A ("bisheriges Modell") wird deshalb in diesem Backtest als
// regressionFraction = 1.0 (= voller Reset auf 1500 bei jedem Saisonwechsel)
// simuliert - das repliziert exakt das reale Live-Verhalten für eine neue
// Saison, nicht die (hier nie wirksame) 0.25-Konfiguration aus elo.js.
// Modell B ("Pre-Season-ELO") testet die vom User verlangten Regressions-
// stufen [0, 10, 20, 25, 30, 40, 50%] als Ersatz für diesen vollen Reset -
// mit exakt derselben ELO-Formel (K-Tiers, Heimvorteil, Torunterschied,
// OT/SO-Gewichtung) wie src/elo.js, nur die Saisonübergangs-Regression
// unterscheidet sich. Keine neue Prognoseformel, keine Information aus der
// jeweils neuen Saison fliesst in den Pre-Season-Wert ein (strikt leak-frei:
// die Prognose für Spiel N wird IMMER vor dessen ELO-Update berechnet, und
// die Saisonübergangs-Regression wird IMMER vor dem ersten Spiel der neuen
// Saison angewendet).
//
// SOG-zugelassen-Adjustierung: unverändert aus src/powerRankings.js /
// server/scripts/backtest-h2h.js übernommen (weight=0.15, minGamesFull=10,
// maxZScore=2.5).
//
// H2H-Feature-Konstruktion (Varianten A-D aus dem User-Auftrag):
//   A) Sieg-Differenz          -> Feature "won01" (zentriert um 0.5)
//   B) Tordifferenz            -> Feature "goalDiff"
//   C) H2H-vs-ELO-Residual     -> Feature "surprise" (tatsächliches Ergebnis
//                                  minus ELO+SOG-Erwartung ZUM JEWEILIGEN
//                                  historischen Zeitpunkt)
//   D) Heim-H2H                -> nur Duelle mit gleicher Heim/Auswärts-
//                                  Konstellation wie das zu prognostizierende
//                                  Spiel ("homeAway"-Variante der Features A-C)
// Jede Variante wird über 6 Zeitfenster (last3/5/10, exponentiell gewichtet
// mit Decay 1.0/0.85/0.7), 6 Shrinkage-Stärken (0/3/5/10/15/20) und 4
// Mindestanzahl-Duelle-Schwellen (0=kein Gate/3/5/10) getestet - bei zu
// wenigen Duellen wird das Feature hart auf 0 gesetzt (zusätzlich zur
// Shrinkage, die stetig Richtung 0 zieht).
//
// Getestete Modellkombinationen (Kalibrierung: logit(p) = g*baseLogit +
// h*(feature/std) + c, per Grid-Search - identische Methodik wie
// server/scripts/backtest-h2h.js):
//   A) bisheriges ELO (regressionFraction=1.0)
//   B) Pre-Season-ELO (beste Regressionsstufe)
//   C) Pre-Season-ELO + statischer Saisonstart-Term (zusätzlich zum
//      laufenden, sich innerhalb der Saison weiterentwickelnden ELO)
//   D) Pre-Season-ELO + SOG-Allowed
//   E) Pre-Season-ELO + SOG-Allowed + H2H (bestes H2H-Feature)
//   F) bisheriges ELO + SOG-Allowed + H2H (Kontrolle: H2H ohne Pre-Season)
//
// Bewertung zusätzlich nach Saisonanteil (erste 10/20/30% vs. Rest der
// Saison) sowie pro Saison (Corona-Saisons 2019/20 + 2020/21 separat
// ausgewiesen, nicht zur Modellauswahl verwendet).
//
// Read-only: verändert weder src/elo.js, src/powerRankings.js, src/
// playoffSim.js noch die historischen Rohdaten noch db.json/seed.json.
//
// Aufruf: node server/scripts/backtest-preseason-h2h.js
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'historical')
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json')

const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]
const CORONA_SEASONS = new Set(['2019/20', '2020/21'])

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

// ============================================================================
// 1. Daten laden
// ============================================================================

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
        homeName: g.homeTeam.name, awayName: g.awayTeam.name,
        homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision,
        sogHome: num(sog.home), sogAway: num(sog.away),
      })
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  games.forEach((g, i) => { g.__idx = i })

  // Position innerhalb der Saison (chronologisch, 0-basiert) + Saisongrösse,
  // fürs Bucketing "erste X% der Saison".
  const perSeasonCount = new Map()
  for (const g of games) perSeasonCount.set(g.season, (perSeasonCount.get(g.season) || 0) + 1)
  const perSeasonRunning = new Map()
  for (const g of games) {
    const idx = perSeasonRunning.get(g.season) || 0
    g.seasonGameIndex = idx
    g.seasonTotalGames = perSeasonCount.get(g.season)
    g.seasonFraction = idx / g.seasonTotalGames
    perSeasonRunning.set(g.season, idx + 1)
  }
  return games
}

// ============================================================================
// 2. ELO-Engine (Produktiv-Parameter aus src/elo.js, Regression parametrisiert)
// ============================================================================

const ELO = {
  start: 1500, baseK: 16, homeAdv: 65, goalDiffFactor: 0.7,
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

// Leak-freier Walk-Forward über ALLE Spiele mit gegebener Saisonübergangs-
// Regression. Liefert pro Spiel die PRE-GAME-Ratings (nie das Ergebnis
// dieses Spiels selbst) + eine Map season -> teamId -> Rating-zu-Saisonbeginn
// (für den statischen Pre-Season-Term in Modell C).
function computeEloSnapshots(games, regressionFraction) {
  const ratings = new Map(), gp = new Map()
  let curSeason = null
  const snaps = new Array(games.length)
  const seasonStartRatings = new Map() // season -> Map(teamId -> rating)

  for (const g of games) {
    if (curSeason !== null && g.season !== curSeason) {
      for (const [id, r] of ratings) ratings.set(id, ELO.start + (r - ELO.start) * (1 - regressionFraction))
    }
    if (!seasonStartRatings.has(g.season)) {
      // Schnappschuss ALLER bis dahin bekannten Teams zu Saisonbeginn (vor
      // dem ersten Spiel der Saison) - Teams ohne Eintrag starten bei 1500.
      seasonStartRatings.set(g.season, new Map(ratings))
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
  return { snaps, seasonStartRatings, finalRatings: ratings }
}

function seasonStartRatingOf(seasonStartRatings, season, teamId) {
  const m = seasonStartRatings.get(season)
  return (m && m.get(teamId)) ?? ELO.start
}

// ============================================================================
// 3. SOG-zugelassen-Adjustierung (unverändert, Produktiv-Parameter)
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
// 4. H2H-Historie (leak-frei, paarungsspezifisch) + Feature-Extraktion
// ============================================================================

const WINDOWS = [
  { key: 'last3', type: 'lastN', n: 3 },
  { key: 'last5', type: 'lastN', n: 5 },
  { key: 'last10', type: 'lastN', n: 10 },
  { key: 'allEqual', type: 'decay', decay: 1.0 },
  { key: 'decay85', type: 'decay', decay: 0.85 },
  { key: 'decay70', type: 'decay', decay: 0.7 },
]
const SHRINK_K = [0, 3, 5, 10, 15, 20]
const MIN_GAMES = [0, 3, 5, 10]

// Orientiert einen vergangenen Duell-Eintrag auf Team A (heutiges Heimteam).
function orientMeeting(m, A) {
  const aWasHome = m.homeId === A
  const homeWon = m.homeGoals > m.awayGoals
  const scoreHome = eloResultScore(homeWon, m.decision)
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
function gated(value, n, minGames) { return n >= minGames ? value : 0 }

// Baut pro Spiel eine flache Feature-Zeile: H2H-Varianten (Feature x Fenster
// x Shrinkage x Mindestanzahl) + Referenz-Logits für alle Baseline-Modelle.
// `refPHomeSnapshots` liefert die ELO+SOG-Erwartung zum jeweiligen
// historischen Zeitpunkt (für Feature C: H2H-vs-ELO-Residual).
function buildFeatureRows(games, snapsA, snapsPre, sogAdj, seasonStartRatings) {
  const rows = new Array(games.length)
  const pairHistory = new Map()

  for (const g of games) {
    const eA = snapsA[g.__idx]      // bisheriges ELO (regression=1.0), pre-game
    const eB = snapsPre[g.__idx]    // Pre-Season-ELO (beste Regression), pre-game
    const sAdj = sogAdj[g.__idx]

    const refLogitA = (eA.home + ELO.homeAdv - eA.away) * Math.LN10 / 400
    const refLogitB = (eB.home + ELO.homeAdv - eB.away) * Math.LN10 / 400
    const refLogitD = ((eB.home + sAdj.home) + ELO.homeAdv - (eB.away + sAdj.away)) * Math.LN10 / 400
    const refLogitF = ((eA.home + sAdj.home) + ELO.homeAdv - (eA.away + sAdj.away)) * Math.LN10 / 400

    // Statischer Pre-Season-Term (Modell C): Saisonstart-Rating-Diff, bleibt
    // über die ganze Saison konstant - im Gegensatz zu refLogitB, das sich
    // laufend mit jedem Spiel weiterentwickelt.
    const ssHome = seasonStartRatingOf(seasonStartRatings, g.season, g.homeId)
    const ssAway = seasonStartRatingOf(seasonStartRatings, g.season, g.awayId)
    const preSeasonStaticLogit = (ssHome - ssAway) * Math.LN10 / 400

    const pairKey = [g.homeId, g.awayId].slice().sort().join('|')
    const hist = pairHistory.get(pairKey) || []
    const oriented = hist.map((m) => orientMeeting(m, g.homeId))
    const sameVenueOnly = oriented.filter((x) => x.sameVenue)

    const row = {
      season: g.season, corona: g.corona, homeWon: g.homeGoals > g.awayGoals,
      seasonFraction: g.seasonFraction,
      refLogitA, refLogitB, refLogitD, refLogitF, preSeasonStaticLogit,
      h2hCount: oriented.length,
    }

    for (const [prefix, list] of [['', oriented], ['homeAway__', sameVenueOnly]]) {
      for (const w of WINDOWS) {
        for (const featKey of ['won01', 'goalDiff', 'pts', 'surprise']) {
          const { mean, n } = windowedMean(list, featKey, w)
          const centered = featKey === 'won01' ? mean - 0.5 : mean
          const shrunk = k => shrink(centered, n, k)
          for (const k of SHRINK_K) {
            for (const mg of MIN_GAMES) {
              row[`${prefix}${featKey}__${w.key}__k${k}__m${mg}`] = gated(shrunk(k), n, mg)
            }
          }
        }
      }
    }

    rows[g.__idx] = row

    // ELO+SOG-Erwartung zum JETZIGEN Zeitpunkt als Referenz für künftige
    // "surprise"-Berechnungen dieser Paarung (leak-frei: nur pre-game-Werte).
    hist.push({ homeId: g.homeId, awayId: g.awayId, homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision, pHomeAtTime: sigmoid(refLogitD) })
    pairHistory.set(pairKey, hist)
  }
  return rows
}

// ============================================================================
// 5. Metriken + Kalibrierung
// ============================================================================

const isCore = (r) => !r.corona
const isCorona = (r) => r.corona
const isAll = () => true
const inFirst = (frac) => (r) => !r.corona && r.seasonFraction < frac
const isRest = (r) => !r.corona && r.seasonFraction >= 0.30

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

const G_GRID = [0.7, 0.85, 1.0, 1.15, 1.3]
const C_GRID = [-0.3, -0.15, 0, 0.15, 0.3]
const H_GRID = [-2, -1.5, -1, -0.6, -0.3, -0.15, 0, 0.15, 0.3, 0.6, 1, 1.5, 2]

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

// Isoliert den Grenznutzen EINES zusätzlichen Terms: g (Basis) fix auf dem
// bereits kalibrierten Optimum, nur der neue Term (h) + Konstante (c) neu.
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

function fmt(m) { return m ? `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}` : 'n/a' }

// ============================================================================
// 6. MAIN
// ============================================================================

function main() {
  const t0 = Date.now()
  const games = loadGames()
  const seasons = [...new Set(games.map((g) => g.season))].sort()
  console.log(`Geladen: ${games.length} Spiele, ${seasons.length} Saisons: ${seasons.join(', ')}`)

  // --- Schritt 1: Pre-Season-ELO-Regressionsraster ---
  const REGRESSION_GRID = [0, 0.10, 0.20, 0.25, 0.30, 0.40, 0.50]
  console.log('\n=== SCHRITT 1: PRE-SEASON-ELO REGRESSIONSRASTER ===')
  console.log('Baseline (Modell A, "bisheriges Modell") = regressionFraction 1.0 (voller Reset auf 1500 bei Saisonwechsel - repliziert das reale Live-Verhalten, siehe Skriptkopf).\n')

  const { snaps: snapsA } = computeEloSnapshots(games, 1.0)
  const baseA = fitBaseline(
    games.map((g, i) => ({ ...g, refLogitA: (snapsA[i].home + ELO.homeAdv - snapsA[i].away) * Math.LN10 / 400, homeWon: g.homeGoals > g.awayGoals })),
    'refLogitA'
  )
  console.log(`Modell A (bisheriges ELO): g=${baseA.g} c=${baseA.c}  Core: ${fmt(baseA.m)}`)

  const regressionResults = []
  for (const rf of REGRESSION_GRID) {
    const { snaps } = computeEloSnapshots(games, rf)
    const rowsTmp = games.map((g, i) => ({ ...g, refLogit: (snaps[i].home + ELO.homeAdv - snaps[i].away) * Math.LN10 / 400, homeWon: g.homeGoals > g.awayGoals }))
    const fit = fitBaseline(rowsTmp, 'refLogit')
    regressionResults.push({ rf, fit })
    console.log(`  Regression ${(rf * 100).toFixed(0).padStart(3)}%  g=${fit.g}  c=${fit.c}  Core: ${fmt(fit.m)}`)
  }
  regressionResults.sort((a, b) => a.fit.score - b.fit.score)
  const bestRegression = regressionResults[0].rf
  const baseB = regressionResults[0].fit
  console.log(`\n-> Beste Regressionsstufe: ${(bestRegression * 100).toFixed(0)}%  (Core LogLoss ${baseB.m.logloss.toFixed(4)} vs. Modell A ${baseA.m.logloss.toFixed(4)}, Δ=${(baseB.m.logloss - baseA.m.logloss).toFixed(4)})`)

  const { snaps: snapsB, seasonStartRatings } = computeEloSnapshots(games, bestRegression)

  // --- Schritt 2: SOG-Adjustierung + Feature-Zeilen bauen ---
  const bySeason = groupBySeason(games)
  const sogAdj = computeSogAdjSnapshots(bySeason, games.length)
  const rows = buildFeatureRows(games, snapsA, snapsB, sogAdj, seasonStartRatings)

  const baseD = fitBaseline(rows, 'refLogitD') // Pre-Season-ELO + SOG
  const baseF = fitBaseline(rows, 'refLogitF') // bisheriges ELO + SOG
  console.log('\n=== MODELL D (Pre-Season-ELO + SOG-Allowed) ===')
  console.log(`g=${baseD.g} c=${baseD.c}  Core: ${fmt(baseD.m)}`)
  console.log('=== MODELL F-Basis (bisheriges ELO + SOG-Allowed, ohne H2H) ===')
  console.log(`g=${baseF.g} c=${baseF.c}  Core: ${fmt(baseF.m)}`)

  // --- Schritt 3: Modell C (Pre-Season-ELO + statischer Saisonstart-Term) ---
  const stdStatic = stdOf(rows, 'preSeasonStaticLogit')
  const fitC = fitWithFeature(rows, 'refLogitB', baseB.g, 'preSeasonStaticLogit', stdStatic)
  console.log('\n=== MODELL C (Pre-Season-ELO + zusätzlicher statischer Saisonstart-Term) ===')
  console.log(`h=${fitC.h} c=${fitC.c}  Core: ${fmt(fitC.m)}  (vs. Modell B: Δ=${(fitC.m.logloss - baseB.m.logloss).toFixed(4)})`)

  // --- Schritt 4: H2H-Grid-Search auf Basis D (Pre-Season+SOG) und F (bisherig+SOG) ---
  const featureKeys = []
  for (const prefix of ['', 'homeAway__']) {
    for (const w of WINDOWS) for (const f of ['won01', 'goalDiff', 'pts', 'surprise']) for (const k of SHRINK_K) for (const mg of MIN_GAMES) {
      featureKeys.push(`${prefix}${f}__${w.key}__k${k}__m${mg}`)
    }
  }
  console.log(`\n=== SCHRITT 4: H2H GRID SEARCH (${featureKeys.length} Varianten × 2 Basismodelle) ===`)
  const t1 = Date.now()
  const resultsE = [] // Pre-Season-ELO + SOG + H2H
  const resultsF = [] // bisheriges ELO + SOG + H2H (Kontrolle, kein Pre-Season)
  for (const fk of featureKeys) {
    const std = stdOf(rows, fk)
    if (std === 0 || !Number.isFinite(std)) continue
    const fitE = fitWithFeature(rows, 'refLogitD', baseD.g, fk, std)
    const fitF = fitWithFeature(rows, 'refLogitF', baseF.g, fk, std)
    resultsE.push({ feature: fk, std, fit: fitE })
    resultsF.push({ feature: fk, std, fit: fitF })
  }
  resultsE.sort((a, b) => a.fit.score - b.fit.score)
  resultsF.sort((a, b) => a.fit.score - b.fit.score)
  console.log(`Getestet in ${Date.now() - t1}ms`)

  const bestE = resultsE[0]
  const bestF = resultsF[0]
  console.log('\n=== TOP 10 H2H-FEATURES: MODELL E (Pre-Season-ELO + SOG + H2H) ===')
  for (let i = 0; i < 10; i++) {
    const r = resultsE[i]
    console.log(`#${i + 1} ${r.feature.padEnd(34)} h=${r.fit.h.toFixed(2).padStart(5)}  ${fmt(r.fit.m)}  ΔLogLoss vs D=${(r.fit.m.logloss - baseD.m.logloss).toFixed(4)}`)
  }
  console.log('\n=== TOP 10 H2H-FEATURES: MODELL F (bisheriges ELO + SOG + H2H, Kontrolle) ===')
  for (let i = 0; i < 10; i++) {
    const r = resultsF[i]
    console.log(`#${i + 1} ${r.feature.padEnd(34)} h=${r.fit.h.toFixed(2).padStart(5)}  ${fmt(r.fit.m)}  ΔLogLoss vs F-Basis=${(r.fit.m.logloss - baseF.m.logloss).toFixed(4)}`)
  }

  // Durchschnittliche H2H-Stichprobengrösse des besten Features (Overfitting-Check)
  const bestEFeatureH2hCounts = rows.filter(isCore).map((r) => r.h2hCount)
  const avgH2hCount = bestEFeatureH2hCounts.reduce((s, x) => s + x, 0) / bestEFeatureH2hCounts.length
  const withAnyH2h = bestEFeatureH2hCounts.filter((x) => x > 0).length
  console.log(`\nH2H-Abdeckung: Ø ${avgH2hCount.toFixed(2)} vorherige Duelle/Spiel, ${((withAnyH2h / bestEFeatureH2hCounts.length) * 100).toFixed(1)}% der Spiele haben >=1 vorheriges Duell.`)

  // --- Schritt 5: Stabilität pro Saison (Modelle A/B/D/bestE/bestF) ---
  const predictA = (r) => sigmoid(baseA.g * r.refLogitA + baseA.c)
  const predictB = (r) => sigmoid(baseB.g * r.refLogitB + baseB.c)
  const predictC = (r) => sigmoid(baseB.g * r.refLogitB + fitC.h * (r.preSeasonStaticLogit / stdStatic) + fitC.c)
  const predictD = (r) => sigmoid(baseD.g * r.refLogitD + baseD.c)
  const predictE = (r) => sigmoid(baseD.g * r.refLogitD + bestE.fit.h * (r[bestE.feature] / bestE.std) + bestE.fit.c)
  const predictF = (r) => sigmoid(baseF.g * r.refLogitF + bestF.fit.h * (r[bestF.feature] / bestF.std) + bestF.fit.c)
  const predictFBase = (r) => sigmoid(baseF.g * r.refLogitF + baseF.c)

  console.log('\n=== SCHRITT 5: STABILITÄT PRO SAISON (LogLoss) ===')
  console.log('Saison        | A(bisherig) | B(PreSeason) | D(PreSeason+SOG) | E(+H2H)  | F-Basis(bisherig+SOG) | F(+H2H)')
  let improvedBvsA = 0, improvedEvsD = 0, improvedFvsFBase = 0, coreSeasonCount = 0
  for (const s of seasons) {
    const seasonRows = rows.filter((r) => r.season === s)
    const mA = metricsFor(seasonRows, predictA, isAll)
    const mB = metricsFor(seasonRows, predictB, isAll)
    const mD = metricsFor(seasonRows, predictD, isAll)
    const mE = metricsFor(seasonRows, predictE, isAll)
    const mFBase = metricsFor(seasonRows, predictFBase, isAll)
    const mF = metricsFor(seasonRows, predictF, isAll)
    const corona = CORONA_SEASONS.has(s)
    if (!corona) {
      coreSeasonCount++
      if (mB.logloss < mA.logloss) improvedBvsA++
      if (mE.logloss < mD.logloss) improvedEvsD++
      if (mF.logloss < mFBase.logloss) improvedFvsFBase++
    }
    console.log(`${s}${corona ? ' [CORONA]' : '         '} | ${mA.logloss.toFixed(4)}      | ${mB.logloss.toFixed(4)}       | ${mD.logloss.toFixed(4)}           | ${mE.logloss.toFixed(4)}  | ${mFBase.logloss.toFixed(4)}                | ${mF.logloss.toFixed(4)}`)
  }
  console.log(`\nB besser als A in ${improvedBvsA}/${coreSeasonCount} Nicht-Corona-Saisons.`)
  console.log(`E besser als D (H2H-Zusatznutzen mit Pre-Season) in ${improvedEvsD}/${coreSeasonCount} Nicht-Corona-Saisons.`)
  console.log(`F besser als F-Basis (H2H-Zusatznutzen ohne Pre-Season) in ${improvedFvsFBase}/${coreSeasonCount} Nicht-Corona-Saisons.`)

  // --- Schritt 6: Saisonanteil-Analyse (das Kernstück dieses Backtests) ---
  console.log('\n=== SCHRITT 6: SAISONSTART-PERFORMANCE (Core, ohne Corona) ===')
  const buckets = [
    ['Erste 10%', inFirst(0.10)],
    ['Erste 20%', inFirst(0.20)],
    ['Erste 30%', inFirst(0.30)],
    ['Rest (>=30%)', isRest],
  ]
  console.log('Bucket        | A(bisherig)           | B(PreSeason)          | D(PreSeason+SOG)      | E(PreSeason+SOG+H2H)  | F(bisherig+SOG+H2H)')
  for (const [label, filt] of buckets) {
    const mA = metricsFor(rows, predictA, filt)
    const mB = metricsFor(rows, predictB, filt)
    const mD = metricsFor(rows, predictD, filt)
    const mE = metricsFor(rows, predictE, filt)
    const mF = metricsFor(rows, predictF, filt)
    console.log(`${label.padEnd(14)}| ${fmt(mA).padEnd(23)}| ${fmt(mB).padEnd(23)}| ${fmt(mD).padEnd(23)}| ${fmt(mE).padEnd(23)}| ${fmt(mF)}`)
  }

  // --- Schritt 7: Gesamtvergleich + Corona separat ---
  console.log('\n=== VERGLEICH (Core, ohne Corona) ===')
  console.log('Modell                                   | n    | Accuracy | Brier  | LogLoss')
  const printRow = (label, m) => console.log(`${label.padEnd(42)}| ${String(m.n).padEnd(5)}| ${(m.accuracy * 100).toFixed(1)}%    | ${m.brier.toFixed(4)} | ${m.logloss.toFixed(4)}`)
  printRow('A) bisheriges ELO', baseA.m)
  printRow('B) Pre-Season-ELO', baseB.m)
  printRow(`C) Pre-Season-ELO + Saisonstart-Term`, fitC.m)
  printRow('D) Pre-Season-ELO + SOG-Allowed', baseD.m)
  printRow(`E) Pre-Season-ELO + SOG + H2H (${bestE.feature})`, bestE.fit.m)
  printRow('   F-Basis) bisheriges ELO + SOG (Kontrolle)', baseF.m)
  printRow(`F) bisheriges ELO + SOG + H2H (${bestF.feature})`, bestF.fit.m)

  console.log('\nCorona-Saisons separat (nicht zur Auswahl verwendet):')
  printRow('A) bisheriges ELO', metricsFor(rows, predictA, isCorona))
  printRow('B) Pre-Season-ELO', metricsFor(rows, predictB, isCorona))
  printRow('D) Pre-Season-ELO + SOG', metricsFor(rows, predictD, isCorona))
  printRow('E) Pre-Season-ELO + SOG + H2H', metricsFor(rows, predictE, isCorona))
  printRow('F) bisheriges ELO + SOG + H2H', metricsFor(rows, predictF, isCorona))

  // --- Schritt 8: Entscheidungskriterium anwenden ---
  console.log('\n=== SCHRITT 8: ENTSCHEIDUNGSKRITERIUM ===')
  const preSeasonRobust = (baseB.m.logloss < baseA.m.logloss) && (baseB.m.brier < baseA.m.brier) && (improvedBvsA >= Math.ceil(coreSeasonCount * 0.6))
  const preSeasonHelpsEarly = metricsFor(rows, predictB, inFirst(0.20)).logloss < metricsFor(rows, predictA, inFirst(0.20)).logloss
  console.log(`Pre-Season-ELO robust (LogLoss+Brier besser, stabil >=60% Saisons)?  ${preSeasonRobust ? 'JA' : 'NEIN'}`)
  console.log(`Pre-Season-ELO hilft speziell am Saisonanfang (erste 20%)?           ${preSeasonHelpsEarly ? 'JA' : 'NEIN'}`)

  const h2hDeltaE = bestE.fit.m.logloss - baseD.m.logloss
  const h2hDeltaF = bestF.fit.m.logloss - baseF.m.logloss
  const h2hMeaningful = (d) => d < -0.0005 // > homöopathische Verbesserung
  const h2hRobustE = h2hMeaningful(h2hDeltaE) && (bestE.fit.m.brier < baseD.m.brier) && improvedEvsD >= Math.ceil(coreSeasonCount * 0.6)
  const h2hRobustF = h2hMeaningful(h2hDeltaF) && (bestF.fit.m.brier < baseF.m.brier) && improvedFvsFBase >= Math.ceil(coreSeasonCount * 0.6)
  console.log(`H2H robust zusätzlich zu Pre-Season+SOG (Modell E vs. D)?            ${h2hRobustE ? 'JA' : 'NEIN'} (ΔLogLoss=${h2hDeltaE.toFixed(4)}, verbessert in ${improvedEvsD}/${coreSeasonCount} Saisons)`)
  console.log(`H2H robust ohne Pre-Season (Modell F vs. F-Basis, Kontrolle)?        ${h2hRobustF ? 'JA' : 'NEIN'} (ΔLogLoss=${h2hDeltaF.toFixed(4)}, verbessert in ${improvedFvsFBase}/${coreSeasonCount} Saisons)`)

  // --- Schritt 9: Ajoie-Ambrì Plausibilitätscheck (NICHT zur Optimierung verwendet) ---
  console.log('\n=== SCHRITT 9: AJOIE-AMBRÌ PLAUSIBILITÄTSCHECK (15.09.2026, nur Illustration) ===')
  const AJO = 103144, APK = 101152
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
  const liveGame = db.games.find((g) => g.id === 'game_2026-09-15_ajo_apk')
  console.log(`Live-Spiel gefunden: ${liveGame ? 'ja' : 'NEIN - Fallback auf angenommene Werte'} (${liveGame?.date}, Heim=${liveGame?.homeTeamId}, Auswärts=${liveGame?.awayTeamId})`)

  // Modell A (bisheriges Modell, wie in der App tatsächlich sichtbar): beide Teams 1500, roh (kein g/c).
  const pA_raw = 1 / (1 + Math.pow(10, (1500 - (1500 + ELO.homeAdv)) / 400))

  // Modell B (Pre-Season-ELO): Saisonend-ELO 2025/26 (aus dem vollständigen
  // 9-Saisons-Walk-Forward, regressionFraction=bestRegression) + eine weitere
  // Regression beim Übergang in 2026/27 (dieselbe Regressionsstufe).
  const { finalRatings } = computeEloSnapshots(games, bestRegression)
  const ajoEndOf2025_26 = finalRatings.get(AJO) ?? ELO.start
  const apkEndOf2025_26 = finalRatings.get(APK) ?? ELO.start
  const ajoPreSeason2026_27 = ELO.start + (ajoEndOf2025_26 - ELO.start) * (1 - bestRegression)
  const apkPreSeason2026_27 = ELO.start + (apkEndOf2025_26 - ELO.start) * (1 - bestRegression)
  const pB_raw = 1 / (1 + Math.pow(10, (apkPreSeason2026_27 - (ajoPreSeason2026_27 + ELO.homeAdv)) / 400))
  const pB_calibrated = sigmoid(baseB.g * ((ajoPreSeason2026_27 + ELO.homeAdv - apkPreSeason2026_27) * Math.LN10 / 400) + baseB.c)

  console.log(`Modell A (bisherig, live wie in der App): Ajoie 1500 / Ambrì 1500 -> Heimsieg Ajoie ${(pA_raw * 100).toFixed(1)}%`)
  console.log(`Modell B (Pre-Season-ELO, Regression ${(bestRegression * 100).toFixed(0)}%): Ajoie ${ajoPreSeason2026_27.toFixed(0)} / Ambrì ${apkPreSeason2026_27.toFixed(0)} (Saisonende 2025/26: Ajoie ${ajoEndOf2025_26.toFixed(0)} / Ambrì ${apkEndOf2025_26.toFixed(0)})`)
  console.log(`  -> Heimsieg Ajoie (rohe ELO-Formel, wie A):        ${(pB_raw * 100).toFixed(1)}%`)
  console.log(`  -> Heimsieg Ajoie (mit kalibriertem g/c aus Backtest): ${(pB_calibrated * 100).toFixed(1)}%`)

  // H2H-Kontext (nur zur Anzeige, unabhängig davon ob H2H übernommen wird)
  const ajoApkMeetings = games.filter((g) => (g.homeId === AJO && g.awayId === APK) || (g.homeId === APK && g.awayId === AJO))
  const ajoWins = ajoApkMeetings.filter((g) => (g.homeId === AJO && g.homeGoals > g.awayGoals) || (g.awayId === AJO && g.awayGoals > g.homeGoals)).length
  console.log(`Historische H2H-Bilanz (9 Saisons Archiv): Ajoie ${ajoWins}-${ajoApkMeetings.length - ajoWins} Ambrì (${ajoApkMeetings.length} Duelle).`)

  let bestModelLine = 'H2H wurde NICHT aufgenommen (siehe Entscheidungskriterium oben) - "bestes Modell" = Modell B/D (Pre-Season-ELO, ggf. + SOG).'
  if (h2hRobustE) {
    const orientedAjoApk = ajoApkMeetings.map((m) => orientMeeting({ ...m, pHomeAtTime: 0.5 }, AJO))
    const sameVenue = orientedAjoApk.filter((x) => x.sameVenue)
    const [, featType, winKey, kStr, mStr] = bestE.feature.match(/^(homeAway__)?([a-zA-Z]+)__([a-zA-Z0-9]+)__k(\d+)__m(\d+)$/) || []
    const list = bestE.feature.startsWith('homeAway__') ? sameVenue : orientedAjoApk
    const winSpec = WINDOWS.find((w) => w.key === winKey)
    const { mean, n } = windowedMean(list, featType, winSpec)
    const centered = featType === 'won01' ? mean - 0.5 : mean
    const shrunkVal = gated(shrink(centered, n, Number(kStr)), n, Number(mStr))
    const stdE = bestE.std
    const sogAjo = 0, sogApk = 0 // Saisonstart: keine aktuelle-Saison-SOG-Daten vorhanden -> 0 (neutral)
    const refLogitD_live = ((ajoPreSeason2026_27 + sogAjo) + ELO.homeAdv - (apkPreSeason2026_27 + sogApk)) * Math.LN10 / 400
    const pE = sigmoid(baseD.g * refLogitD_live + bestE.fit.h * (shrunkVal / stdE) + bestE.fit.c)
    bestModelLine = `Bestes Modell MIT H2H (E, Feature ${bestE.feature}): Heimsieg Ajoie ${(pE * 100).toFixed(1)}% (H2H-Term-Rohwert=${centered.toFixed(3)}, n=${n} Duelle, nach Shrinkage/Gate=${shrunkVal.toFixed(3)}).`
  }
  console.log(bestModelLine)
  console.log('(Dieser Einzelfall dient nur der Plausibilitätsprüfung und wurde NICHT zur Modelloptimierung verwendet.)')

  // --- Ergebnis-JSON sichern ---
  const outPath = path.join(__dirname, 'backtest-preseason-h2h-result.json')
  fs.writeFileSync(outPath, JSON.stringify({
    bestRegression,
    regressionGridResults: regressionResults.map((r) => ({ rf: r.rf, g: r.fit.g, c: r.fit.c, m: r.fit.m })),
    modelA: { g: baseA.g, c: baseA.c, m: baseA.m },
    modelB: { g: baseB.g, c: baseB.c, m: baseB.m, bestRegression },
    modelC: { h: fitC.h, c: fitC.c, m: fitC.m },
    modelD: { g: baseD.g, c: baseD.c, m: baseD.m },
    modelE: { feature: bestE.feature, std: bestE.std, h: bestE.fit.h, c: bestE.fit.c, m: bestE.fit.m },
    modelFBase: { g: baseF.g, c: baseF.c, m: baseF.m },
    modelF: { feature: bestF.feature, std: bestF.std, h: bestF.fit.h, c: bestF.fit.c, m: bestF.fit.m },
    stability: { improvedBvsA, improvedEvsD, improvedFvsFBase, coreSeasonCount },
    decision: { preSeasonRobust, preSeasonHelpsEarly, h2hRobustE, h2hRobustF },
    ajoieAmbri: {
      pA_raw, ajoPreSeason2026_27, apkPreSeason2026_27, pB_raw, pB_calibrated,
      h2hMeetings: ajoApkMeetings.length, ajoWins,
    },
  }, null, 2))
  console.log(`\nDetails gespeichert: ${outPath}`)
  console.log(`Gesamtlaufzeit: ${Date.now() - t0}ms`)
}

main()
